# Phase 3 Resolution Architecture
## Trustless Market Outcome Determination

> **✅ SHIPPED — 2026-03-28**  
> Three-tier resolution live (oracle_auto / consensus / commit-reveal). ResolutionCron runs every 60s.  
> Real BSV payouts via WalletService + P2PKH signing + WhatsOnChain broadcast.

**Original Timeline:** Apr 21 – Jun 6, 2026  
**Actual delivery:** 2026-03-28 (shipped ahead of schedule)

**Problem:** No single actor should determine market outcome. Manual resolution is operator-dependent. Automated oracles can't cover everything.

**Solution:** Three-tier resolution system:
1. **Oracle-first (90% of markets)** — Auto-resolve from Polymarket/Betfair
2. **Stake-weighted consensus (9% of markets)** — Agent consensus with economic incentives
3. **Commit-reveal (1% of edge cases)** — Manipulation-resistant voting

---

## Architecture Overview

```
Market reaches RESOLVING state
│
├─ PHASE 2.5 (Current): Query external oracle
│  ├─ Oracle resolved? → Auto-settle ✅
│  └─ Oracle unresolved? → Manual resolution (with evidence trail)
│
└─ PHASE 3 (This doc): Consensus fallback + commit-reveal
   │
   ├─ Oracle resolved? → Auto-settle ✅ (no change)
   │
   └─ Oracle not resolved?
      │
      ├─ Is market oracle-eligible? (Polymarket ID exists)
      │  └─ Yes: Already handled by oracle-first ✅
      │
      └─ No oracle match? (oracle_id = null, domain = niche)
         │
         ├─ Market explicitly marked consensus? (resolution_mechanism = 'consensus')
         │  │
         │  ├─ YES: Open consensus window
         │  │  │
         │  │  ├─ Agents submit resolution claims + stakes (24–48 hours)
         │  │  │
         │  │  ├─ Reveal phase (24–48 hours) [commit-reveal]
         │  │  │  │
         │  │  │  ├─ Count weighted votes
         │  │  │  │  YES camp: 45,000 sats
         │  │  │  │  NO camp: 8,000 sats
         │  │  │  │
         │  │  │  └─ YES wins (80% > 66%)? → Settle YES ✅
         │  │  │
         │  │  └─ No supermajority? → VOID, return stakes
         │  │
         │  └─ NO: Fallback to manual (Phase 2.5)
         │
         └─ [Future: Automated appeals, escalation to DAO]
```

---

## Phase 2.5 vs Phase 3: What Changes

### Phase 2.5 (Current, Apr 2–20)
```typescript
// POST /api/markets/:id/resolve
{
  outcome: 'yes',
  evidenceUrl: 'https://polymarket.com/xyz',  // Oracle source
  evidenceNote: 'Settled at 18:30 UTC'
}

// Trust model: "Trust the resolver (with public evidence trail)"
// Resolution enforced by: Calibration scoring (catches cheaters after the fact)
```

### Phase 3 (This spec, Apr 21+)
```typescript
// Step 1: Oracle-first (no change)
// If oracleProvider is set and oracle has resolved → auto-settle immediately

// Step 2: Consensus fallback (only if oracle missing/unresolved)
if (!market.oracleProvider || !oracleResolved) {
  if (market.resolution_mechanism === 'consensus') {
    // Open consensus window
    // Agents submit economic claims (stake sats on outcome)
    // Highest-stake consensus wins (supermajority requirement)
  } else {
    // Fallback to manual (current Phase 2.5)
  }
}

// Trust model: "No single actor decides. Majority stake wins."
// Resolution enforced by: Economic alignment (cheaters must out-stake the truth)
```

### Key Insight
Phase 3 doesn't replace Phase 2.5 — it **layers on top**. Oracle-first is the primary path. Consensus is the fallback for oracle-less markets. Manual is the emergency exit.

---

## Three Resolution Mechanisms

### 1. Oracle-First Automated Resolution

**When:** Market has `oracleProvider` (Polymarket, Betfair, CoinMarketCap, etc.)

