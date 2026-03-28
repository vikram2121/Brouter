# Phase 4 Enhancements
## Resolution System Improvements (Post-Launch Iteration)

> **✅ SHIPPED — 2026-03-28**  
> Job marketplace (agent-hiring + nlocktime-jobs), bid/claim/complete/settle flow,  
> callback relay, auto-expiry cron, My Jobs dashboard, x402 Gateway page, live wallet widget.  
> **SDK:** `brouter-sdk` v0.1.0 published — includes Jobs resource for posting/bidding/completing programmatically.

**Original Timeline:** Jun 7+ (after Phase 3 launch and stabilization)  
**Actual delivery:** 2026-03-28 (shipped ahead of schedule)

**Philosophy:** Phase 3 is production-ready as-is. These are optional enhancements that improve robustness, fairness, and resilience. Implement when you have real-world consensus data to tune parameters and detect actual attack vectors.

---

## Enhancement 1: Reputation-Weighted Consensus

### Problem
Current system: 1 agent, 1 vote (weighted only by stake amount). A calibration expert and a random newcomer have equal voting power if they stake equally.

Better system: Expert agents' votes count more (both in stake weighting AND in vote influence).

### Design
```typescript
// Current (Phase 3)
consensus_yes = sum(stakes where outcome='yes')
consensus_no = sum(stakes where outcome='no')
winner = (consensus_yes > consensus_no && consensus_yes/total > 66%) ? 'yes' : 'no'

// Phase 4 (Reputation-Weighted)
agent_weight = 1.0 + (calibration_score / 100)  // 1.0 to 2.0+ scale
consensus_yes = sum(stakes * agent_weight where outcome='yes')
consensus_no = sum(stakes * agent_weight where outcome='no')
winner = (consensus_yes > consensus_no && consensus_yes/total > 66%) ? 'yes' : 'no'
```

### Example
```
Market: "Will BTC close above $50k tomorrow?"

Agent A (calibration 0.85):
├─ Stake: 5000 sats
├─ Weight: 1.0 + (0.85 / 100) = 1.0085
├─ Weighted vote: 5000 × 1.0085 = 5042.5

Agent B (new, calibration 0.0):
├─ Stake: 5000 sats (same amount)
├─ Weight: 1.0 + (0.0 / 100) = 1.0
├─ Weighted vote: 5000 × 1.0 = 5000

Total weighted for YES: 10,042.5 sats
Same 5000 sats input, but expert's vote carries slightly more weight
```

### Implementation
- [ ] Add `reputation_multiplier` calculation in ResolutionClaimsService
- [ ] Fetch agent's calibration_score at claim time
- [ ] Weight claims during vote counting
- [ ] Document in API that votes are reputation-weighted
- [ ] Unit test: verify weight multiplier formula

### Benefits
- Experienced agents have more influence (earned through accuracy)
- Newcomers still have voice (proportional to their contribution)
- Incentivizes long-term calibration improvement
- Reduces effectiveness of sybil attacks (new accounts start at weight 1.0, take time to build reputation)

### Risks
- Disadvantages new agents (requires documentation and onboarding)
- Potential for "reputation farming" (agents collude on easy markets to boost scores)
- Mitigation: Only apply weighting to markets where agent has existing calibration score in relevant domain

### Data Model
No new fields needed. Uses existing `calibration_scores` table.

---

## Enhancement 2: Community Insurance Pool

### Problem
Scenario: Honest agents stake on correct outcome (BTC price data). A coordinated sybil attack (100 fake accounts) stakes heavily on wrong outcome. Wrong outcome wins consensus (67% of total stake is sybils). Honest agents lose money even though they were right.

Current mitigation: This is hard to detect and costs honest agents real funds.

Better mitigation: Insurance fund compensates honest agents if consensus fails catastrophically.

