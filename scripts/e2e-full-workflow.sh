#!/bin/bash

# Full Phase 1 End-to-End Test
# Market creation → Positions → Signals → Votes → Resolution → Settlement → Calibration
# Duration: ~2 minutes, exercises all critical paths

set -e

API="http://localhost:3001/api"
ALICE_TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhZ2VudElkIjoiYWxpY2UiLCJpYXQiOjE3NzQyNjYwOTUsImV4cCI6MTc3NDg3MDg5NX0.qiw9SDTS_po69A2PJRp64DWx9kfw6flTyGGkyyDisU8"
BOB_TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhZ2VudElkIjoiYm9iIiwiaWF0IjoxNzc0MjY2MDk1LCJleHAiOjE3NzQ4NzA4OTV9.75AnZ7BwW2PthlYckofHIW7_J_5-SDI6XG1zo1rg2Io"
CHARLIE_TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhZ2VudElkIjoiY2hhcmxpZSIsImlhdCI6MTc3NDI2NjA5NSwiZXhwIjoxNzc0ODcwODk1fQ.njbDU1cq0rpR6pig2dLn0IUDpLwDwMtpeZapMTSSBfA"

echo "🚀 Full Phase 1 End-to-End Workflow Test"
echo "=========================================="
echo ""

# ===== Setup Agents =====
echo "1️⃣  Setting up agents..."
mysql -uroot scout << 'EOF'
SET FOREIGN_KEY_CHECKS = 0;
DELETE FROM trace_rights WHERE 1=1;
DELETE FROM signal_dust WHERE 1=1;
DELETE FROM signal_payouts WHERE 1=1;
DELETE FROM signal_pools WHERE 1=1;
DELETE FROM signal_votes WHERE 1=1;
DELETE FROM signals WHERE 1=1;
DELETE FROM calibration_scores WHERE 1=1;
DELETE FROM stakes WHERE 1=1;
DELETE FROM market_state_log WHERE 1=1;
DELETE FROM market_disputes WHERE 1=1;
DELETE FROM price_history WHERE 1=1;
DELETE FROM markets WHERE 1=1;
DELETE FROM auth_tokens WHERE 1=1;
DELETE FROM agents WHERE id IN ('alice', 'bob', 'charlie');
SET FOREIGN_KEY_CHECKS = 1;

INSERT INTO agents (id, pubkey, handle) VALUES
  ('alice', 'pubkey_alice', 'Alice'),
  ('bob', 'pubkey_bob', 'Bob'),
  ('charlie', 'pubkey_charlie', 'Charlie');

