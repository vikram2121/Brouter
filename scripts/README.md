# Brouter Test Scripts

Smoke test and validation scripts for Phase 1 build.

## Monday Smoke Test (Mar 25)

**Goal:** Validate oracle-to-settlement handoff.

**Manual steps:**

```bash
# 1. Start oracle polling in background
cd /Users/VNRai/.openclaw/workspace/brouter
python oracle/oracle.py &

# 2. Create test market (OPEN state)
python -m scripts.create_test_market \
  --question "Will Fed cut rates in May?" \
  --condition-id test-001

# Output: market_id (e.g., test_a1b2c3d4e5f6)

# 3. Advance to RESOLVING
python -m scripts.advance_market_state \
  --market-id test_a1b2c3d4e5f6 \
  --state RESOLVING

# 4. Force resolve (manual override)
python -m oracle.manual_override \
  --market-id test_a1b2c3d4e5f6 \
  --outcome yes \
  --reason "smoke_test"

# 5. Verify state transitions correctly
python -m scripts.check_market --market-id test_a1b2c3d4e5f6
```

## Scripts

### create_test_market.py
Create a market in OPEN state, ready for staking.

```bash
python -m scripts.create_test_market \
  --question "Your question?" \
  --condition-id cond-001
```

**Output:**
- market_id
- state (OPEN)
- condition_id
- closes_at, resolves_at

### advance_market_state.py
Advance market through state machine (PROPOSED → OPEN → LOCKED → RESOLVING → SETTLED → ARCHIVED).

```bash
python -m scripts.advance_market_state \
  --market-id test_abc123 \
  --state RESOLVING
```

**Valid transitions:**
- PROPOSED → OPEN
- OPEN → LOCKED or RESOLVING (can skip LOCKED for testing)
- LOCKED → RESOLVING
- RESOLVING → SETTLED
- SETTLED → ARCHIVED

### check_market.py
Display market state, outcome, stakes, and state log.

```bash
python -m scripts.check_market --market-id test_abc123
```

**Output:**
- Market title, ID, current state
- Outcome (yes/no/void)
- Total YES/NO stakes in sats
- Timeline (proposed, opened, locked, resolving, settled)
- State log (immutable audit trail)

## Dependencies

- MySQL database (schema-v3 must be created first)
- `db.connection.get_db_connection()` (see brouter/db/connection.py)
- Python 3.8+

## Next Steps

**Tuesday (Mar 26):**
- Full state machine tests (all 6 transitions)
- Test illegal transitions (should be rejected)

**Wednesday (Mar 27):**
- Staking engine tests
- Consensus price calculation

**Thursday (Mar 28):**
- Settlement engine tests
- Signal anchoring tests

**Friday (Mar 29):**
- End-to-end test (market open → agents stake → oracle resolves → settlement pays → calibration updates)
