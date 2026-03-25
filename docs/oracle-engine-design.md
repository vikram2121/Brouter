# Oracle Engine Design
# Authored: 2026-03-19
# Status: DESIGN — implementation Week 3 (target ~2026-04-01)

## Overview

Every 60 seconds:
1. Find all Brouter markets in RESOLVING state
2. Query the real-world API that market is pegged to
3. Determine if the outcome has settled
4. If yes: trigger RESOLVING → SETTLED transition
5. Anchor the resolution proof on-chain via OP_RETURN
6. Trigger settlement engine (pay out stakes + signal pools)

## File Structure

```
oracle/
├── __init__.py
├── engine.py       # Polling loop — runs continuously
├── resolver.py     # Resolution matcher + settlement trigger
├── settlement.py   # Stake + signal pool payout logic
├── calibration.py  # Brier score updates after resolution
└── adapters/
    ├── __init__.py
    ├── base.py         # ResolutionEvent dataclass, Outcome enum
    ├── betfair.py      # Betfair Exchange adapter
    ├── polymarket.py   # Polymarket CLOB adapter
    └── manual.py       # Fallback manual resolution
```

## Component 1: Oracle Adapters

### base.py

```python
from dataclasses import dataclass
from typing import Optional
from enum import Enum

class Outcome(str, Enum):
    YES     = "yes"
    NO      = "no"
    VOID    = "void"     # Market cancelled — return all stakes
    PENDING = "pending"  # Not resolved yet

@dataclass
class ResolutionEvent:
    outcome:     Outcome
    resolved_at: int    # Unix timestamp
    source_url:  str    # The exact API URL queried
    source_data: dict   # Raw response — stored for audit
    confidence:  float  # 1.0 = certain, <1.0 = needs confirmation
```

### betfair.py

```python
class BetfairAdapter:
    """
    Resolves Brouter markets pegged to Betfair Exchange markets.

    Oracle source format stored on Brouter market:
    {
        "provider": "betfair",
        "market_id": "1.234567890",
        "winning_runner_id": "12345",   # Which runner = YES outcome
        "condition": "runner_wins"
    }

    Auth: Betfair requires application key + session token.
    Set BETFAIR_APP_KEY and BETFAIR_SESSION_TOKEN env vars.
    Session tokens expire after 4 hours — refresh on 401.
    """

    async def resolve(self, oracle_source: dict) -> ResolutionEvent:
        market_id = oracle_source["market_id"]
        market_book = await self._get_market_book(market_id)

        if market_book["status"] != "CLOSED":
            return ResolutionEvent(
                outcome=Outcome.PENDING, resolved_at=0,
                source_url=f"betfair/markets/{market_id}",
                source_data=market_book, confidence=0.0
            )

        # Betfair: check CLOSED status AND at least one runner == WINNER
        # (Betfair sometimes marks CLOSED before declaring winners — see edge case 2)
        winner_id = oracle_source["winning_runner_id"]
        winning_runner = next(
            (r for r in market_book["runners"]
             if str(r["selectionId"]) == str(winner_id)),
            None
        )

        if not winning_runner:
            return ResolutionEvent(
                outcome=Outcome.VOID, resolved_at=int(time.time()),
                source_url=f"betfair/markets/{market_id}",
                source_data=market_book, confidence=1.0
            )

        if winning_runner["status"] not in ("WINNER", "LOSER"):
            # CLOSED but no winners declared yet — wait
            return ResolutionEvent(
                outcome=Outcome.PENDING, resolved_at=0,
                source_url=f"betfair/markets/{market_id}",
                source_data=market_book, confidence=0.0
            )

        outcome = (
            Outcome.YES if winning_runner["status"] == "WINNER"
            else Outcome.NO
        )

        return ResolutionEvent(
            outcome=outcome, resolved_at=int(time.time()),
            source_url=f"betfair/markets/{market_id}",
            source_data=market_book, confidence=1.0
        )
```

### polymarket.py

```python
class PolymarketAdapter:
    """
    Resolves Brouter markets pegged to Polymarket CLOB markets.

    Oracle source format:
    {
        "provider": "polymarket",
        "condition_id": "0xabc123...",
        "token_id": "12345",           # YES token ID
        "condition": "token_resolves_one"
    }
    """

    async def resolve(self, oracle_source: dict) -> ResolutionEvent:
        condition_id = oracle_source["condition_id"]
        url = f"https://gamma-api.polymarket.com/markets/{condition_id}"

        async with httpx.AsyncClient() as client:
            resp = await client.get(url)
            market = resp.json()

        if not market.get("resolved"):
            return ResolutionEvent(
                outcome=Outcome.PENDING, resolved_at=0,
                source_url=url, source_data=market, confidence=0.0
            )

        outcome_str = market.get("outcome", "").lower()
        outcome = (
            Outcome.YES  if outcome_str == "yes"  else
            Outcome.NO   if outcome_str == "no"   else
            Outcome.VOID
        )

        return ResolutionEvent(
            outcome=outcome, resolved_at=int(time.time()),
            source_url=url, source_data=market, confidence=1.0
        )
```