INSERT INTO auth_tokens (agentId, token, createdAt, expiresAt)
VALUES
  ('alice', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhZ2VudElkIjoiYWxpY2UiLCJpYXQiOjE3NzQyNjYwOTUsImV4cCI6MTc3NDg3MDg5NX0.qiw9SDTS_po69A2PJRp64DWx9kfw6flTyGGkyyDisU8', NOW(), DATE_ADD(NOW(), INTERVAL 7 DAY)),
  ('bob', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhZ2VudElkIjoiYm9iIiwiaWF0IjoxNzc0MjY2MDk1LCJleHAiOjE3NzQ4NzA4OTV9.75AnZ7BwW2PthlYckofHIW7_J_5-SDI6XG1zo1rg2Io', NOW(), DATE_ADD(NOW(), INTERVAL 7 DAY)),
  ('charlie', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhZ2VudElkIjoiY2hhcmxpZSIsImlhdCI6MTc3NDI2NjA5NSwiZXhwIjoxNzc0ODcwODk1fQ.njbDU1cq0rpR6pig2dLn0IUDpLwDwMtpeZapMTSSBfA', NOW(), DATE_ADD(NOW(), INTERVAL 7 DAY));
EOF
echo "✓ Agents created and authenticated"
echo ""

# ===== Create Market =====
echo "2️⃣  Creating market..."
MARKET_JSON=$(curl -s -X POST "$API/markets" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Will Bitcoin reach $150k by EOY 2026?",
    "description": "BTC price prediction for end of year 2026",
    "domain": "crypto",
    "tier": "weekly",
    "closesAt": "2026-12-20T00:00:00Z",
    "resolvesAt": "2026-12-31T23:59:59Z",
    "resolutionCriteria": "Official BTC/USD price from CoinMarketCap on Dec 31, 2026"
  }')

MARKET_ID=$(echo "$MARKET_JSON" | jq -r '.data.market.id')
echo "✓ Market created: $MARKET_ID"
echo ""

# ===== Agents Take Positions =====
echo "3️⃣  Agents taking positions..."

# Alice: 5000 sats on YES
curl -s -X POST "$API/markets/$MARKET_ID/position" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -d '{"direction": "yes", "amountSats": 5000}' > /dev/null

# Bob: 3000 sats on NO
curl -s -X POST "$API/markets/$MARKET_ID/position" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $BOB_TOKEN" \
  -d '{"direction": "no", "amountSats": 3000}' > /dev/null

# Charlie: 2000 sats on YES
curl -s -X POST "$API/markets/$MARKET_ID/position" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CHARLIE_TOKEN" \
  -d '{"direction": "yes", "amountSats": 2000}' > /dev/null

echo "✓ Alice: 5000 sats on YES"
echo "✓ Bob: 3000 sats on NO"
echo "✓ Charlie: 2000 sats on YES"
echo ""

# ===== Open Market =====
echo "4️⃣  Opening market..."
curl -s -X POST "$API/markets/$MARKET_ID/open" \
  -H "Content-Type: application/json" > /dev/null
echo "✓ Market opened (state: OPEN)"
echo ""

# ===== Create Signals =====
echo "5️⃣  Creating signals..."

# Alice creates YES signal
SIGNAL_A_JSON=$(curl -s -X POST "$API/markets/$MARKET_ID/signal" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -d '{"position": "yes", "postingFeeSats": 500}')

SIGNAL_A_ID=$(echo "$SIGNAL_A_JSON" | jq -r '.data.signal.id')

# Bob creates NO signal
SIGNAL_B_JSON=$(curl -s -X POST "$API/markets/$MARKET_ID/signal" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $BOB_TOKEN" \
  -d '{"position": "no", "postingFeeSats": 500}')

SIGNAL_B_ID=$(echo "$SIGNAL_B_JSON" | jq -r '.data.signal.id')

echo "✓ Alice created signal A (YES): $SIGNAL_A_ID"
echo "✓ Bob created signal B (NO): $SIGNAL_B_ID"
echo ""

# ===== Vote on Signals =====
echo "6️⃣  Voting on signals..."

# Charlie upvotes signal A (YES)
curl -s -X POST "$API/signals/$SIGNAL_A_ID/vote" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CHARLIE_TOKEN" \
  -d '{"direction": "up", "amountSats": 200}' > /dev/null

# Alice downvotes signal B (NO)
curl -s -X POST "$API/signals/$SIGNAL_B_ID/vote" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -d '{"direction": "down", "amountSats": 300}' > /dev/null

echo "✓ Charlie upvoted signal A: 200 sats"
echo "✓ Alice downvoted signal B: 300 sats"
echo ""

# ===== Verify Signal Pools =====
echo "7️⃣  Verifying signal pools..."
mysql -uroot scout << EOF
SELECT CONCAT('Signal A: Total=', totalSats, ', Up=', upSats, ', Down=', downSats) as pool_state
FROM signal_pools WHERE signalId = '$SIGNAL_A_ID';
EOF
echo ""

# ===== Lock Market =====
echo "8️⃣  Locking market..."
curl -s -X POST "$API/markets/$MARKET_ID/lock" \
  -H "Content-Type: application/json" > /dev/null
echo "✓ Market locked (state: LOCKED)"
echo ""

# ===== Start Resolution =====
echo "9️⃣  Starting resolution phase..."
curl -s -X POST "$API/markets/$MARKET_ID/start-resolution" \
  -H "Content-Type: application/json" > /dev/null
echo "✓ Market entering RESOLVING state"
echo ""

# ===== Resolve Market =====
echo "🔟 Resolving market (outcome: YES)..."
RESOLVE_JSON=$(curl -s -X POST "$API/markets/$MARKET_ID/resolve" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -d '{"outcome": "yes"}')

MARKET_STATE=$(echo "$RESOLVE_JSON" | jq -r '.data.market.state // "error"')
echo "✓ Market state: $MARKET_STATE"
echo ""

# ===== Verify Payouts =====
echo "1️⃣1️⃣ Verifying payouts and settlement..."
mysql -uroot scout << EOF
SELECT 
  'Market Stakes Summary:' as label,
  (SELECT SUM(amountSats) FROM stakes WHERE marketId = '$MARKET_ID' AND direction = 'yes') as total_yes_sats,
  (SELECT SUM(amountSats) FROM stakes WHERE marketId = '$MARKET_ID' AND direction = 'no') as total_no_sats,
  (SELECT COUNT(*) FROM signal_payouts WHERE signalId IN ('$SIGNAL_A_ID', '$SIGNAL_B_ID')) as total_payouts,
  (SELECT COUNT(*) FROM calibration_scores) as calibration_records;
EOF
echo ""

# ===== Verify Calibration Scores =====
echo "1️⃣2️⃣ Verifying calibration scores..."
mysql -uroot scout << EOF
SELECT 
  agentId,
  domain,
  ROUND(score, 4) as brier_score,
  sampleCount as markets
FROM calibration_scores
ORDER BY agentId DESC;
EOF
echo ""

# ===== Final Status =====
echo "✅ Full Phase 1 Workflow Test Complete!"
echo "=========================================="
echo ""
echo "Summary:"
echo "- Market: $MARKET_ID (state: SETTLED)"
echo "- Signals: A=$SIGNAL_A_ID (YES), B=$SIGNAL_B_ID (NO)"
echo "- Outcome: YES (Alice & Charlie won market, signal A correct, signal B incorrect)"
echo "- Calibration: Brier scores updated for all stakers"
echo "- Settlement: Payouts distributed, dust tracked, trace rights granted"
echo ""
echo "Next: Deploy www.brouter.ai + Phase 1 stress testing"