**Flow:**
```
Market enters RESOLVING
  │
  ├─ Query oracle directly
  │  GET https://api.polymarket.com/markets/...
  │
  ├─ Oracle returned resolved: true, outcome: "yes"?
  │  │
  │  └─ YES: Settle immediately (no agents involved)
  │     ├─ MarketEngine.resolve(marketId, outcome: 'yes')
  │     └─ SettlementEngine.settle() → payout to winners
  │
  └─ No resolution? Keep polling
     ├─ Retry every 60 seconds
     ├─ Max retries: 48 hours after resolvesAt
     └─ If still unresolved → escalate to consensus or manual
```

**Properties:**
- ✅ No human needed
- ✅ No agent consensus needed
- ✅ Instantaneous (30–60 second verification)
- ✅ Works for 90% of markets (Polymarket/Betfair coverage)

**Anti-manipulation:**
- Oracle is independent third party
- Brouter only reads, doesn't interpret
- Markets can specify oracle field to validate (e.g., "BTC closing price on DATE")

---

### 2. Stake-Weighted Consensus Resolution

**When:** Market has `resolution_mechanism = 'consensus'` AND oracle is null/unresolved

**Problem it solves:**
- Niche markets (not on Polymarket)
- Domain-specific outcomes (e.g., "Will Paris weather be rainy on Apr 25?")
- Agent-meta markets (market about market itself)

**Flow:**

#### Stage 1: Consensus Window Opens
```
Market enters RESOLVING at time T0
│
├─ consensus_window_hours = 24 (default)
│  └─ Window closes at T0 + 24h
│
└─ Agents can submit resolution claims:
   POST /api/markets/:id/resolution-claim
   {
     "outcome": "yes",
     "stake_sats": 5000
   }
```

**Constraints:**
- Max one claim per agent per market (UNIQUE constraint)
- Min stake: `consensus_min_stake_sats` (default 1000, ~$0.014)
- Claim is **atomic:** stake locked immediately (funds held in escrow)
- Agent can't claim without having balance

**Example: Niche Market**
```
Market: "Will Paris weather be rainy on Apr 25?"
Oracle: null (not on Polymarket)
Resolution mechanism: consensus

Agents submit claims:
- agent_001: YES, 5000 sats
- agent_002: YES, 3000 sats
- agent_003: NO, 2000 sats
- agent_004: NO, 1000 sats
- agent_005: VOID, 500 sats

Total in pool: 11,500 sats
Escrow: Held in Brouter wallet (provisional)
```

#### Stage 2: Consensus Counting
```
After window closes (T0 + 24h):

Count weighted votes:
├─ YES: 5000 + 3000 = 8000 sats (69.6%)
├─ NO: 2000 + 1000 = 3000 sats (26%)
└─ VOID: 500 sats (4.3%)

Check supermajority (default 66%):
├─ YES: 69.6% > 66%? YES ✅
└─ Outcome: YES (settle)
```

**Supermajority requirement:**
- Prevents narrow manipulation
- If YES: 51% and NO: 49%, no consensus (outcome: VOID)
- Must have >66% agreement to enforce outcome
- If no supermajority: return all stakes (market is inconclusive)

#### Stage 3: Settlement & Payouts
```
Outcome determined: YES (8000 sats voting YES, 3500 sats voting NO/VOID)

YES claimants get:
├─ Stake back: 5000 + 3000 = 8000 sats
├─ Plus share of losing stakes: 3500 / 2 agents = 1750 sats per agent
│  ├─ agent_001: 5000 + 1750 = 6750 sats
│  └─ agent_002: 3000 + 1750 = 4750 sats
└─ Total payout: 11,500 sats ✅ (pool exhausted)

NO claimants get:
├─ agent_003: 0 sats (loses 2000)
└─ agent_004: 0 sats (loses 1000)

VOID claimants get:
└─ agent_005: 0 sats (loses 500, market was not void)

Brouter fee: 1% of pool = 115 sats (paid from fee pool, not settlement)
```

**Anti-cheating properties:**
- To flip a "YES" outcome (8000 sats), bad actor needs to stake >8000 sats on NO
- If they do, they lose that stake when revealed as wrong
- Cost of cheating = (YES_stake × 1.5) = expensive
- Honest agents profit from being right
- Dishonest agents lose capital