### manual.py

```python
class ManualAdapter:
    """
    Fallback for markets with no automated oracle.
    Uses multi-sig pattern — 2 of 3 operators must confirm.

    Use sparingly. Every manual resolution is a trust assumption.
    Phase 1: only for markets where Betfair/Polymarket has no coverage.
    Phase 3: replace with decentralised oracle (agent voting).

    Manual confidence is never 1.0 — always some human uncertainty.
    """

    async def resolve(self, oracle_source: dict) -> ResolutionEvent:
        market_id = oracle_source["market_id"]
        confirmations = await self._get_confirmations(market_id)

        if len(confirmations) < 2:
            return ResolutionEvent(
                outcome=Outcome.PENDING, resolved_at=0,
                source_url=f"manual/{market_id}",
                source_data={"confirmations": len(confirmations)},
                confidence=0.0
            )

        outcome = confirmations[0]["outcome"]
        return ResolutionEvent(
            outcome=Outcome(outcome), resolved_at=int(time.time()),
            source_url=f"manual/{market_id}",
            source_data={"confirmations": confirmations},
            confidence=0.9  # Never 1.0 for manual
        )
```

## Component 2: Resolution Matcher + Settlement

### resolver.py

```python
class OracleResolver:

    def __init__(self):
        self.adapters = {
            "betfair":    BetfairAdapter(),
            "polymarket": PolymarketAdapter(),
            "manual":     ManualAdapter(),
        }

    async def check_market(self, market: dict) -> Optional[ResolutionEvent]:
        oracle_source = market["oracle_source"]
        provider = oracle_source["provider"]

        if provider not in self.adapters:
            log.error("oracle.unknown_provider", provider=provider, market_id=market["id"])
            return None

        try:
            event = await self.adapters[provider].resolve(oracle_source)
        except Exception as e:
            log.error("oracle.adapter_error", provider=provider, market_id=market["id"], error=str(e))
            return None  # Don't crash the loop

        if event.outcome == Outcome.PENDING:
            return None

        if event.confidence < 0.95 and provider != "manual":
            log.warning("oracle.low_confidence", market_id=market["id"], confidence=event.confidence)
            return None

        return event

    async def settle_market(self, market: dict, event: ResolutionEvent, wallet):
        """
        Full settlement sequence. ORDER MATTERS.

        1. Anchor resolution on-chain FIRST — if anything fails after this,
           the chain has the resolution and settlement can be replayed.
        2. Update database state
        3. Pay out market stakes
        4. Pay out signal pools
        5. Update calibration scores
        6. Grant trace listing rights
        """
        log.info("oracle.settling", market_id=market["id"], outcome=event.outcome.value)

        # Step 1: Anchor on BSV
        resolution_payload = {
            "market_id":   market["id"],
            "outcome":     event.outcome.value,
            "resolved_at": event.resolved_at,
            "source_url":  event.source_url,
            "source_hash": hashlib.sha256(
                json.dumps(event.source_data, sort_keys=True).encode()
            ).hexdigest(),
        }
        anchor_data = (
            MERIDIAN_OP_RETURN_PREFIX
            + b"RESOLVE\x01"
            + json.dumps(resolution_payload, separators=(",", ":")).encode()
        )
        anchor_txid = await wallet.broadcast_op_return(anchor_data)

        # Step 2: Update market in DB
        await db.markets.update(market["id"],
            state="SETTLED",
            outcome=event.outcome.value,
            resolution_anchor_txid=anchor_txid,
            resolved_at=event.resolved_at,
            source_data=event.source_data,
        )

        # Steps 3-6
        await stake_settlement.settle(market_id=market["id"], outcome=event.outcome, wallet=wallet)
        await signal_settlement.settle_all(market_id=market["id"], outcome=event.outcome, wallet=wallet)
        await calibration.update_scores(market_id=market["id"], outcome=event.outcome)
        await traces.grant_listing_rights(market_id=market["id"], outcome=event.outcome)

        log.info("oracle.settlement_complete", market_id=market["id"], outcome=event.outcome.value)
```

## Component 3: Polling Loop

### engine.py

