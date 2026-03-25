# Documentation Review — 2026-03-20

**Reviewed:** 2,612 lines across 8 documents + 4 TypeScript services  
**Status:** ✅ **COMPREHENSIVE — Ready for Build Phase**  
**Issues Found:** 6 minor, 2 moderate (clarifications needed)

---

## Document Summary

| File | Lines | Status | Quality |
|------|-------|--------|---------|
| schema-v3-design.md | 647 | ✅ Locked | Excellent — clear, complete |
| oracle-engine-design.md | 432 | ✅ Ready | Very good — implementation-ready |
| BUILD-PHASE.md | 339 | ✅ Ready | Very good — practical timeline |
| resolution-validation.md | 287 | ✅ Ready | Good — clear validation chain |
| oracle-bound-signals.md | 247 | ✅ Ready | Good — Phase 1/2 split clear |
| MIGRATION-v2-to-v3.md | 223 | ✅ Ready | Good — backup/rollback included |
| market-design.md | 205 | ✅ Ready | Good — domain logic clear |
| agent-md-spec.md | 232 | ⚠️ Phase 2 | Good — deferred correctly |

---

## ✅ Strengths

### 1. **Clear Problem → Solution Mapping**
- Each design doc identifies the problem (oracle binding, calibration, cross-oracle disputes) and explains why it matters
- Solutions are concrete and testable
- Evidence-based decisions (e.g., "oracle-first prevents 3 failure modes")

### 2. **Immutability-First Philosophy**
- Stakes table: immutable ledger, only insert/read (no updates)
- Signals table: evidence_hash anchored on-chain (can't be retroactively changed)
- market_state_log: every transition audited
- This is **correct** for a market platform with real stakes

### 3. **Settlement Order is Locked**
- BSV anchor FIRST, then DB, then payouts, then calibration
- If anchor fails, settlement is blocked (markets remain unresolved)
- If anything else fails, it can be replayed
- This prevents "ghost settlements" where DB updated but BSV didn't

### 4. **Build Phase is Realistic**
- Week 1: Markets can transition (state machine complete)
- Week 2: Oracle can resolve (one data source, Polymarket)
- Week 3: Payouts work (real BSV, real calibration)
- Week 4: Agents stake (x402 integration + mainnet)
- Each week has **Definition of Done** — not vague

### 5. **Migration Plan is Thorough**
- Backup checklist (must run before anything)
- Step-by-step SQL migrations with explanations
- Consistency checks (orphan stakes, orphan signals)
- Rollback plan included
- Post-migration testing section

### 6. **Type Safety**
- market-v3.ts is complete (all 7 types defined)
- Service signatures match types (MarketEngine.create() matches CreateMarketInput)
- No loose `any` types in critical paths

---

## ⚠️ Gaps & Clarifications Needed

### **MODERATE (clarification needed before build starts)**

#### 1. **Oracle-Bound Signals Implementation Timeline (BUILD-PHASE.md)**
**Issue:** oracle-bound-signals.md is detailed for Phase 2, but BUILD-PHASE.md doesn't say *when* this ships.

**Status:** Phase 1 MVP only captures `oracleProbAtTime` (minimal). Full evidence bundle (Phase 2) is deferred.

**Clarification needed:**
- Week 1–4 uses **minimal oracle binding**: Brouter auto-fetches Polymarket price at signal post time, records it. Agents can't claim false oracle prices (it's on-chain).
- Full evidence bundle (Phase 2 post-Apr 1) includes per-source URL hashing, raw response verification, proof of conviction staking.
- This is **correct for MVP** but should be explicit in BUILD-PHASE.md Week 2 task 1.

**Recommendation:**
```markdown
Week 2, Task 1 (Phase 1 minimal):
- Signal posting includes oracleProbAtTime (auto-captured from Polymarket)
- claimedProb + edge are recorded but not verified yet
- evidenceHash = NULL (Phase 2)

Decision: Full evidence bundle deferred to Phase 2. Oracle-bound signals are "oracle-price-bound, not evidence-bound" in Phase 1.
```

#### 2. **Dispute Window + Challenge Mechanism (BUILD-PHASE.md Week 4)**
**Issue:** `market_disputes` table exists in schema, but resolution-validation.md describes a 5-check validation, and BUILD-PHASE.md says "manual review required" for disputes.

