#!/bin/bash
# Smoke test: Oracle → Market → Manual Override → Settlement
# Run Monday 2026-03-25 morning

set -e

PROJECT_ROOT="/Users/VNRai/.openclaw/workspace/brouter"
cd "$PROJECT_ROOT"

# Use venv Python and set PYTHONPATH
export PYTHONPATH="$PROJECT_ROOT:$PYTHONPATH"
export BROUTER_DRY_RUN=true
PYTHON="$PROJECT_ROOT/.venv/bin/python"

echo "🔥 SMOKE TEST: Oracle → Settlement Handoff"
echo "==========================================="
echo ""

# 1. Start oracle in background
echo "1️⃣  Starting oracle polling..."
$PYTHON oracle/oracle.py &
ORACLE_PID=$!
sleep 2  # Give oracle time to start
echo "   Oracle PID: $ORACLE_PID"
echo ""

# 2. Create test market
echo "2️⃣  Creating test market..."
MARKET_OUTPUT=$($PYTHON -m scripts.create_test_market \
  --question "Will Fed cut rates in May?" \
  --condition-id test-001)
echo "$MARKET_OUTPUT"

# Extract market ID from output (assume format: "✅ Market created: test_abc123")
MARKET_ID=$(echo "$MARKET_OUTPUT" | grep "Market created" | awk '{print $NF}')
echo "   Market ID: $MARKET_ID"
echo ""

# 3. Advance to RESOLVING
echo "3️⃣  Advancing to RESOLVING state..."
$PYTHON -m scripts.advance_market_state \
  --market-id "$MARKET_ID" \
  --state RESOLVING
echo ""

# 4. Force resolve with manual override
echo "4️⃣  Force resolving with manual override..."
$PYTHON -m oracle.manual_override \
  --market-id "$MARKET_ID" \
  --outcome yes \
  --reason "smoke_test"
echo ""

# 5. Check market state
echo "5️⃣  Checking final market state..."
$PYTHON -m scripts.check_market --market-id "$MARKET_ID"
echo ""

# Cleanup
echo "🧹 Stopping oracle..."
kill $ORACLE_PID 2>/dev/null || true

echo ""
echo "✅ SMOKE TEST COMPLETE"
echo ""
echo "Expected result:"
echo "  - Market state: SETTLED"
echo "  - Outcome: yes"
echo "  - State log shows: PROPOSED → OPEN → RESOLVING → SETTLED"