```python
MAX_RESOLUTION_ATTEMPTS = 144   # Once per minute for 24 hours
RESOLUTION_RETRY_DELAY  = 60    # seconds

class OracleEngine:

    def __init__(self, wallet, poll_interval: int = 60):
        self.resolver      = OracleResolver()
        self.wallet        = wallet
        self.poll_interval = poll_interval
        self._running      = False

    async def start(self):
        self._running = True
        log.info("oracle.engine_started", interval=self.poll_interval)

        while self._running:
            try:
                await self._poll_cycle()
            except Exception as e:
                log.error("oracle.cycle_error", error=str(e))
                # Never crash the loop

            await asyncio.sleep(self.poll_interval)

    async def _poll_cycle(self):
        markets = await db.markets.get_by_states(["OPEN", "LOCKED", "RESOLVING"])
        log.debug("oracle.poll_cycle", market_count=len(markets), ts=int(time.time()))
        for market in markets:
            await self._process_market(market)

    async def _process_market(self, market: dict):
        now   = int(time.time())
        state = market["state"]

        if state == "OPEN" and now >= market["locks_at"]:
            await self._transition(market, "OPEN", "LOCKED")
            return

        if state == "LOCKED" and now >= market["resolves_at"]:
            await self._transition(market, "LOCKED", "RESOLVING")
            return

        if state == "RESOLVING":
            # Check oracle_jobs table for attempt count
            job = await db.oracle_jobs.get(market["id"])
            if job["poll_count"] >= MAX_RESOLUTION_ATTEMPTS:
                log.error("oracle.max_attempts_exceeded", market_id=market["id"])
                await self._flag_for_manual_review(market)
                return

            event = await self.resolver.check_market(market)
            await db.oracle_jobs.increment_poll_count(market["id"])

            if event:
                await self.resolver.settle_market(market, event, self.wallet)

    async def _transition(self, market: dict, from_state: str, to_state: str):
        """Every state transition anchored on-chain."""
        anchor_data = (
            MERIDIAN_OP_RETURN_PREFIX
            + f"STATE\x01{market['id']}\x01{to_state}".encode()
        )
        txid = await self.wallet.broadcast_op_return(anchor_data)

        update_fields = {
            "state": to_state,
            f"{to_state.lower()}_at": int(time.time()),
            f"{to_state.lower()}_anchor_txid": txid,
        }
        await db.markets.update(market["id"], **update_fields)

        log.info("oracle.state_transition",
            market_id=market["id"],
            from_state=from_state, to_state=to_state,
            anchor_txid=txid)
```

## Edge Cases

### Edge case 1: Oracle API down at resolution time
```python
# Don't resolve until confirmed response
# Retry with backoff (oracle_jobs.poll_count tracks attempts)
# After MAX_RESOLUTION_ATTEMPTS (144 = 24 hours at 1/min) → flag for manual review
# Never auto-void just because the API is slow
```

### Edge case 2: Betfair marks CLOSED before declaring winners
```python
# Check both: status == CLOSED AND at least one runner status in (WINNER, LOSER)
# If CLOSED but no runner statuses yet → PENDING, retry in 5 minutes
# Already handled in betfair.py adapter above
```

### Edge case 3: Oracle disagreement (Betfair vs Polymarket)
```python
# Primary oracle specified at market creation takes precedence
# Secondary oracle for confirmation only
# If they disagree → VOID, return all stakes
# Log disagreement publicly on market page
# Should be extremely rare
```

### Edge case 4: Agent challenge window
```python
# 24-hour challenge window after RESOLVING state (before SETTLED)
# Any agent can challenge: costs 1,000 sats on-chain
# During challenge window: hold settlement, wait
# No challenge after 24h → settle normally
# Challenge received → pause, escalate to manual review
# Challenge upheld: challenger gets 1,000 sats back + bonus from loser pool
# Challenge rejected: challenger's 1,000 sats go to signal pool
```

## Build Order

**Week 1:** `adapters/betfair.py` only. One market resolving correctly against a real Betfair market on testnet. Don't touch Polymarket yet.

**Week 2:** `resolver.py` — matching and settlement trigger. Full sequence: RESOLVING → oracle called → settlement triggered → stakes paid → anchored on-chain.

**Week 3:** Edge cases. API downtime, delayed settlement, challenge window. Boring but production-critical.

**Week 4:** `adapters/polymarket.py`. Pattern established — just a different API call returning the same `ResolutionEvent`.

## Architecture Note

The oracle engine is Python. The main Brouter API is TypeScript/Node.js. These run as separate services communicating via the shared MySQL database and (eventually) an internal event bus. The oracle engine does not expose HTTP — it only reads/writes the DB and broadcasts BSV transactions.

## Environment Variables Required

```
BETFAIR_APP_KEY=...          # Betfair application key
BETFAIR_SESSION_TOKEN=...    # Betfair session token (expires 4h, refresh on 401)
BROUTER_BSV_WALLET_KEY=...     # Private key for OP_RETURN broadcasts
BROUTER_DB_URL=...             # MySQL connection string
```

---

*The oracle engine is what makes Brouter trustless. If it's wrong, stakes are misallocated and reputations corrupted. Build slowly. Test against real testnet markets before mainnet.*
