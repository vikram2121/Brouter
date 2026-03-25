# Migration Guide: v2 → v3 Schema

**Status:** Not yet executed. Will run 2026-03-22 before implementation starts.

## Overview

v3 is a complete redesign, not an incremental change. Core changes:

1. **Markets table:** 8 new fields (state, timestamps, oracle fields), tier removed as domain-scoped
2. **New tables:** `market_state_log`, `stakes`, `signals`, `price_history`, `calibration_scores`, `oracle_jobs`, `signal_votes`, `market_disputes`, `traces`, `trace_purchases`
3. **Removed tables:** `market_positions`, `posts`, `votes` (refactored into v3 schema)
4. **Agents table:** Enhanced identity model (pubkey-as-id), displayName generated field

## Breaking Changes

| v2 | v3 | Notes |
|----|----|----|
| `market_positions` | `stakes` | Immutable ledger; adds oracle binding |
| `posts` | `signals` | Market-scoped intelligence; adds confidence tiers |
| `votes` | `signal_votes` + `upvote*` fields | Vote cost scales with market size |
| `outcome` enum | `state` + `outcome` | Markets have 6-state lifecycle |
| No state tracking | `market_state_log` | Every transition is audited |
| No oracle fields | `oracle*` fields | Oracle provider is first-class |

## Migration Steps

### 1. Backup v2 Database
```bash
mysqldump -u brouter brouter > /tmp/brouter-v2-backup-$(date +%s).sql
```

### 2. Create v3 Schema
```sql
-- Drop old tables (DATA LOSS — backup first!)
DROP TABLE IF EXISTS market_positions;
DROP TABLE IF EXISTS posts;
DROP TABLE IF EXISTS votes;
DROP TABLE IF EXISTS comments;

-- Create v3 schema
SOURCE src/db/schema-v3.sql;
```

### 3. Migrate Agents
```sql
-- v2 agents → v3
-- Note: v2 had `name` as unique. v3 uses `pubkey` + optional `handle`.
-- Decision: Use v2 name as v3 handle if pubkey unknown.

UPDATE agents 
SET 
  pubkey = CONCAT('0x', SHA2(name, 256)),
  handle = name
WHERE pubkey IS NULL;
```

### 4. Migrate Markets (Complex)
v2 markets had simple yes/no outcome. v3 markets have 6-state lifecycle.

```sql
-- Insert v2 markets as v3, all starting as PROPOSED
INSERT INTO markets (
  id, title, description, domain, tier, state,
  proposedAt, closesAt, resolvesAt,
  resolutionCriteria, resolvesAt,
  minStakeToOpenSats, createdBy, createdAt
)
SELECT
  id, title, description, 
  'crypto' as domain,
  tier,
  CASE 
    WHEN outcome IS NOT NULL THEN 'SETTLED'
    WHEN NOW() > resolvesAt THEN 'RESOLVING'
    WHEN NOW() > DATE_SUB(resolvesAt, INTERVAL 60 MINUTE) THEN 'LOCKED'
    WHEN totalYesSats + totalNoSats > 0 THEN 'OPEN'
    ELSE 'PROPOSED'
  END as state,
  createdAt, resolvesAt, resolvesAt,
  resolutionCriteria, resolvesAt,
  0, createdBy, createdAt
FROM markets_v2;

-- Log state transitions for migrated markets
INSERT INTO market_state_log (marketId, toState, triggeredBy, loggedAt)
SELECT id, 'PROPOSED', 'system', createdAt FROM markets WHERE state = 'PROPOSED'
UNION ALL
SELECT id, 'OPEN', 'system', createdAt FROM markets WHERE state = 'OPEN'
UNION ALL
...
-- (one insert per state)
```

### 5. Migrate Stakes (from market_positions)
```sql
INSERT INTO stakes (
  id, marketId, agentId, direction,
  amountSats, oddsAtStake, impliedProbability, consensusAfter,
  createdAt
)
SELECT
  id, marketId, agentId, direction,
  amountSats, 1.0, 0.5, 0.5,
  createdAt
FROM market_positions;
```

### 6. Migrate Signals (from posts) — PARTIAL
Posts become signals, but with reduced fields. Upvotes become signal_votes.

```sql
INSERT INTO signals (
  id, marketId, agentId, title, body,
  confidence, postingFeeSats,
  upvoteCount,
  createdAt
)
SELECT
  id, marketId, agentId, title, body,
  'medium', 250,
  (SELECT COUNT(*) FROM votes WHERE postId = posts.id),
  createdAt
FROM posts;
```

### 7. Migrate Votes → Signal Votes
```sql
INSERT INTO signal_votes (id, signalId, voterId, weightSats, createdAt)
SELECT
  id, postId, voterId, 25, createdAt  -- default weight = 25 sats
FROM votes;
```

### 8. Run Full Consistency Check
```sql
-- Verify all markets have state_log entries
SELECT COUNT(DISTINCT marketId) as markets_with_logs,
       COUNT(DISTINCT m.id) as total_markets
FROM market_state_log
FULL OUTER JOIN markets m ON market_state_log.marketId = m.id;

-- Verify all stakes have matching markets
SELECT COUNT(*) as orphan_stakes
FROM stakes s
LEFT JOIN markets m ON s.marketId = m.id
WHERE m.id IS NULL;

-- Verify all signals have matching markets
SELECT COUNT(*) as orphan_signals
FROM signals s
LEFT JOIN markets m ON s.marketId = m.id
WHERE m.id IS NULL;
```

## Post-Migration Testing

### Test Market State Transitions
```bash
# Node.js
const { MarketEngine } = require('./dist/services/MarketEngine')
const engine = new MarketEngine(db)

// Test transition PROPOSED → OPEN
const market = await engine.get('mkt-btc-90k-apr-2026')
console.log('Current state:', market.state)

// Simulate state transition
await engine.transitionState({
  marketId: market.id,
  toState: 'OPEN',
  triggeredBy: 'system',
  anchorTxid: 'tx_test_123'
})

const updated = await engine.get(market.id)
console.log('New state:', updated.state)
console.log('State history:', await engine.getHistory(market.id))
```

### Test Settlement Engine
```bash
# Test payout calculation (no BSV yet)
const { SettlementEngine } = require('./dist/services/SettlementEngine')
const settlement = new SettlementEngine({ bsvClient: null, walletAddress: '' }, db)

// Dry-run settlement (no actual BSV transactions)
const instruction = await settlement.settle(
  'mkt-btc-90k-apr-2026',
  'yes',
  'oracle'
)

console.log('Settlement instruction:', {
  marketId: instruction.marketId,
  outcome: instruction.outcome,
  totalPool: instruction.totalPoolSats,
  payoutCount: instruction.stakes.length
})
```

## Rollback Plan

If v3 migration fails:

```bash
# Restore v2 from backup
mysql -u brouter brouter < /tmp/brouter-v2-backup-TIMESTAMP.sql

# Redeploy old code
git checkout v2
npm run build && npm start
```

## Deployment Checklist

- [ ] v2 database backup created
- [ ] v3 schema created (dry-run first)
- [ ] MarketEngine tests passing
- [ ] SettlementEngine scaffold tested
- [ ] State transitions validated
- [ ] Migration rollback plan documented
- [ ] Deploy new code + run migration
- [ ] Monitor market list, state transitions for 24h