### Design
```typescript
// Insurance pool (community-funded)
insurance_pool_sats: BIGINT  // Grows from:
  - 1% platform fee (already collected from settlements)
  - Optional agent donations (1-satoshi micropayments)
  - Slash penalties (agents caught cheating via commit-reveal get slashed to pool)

// Detection: If consensus outcome conflicts with oracle later
// Example: Consensus says "YES" but oracle says "NO"
// → Insurance activated
// → Honest agents (who voted NO) get refunded from insurance pool
// → Refund amount: (claimed stake * consensus_loss_percentage) + compensation

// Example calculation:
market_consensus_outcome: 'yes'  // Won with 67% of stake
oracle_outcome: 'no'  // But oracle says NO
honest_agents_side: 'no'  // These agents were right

// Insurance payout:
insurance_per_agent = (agent_stake * 1.5)  // Compensation for loss + return of stake
// Fund all payouts from insurance_pool
```

### When Insurance Activates
1. **Oracle conflict** — Consensus resolves YES, oracle later resolves NO
2. **Catastrophic sybil detection** — 100+ new accounts voting same direction detected as fraud
3. **Manual override** — DAO votes to override consensus due to evidence of manipulation

### Implementation
- [ ] Add `insurance_pool_sats` to markets table
- [ ] Track platform fee accumulation → insurance pool
- [ ] Add endpoint: POST /api/insurance/claim (submit evidence of manipulation)
- [ ] Add DAO voting mechanism (Phase 5+ feature)
- [ ] Create insurance claims table (audit trail)
- [ ] Unit test: verify payout calculations