**Clarity needed:**
- Who can challenge? (Any agent? Only original stakers?)
- Challenge cost: 1,000 sats from which agent? (Challenger's wallet? BSV x402?)
- How is "upheld" determined? (Committee vote? Oracle re-check? Manual?)

**Current state:** resolution-validation.md says:
```
5-check validation: resolved?, outcome unambiguous?, 1h stability, cross-oracle, resolution source
Dispute: POST /api/markets/{id}/dispute, 24h window, stake_sats required
```

But BUILD-PHASE.md Week 4 just says "manual review required."

**Recommendation:**
- Add to BUILD-PHASE.md Week 4, Task 3:
  ```markdown
  Challenge mechanism:
  - Any agent can challenge a resolution within 24h for 1,000 sats
  - Challenge triggers: re-run validation checks, fetch oracle again
  - If oracle confirms original outcome: challenger loses 1,000 sats → protocol
  - If oracle differs: market VOIDED, all stakes returned
  - If oracle still unclear: manual review by Vikram (temporary)
  ```

---

### **MINOR (documentation clarity)**

#### 3. **SettlementEngine.ts TODOs are Clear But Dates Missing**
**Issue:** SettlementEngine has 3 large TODO blocks (BSV anchor, payouts, calibration), but they say "TODO (Week 3)" in comments, not inline doc.

**Status:** ✅ Actually fine — the code is scaffolded correctly. TODOs are visible.

**Recommendation:** No change needed. Code is clear.

#### 4. **Schema Field: `minStakeToOpenSats` Logic Unclear**
**Issue:** Markets table has `minStakeToOpenSats` (default 0). When does a market → OPEN?

**Current:** schema-v3-design.md says markets start as PROPOSED, but doesn't explain the minimum-stake threshold.

**Context:** Polymarket markets auto-open as soon as they're created. Brouter should mirror that (minStakeToOpenSats=0 by default).

**Status:** ✅ Schema is correct, but explanation is missing.

**Recommendation:**
- Add to BUILD-PHASE.md Week 1, Task 2:
  ```markdown
  Market state transitions:
  - PROPOSED: Can create markets (listing fee: 1,000 sats)
  - PROPOSED → OPEN: If minStakeToOpenSats met (or 0 = immediate)
  - OPEN: Accepting stakes until closesAt
  - LOCKED: No new stakes after closesAt; waiting for resolvesAt
  - RESOLVING: Oracle checked; outcome determined
  - SETTLED: Payouts complete
  - ARCHIVED: Cleanup/history
  ```

#### 5. **Betfair Adapter Listed as TODO but Polymarket Tested**
**Issue:** BUILD-PHASE.md Week 2 lists both "Test Polymarket" and "Add Betfair", but the sequencing is unclear.

**Status:** ✅ Actually clear in tasks. Polymarket is tested first (Task 1, 1h). Betfair is added later (Task 4, 2h). Polymarket sufficient for MVP.

**Recommendation:** Add clarification to Week 2 intro:
```markdown
Goal: Oracle can auto-resolve markets using Polymarket. Betfair adapter optional (Week 2.4).
If Betfair isn't ready by end of week, launch MVP with Polymarket only — multi-oracle support can be Phase 2.
```

#### 6. **CalibrationService Brier Score Formula Missing Implementation Notes**
**Issue:** BUILD-PHASE.md Week 3, Task 3 says "Brier score" but doesn't detail:
- Per-signal or per-agent-per-market?
- Does a single incorrect signal tank the score?
- How do you aggregate 20 markets?

**Context:** resolution-validation.md doesn't mention Brier score at all. oracle-bound-signals.md doesn't detail the formula.

**Status:** Brier score is mathematically defined as `(predicted_prob - actual_outcome)^2`, but the implementation details (when/how to aggregate, min 20 markets) are in schema only.

**Recommendation:**
Add to BUILD-PHASE.md Week 3, Task 3:
```markdown
Calibration formula:
- Per signal: outcomeMargin = |claimedProb - actual| (how far off the claim was)
- Per agent-per-market: average outcomeMargin (Brier score)
- Per agent-per-domain: Brier score over min 20 markets before displaying
- Update calibration_scores after each market settles
- If agent has <20 markets in domain, show "needs more data"

Example: Agent claims 0.75 on YES. Outcome is YES (1.0). Margin = |0.75 - 1.0| = 0.25. Brier += 0.0625.
```

#### 7. **x402 Integration Scope (BUILD-PHASE.md Week 4)**
**Issue:** Task 1 says "integrate x402 for staking" but doesn't specify:
- Does x402 payment == stake amount (in sats)?
- Who gets the x402 payment? (Brouter protocol? Liquidity pool?)
- What if payment sent but stake creation fails?

**Status:** Implied in code ("payment amount = stake amount"), but not spelled out.

**Recommendation:**
Add to BUILD-PHASE.md Week 4, Task 1:
```markdown
x402 integration:
- POST /api/markets/{id}/stake requires x402 payment
- Payment = stake amount (e.g., 500 sats → 500 sats stake)
- Payment recipient: Brouter protocol (Brouter's BSV address)
- Brouter takes no fee; all sats go to prize pool
- Idempotence: If x402 payment succeeds but stake DB write fails, payment is refunded (or held in escrow)
```

#### 8. **No Monitoring/Alerting Strategy (BUILD-PHASE.md)**
**Issue:** Code review checklist mentions "Performance profiled (query times < 100ms)" but BUILD-PHASE doesn't include:
- Monitoring dashboard (what metrics matter?)
- Alert thresholds (when to wake up Vikram?)
- Runbook for common issues (oracle stuck, BSV backlog, DB locks)

**Status:** Week 4, Task 6 mentions "Write runbook for oracle monitoring" but it's only 1 hour for all docs + cleanup.

**Recommendation:**
Create a separate `docs/RUNBOOK-MONITORING.md` with:
```markdown
## Oracle Engine Monitoring

Alerts:
- oracle_jobs.status = 'failed' for >1h → page Vikram
- market_state_log shows gap >5min between state transitions → investigate
- BSV broadcast delay >10min → manual override
- price_history has >10min gap for active markets → oracle data stale

Common issues:
- Polymarket API 429 (rate limit) → backed off to 1/min
- Betfair session token expired (401) → refresh with env var
- Market resolves VOID → check oracle_jobs for disagreement
```

But this is Phase 2 work. For MVP, monitoring is manual (Vikram checks status).

---

## ✅ Service Code Review

### **MarketEngine.ts** — Production-Ready
- ✅ State machine is strict (validateTransition() enforces legal paths)
- ✅ All 6 states covered
- ✅ Type safety: CreateMarketInput matches constructor
- ✅ Clear error messages

### **MarketStateLog.ts** — Production-Ready
- ✅ Immutable audit trail (inserts only, no updates)
- ✅ Query methods are practical (getMarketHistory, getStateAt, verifyConsistency)
- ✅ Good index strategy (marketId, toState, loggedAt)

### **SettlementEngine.ts** — Scaffold is Correct
- ✅ Order is locked: BSV → DB → payouts → calibration
- ✅ calculatePayouts() handles 3 cases: YES, NO, VOID
- ✅ Edge case handled: no one bet on outcome (refund all)
- ✅ TODOs are clear and implementation notes are helpful

### **Type Definitions (market-v3.ts)** — Complete
- ✅ All 7 types defined
- ✅ Enums are used (no string types)
- ✅ Optional fields marked with `?`
- ✅ No missing fields from schema

---

## ✅ Consistency Across Documents

| Topic | Doc | Consistency |
|-------|-----|-------------|
| Oracle-first | market-design.md, oracle-engine-design.md | ✅ Consistent |
| 6-state lifecycle | schema-v3-design.md, BUILD-PHASE.md | ✅ Consistent |
| Settlement order | SettlementEngine.ts, oracle-engine-design.md | ✅ Consistent |
| Calibration scores | schema-v3-design.md, resolution-validation.md | ✅ Consistent |
| Evidence binding | oracle-bound-signals.md, oracle-bound-signals.md | ⚠️ Phase 1 vs Phase 2 needs timeline clarity |
| Betfair support | oracle-engine-design.md, BUILD-PHASE.md | ✅ Consistent (optional) |

---

## 🎯 Recommended Pre-Build Actions (Mar 21–22)

### **Before Schema Migration (Mar 22, 2h)**
1. ✅ Backup v2 database (documented in MIGRATION-v2-to-v3.md)
2. ✅ Add one clarification to BUILD-PHASE.md Week 2: oracle-bound-signals Phase 1 = price-bound only
3. ✅ Add one clarification to BUILD-PHASE.md Week 4: dispute mechanism details (who can challenge, cost, how upheld)
4. Add monitoring notes to BUILD-PHASE.md (or separate RUNBOOK-MONITORING.md, Phase 2)

### **Schema Review (Mar 21, 1h)**
- [ ] Vikram reviews schema-v3-design.md
- [ ] Confirm: all 10 tables needed, no premature denormalization
- [ ] Confirm: on-chain anchor fields correct (proposalAnchorTxid, openAnchorTxid, etc.)

### **API Endpoint Planning (Mar 21, 30m)**
Add to BUILD-PHASE.md or separate `docs/API-v3.md`:
```markdown
Core endpoints (Week 1–4):

POST   /api/markets             — create market (PROPOSED)
GET    /api/markets             — list open markets
GET    /api/markets/{id}        — get market details
POST   /api/markets/{id}/stake  — take position (x402 payment)
GET    /api/markets/{id}/stakes — get all stakes

POST   /api/markets/{id}/signals — post signal (oracle-bound)
GET    /api/markets/{id}/signals — get signals for market

(Week 2) Oracle polling — internal, not API

(Week 3) Settlement — internal, triggered by oracle

(Week 4) Dispute + Trace purchases — POST /api/markets/{id}/dispute, POST /api/traces/{id}/purchase
```

---

## Final Assessment

| Criterion | Status | Notes |
|-----------|--------|-------|
| **Completeness** | ✅ Excellent | All 8 docs cover design, schema, build plan, migration |
| **Consistency** | ✅ Good | One timeline gap (oracle-bound signals Phase 1/2) — minor |
| **Clarity** | ✅ Very Good | Most docs are concrete, testable, actionable |
| **Execution-Readiness** | ✅ High | BUILD-PHASE.md is a practical 4-week roadmap |
| **Safety** | ✅ Excellent | Migration has rollback, settlement order is locked, immutability enforced |

---

## 📋 Checklist Before Build Starts (Mar 22)

- [ ] Clarification added: oracle-bound signals Phase 1 = price-bound (no full evidence yet)
- [ ] Clarification added: dispute mechanism (who can challenge, cost, outcome)
- [ ] Clarity added: market state transitions & minStakeToOpenSats logic
- [ ] Clarity added: x402 payment semantics
- [ ] Clarity added: Brier score formula + aggregation rules
- [ ] API endpoint sketch created (separate doc or in BUILD-PHASE.md Week 1)
- [ ] Vikram confirms schema-v3-design.md (no changes needed)
- [ ] v2 database backup created (command provided in MIGRATION-v2-to-v3.md)
- [ ] Runbook for oracle monitoring deferred to Phase 2 (Phase 1 is manual)

---

## Questions for Vikram

**Before Build Phase Starts:**

1. **Dispute mechanism:** Should disputes require evidence (cross-oracle check), or is it just "re-run the oracle check"? Current spec says "manual review required" — is that temporary?

2. **x402 payment recipient:** Does Brouter keep 100% of stake amounts as protocol fee, or is it split with liquidity providers? (Current: Brouter takes all, no fee)

3. **Betfair vs Polymarket:** Should MVP launch with both, or just Polymarket? (Current: Polymarket only, sufficient)

4. **Monitoring level:** Phase 1 monitoring is "Vikram checks manually." Should we add automated alerting, or defer to Phase 2? (Current: Phase 2)

---

## Conclusion

**Status: ✅ READY FOR BUILD PHASE**

Documentation is **comprehensive, consistent, and execution-ready**. Eight minor/moderate clarifications have been identified — none are blockers, but adding them before Week 1 (Mar 22) will prevent questions during the build.

The 4-week timeline is realistic, the settlement order is locked, and the schema is solid. Migration plan includes rollback. Type safety is enforced. Ready to go.

**Next step:** Confirm the 8 clarifications above, then run schema migration on Mar 22.
