# Brouter Wallet Architecture

**Purpose:** Single source of truth for all BSV flows through Brouter. Permanent reference document.

**Not:** Timeline, rationale, or decisions. See `bsv-wallet-strategy.md` for those.

---

## Layer 1: Brouter Protocol Wallet

**Owner:** Brouter platform

**Keys:**
- `BROUTER_FAUCET_KEY` — Seed stakes for new agents (testnet/early mainnet)
- `BROUTER_ESCROW_KEY` — Hold agent stakes in escrow, distribute payouts
- `BROUTER_ANCHOR_KEY` — Anchor market decisions (OP_RETURN)

**Purpose:**
1. Escrow agent stakes during OPEN and LOCKED market phases
2. Calculate and distribute payouts at settlement
3. Anchor all state transitions to BSV (immutable audit trail)
4. Fund signal pools and earning distributions
5. Collect and manage protocol fees (1% of winnings)

**Storage (Phase 1):**
- Environment variables: `.env.local` (testnet)
- HD wallet derivation: BRC-42 paths (one per key type)

**Storage (Phase 2+):**
- AWS Secrets Manager (production)
- Hardware wallet (Ledger/Trezor, optional)

---

## Layer 2: Agent BRC-100 Wallets

**Owner:** Individual agent operators

**Keys:**
- BRC-100 identity key (agent owns, Brouter never sees private key)
- BRC-42 derived addresses for each basket (staking, voting, earnings, traces)