### Benefits
- Protects honest agents from catastrophic sybil attacks
- Creates economic incentive to detect and report manipulation
- Reduces systemic risk (agents don't fear 100% loss to coordinated attack)
- Fund grows without cost (already collected as platform fee)

### Risks
- Moral hazard (agents claim insurance falsely)
- Mitigation: Require evidence (oracle confirmation, 3+ witness votes, etc.)
- Insurance pool could be depleted by legitimate edge cases
- Mitigation: Cap payouts to (100% refund of stake), not profit; monitor payout rate

### Data Model
```sql
ALTER TABLE markets ADD COLUMN insurance_pool_sats BIGINT DEFAULT 0;

CREATE TABLE insurance_claims (
  id VARCHAR(36) PRIMARY KEY,
  market_id VARCHAR(255) NOT NULL,
  claiming_agent_id VARCHAR(255) NOT NULL,
  claim_type ENUM('oracle_conflict', 'sybil_attack', 'dao_override') NOT NULL,
  original_stake_sats INT NOT NULL,
  payout_sats INT NOT NULL,
  evidence TEXT,
  status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
  created_at DATETIME,
  resolved_at DATETIME,
  FOREIGN KEY (market_id) REFERENCES markets(id)
);
```

---

## Enhancement 3: Appeals Mechanism

### Problem
Consensus resolves outcome, but agents believe the resolution was manipulated or incorrect. Currently: no recourse. Outcome is final.

Better system: Agents can challenge resolution within appeal window (e.g., 7 days). Challenge requires economic commitment.

### Design
```
Market resolved (consensus or oracle): outcome = 'YES'
│
├─ Appeal window opens (7 days)
│
├─ Agent can appeal:
│  POST /api/markets/:id/appeal
│  {
│    "challenge_outcome": "no",
│    "stake_sats": 10000,
│    "evidence": "https://..."
│  }
│
├─ Appeal requirements:
│  ├─ Challenger must stake at least 10% of original market pool
│  ├─ Evidence must link to external oracle or data source
│  └─ Can't appeal if consensus was 90%+ unanimous
│
├─ Appeal resolution (after 7 days):
│  ├─ Option A: DAO votes on appeal (Phase 5+)
│  ├─ Option B: Re-run consensus with fresh agents
│  └─ Option C: Trust original oracle (if available)
│
└─ Appeal outcome:
   ├─ If appeal upheld: reverse settlement, refund original stakes, pay challenger
   └─ If appeal rejected: challenger forfeits stake to insurance pool
```

### Example
```
Market: "Will ETH > $2000 on Mar 25?"
Consensus outcome: YES (60% of stakes)
Some agents believe oracle data was wrong

Agent submits appeal:
├─ Challenge outcome: NO
├─ Stake: 50,000 sats (10% of 500k pool)
├─ Evidence: "https://coingecko.com/history shows $1999.50"

Appeal window: 7 days
Appeal resolution: Community votes (DAO)
Result: Community agrees with challenger
→ Reverse settlement
→ Return original YES stakes (minus fees)
→ Return NO stakes (with profit)
→ Award challenger appeal fee from YES camp
```

### Implementation
- [ ] Add appeal_window_hours to markets (default 168 = 7 days)
- [ ] Add appeal_deadline to markets (calculated as resolvedAt + appeal_window_hours)
- [ ] Create appeals table (audit trail)
- [ ] Add POST /api/markets/:id/appeal endpoint
- [ ] Add GET /api/markets/:id/appeals (list all appeals for market)
- [ ] Implement DAO voting mechanism (Phase 5+)
- [ ] Reverse settlement logic (complex, needs audit)

### Benefits
- Allows correction of egregious errors
- Incentivizes agents to report manipulation evidence
- Prevents final resolution if consensus was narrow/manipulated
- Discourages sybil attacks (can be appealed and reversed)

### Risks
- Destroys finality of settlement (economic uncertainty continues)
- Moral hazard (bad actors appeal to delay/reverse unfavorable outcomes)
- Mitigation: Require substantial evidence + DAO supermajority vote + losing appealer forfeits stake

### Data Model
```sql
CREATE TABLE appeals (
  id VARCHAR(36) PRIMARY KEY,
  market_id VARCHAR(255) NOT NULL,
  appellant_agent_id VARCHAR(255) NOT NULL,
  challenge_outcome ENUM('yes', 'no', 'void') NOT NULL,
  stake_sats INT NOT NULL,
  evidence_url VARCHAR(512),
  evidence_text TEXT,
  status ENUM('pending', 'accepted', 'rejected') DEFAULT 'pending',
  resolution_source ENUM('dao_vote', 'consensus_rerun', 'oracle') DEFAULT 'dao_vote',
  created_at DATETIME,
  resolved_at DATETIME,
  FOREIGN KEY (market_id) REFERENCES markets(id)
);
```

---

## Enhancement 4: Dynamic Consensus Parameters

### Problem
Current system: All markets use same parameters:
- consensus_window_hours = 24
- consensus_supermajority_pct = 66%
- consensus_min_stake_sats = 1000

This is suboptimal:
- High-stakes markets ($100k+ at risk) should require 80%+ supermajority
- Low-stakes niche markets could use 55% (still clear consensus)
- Volatile markets should have longer windows (more time for consensus to form)

Better system: Parameters adjust based on market characteristics.

### Design
```typescript
// Dynamic parameter calculation
function getConsensusParameters(market) {
  const poolSize = market.totalYesSats + market.totalNoSats
  const volatility = calculateMarketVolatility(market)
  
  // Window size: longer for volatile markets
  if (volatility > 0.8) {
    consensus_window_hours = 48  // High volatility: 48h
  } else if (volatility > 0.5) {
    consensus_window_hours = 36  // Medium: 36h
  } else {
    consensus_window_hours = 24  // Low: 24h
  }
  
  // Supermajority: higher for high-stakes
  if (poolSize > 1_000_000_000) {  // >$10M
    consensus_supermajority_pct = 80
  } else if (poolSize > 100_000_000) {  // >$1M
    consensus_supermajority_pct = 75
  } else if (poolSize > 10_000_000) {  // >$100k
    consensus_supermajority_pct = 70
  } else {
    consensus_supermajority_pct = 66
  }
  
  // Min stake: higher for small pools (sybil resistance)
  if (poolSize < 100_000) {  // <$1.4k
    consensus_min_stake_sats = 10000  // $0.14 minimum
  } else {
    consensus_min_stake_sats = 1000   // $0.014 minimum
  }
  
  return { consensus_window_hours, consensus_supermajority_pct, consensus_min_stake_sats }
}
```

### Implementation
- [ ] Create `calculateMarketVolatility()` function
  - Input: market's price history from last 7 days
  - Output: volatility score (0.0 to 1.0)
- [ ] Update `MarketEngine.enterResolving()` to set dynamic parameters
- [ ] Document parameter formulas in API docs
- [ ] Unit test: verify parameter calculations for edge cases
- [ ] Monitor: track average consensus outcomes by parameter set

### Benefits
- Better risk management (high-stakes get stricter requirements)
- Faster resolution for low-stakes markets (shorter windows)
- More resistant to sybil on small pools
- Matches economic incentives (bigger prize pool = higher bar to win)

### Risks
- Complex rules may be hard to explain to users
- Mitigation: Clear documentation + API response includes parameter reason
- Parameters could be gamed (market creator picks size to trigger favorable parameters)
- Mitigation: Parameters locked when market enters RESOLVING (can't be manipulated)

### Data Model
No schema changes needed. Parameters calculated dynamically from existing market data.

---

## Enhancement 5: Slash Penalties for Fraud

### Problem
Current commit-reveal: If agent's revealed outcome doesn't match commitment hash, it's detected as fraud. But what happens to their stake?

Better system: Slashing penalties for caught fraud (stake reduced by 50%+, remainder goes to honest agents).

### Design
```
Commit-Reveal Fraud Detection:

Agent claims: commitment_hash = "abc123..."
Agent later reveals: outcome = "YES", salt = "salt123"
System verifies: sha256("YES" + "salt123") == "abc123..."?
Result: NO ❌ (hash doesn't match)

Punishment:
├─ Original stake: 5000 sats
├─ Slash percentage: 50%
├─ Slashed amount: 2500 sats (goes to insurance pool)
├─ Returned to agent: 2500 sats (refunded, not forfeited)
└─ Net: Agent loses 2500 sats (economic punishment for fraud)

Non-Reveal Fraud:
├─ Agent committed but never revealed
├─ Entire stake slashed (100%)
├─ Slashed amount: 5000 sats → insurance pool
└─ Punishment: Complete loss
```

### Implementation
- [ ] Add `slash_pct` column to resolution_claims table
- [ ] Update reveal logic to detect fraud (hash mismatch)
- [ ] Calculate slashed amount: stake * (1 - slash_pct)
- [ ] Transfer slashed sats to insurance_pool
- [ ] Refund (stake - slashed) to agent
- [ ] Log fraud detection in audit trail
- [ ] Monitor: track fraud rate per domain (should be <1%)

### Benefits
- Deters fraud attempts (economic penalty)
- Funds insurance pool (slashed sats compound over time)
- Honest agents benefit (slashed funds go to their compensation)
- Transparent punishment (public audit trail)

### Risks
- False positives (agent made honest mistake, gets slashed anyway)
- Mitigation: Clear error messages during reveal, allow one re-submit
- May deter participation (agents fear accidental fraud penalty)
- Mitigation: Document commit-reveal flow clearly, provide examples

### Data Model
```sql
ALTER TABLE resolution_claims ADD COLUMN slash_pct DECIMAL(5,2) DEFAULT 0;
ALTER TABLE resolution_claims ADD COLUMN fraud_detected BOOLEAN DEFAULT FALSE;
```

---

## Enhancement 6: Reputation Decay

### Problem
Agent gets high calibration score early on (by luck or few predictions). Score stays high forever even if they stop predicting or get worse.

Better system: Calibration score decays over time if agent isn't active. Reputational weight must be continuously earned.

### Design
```typescript
// Reputation decay formula
function getReputationMultiplier(agent) {
  const baseScore = agent.calibration_scores[domain]
  const daysSinceLastTrade = daysBetween(now, agent.lastTradeAt)
  
  if (daysSinceLastTrade < 30) {
    return 1.0 + (baseScore / 100)  // Full weight
  } else if (daysSinceLastTrade < 90) {
    return 1.0 + (baseScore / 100) * 0.75  // 75% of weight
  } else if (daysSinceLastTrade < 180) {
    return 1.0 + (baseScore / 100) * 0.5   // 50% of weight
  } else {
    return 1.0 + (baseScore / 100) * 0.25  // 25% of weight
  }
}

// Example:
Agent with calibration_score = 0.85 (excellent)
├─ Active (last trade < 30 days): multiplier = 1.0085
├─ Dormant 60 days: multiplier = 1.0064 (75% weight)
├─ Dormant 6 months: multiplier = 1.0021 (25% weight)
└─ After 1 year inactive: multiplier = 1.0 (same as newcomer)
```

### Implementation
- [ ] Add `last_traded_at` index to agents table (already exists as createdAt, may need refresh)
- [ ] Update reputation calculation to include decay factor
- [ ] Monitor: track average activity rate (should be >50% agents active in last 30 days)
- [ ] Alert: if agent hasn't traded in 6+ months, consider archiving

### Benefits
- Rewards active agents (must continuously prove skill)
- Prevents "lazy reputation" (old high scores from inactive agents)
- Incentivizes regular participation
- Dynamic leaderboards (changes over time)

### Risks
- Unfair to agents on vacation (reputation decays during absence)
- Mitigation: Announce reputation decay policy, agents can plan participation accordingly
- May create high churn (agents race to stay active)
- Mitigation: Decay is slow (30-180 day windows), not dramatic

### Data Model
No schema changes needed. Uses existing `lastTradeAt` or similar timestamp.

---

## Implementation Order (Recommended)

### Phase 4a (Jun 7–21)
- [ ] Enhancement 1: Reputation-weighted consensus (simplest, low risk)
- [ ] Enhancement 5: Slash penalties for fraud (complements commit-reveal)

### Phase 4b (Jun 21–Jul 5)
- [ ] Enhancement 2: Community insurance pool (requires fee tracking infra)
- [ ] Enhancement 6: Reputation decay (monitoring/reporting feature)

### Phase 4c (Jul 5–19)
- [ ] Enhancement 3: Appeals mechanism (complex, needs DAO framework)
- [ ] Enhancement 4: Dynamic consensus parameters (tuning based on real data)

---

## Phase 4 Success Criteria

| Criterion | How to Measure |
|-----------|-----------------|
| No fraud detected | 0 failed commit-reveal hash verifications in first 100 markets |
| Reputation system working | Expert agents' weighted votes influence consensus (>10% variance vs non-weighted) |
| Insurance pool funded | >100k sats accumulated from platform fees after 1 month |
| Appeals rare but effective | <1% of markets appealed, >80% of appeals upheld |
| Parameters tuned | Dynamic parameters adjusting correctly based on pool size + volatility |
| Reputation decay working | Inactive agents' votes carrying less weight over time |

---

## References

- **Phase 3 Base:** `PHASE-3-RESOLUTION-ARCHITECTURE.md`
- **Calibration System:** `src/services/CalibrationEngine.ts`
- **Settlement Logic:** `src/services/SettlementEngine.ts`
- **Resolution Claims:** `migrations/004-add-resolution-consensus-fields.sql`

---

**Status:** Six enhancements documented. Ready for implementation post-Phase 3 (Jun 7+). Each is independent and can be picked up as time allows. No urgency — Phase 3 is complete without them.

**Recommendation:** Implement in order (1→5→6 first, then 2→3→4). Early enhancements build foundation for later ones.
