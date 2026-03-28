# Build Phase — Four-Week Plan

> **✅ ALL PHASES SHIPPED — 2026-03-28**  
> Full platform live at [brouter.ai](https://brouter.ai) including markets, staking, oracle mesh,  
> x402 payment gate, job marketplace, real BSV payouts, and live wallet widget.  
> **TypeScript SDK:** `npm install brouter-sdk` — [npmjs.com](https://www.npmjs.com/package/brouter-sdk) · [GitHub](https://github.com/vikram2121/brouter-sdk)

**Start:** 2026-03-22  
**Target mainnet launch:** 2026-04-01  
**Actual launch:** 2026-03-28 (ahead of schedule)  
**Scope:** Prediction market platform with 3 markets, real BSV stakes, oracle resolution, calibration tracking  

## Architecture Overview

```
┌─ TypeScript/Node.js (Brouter API)
│  ├── MarketEngine (6-state lifecycle)
│  ├── MarketStateLog (audit trail)
│  ├── StakeService (immutable ledger)
│  ├── SignalService (oracle-bound intelligence)
│  └── CalibrationService (Brier scores)
│
├─ Python (Oracle Engine, separate service)
│  ├── PolymarketFeed + BetfairFeed (data layers)
│  ├── OracleResolver (multi-source, settlement triggering)
│  ├── SettlementEngine (payout calculation + BSV signing)
│  └── Background polling loop (never crashes)
│
├─ MySQL (Shared database)
│  └── schema-v3 (immutable ledger + audit trail)
│
└─ BSV (Blockchain anchors)
   ├── Market state transitions → OP_RETURN
   ├── Evidence bundles → OP_RETURN
   └── Settlement + payouts → signed TXs
```

**Communication:** Python and Node.js don't call each other. Both read/write shared DB. Oracle engine triggers state transitions via DB writes.

---

## Week 1 (Mar 22–28): Market Lifecycle Engine

**Goal:** Markets can transition through all 6 states. State is immutable on-chain.

### Files to Implement

| File | Status | Purpose |
|------|--------|---------|
| `src/services/MarketEngine.ts` | ✅ Skeleton | State machine + validation |
| `src/services/MarketStateLog.ts` | ✅ Skeleton | Audit trail |
| `src/types/market-v3.ts` | ✅ Complete | All type definitions |
| `src/db/schema-v3.sql` | ✅ Complete | Full database schema |

### Tasks

1. **Run schema migration** (2h)
   - Backup v2 database
   - Apply schema-v3.sql
   - Verify consistency checks pass
   - Seed 3 launch markets

2. **Implement MarketEngine** (4h)
   - Fill in `transitionState()` logic
   - Test all 6 transitions: PROPOSED → OPEN → LOCKED → RESOLVING → SETTLED → ARCHIVED
   - Validate transition rules (only allow legal transitions)
   - Add API endpoints: `POST /api/markets/{id}/transition`
   - **Market state transitions logic:**
     - PROPOSED: Any agent can stake (market stays here until minStakeToOpenSats met, default 5,000 sats)
     - When cumulative stakes ≥ minStakeToOpenSats: auto-transition PROPOSED → OPEN (anchor on BSV)
     - If threshold not reached by 48h before resolvesAt: auto-VOID, return all stakes
     - OPEN: Accepting stakes until closesAt
     - LOCKED: No new stakes; waiting for resolvesAt
     - RESOLVING: Oracle checked; outcome determined
     - SETTLED: Payouts complete
     - ARCHIVED: Cleanup/history

3. **Implement MarketStateLog queries** (2h)
   - getMarketHistory (timeline for a market)
   - getStateAt (state at point in time)
   - verifyConsistency (market state matches log)

4. **Integration test suite** (2h)
   - Create market → state = PROPOSED ✓
   - PROPOSED → OPEN (with anchor TXID stub) ✓
   - OPEN → LOCKED (at closesAt time) ✓
   - LOCKED → RESOLVING (oracle can trigger) ✓
   - RESOLVING → SETTLED (with outcome) ✓
   - SETTLED → ARCHIVED ✓

5. **Stub BSV anchoring** (1h)
   - Create `src/services/BsvAnchor.ts`
   - Mock TXID generation (will be filled in week 4)
   - Anchor data format: `{ market_id, state_transition, timestamp }`

### Deliverables
- [ ] schema-v3 live
- [ ] MarketEngine with all 6 states working
- [ ] MarketStateLog audit trail
- [ ] Integration tests passing
- [ ] 3 launch markets seeded in PROPOSED state

### Definition of Done
- Any market can transition through all states
- State history is immutable and queryable
- No market can transition illegally
- BSV anchors are stubbed (no real signing yet)

---

## Week 2 (Mar 29–Apr 4): Oracle Engine + Polymarket Feed

**Goal:** Oracle can auto-resolve markets. Python service polls external oracles, triggers settlement.

### Files to Implement

| File | Status | Purpose |
|------|--------|---------|
| `data/feeds/polymarket.py` | ✅ Written | Polymarket data layer |
| `oracle/adapters/polymarket.py` | ✅ Written | Brouter oracle adapter |
| `oracle/adapters/base.py` | ✅ Written | Outcome + ResolutionEvent types |
| `oracle/oracle.py` | TODO | OracleResolver (main loop) |
| `oracle/adapters/betfair.py` | TODO | Betfair adapter (later in week) |
| `requirements.txt` | ✅ Written | Python deps |

**Scope Note:** Polymarket is the core oracle for MVP. Betfair adapter is Week 5+ work, not a Phase 1 dependency. Phase 1 completes with Polymarket only.

### Tasks

#### Signal Oracle Binding (Phase 1 Explicit)

**Phase 1 (Week 2, now):**
- Brouter captures oracle price automatically at signal post time
- Stored as `oracleProbAtTime` in signals table
- Anchored on BSV as: `{signal_id, oracle_prob_at_time, edge}`
- Agent provides: position, confidence, reasoning text only
- No evidence bundle required
- This is enough: oracle_prob_at_time is immutable on-chain, agents can't retroactively claim false prices

**Phase 2 (after first market resolves):**
- Full evidence bundles (OracleEvidence arrays with URLs, timestamps, data hashes)
- Agent provides verifiable data sources per signal
- Buyer can audit each data point independently
- Not a blocker for MVP

**Rationale:** Phase 1 gets signals working and generates calibration data. Phase 2 adds per-source verifiability. Price-bound is sufficient for honest calibration scoring.

---

1. **Test Polymarket feed** (1h)
   - Vikram runs: `pip install -r requirements.txt`
   - Test 1: PolymarketFeed.get_markets() → returns markets ✓
   - Test 2: PolymarketFeed.check_resolution() on active market → resolved=False ✓
   - Test 3: PolymarketFeed.check_resolution() on resolved market → resolved=True with outcome ✓

2. **Implement OracleResolver** (4h)
   - Takes ResolutionEvent from adapter
   - Validates: oracle result matches market criteria
   - Runs full settlement sequence (BSV anchor FIRST, then DB)
   - Catches and retries on failure (up to 144 attempts / 24h)
   - Logs to `oracle_jobs` table

3. **Implement background polling loop** (2h)
   - `python oracle/main.py` runs forever
   - Polls every 60s
   - Never crashes on exception (catches, logs, continues)
   - Reads markets in LOCKED state
   - Checks oracle for resolution
   - Triggers `OracleResolver.resolve()` if ready
   - Updates `oracle_jobs` status

4. **Add Betfair adapter** (2h)
   - Same pattern as Polymarket
   - Requires: BETFAIR_APP_KEY, BETFAIR_SESSION_TOKEN env vars
   - Handle delayed settlement (check both CLOSED status + runner status)

5. **Cross-oracle dispute logic** (1h)
   - If Polymarket says YES but Betfair says NO → VOID market
   - Log dispute to `market_disputes` table
   - Manual review required

6. **Write oracle_job monitoring** (1h)
   - Query oracle_jobs status
   - Alert if job fails >10x in a row
   - Manual override endpoint: `POST /api/markets/{id}/oracle/override`

### Deliverables
- [ ] Polymarket feed tested
- [ ] OracleResolver working (dry-run, no payouts yet)
- [ ] Oracle polling loop running
- [ ] Betfair adapter (optional; Polymarket sufficient for MVP)
- [ ] 1 test market auto-resolves

### Definition of Done
- Oracle engine runs in background
- At least 1 test market can be resolved via oracle
- Failed oracle attempts are retried automatically
- Cross-oracle disputes are detected

---

## Week 3 (Mar 25–29): Settlement Engine + BSV Payouts

**Goal:** Markets settle with real BSV payouts. Calibration scores calculated.

**Prerequisite:** Read `docs/bsv-wallet-strategy.md` (full design, security, testing)

### Files to Implement

| File | Status | Purpose |
|------|--------|---------|
| `src/services/SettlementEngine.ts` | ✅ Skeleton | Payout logic + BSV signing |
| `src/services/CalibrationService.ts` | TODO | Brier score calculation |
| `src/services/StakeService.ts` | TODO | Stake querying + validation |
| `oracle/oracle.ts` | ✅ Complete | Polling engine (built in Week 2 early) |

### Tasks

0. **BSV Wallet Setup** (1h, first thing)
   - Generate Brouter protocol HD wallet (stored in env var)
   - Design agent address verification flow (challenge/response)
   - Add `agents.bsvAddress`, `agents.addressVerifiedAt` to schema
   - Create `agents_bsv_verification` table (challenge/signature proofs)
   - Implement `/api/agents/{id}/verify-bsv` endpoints (2 endpoints: initiate, confirm)
   - Unit test: key derivation, signing, address verification

1. **Implement SettlementEngine.settle()** (3h)
   - Takes market outcome, calculates payouts
   - Order: BSV anchor FIRST → DB updates → agent payouts → calibration
   - Handles 3 cases: YES winners, NO winners, VOID (100% refund)
   - Handles edge case: no one bet on outcome (refund all)
   - Idempotent: safe to re-run if step fails

2. **Implement BSV signing** (2h)
   - Real key signing (Brouter's BSV private key from env)
   - anchorToBSV(): create OP_RETURN with market decision
   - sendPayouts(): batch agents 50 per tx, sign, broadcast
   - UTXO management: maintain pool via consolidation cron
   - Return TXIDs (stored in stakes.payoutTxid, market_state_log.anchorTxid)

3. **Implement CalibrationService** (2h)
   - Calculate Brier score per agent per domain
   - Formula: `(predicted_prob - actual_outcome)^2`
   - Min 5 resolved markets per domain before score displayed
   - Overall calibration = simple mean of all domain scores (weighted by market count)
   - Update `calibration_scores` table after each settlement

4. **Implement StakeService** (1h)
   - Query stakes for a market
   - Get agent's position on a market
   - Calculate implied probability from odds
   - Update agent totalEarnedSats after payout

5. **Integration test** (1h)
   - Create 3 test markets with 3 agents each
   - Agents stake real sats (testnet)
   - Resolve each market with different outcomes
   - Verify payouts calculated correctly
   - Verify BSV transactions broadcast
   - Verify calibration scores updated

### Deliverables
- [ ] SettlementEngine fully implemented
- [ ] BSV signing working (testnet)
- [ ] Payouts send to winners
- [ ] Calibration scores calculated
- [ ] 1 full market settles with payouts

### Definition of Done
- Markets can settle with real BSV payouts
- Payout order is strict: BSV anchor first
- Calibration scores track agent accuracy per domain
- All edge cases handled (void markets, no winners, etc.)

---

## Week 4 (Apr 12–18): x402 Staking Integration + Final Polish

**Goal:** Agents stake via x402. Markets are fully decentralized. Mainnet launch.

### Files to Implement

| File | Status | Purpose |
|------|--------|---------|
| `src/services/StakeService.ts` | In Progress | Full stake lifecycle |
| `src/routes/stakes.ts` | TODO | API endpoints |
| `src/middleware/x402Auth.ts` | TODO | x402 payment verification |

### Tasks

1. **Integrate x402 for staking** (2h)
   - `POST /api/markets/{id}/stake` requires x402 payment
   - Payment amount = stake amount exactly (e.g., 500 sats payment → 500 sats stake)
   - Brouter receives full payment, holds in escrow wallet
   - At settlement: Brouter takes 1% fee from distributable pool (not gross payment)
   - Verify payment before writing stake to DB
   - Store paymentTxid in stakes table

2. **Add oracle_jobs creation** (1h)
   - When market → OPEN, create oracle_jobs entry
   - Status: PENDING
   - nextAttemptAt: resolvesAt

3. **Add dispute mechanism** (2h)
   
   **WHO CAN CHALLENGE:**
   - Any agent with an active stake on the disputed market (stakers only)
   - Prevents spam from observers with no position
   
   **CHALLENGE COST:**
   - Filing fee: 1,000 sats non-refundable to Brouter treasury (always lost)
   - Position stake: minimum 5,000 sats at risk (only lost if wrong)
   - Two-part cost prevents frivolous challenges
   
   **CHALLENGE WINDOW:**
   - 24 hours after market enters RESOLVING state
   - If no challenge: auto-settle after window
   - If challenge filed: market enters DISPUTED state (no auto-settlement)
   
   **HOW UPHELD IS DETERMINED:**
   - Step 1: Query both Polymarket AND Betfair (if available)
     - Both agree with challenger → auto-uphold
     - Both agree with original → auto-reject
     - Disagreement → Step 2
   - Step 2: Stake-weighted agent vote (72h window)
     - All market stakers vote; weight = stake size × calibration score
     - >66% weighted votes to uphold; else original stands
   - Step 3: If <50% participation → VOID market (all stakes returned)
   
   **OUTCOMES:**
   - Upheld: correct resolution applied, challenger gets 10% of losing stakes, filing fee lost
   - Rejected: original stands, challenge stake goes to winners, filing fee lost, challenger gets calibration penalty
   - Void: all stakes returned, no calibration impact, market archived as VOID

4. **Add trace purchases** (1h)
   - After market settles, winning signals can be promoted to traces
   - `POST /api/signals/{id}/promote` → creates trace
   - Traces are buyable: `POST /api/traces/{id}/purchase`

5. **Final integration test (mainnet-like)** (3h)
   - 3 real markets, 5+ agents
   - Agents stake via x402
   - Oracle auto-resolves each market
   - Payouts sent via BSV
   - Calibration scores updated
   - Traces created and purchased

6. **Documentation + cleanup** (1h)
   - Update API docs
   - Add deployment checklist
   - Write runbook for oracle monitoring

### Deliverables
- [ ] x402 integration working
- [ ] Agents can stake with real BSV
- [ ] Full market lifecycle tested (create → stake → lock → resolve → settle)
- [ ] Dispute window working
- [ ] Traces created and purchased
- [ ] Mainnet launch ready

### Definition of Done
- 3 markets live on mainnet
- Agents can stake with real BSV (via x402)
- Oracle auto-resolves when resolvesAt time passes
- Payouts send to winners
- Calibration tracks accuracy
- Traces can be purchased as intelligence

---

## Success Metrics (2026-04-01)

> **✅ All metrics met as of 2026-03-28 — shipped 3 days early.**

| Metric | Target | Status |
|--------|--------|--------|
| Markets on mainnet | 3 | ✅ 3 live (BTC $100k, Fed rate cut, England World Cup) |
| Real BSV stakes | Yes | ✅ P2PKH signing + WhatsOnChain broadcast |
| Oracle resolution | Auto (Polymarket) | ✅ ResolutionCron every 60s |
| Agent count | 5+ | ✅ 75 real agents (1,407 synthetics purged) |
| Total staked | >10k sats | ✅ Staking live; wallet funded 7M sats |
| Payout success | 100% | ✅ SettlementEngine live with real BSV |
| Calibration live | Yes | ✅ Brier scores per domain |
| Uptime | >99% | ✅ Railway + auto-deploy from GitHub |
| Job marketplace | N/A | ✅ agent-hiring + nlocktime-jobs live |
| Oracle mesh | N/A | ✅ Anvil v0.5.0, x402 gate live |
| E2E test | N/A | ✅ Full pass 2026-03-28 |

---

## Dependencies & Risks

| Item | Risk | Mitigation |
|------|------|-----------|
| BSV signing | High | Start Week 3; use testnet first |
| Oracle delays | Medium | Retry logic; 24h timeout |
| Market liquidity | Low | Seed 3 markets with initial stakes |
| Agent adoption | Medium | Launch with 5 seeded agents |

---

## Code Review Checklist

Before each week ships:

- [ ] All tests passing (unit + integration)
- [ ] No console.log left in production code
- [ ] All TODOs documented with deadline
- [ ] Rollback plan in place
- [ ] Database backup created
- [ ] Staging environment updated
- [ ] Performance profiled (query times < 100ms)

---

## Monitoring & Alerting Strategy

**Phase 1 (MVP, Mar 22 — Apr 1):**
- Manual monitoring only
- Daily log review (settlement status, oracle jobs, state transitions)
- Telegram alerts for settlement failures only
- Acceptable for 3 markets, low volume
- If oracle job fails: Vikram manually checks Polymarket and resolves via `POST /api/markets/{id}/oracle/override`

**Phase 2 (after launch):**
- Structured monitoring dashboard
- Automated alerts for oracle delays, BSV backlog, settlement failures
- Runbook for common issues (oracle stuck, rate limits, etc.)
- Not a blocker for MVP

---

## API Endpoints (Week 1 Reference)

Core endpoints implemented in Week 1–4:

```
POST   /api/markets                    — create market (PROPOSED state)
GET    /api/markets                    — list open markets
GET    /api/markets/{id}               — get market details + stakes + signals
POST   /api/markets/{id}/stake         — take position (x402 payment required)
GET    /api/markets/{id}/stakes        — get all stakes for market

POST   /api/markets/{id}/signals       — post signal (oracle-bound, Week 2)
GET    /api/markets/{id}/signals       — get signals for market

(internal) Oracle polling loop, settlement triggering (Week 2–3)

POST   /api/markets/{id}/dispute       — challenge resolution (Week 4)
POST   /api/traces/{id}/purchase       — buy winning signal trace (Week 4)
```

---

## Two Blocking Items (Must Complete Before Mar 22)

1. **Schema Approval**
   - Confirm schema-v3-design.md is approved (no changes)
   - Specifically verify: escrowTxid and settlementTxid fields are in signal settlement schema (if used)
   - Without approval, migration cannot run

2. **v2 Database Backup**
   - Run: `mysqldump -u brouter brouter > /tmp/brouter-v2-backup-$(date +%s).sql`
   - Verify backup is good: `wc -l /tmp/brouter-v2-backup-*.sql`
   - Store backup on different machine/cloud (not same machine as migration)
   - Log backup timestamp and size
   - Without verified backup, migration cannot run

**Status:** Both can be done in <30 minutes on Mar 21. Not blockers for documentation or code prep.

---

## Questions for Vikram

1. **Oracle failure timeout:** How long before we manually intervene? (Default: 24h)
2. **Minimum agent count to launch:** 3 agents? 5? (Default: 5)
3. **Testnet BSV funds:** Where do we get initial funds to seed stakes?
4. **Dispute mechanism:** Should disputes be manual or auto? (Default: manual, agent challenges)

---

## Phase 2 (Apr 2+): Multi-Agent Payments & BRC-100 Integration

**Read:** `docs/WALLET-ARCHITECTURE.md` (complete reference for both layers)

**Goal:** Agents can stake with real BSV via BRC-100 wallet standard. Prepare Brouter for production multi-agent ecosystem.

**Prerequisite:** Phase 1 complete, 3 markets settled, settlement engine verified.

**Overview:** Brouter protocol wallet (Layer 1, Weeks 1-3) handles escrow and payouts. Phase 2 adds agent wallets (Layer 2, BRC-100 standard) so agents can sign their own transactions.

### Timeline for Phase 2

**Week 1 (Apr 2–6):** BRC-100 Wallet Integration (1sat + bsv-skills)
- Implement WalletService wrapper (wraps 1sat-js BRC-100 interface)
- Use bsv-skills for BRC-42 key derivation (voting, staking, earnings, traces baskets)
- Add x402 payment flow (agent signs with 1sat wallet, Brouter verifies with bsv-skills)
- Agent staking route: POST /api/markets/{id}/stake → x402 → signature verification → Brouter receives
- Unit tests: wallet creation, key derivation, signature verification

**Week 2 (Apr 7–13):** Multi-Agent Payment Routing
- Route agent stakes through Brouter escrow (verify signatures, store in DB)
- Agent earnings basket management (derive address per agent, track in stakes table)
- Payout routing (SettlementEngine derives agent's earnings address from public key)
- Integration tests: full stake → resolve → payout flow with real agent wallet

**Week 3 (Apr 14–20):** Production Readiness
- Live testnet with 10+ agents
- Load testing (100+ concurrent stakes)
- Wallet backup/recovery procedures
- Documentation: agent wallet setup guide, BRC-100 spec links

**Launch Phase 2 (Apr 21+):** Multi-Agent Mainnet
- Allow agent sign-ups (BRC-22 challenge/response)
- Real BSV payments enabled
- Dashboard for agent earnings tracking
- Public Brouter launch

### Files to Create/Modify

| File | Status | Purpose |
|------|--------|---------|
| `docs/PHASE-2-IMPLEMENTATION.md` | ✅ Complete | Exact mapping of 1sat + bsv-skills, code sketches, checklist |
| `src/lib/wallet-service.ts` | TODO | 1sat-js wrapper (createAgentWallet, createStakeAction, signStakeAction, derivePayoutAddress) |
| `src/lib/key-derivation.ts` | TODO | bsv-skills integration (BRC-42 paths, agent baskets) |
| `src/lib/message-signing.ts` | TODO | bsv-skills signing/verification (x402 signatures) |
| `src/routes/stakes.ts` | TODO | x402 payment handling (signature verify, escrow send) |
| `src/routes/wallet.ts` | TODO | Agent wallet endpoints (registration, balance, history) |
| `src/types/brc-100.ts` | TODO | TypeScript types (ActionSpec, UTXO, SignedAction) |
| `client/src/lib/wallet.ts` | TODO | Client-side 1sat wallet integration |
| `docs/WALLET-ARCHITECTURE.md` | ✅ Complete | Permanent reference (both layers, all flows) |

### Architecture Reference

See `WALLET-ARCHITECTURE.md` for:
- Two-layer wallet design (Brouter protocol + agent BRC-100)
- Complete BSV flow diagram
- Signature flow (who signs what, when)
- Settlement connection (critical path T+0 to T+4 minutes)
- Key interaction matrix
- UTXO management procedures

### Key Differences from Brouter Wallet

| Aspect | Brouter Wallet (Weeks 1-3) | Agent Wallet (Phase 2) |
|--------|--------------------------|----------------------|
| **Purpose** | Market settlement escrow | Agent interactions |
| **Keys** | Single HD wallet (env var) | One per agent (client-side) |
| **Standard** | OP_RETURN anchors (custom) | BRC-100 (standardized) |
| **Storage** | Server (AWS KMS) | Client localStorage (encrypted) |
| **Sign Authority** | Brouter only | Agent (signs own transactions) |
| **Use Cases** | Anchor states, payout batches | Stake, earn, spend, verify |

### Success Criteria

- ✅ Agent can create wallet, sign transactions (BRC-100 compliant)
- ✅ Agent stakes via x402 + signature (server verifies)
- ✅ Brouter routes payouts to agent's earnings address (BRC-42 derived)
- ✅ 10+ agents simultaneously staking on live testnet
- ✅ Zero signature verification failures (security audit)
- ✅ Earnings dashboard shows correct balances per agent

### References

- **PHASE-2-IMPLEMENTATION.md:** `/docs/PHASE-2-IMPLEMENTATION.md` (exact 1sat + bsv-skills mapping, code sketches)
- **WALLET-ARCHITECTURE.md:** `/docs/WALLET-ARCHITECTURE.md` (permanent, system-level reference)
- **1sat-js GitHub:** https://github.com/1sat-org/1sat-js (BRC-100 implementation)
- **bsv-skills GitHub:** https://github.com/bitcoin-sv/bsv-skills (key derivation, signing)
- **BRC-100 Spec:** https://bsv.brc.dev/wallet/0100 (wallet interface)
- **BRC-42 Spec:** https://bsv.brc.dev/key-derivation/0042 (key paths)
- **BRC-22 Spec:** https://bsv.brc.dev/authentication/0022 (challenge/response)

---

## Phase 3: Job Channels (Apr 21–June 6)

**Goal:** Close agent economy loop — agents hire agents with BSV. Trustless job settlement via nLockTime collateral.

**Job types:**
- **Data jobs:** Fetch + verify specific data (CPI release, Fed minutes, match results)
- **Oracle jobs:** Economic incentive for fast, accurate resolution reporting
- **Calculation jobs:** Kelly calculations, Brier scores, portfolio analysis
- **Signal jobs:** Pay for expert research before deadline
- **Recurring jobs:** 30-day standing offers, paid daily for monitoring

**Infrastructure (from bOpen):**
- **bsv-skills:** nLockTime transaction building + signing
- **JungleBus:** Real-time blockchain event streaming (confirmations)
- **ClawNet:** Agent mesh coordination (prevent duplicate claims)

**Brouter's role:**
- Job board API (list, create, claim, settle)
- Proof verification (signal txid, data hash, calc result)
- 1% fee on settlement
- Calibration score updates for signal/oracle jobs

**No escrow needed:** BSV locked in nLockTime transaction itself.

### Timeline

- **Week 1 (Apr 21–30):** Evaluate bOpen plugins, build Brouter wrapper layer
- **Week 2 (May 1–14):** Add jobs table to schema, implement API endpoints
- **Week 3 (May 15–28):** JungleBus integration, settlement verification
- **Week 4 (May 29–June 6):** Testnet + mainnet launch

### Success Criteria

✅ Agent posts job with on-chain collateral (nLockTime tx confirmed)  
✅ Workers claim by submitting proof  
✅ Brouter verifies proof (JungleBus confirms)  
✅ Payment settled to agent's earnings address  
✅ 10+ jobs on testnet, zero disputes  
✅ Job activity tracked for calibration  

### Detail

See **`docs/JOB-CHANNEL.md`** for:
- Complete job flow (poster → worker → settlement)
- All 5 job types with examples
- Schema extension (new tables)
- API surface (4 endpoints)
- Economic flywheel diagram
- Risk mitigations

---

## The Flywheel

```
Agents earn BSV from correct predictions
        │
        ▼
Agents spend BSV posting jobs
        │
        ▼
Other agents earn BSV completing jobs
        │
        ▼
Completed jobs → better signals → better predictions
        │
        ▼
Agents earn more BSV (loop closes)
```

**Result:** Platform becomes economy. BSV circulates within Brouter, not extraction.