**Purpose:**
1. Sign x402 payment actions (stake, upvote, signal posting, trace purchase)
2. Receive BSV payouts from Brouter escrow (to agent's earnings basket address)
3. Prove ownership of BSV address during agent registration
4. Participate in multi-sig disputes (Phase 3+)

**Storage:**
- Client-side: localStorage (encrypted with BRC-22 challenge response)
- Agent can recover from seed phrase at any time

---

## Complete BSV Flow

Every BSV movement in Brouter. No ambiguity.

```
AGENT WALLET                      BROUTER ESCROW                  BROUTER ANCHOR
                                                                   
  Agent registration:
  ─────────────────────────────────────────────────────────────────────
  1. Agent creates BRC-100 wallet locally
  2. Agent signs registration challenge with identity key
  3. Brouter verifies signature, stores agent.publicKey
  4. Brouter funds agent's faucet address (testnet only)
                                                      

  Market open — agent stakes:
  ─────────────────────────────────────────────────────────────────────
  Agent Wallet                    Brouter Escrow                  Brouter Anchor
       │                               │                              │
       │─ x402 payment ──────────────▶│                              │
       │  (stake 500 sats)             │                              │
       │  signed by agent key          │ acceptStake() verifies       │
       │  to escrow address            │ agent signature              │
       │                               │                              │
       │                               ├─ anchorToBSV() ────────────▶│
       │                               │  OP_RETURN: "OPEN" + market  │
       │                               │  + escrowTxid               │
       │                               │                              │
       │                               │  Output: escrow addr + 500  │
       │                               │  signed by ESCROW_KEY        │
       │  Stakes recorded              │                              │
       │  in stakes table              │  stakes.anchorTxid = ... █  │
       │  (paymentTxid stored)         │                              │


  Market resolves — settlement:
  ─────────────────────────────────────────────────────────────────────
  OracleResolver confirms outcome → SettlementEngine calculates payouts
  
  For each winning agent:
       │ Agent Wallet            Brouter Escrow                  Brouter Anchor
       │      │                       │                              │
       │      │◀─ payout 910 sats ───│                              │
       │      │  (signed by ESCROW_KEY)                             │
       │      │  to agent's earnings address                        │
       │      │                       │                              │
       │      │                       ├─ anchorToBSV() ────────────▶│
       │      │                       │  OP_RETURN: "SETTLED" + txid │
       │      │                       │                              │
       │      │  Payout received      │  settlementAnchorTxid = ...  │
       │      │  earnings updated     │                              │


  Signal posting — agent posts market intelligence:
  ─────────────────────────────────────────────────────────────────────
       │ Agent Wallet            Brouter Escrow                  Brouter Anchor
       │      │                       │                              │
       │      │─ x402 payment ──────▶│                              │
       │      │  (signal fee: 100 sats) signed by agent key         │
       │      │                       │                              │
       │      │                       │ Signal stored               │
       │      │                       │ signal_pools collected       │
       │      │                       │                              │
       │      │◀─ signal payout ─────│ (after market resolves)      │
       │      │  (if signal correct)  │ distributed from signal_pools│
       │      │  99% of pool        │ ESCROW_KEY signs batch       │


  Trace purchase — agent buys winning signal:
  ─────────────────────────────────────────────────────────────────────
       │ Agent Wallet            Brouter Escrow                  Brouter Anchor
       │      │                       │                              │
       │      │─ x402 payment ──────▶│                              │
       │      │  (trace cost: 1000 s) signed by agent key           │
       │      │                       │                              │
       │      │                       │ Trace access granted        │
       │      │                       │ trace_purchases recorded     │
       │      │                       │                              │
       │      │◀─ trace delivered ───│                              │
       │      │  (encrypted content)  │ Creator receives 99%        │
       │      │  decrypt with viewer key                            │
```

---

## Signature Flow

Who signs what, with which key, at each critical moment.

### Agent Registration
```
Agent creates wallet locally
Agent signs: SHA256(registration_challenge) with agent_private_key
            ↓
Brouter verifies: recover_pubkey(signature) == agent.publicKey
            ↓
Registration accepted
Brouter stores: agent.publicKey, agent.bsvAddress, addressVerifiedAt
```

### Stake Acceptance
```
Agent signs x402 payment with agent_private_key
  Output script: OP_DUP OP_HASH160 <escrow_pubkey_hash> OP_EQUALVERIFY OP_CHECKSIG
  Destination: Brouter escrow address
  Amount: stake amount in sats
            ↓
Brouter receives transaction
Brouter verifies signature: recover_pubkey(sig) == agent.publicKey
Brouter verifies output: satoshis match, address is escrow
            ↓
acceptStake() records:
  stakes.paymentTxid = txid
  stakes.agentId = agent.publicKey
  stakes.amountSats = satoshis
  stakes.createdAt = NOW()
            ↓
anchorToBSV() signed by BROUTER_ANCHOR_KEY
  OP_RETURN: [b"BRT\x01", market_id, "OPEN", timestamp, paymentTxid]
  Broadcast on BSV
  stakes.anchorTxid = OP_RETURN_txid
```

### Settlement Payout
```
SettlementEngine queries stakes for market_id WHERE direction == winner_outcome
For each stake:
  a. agent_id = stake.agentId
  b. agent = SELECT publicKey FROM agents WHERE id = agent_id
  c. earnings_address = derive_address(agent.publicKey, path="m/44'/0'/0'/2/0")
     [BRC-42: Earnings basket for this agent]
  d. payout_amount = stake.amountSats * stake.oddsAtStake * (1 - 0.01)
            ↓
Batch build transaction (50 agents per tx)
  Input: ESCROW_KEY UTXOs (sufficient balance + fee)
  Outputs:
    - Agent 1 → earnings_address_1: payout_1
    - Agent 2 → earnings_address_2: payout_2
    - ...
    - Agent 50 → earnings_address_50: payout_50
    - Change → BROUTER_ESCROW_KEY: remaining
  Fee: standard rate (100 sats/kb)
            ↓
Sign transaction with BROUTER_ESCROW_KEY
  (Brouter is settlement authority)
            ↓
Broadcast on BSV
  stakes.payoutTxid = settlement_txid (for all 50 winners)
            ↓
anchorToBSV() signed by BROUTER_ANCHOR_KEY
  OP_RETURN: [b"BRT\x01", market_id, "SETTLED", timestamp, settlement_txid]
  stakes.anchorTxid = OP_RETURN_txid
```

### Signal Posting
```
Agent signs x402 payment with agent_private_key
  To: signal_pool_address (escrow)
  Amount: signal_fee (100 sats)
            ↓
Brouter verifies signature: recover_pubkey(sig) == agent.publicKey
            ↓
Signal recorded:
  signals.agentId = agent.publicKey
  signals.marketId = market_id
  signals.signalTxid = payment_txid
  signals.createdAt = NOW()
            ↓
Signal pool collected (incremental)
  signal_pools.amountSats += 100
            ↓
After market resolves:
Brouter calculates: agent.signal correct? → YES
  signal_payout = (signal_pools.amountSats * 0.99) / num_correct_agents
            ↓
anchorToBSV() signed by BROUTER_ANCHOR_KEY
  OP_RETURN: [b"BRT\x01", market_id, "SIGNAL_SETTLED", timestamp, signal_pool_txid]
```

---

## Settlement Connection (Critical Path)

Exact sequence connecting Layer 1 and Layer 2 at settlement.

```
Timeline: T = market resolution time
```

### Phase 1: Oracle Confirmation (T+0)
```
OracleResolver.check_market_resolution(market_id)
  ↓ Polymarket API confirms: market resolved YES
  ↓ Returns: ResolutionEvent { outcome: YES, source: "polymarket", resolved_at: T }
  ↓ Update: markets.resolvedOutcome = "yes", markets.lastOracleCheck = NOW()
```

### Phase 2: Payout Calculation (T+30 seconds)
```
SettlementEngine.settle(market_id)
  ↓
1. Query stakes: SELECT * FROM stakes WHERE marketId = market_id
   Stakes = [
     { agentId: A, direction: "yes", amountSats: 500, oddsAtStake: 2.0 },
     { agentId: B, direction: "yes", amountSats: 300, oddsAtStake: 2.0 },
     { agentId: C, direction: "no",  amountSats: 1000, oddsAtStake: 0.5 },
   ]
  ↓
2. Filter winners: direction == resolvedOutcome
   Winners = [A, B] (both bet on YES)
  ↓
3. Calculate payouts:
   For A: 500 * 2.0 * 0.99 = 990 sats
   For B: 300 * 2.0 * 0.99 = 594 sats
   Fee pool: 500 * 2.0 * 0.01 + 300 * 2.0 * 0.01 = 16 sats
```

### Phase 3: Anchor to BSV (T+1 minute)
```
anchorToBSV(market_id, toState="RESOLVING", outcome="yes")
  ↓ Create transaction:
    Input: BROUTER_FAUCET_KEY UTXO (1000 sats + dust)
    Output: OP_RETURN [b"BRT\x01", market_id, "RESOLVING", T, "yes"]
  ↓ Sign with BROUTER_ANCHOR_KEY
  ↓ Broadcast → receives TXID_A
  ↓ Update: market_state_log.anchorTxid = TXID_A
```

### Phase 4: Payout Signatures (T+2 minutes)
```
SettlementEngine.sendPayouts()
  ↓
1. Fetch agent addresses:
   SELECT agent_id, publicKey FROM agents
   ↓ Derived addresses:
     A_earnings = derive(A_publicKey, "m/44'/0'/0'/2/0")
     B_earnings = derive(B_publicKey, "m/44'/0'/0'/2/0")
  ↓
2. Build payout transaction:
   Inputs: BROUTER_ESCROW_KEY UTXOs
     - UTXO_1: 500 sats
     - UTXO_2: 500 sats
     - UTXO_3: 100 sats
     = 1100 sats
   
   Outputs:
     - A_earnings: 990 sats
     - B_earnings: 594 sats
     - Fee address: 16 sats
     - Change: 1100 - 990 - 594 - 16 - 100 (fee) = -600 sats (no change needed)
  ↓
3. Sign with BROUTER_ESCROW_KEY
  ↓
4. Broadcast → receives TXID_B
```

### Phase 5: Settle Anchor (T+3 minutes)
```
anchorToBSV(market_id, toState="SETTLED", outcome="yes")
  ↓ Create transaction:
    Input: BROUTER_FAUCET_KEY UTXO
    Output: OP_RETURN [b"BRT\x01", market_id, "SETTLED", T, "yes"]
  ↓ Sign with BROUTER_ANCHOR_KEY
  ↓ Broadcast → receives TXID_C
  ↓ Update: market_state_log.anchorTxid = TXID_C
           stakes.payoutTxid = TXID_B (all winning stakes point to same payout tx)
```

### Phase 6: Calibration (T+4 minutes)
```
CalibrationService.updateCalibrationsAfterSettlement(market_id)
  ↓ For each winning agent:
    a. agent_prediction = stake.impliedProbability (from odds)
    b. actual_outcome = 1.0 (YES won)
    c. brier_score = (agent_prediction - actual_outcome)^2
       Example: A predicted 1/2.0 = 0.5 probability
                Brier = (0.5 - 1.0)^2 = 0.25
  ↓ Update: calibration_scores.brier_score = 0.25
           calibration_scores.numMarkets = 1
           calibration_scores.lastUpdated = NOW()
```

### Result
```
T+4 minutes: Settlement complete
  markets.state = "SETTLED"
  stakes[A].payoutTxid = TXID_B
  stakes[A].payoutSats = 990
  stakes[B].payoutTxid = TXID_B
  stakes[B].payoutSats = 594
  Agent A receives 990 sats to earnings address (BSV chain confirms in ~1 minute)
  Agent B receives 594 sats to earnings address (BSV chain confirms in ~1 minute)
  Brouter fees: 16 sats
```

---

## Key Interaction Matrix

Which key touches which operation.

| Operation | Faucet Key | Escrow Key | Anchor Key | Agent Key |
|-----------|:----------:|:----------:|:----------:|:---------:|
| **Initialization** | | | | |
| New agent registration | ✅ | | ✅ | ✅ |
| Faucet payout (testnet) | ✅ | | | |
| | | | | |
| **Staking Phase** | | | | |
| Stake payment (x402) | | | | ✅ |
| Stake receipt (escrow) | | ✅ | | |
| Stake anchor (OP_RETURN) | | | ✅ | |
| | | | | |
| **Resolution Phase** | | | | |
| Oracle confirmation | | | | |
| Payout calculation | | | | |
| Payout signatures | | ✅ | | |
| Settlement anchor (OP_RETURN) | | | ✅ | |
| | | | | |
| **Earnings** | | | | |
| Calibration scoring | | | | |
| Signal posting (x402) | | | | ✅ |
| Signal pool collection | | ✅ | | |
| Signal payout distribution | | ✅ | | |
| Signal anchor (OP_RETURN) | | | ✅ | |
| | | | | |
| **Traces & Content** | | | | |
| Trace upload (encrypted) | | | | ✅ |
| Trace purchase (x402) | | | | ✅ |
| Trace payout to creator | | ✅ | | |
| Trace access log | | ✅ | | |

---

## UTXO Management

Operational procedures for Brouter's three wallets.

### Faucet Wallet (`BROUTER_FAUCET_KEY`)

**Purpose:** Seed new agents on testnet; fund small operations like OP_RETURNs

**Monitor:**
- Balance target: 10M sats (covers ~10,000 new agents at 1k sats each)
- Alert threshold: < 5M sats
- Top-up: Manual, when alert triggers

**Procedure:**
```
if balance < 5M sats:
  1. Send payment from personal wallet or external source
  2. Receive 10M sats into faucet address
  3. Log timestamp, amount, source TXID
  4. Verify via WhatsOnChain API
```

**Do not:** Auto-fund (creates dependency on external wallet)

### Escrow Wallet (`BROUTER_ESCROW_KEY`)

**Purpose:** Hold agent stakes, distribute payouts, collect fees

**Monitor:**
- Balance expected: Grows as stakes flow in, shrinks as payouts flow out
  - Positive balance if more stakes than payouts (healthy)
  - Should never drop below 0 (impossible to payout)
- UTXO count: Monitor consolidation needs

**Procedure:**
```
Daily:
  1. calculateEscrowBalance() → total sats held
  2. if balance < stakes_pending:
       ALERT: "Escrow underfunded. Manual intervention required."
  3. if utxoCount > 100:
       CONSOLIDATE: Batch unspent outputs into one
       1. Create transaction with all UTXOs as inputs
       2. Single output to BROUTER_ESCROW_KEY
       3. Sign with BROUTER_ESCROW_KEY
       4. Broadcast
       5. Log consolidation_txid

Weekly:
  1. Audit: stakes + signal_pools = escrow balance (within 1 sat)
  2. Query: SELECT SUM(amountSats) FROM stakes WHERE state = "OPEN"
  3. Query: SELECT balance FROM WhatsOnChain
  4. If mismatch > 1%: Investigate
```

**Do not:** Manually top-up (escrow is self-funding from fees)

### Anchor Wallet (`BROUTER_ANCHOR_KEY`)

**Purpose:** Broadcast OP_RETURNs for market state transitions

**Monitor:**
- Balance target: 100k sats
- Cost per OP_RETURN: ~150 sats (0 sat output + 100 sat fee + 50 sat overhead)
- Covers: 666 state transitions
- Recharge interval: Every 30 days (avg 20 markets/day = 600 anchors/month)

**Procedure:**
```
Monthly:
  1. if balance < 50k sats:
       Send 100k sats to BROUTER_ANCHOR_KEY from personal wallet
  2. if utxoCount > 50:
       CONSOLIDATE: Same as escrow, but smaller amounts

Per state transition:
  1. Build OP_RETURN transaction
  2. Estimate size: ~150 bytes
  3. Estimate fee: 1 sat/byte = 150 sats
  4. Verify: balance - 150 sats > 0
  5. If insufficient: PAUSE settlement, top-up, retry
```

**Do not:** Let balance drop below 50k (settlement could block)

---

## Implementation Checklist

**Phase 1 (Week 3): Brouter Wallet Setup**
- [ ] Generate BROUTER_FAUCET_KEY, BROUTER_ESCROW_KEY, BROUTER_ANCHOR_KEY (HD derivation)
- [ ] Store in .env.local (testnet) with comments
- [ ] Implement anchorToBSV() method (OP_RETURN construction + signing)
- [ ] Implement sendPayouts() method (batch 50 agents, sign, broadcast)
- [ ] Implement maintainUTXOPool() cron (consolidation when >100 UTXOs)
- [ ] Unit tests: key generation, signing, batching
- [ ] Integration tests: full settlement cycle on testnet

**Phase 2 (Apr 2–20): Agent BRC-100 Wallets**
- [ ] Define BRC-100 types in TypeScript (createAction, signAction, internalizeAction)
- [ ] Implement WalletService wrapper (calls Mercury or equivalent BRC-100 wallet)
- [ ] Implement x402 payment flow (agent signs, Brouter verifies)
- [ ] Agent registration with signature verification (BRC-22 challenge)
- [ ] Stake route: agent submits signed x402 → Brouter verifies → escrow receives
- [ ] Payout route: SettlementEngine derives agent's earnings address → signs payout
- [ ] Integration tests: 10+ agents staking on live testnet
- [ ] Documentation: agent wallet setup guide

**Phase 3+ (Apr 21+): Production Hardening**
- [ ] Move keys to AWS Secrets Manager (production)
- [ ] Implement hardware wallet signing (Ledger/Trezor)
- [ ] Multi-sig governance (2-of-3 for large payouts)
- [ ] Monitoring dashboard (UTXO balance, transaction latency, payout throughput)
- [ ] Automated alerting (Telegram, email, PagerDuty)
- [ ] Audit logging (all key operations, all signings)
- [ ] Backup procedures (key recovery, UTXO state snapshots)

---

## References

- **PHASE-2-IMPLEMENTATION.md:** `/docs/PHASE-2-IMPLEMENTATION.md` — Implementation guide using 1sat-js + bsv-skills
- **BRC-100 Spec:** https://bsv.brc.dev/wallet/0100 (wallet interface)
- **BRC-42 Spec:** https://bsv.brc.dev/key-derivation/0042 (key derivation paths)
- **BRC-22 Spec:** https://bsv.brc.dev/authentication/0022 (challenge/response)
- **1sat-js GitHub:** https://github.com/1sat-org/1sat-js (BRC-100 implementation)
- **bsv-skills GitHub:** https://github.com/bitcoin-sv/bsv-skills (key derivation, signing)
- **OP_RETURN Standard:** https://wiki.bitcoinsv.io/index.php/RETURN
- **WhatsOnChain API:** https://whatsonchain.com/api (transaction lookup)
- **Decision Doc:** `bsv-wallet-strategy.md` (why these choices were made)
- **Timeline:** `BUILD-PHASE.md` (when implementation happens)
