# Oracle Integration Tests — Week 2 Validation

**Status:** Tests created, ready to run  
**Location:** `test_oracle_integration.py` (Python), `src/__tests__/oracle-integration.test.ts` (TypeScript)  
**Purpose:** Validate OracleResolver end-to-end before settlement integration (Week 3)  

---

## What's Being Tested

### Test 1: Market Created in RESOLVING State
**Setup:** Insert market with `state='RESOLVING'` and Polymarket `conditionId`  
**Expected:** Market is in database, ready for oracle checks  
**Validates:** Database schema correct, oracle can find markets to check  

**State transition:** OPEN → RESOLVING → SETTLED (oracle detects resolution → settlement engine handles payout)  

### Test 2: OracleResolver Detects Resolution
**Setup:** Create market pegged to real Polymarket ID  
**Action:** Call `OracleResolver.poll_once()`  
**Expected:**
- Market's `resolvedOutcome` is set (yes/no/void)
- `lastOracleCheck` timestamp updated
- `market_state_log` entry created with outcome + source  
**Validates:** Oracle polling loop works, database updates atomic  

### Test 3: Multiple Concurrent Markets
**Setup:** Create 3 RESOLVING markets  
**Action:** Run single `poll_once()` cycle  
**Expected:** All 3 checked, outcomes logged for resolved ones  
**Validates:** Bulk polling works, rate limits respected (5s between Polymarket queries)  

### Test 4: Respects 30-Second Check Interval
**Setup:** Create market with `lastOracleCheck = NOW()`  
**Query:** Get count of markets needing recheck: `lastOracleCheck < DATE_SUB(NOW(), INTERVAL 30 SECOND)`  
**Expected:** Recently-checked market is excluded  
**Validates:** Polling loop doesn't hammer Polymarket unnecessarily  

### Test 5: State Log Immutability
**Setup:** Create market, log 3 "resolutions" (simulating repeated oracle checks)  
**Expected:**
- All 3 logs present (never deleted)
- Ordered by insertion (immutable sequence)
- Market's current `resolvedOutcome` reflects latest update  
**Validates:** Audit trail is permanent, correct ordering maintained  

---

## Running the Tests

### Prerequisites

```bash
# Install dependencies
pip install -r requirements.txt

# Ensure MySQL is running
mysql -u root -p

# Create test database (optional — tests create it)
mysql -u brouter brouter < src/db/schema-v3.sql
```

### Run Python Tests

```bash
cd /Users/VNRai/.openclaw/workspace/brouter

# Run with standard output (recommended)
python test_oracle_integration.py

# OR with pytest
pytest test_oracle_integration.py -v -s
```

### Expected Output

```
============================================================
BROUTER ORACLE INTEGRATION TESTS
============================================================

[Setup] Creating test database...
[Setup] ✓ Database created

[Test 1] Oracle detects RESOLVING market...
✓ RESOLVING market created

[Test 2] Oracle polls Polymarket and detects resolution...
  Polled and resolved 1 markets
✓ Market resolved to: yes
✓ State log has 1 resolution entries
  - yes (source: polymarket)

[Test 3] Oracle polls multiple markets...
✓ Polled 3 markets, 1 resolved
✓ 3 markets have lastOracleCheck timestamp

[Test 4] Oracle respects 30-second check interval...
✓ 2 markets need rechecking (excluding test-recent-check with recent check)

[Test 5] Verifying state log immutability...
✓ All 3 state transitions logged immutably
  - Log 1: yes
  - Log 2: no
  - Log 3: void

============================================================
✓ ALL TESTS PASSED
============================================================
```

---

## What Each Test Validates

| Test | Validates |
|------|-----------|
| 1 | Database schema has markets table with correct columns |
| 2 | OracleResolver connects to DB, polls Polymarket, updates market state |
| 3 | Bulk polling works, rate limits respected (5s delays) |
| 4 | `lastOracleCheck` filtering works (prevents hammering Polymarket) |
| 5 | `market_state_log` is immutable, permanently audits all state changes |

---

## Integration with Week 3 Settlement

**Currently (Week 2):**
- Oracle detects resolution ✅
- Updates `markets.resolvedOutcome` ✅
- Logs to `market_state_log` ✅

**Missing (Week 3):**
- Settlement engine reads `resolvedOutcome`
- Calculates payouts based on outcome
- Broadcasts payout transaction to BSV
- Anchors settlement to blockchain

**Connection:** SettlementEngine will read the same `markets.resolvedOutcome` that OracleResolver sets.

---

## Error Cases Not Yet Tested

### Rate Limiting
**Scenario:** Polymarket returns 429 (too many requests)  
**Current behavior:** `safe_get()` exponential backoff (5, 10, 20 seconds)  
**Test:** Stress test with 100 markets in single poll_once() cycle  

### Malformed Market Data
**Scenario:** `conditionId` is invalid or Polymarket API returns error  
**Current behavior:** Logged as warning, market skipped  
**Test:** Pass invalid condition ID, verify warning log + continue  

### Database Connection Loss
**Scenario:** MySQL disconnects mid-polling  
**Current behavior:** Exception caught, logged, polling stops  
**Test:** Kill MySQL connection, verify graceful shutdown + error log  

### Polymarket API Down
**Scenario:** Gamma API unreachable  
**Current behavior:** Backoff, retry, eventually log error  
**Test:** Mock Polymarket API, return 500 errors, verify retry logic  

---

## Deployment Readiness Checklist (Week 2 End)

- [ ] All 5 core tests passing
- [ ] Error case scenarios tested (rate limit, malformed data, DB loss)
- [ ] Oracle can continuously poll without memory leaks (run for 1 hour)
- [ ] Rate limiting respected (verify Polymarket logs for 429s)
- [ ] State logs are correctly immutable (spot-check DB)
- [ ] Documentation updated with actual test results
- [ ] Oracle deployed to staging, 3 real markets monitored

---

## Success Criteria

✅ OracleResolver.poll_once() completes without errors  
✅ Resolving markets are detected and outcomes logged  
✅ `market_state_log` entries are permanent (never updated/deleted)  
✅ Rate limits prevent hammering Polymarket  
✅ Multiple markets polled concurrently  
✅ state transitions tracked in immutable audit trail  

---

## Next Steps (Week 3)

1. **SettlementEngine integration:** Read `resolvedOutcome` from markets table
2. **Payout calculation:** Determine winners + amounts
3. **BSV transactions:** Sign and broadcast payouts
4. **Anchor to blockchain:** OP_RETURN settlement proof
5. **End-to-end test:** Market resolves → settlement sends payouts → calibration scores updated

---

## Reference

- **Oracle code:** `oracle/oracle.py`, `oracle/adapters/polymarket.py`
- **Polymarket feed:** `data/feeds/polymarket.py`
- **Database schema:** `src/db/schema-v3.sql`
- **Integration tests:** `test_oracle_integration.py`, `src/__tests__/oracle-integration.test.ts`