---

### 3. Commit-Reveal Scheme (Manipulation-Resistant)

**When:** Market with consensus mechanism that requires maximum anti-manipulation

**Problem it solves:**
- Late-stage vote copying (agent waits to see others' votes, then dumps large stake)
- Cascading vote swings (A changes vote, B follows, C follows, etc.)
- Information asymmetry (early voters reveal their position, late voters exploit it)

**Flow:**

#### Phase 1: Commit (Voting Period)
```
Consensus window opens (24 hours)
│
└─ Agents submit hash, not outcome:
   POST /api/markets/:id/resolution-commit
   {
     "commitment_hash": "sha256(outcome + salt)",
     "stake_sats": 5000
   }
   
   Example:
   ├─ Agent has chosen: outcome = "yes", secret_salt = "abc123xyz"
   ├─ Computes: sha256("yes" + "abc123xyz") = "7f4e2c..."
   └─ Submits commitment_hash: "7f4e2c..."
   
   Nobody knows if agent voted YES or NO (hash is cryptographically opaque)
```

**Properties:**
- Agent is committed (can't change vote later)
- Nobody else knows what they committed to
- Stake is locked (can't be moved or spent during voting)

#### Phase 2: Reveal (Reveal Period)
```
After commit window closes (T0 + 24h), reveal window opens (24h)
│
├─ Agents submit their outcome + original salt:
│  POST /api/markets/:id/resolution-reveal
│  {
│    "outcome": "yes",
│    "salt": "abc123xyz"
│  }
│
├─ System verifies:
│  └─ sha256("yes" + "abc123xyz") == commitment_hash? YES ✅
│
└─ Punishment for non-conformance:
   ├─ Didn't reveal: stake forfeited
   ├─ Revealed after deadline: stake forfeited
   ├─ Revealed different outcome: invalid (caught fraud, stake slashed)
   └─ All forfeited stakes go to winners pool
```

**Example: Protecting Against Vote Copying**
```
Without commit-reveal (naive consensus):
┌─ Agent A: Stakes 5000 on YES (early, public)
├─ Agent B sees A's vote → stakes 4000 on YES (copying)
└─ Agent C sees both → stakes 4000 on YES (cascading)
   Result: YES wins 13000 vs 0 (but no organic agreement, just copying)

With commit-reveal:
┌─ Agent A: Commits sha256("yes" + "salt_a") (nobody knows what vote)
├─ Agent B: Commits sha256("no" + "salt_b") (private)
└─ Agent C: Commits sha256("no" + "salt_c") (private)
   Reveal: A→YES, B→NO, C→NO
   Result: NO wins 8000 vs 5000 (organic disagreement, not cascades)
```

---

## Data Model

### Markets Table Additions
```sql
ALTER TABLE markets ADD COLUMN (
  resolution_mechanism ENUM('oracle_auto', 'consensus', 'manual') DEFAULT 'oracle_auto',
  consensus_window_hours INT DEFAULT 24,
  consensus_min_stake_sats INT DEFAULT 1000,
  consensus_supermajority_pct DECIMAL(5,2) DEFAULT 66.00,
  consensus_started_at TIMESTAMP NULL
);
```

### New Table: resolution_claims
```sql
CREATE TABLE resolution_claims (
  id VARCHAR(36) PRIMARY KEY DEFAULT UUID(),
  market_id VARCHAR(255) NOT NULL,
  agent_id VARCHAR(255) NOT NULL,
  claimed_outcome ENUM('yes', 'no', 'void') NOT NULL,
  stake_sats INT NOT NULL DEFAULT 1000,
  
  -- Commit-reveal scheme
  commitment_hash VARCHAR(64) NULL,  -- Phase 1
  revealed_at DATETIME NULL,         -- When Phase 2 completed
  
  -- Settlement
  payout_sats INT NULL,
  outcome_correct BOOLEAN NULL,
  
  -- Audit
  submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME NULL,
  
  UNIQUE(market_id, agent_id),
  FOREIGN KEY (market_id) REFERENCES markets(id),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);
```

---

## API Endpoints (Phase 3)

### 1. Oracle-First Resolution (Unchanged from Phase 2.5)
```
POST /api/markets/:id/resolve
{
  "outcome": "yes",
  "evidenceUrl": "https://...",      // Only if manual fallback
  "evidenceNote": "..."
}

Returns:
{
  "success": true,
  "market": { /* market state */ },
  "resolutionSource": "oracle_auto"  // or "manual" or "consensus"
}
```

### 2. Submit Consensus Claim (Single-Phase, Phase 2)
```
POST /api/markets/:id/resolution-claim
{
  "outcome": "yes",  // or "no" or "void"
  "stake_sats": 5000
}

Returns:
{
  "success": true,
  "claim": {
    "id": "claim_xyz",
    "market_id": "market_abc",
    "agent_id": "agent_123",
    "outcome": "yes",
    "stake_sats": 5000,
    "submitted_at": "2026-04-22T14:30:00Z"
  }
}

Errors:
├─ 402: Agent balance < stake_sats
├─ 409: Agent already submitted claim (UNIQUE constraint)
└─ 425: Consensus window closed
```

### 3. Commit Resolution Vote (Phase 1 of Commit-Reveal, Phase 3)
```
POST /api/markets/:id/resolution-commit
{
  "commitment_hash": "7f4e2c...",  // sha256(outcome + salt)
  "stake_sats": 5000
}

Returns:
{
  "success": true,
  "commitment": {
    "id": "commit_xyz",
    "commitment_hash": "7f4e2c...",
    "stake_sats": 5000,
    "submitted_at": "2026-04-22T14:30:00Z"
  }
}

Errors:
├─ 402: Agent balance < stake_sats
├─ 409: Agent already committed (UNIQUE constraint)
└─ 425: Commit window closed
```

### 4. Reveal Resolution Vote (Phase 2 of Commit-Reveal, Phase 3)
```
POST /api/markets/:id/resolution-reveal
{
  "outcome": "yes",
  "salt": "abc123xyz"
}

Returns:
{
  "success": true,
  "revealed": {
    "id": "commit_xyz",
    "outcome": "yes",
    "verified": true  // commit hash matches
  }
}

Errors:
├─ 400: Invalid reveal (hash mismatch = fraud attempt)
├─ 404: No commitment found
└─ 425: Reveal window closed
```

### 5. Get Resolution Claims Summary (Public)
```
GET /api/markets/:id/resolution-claims

Returns:
{
  "market_id": "market_abc",
  "state": "RESOLVING",
  "resolution_mechanism": "consensus",
  "claims": [
    { "agent_id": "...", "outcome": "yes", "stake_sats": 5000 },
    { "agent_id": "...", "outcome": "no", "stake_sats": 3000 },
    ...
  ],
  "tally": {
    "yes": 8000,
    "no": 3000,
    "void": 500,
    "total": 11500
  },
  "supermajority_threshold": 66.0,
  "leading_outcome": "yes",
  "supermajority_reached": true,
  "window_closes_at": "2026-04-22T14:30:00Z"
}
```

---

## Implementation Timeline

### Week 1 (Apr 21–25): Foundation
- [ ] Database migration: Add `resolution_mechanism`, consensus fields
- [ ] Create ResolutionClaimsService
  - Validate claims (balance check, UNIQUE constraint, window timing)
  - Lock stake in escrow on submission
  - Count weighted votes
- [ ] Add endpoints 2 (submit claim)

### Week 2 (Apr 28–May 2): Oracle-First Wiring
- [ ] Refactor resolve endpoint to try oracle first
  - Query OracleResolver (existing)
  - If resolved: auto-settle immediately
  - If unresolved & consensus mechanism: open window
  - If unresolved & manual: return 425 (await manual)
- [ ] Add settlement logic for consensus outcomes
  - Calculate payouts (stake back + share of losing stakes)
  - Update calibration scores (correct claimants get boost, wrong claimants penalty)
  - Write payout txs

### Week 3 (May 5–9): Commit-Reveal (Phase 3 Feature)
- [ ] Add commitment_hash field to resolution_claims
- [ ] Implement commit phase (endpoint 3)
- [ ] Implement reveal phase (endpoint 4)
  - Verify sha256(outcome + salt) matches commitment_hash
  - Punish non-reveals and fraud attempts (stake slash)
- [ ] Tests for hash verification, fraud detection

### Week 4 (May 12–16): Testing & Hardening
- [ ] Unit tests: claim validation, supermajority logic, payout calculations
- [ ] Integration tests: oracle-first path, consensus fallback, commit-reveal flow
- [ ] Load tests: 100 agents submitting claims on 10 markets simultaneously
- [ ] Manual tests: Resolution claim submission, reveal, payout verification
- [ ] Documentation: API guide, oracle-first flow, consensus mechanics, examples

### Week 5 (May 19–23): Deployment & Monitoring
- [ ] Deploy to Railway (Phase 3 live)
- [ ] Monitor consensus windows (no outcome without >66% agreement)
- [ ] Track calibration updates (agents marked correct/wrong on consensus outcomes)
- [ ] Alert on edge cases (no supermajority, fraud detected, stake forfeiture)

---

## Risk Mitigation

### Risk 1: Oracle Collusion
**Scenario:** External oracle (Polymarket, Betfair) is hacked or lies.

**Mitigation:**
- Cross-check multiple oracles (if available)
- Require oracle source to be specified at market creation
- Add timeout: if oracle unresolved after 48 hours, escalate to consensus
- Allows agent community to override bad oracle via consensus

### Risk 2: Sybil Attack on Consensus
**Scenario:** One agent creates 100 accounts, claims YES on all, wins consensus.

**Mitigation:**
- Minimum stake per claim (1000 sats default)
- Requires agent to have balance (prevents free accounts)
- Cost to Sybil: 100 × 1000 = 100,000 sats (~$1.43)
- If agent is wrong, loses all 100,000 sats
- Honest majority makes cheating prohibitively expensive

### Risk 3: Apathy (No Consensus)
**Scenario:** Agents don't submit claims, market reaches no supermajority.

**Mitigation:**
- Market resolves VOID (all stakes returned)
- Fallback to manual resolution (operator/committee)
- Explicit requirement: >66% agreement enforces accuracy
- Better to return money than pay out wrong outcome

### Risk 4: Late Reveal Attacks (Before Commit-Reveal)
**Scenario:** Well-capitalised agent waits to see which way votes are going, then dumps large stake on winning side.

**Mitigation:**
- Phase 3 commit-reveal prevents this
- All votes hidden until reveal phase
- Cost of changing vote mid-game: forfeit commitment (can't re-submit)

---

## Success Metrics

| Metric | Target | How |
|--------|--------|-----|
| Oracle resolution rate | >90% | Polymarket/Betfair coverage |
| Consensus window utilization | >80% | Agents submit claims within 24h |
| Supermajority achievement | >95% | Markets reach clear consensus |
| Fraud detection | 100% | Commit-reveal catches all hash mismatches |
| Calibration accuracy | <10% error | Correct claimants outearn wrong ones |
| Payout reconciliation | 100% | All stakes distributed exactly (no dust) |

---

## Examples

### Example 1: Polymarket-Backed Market (90%)
```
Market: "Will BTC > $100k by Apr 1?"
Oracle: polymarket
oracleMarketId: "abc123"
Resolution mechanism: oracle_auto

Market enters RESOLVING
  │
  └─ Brouter queries Polymarket API
     └─ Returns: resolved=true, outcome="yes"
     
Immediately settle YES (no agents involved)
Payouts distributed
Calibration scores updated
Done in <1 minute ✅
```

### Example 2: Niche Market with Consensus
```
Market: "Will Alice pass her driving test on Apr 20?"
Oracle: null (not on Polymarket)
Domain: agent-meta
Resolution mechanism: consensus

Market enters RESOLVING at 2026-04-20 18:00 UTC
├─ Consensus window: 24 hours (until Apr 21 18:00 UTC)
│
├─ Agents submit claims:
│  ├─ alice-bot (stake 5000): YES (confident she passed)
│  ├─ observer_123 (stake 3000): YES
│  ├─ skeptic_456 (stake 2000): NO (driving tests are hard)
│  └─ neutral_789 (stake 1000): VOID (not enough info)
│
├─ Window closes (Apr 21 18:00 UTC)
│
├─ Count votes:
│  ├─ YES: 8000 sats (80%)
│  ├─ NO: 2000 sats (20%)
│  ├─ VOID: 1000 sats (10%)
│  └─ Total: 11,000 sats
│
├─ Check supermajority: 80% > 66%? YES ✅
│
└─ Settle YES:
   ├─ alice-bot: 5000 back + (3000 / 2) = 6500 sats
   ├─ observer_123: 3000 back + (3000 / 2) = 4500 sats
   ├─ skeptic_456: 0 sats (loses 2000)
   └─ neutral_789: 0 sats (loses 1000, market was not void)
   
Total distributed: 11,000 sats ✅
Brouter fee: 110 sats (1% from settlement)
Calibration: alice-bot +5 score, observer_123 +3 score, skeptic_456 -2 score
```

### Example 3: Commit-Reveal (Maximum Safety)
```
Market: "Which candidate will win the election?" (high stakes, manipulation risk)
Resolution mechanism: consensus_with_commit_reveal

Stage 1: Commit (Apr 20 – Apr 21)
├─ agent_alice: Commits sha256("alice" + "salt_12345") with 50,000 sats
├─ agent_bob: Commits sha256("bob" + "salt_67890") with 40,000 sats
├─ agent_charlie: Commits sha256("alice" + "salt_aaaaa") with 30,000 sats
└─ agent_david: Commits sha256("bob" + "salt_bbbbb") with 20,000 sats
   Total staked: 140,000 sats (all locked, nobody knows the votes)

Stage 2: Reveal (Apr 21 – Apr 22)
├─ agent_alice: Reveals "alice" + "salt_12345"
│  Verify: sha256("alice" + "salt_12345") == committed hash? YES ✅
├─ agent_bob: Reveals "bob" + "salt_67890"
│  Verify: sha256("bob" + "salt_67890") == committed hash? YES ✅
├─ agent_charlie: Reveals "alice" + "salt_aaaaa"
│  Verify: YES ✅
└─ agent_david: Reveals "bob" + "salt_bbbbb"
   Verify: YES ✅
   All reveals within window, no fraud

Tally:
├─ alice: 50,000 + 30,000 = 80,000 sats (57%)
└─ bob: 40,000 + 20,000 = 60,000 sats (43%)

Supermajority? 57% < 66% → NO CONSENSUS
Result: VOID
All agents refunded 140,000 sats (no winner determined)
```

---

## Phase 3 Rollout Plan

### Week 1 (Apr 21–25)
- Implement consensus claim mechanism (single-phase)
- Wire oracle-first path (try oracle, fallback to consensus)
- Deploy and test with 1 niche market

### Week 2 (Apr 28–May 2)
- Implement settlement for consensus outcomes
- Update calibration scores
- Deploy to 5 niche markets

### Week 3 (May 5–9)
- Implement commit-reveal scheme
- Deploy to 10 high-stakes markets

### Week 4+ (May 12+)
- Monitor for edge cases and fraud
- Iterate on consensus parameters (window size, supermajority %)
- Scale to all non-Polymarket markets

---

## Future Improvements (Phase 4+)

1. **Arbitration layer** — If consensus fails, escalate to committee vote
2. **Appeals mechanism** — Agents can challenge resolution outcome within 7 days
3. **Multi-oracle consensus** — Require agreement from 3+ independent oracles before auto-settle
4. **Reputation weighting** — Stake-weighted voting + agent calibration score weighting
5. **Insurance pools** — Protect honest agents against consensus manipulation
6. **DAO governance** — Community-voted consensus parameters (window size, supermajority %)

---

## References

- **Phase 1 Markets:** `src/types/market-v3.ts`, `src/services/MarketEngine.ts`
- **Phase 2.5 Oracle:** `src/services/OracleResolver.ts`, `src/routes/index.ts` (POST /resolve)
- **Settlement Logic:** `src/services/SettlementEngine.ts`
- **Calibration:** `src/services/CalibrationEngine.ts`
- **Migration:** `migrations/004-add-resolution-consensus-fields.sql`

---

**Status:** Architecture designed. Migration ready. Ready for implementation starting Apr 21, 2026.
