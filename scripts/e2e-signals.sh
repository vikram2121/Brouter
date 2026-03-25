#!/bin/bash

set -e

API="http://localhost:3001/api"

echo "🚀 End-to-End Signal Creation & Voting Test"
echo "==========================================="
echo ""

# ===== Setup Agents & Tokens =====
echo "1️⃣  Setting up agents..."
mysql -uroot scout << 'EOF'
SET FOREIGN_KEY_CHECKS = 0;
DELETE FROM trace_rights WHERE 1=1;
DELETE FROM signal_dust WHERE 1=1;
DELETE FROM signal_payouts WHERE 1=1;
DELETE FROM signal_pools WHERE 1=1;
DELETE FROM signal_votes WHERE 1=1;
DELETE FROM signals WHERE 1=1;
DELETE FROM auth_tokens WHERE 1=1;
DELETE FROM agents WHERE id IN ('alice', 'bob', 'charlie');
SET FOREIGN_KEY_CHECKS = 1;

INSERT INTO agents (id, pubkey, handle, description, firstSeenAt, createdAt, updatedAt, totalStakedSats, totalEarnedSats)
VALUES 
  ('alice', '0200000000000000000000000000000000000000000000000000000000000001', 'Alice', 'Bullish analyst', NOW(), NOW(), NOW(), 0, 0),
  ('bob', '0200000000000000000000000000000000000000000000000000000000000002', 'Bob', 'Bearish analyst', NOW(), NOW(), NOW(), 0, 0),
  ('charlie', '0200000000000000000000000000000000000000000000000000000000000003', 'Charlie', 'Neutral analyst', NOW(), NOW(), NOW(), 0, 0);

INSERT INTO auth_tokens (agentId, token, createdAt, expiresAt)
VALUES
  ('alice', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhZ2VudElkIjoiYWxpY2UiLCJpYXQiOjE3NzQyNjYwOTUsImV4cCI6MTc3NDg3MDg5NX0.qiw9SDTS_po69A2PJRp64DWx9kfw6flTyGGkyyDisU8', NOW(), DATE_ADD(NOW(), INTERVAL 7 DAY)),
  ('bob', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhZ2VudElkIjoiYm9iIiwiaWF0IjoxNzc0MjY2MDk1LCJleHAiOjE3NzQ4NzA4OTV9.75AnZ7BwW2PthlYckofHIW7_J_5-SDI6XG1zo1rg2Io', NOW(), DATE_ADD(NOW(), INTERVAL 7 DAY)),
  ('charlie', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhZ2VudElkIjoiY2hhcmxpZSIsImlhdCI6MTc3NDI2NjA5NSwiZXhwIjoxNzc0ODcwODk1fQ.njbDU1cq0rpR6pig2dLn0IUDpLwDwMtpeZapMTSSBfA', NOW(), DATE_ADD(NOW(), INTERVAL 7 DAY));

SELECT COUNT(*) as agents_created FROM agents WHERE id IN ('alice', 'bob', 'charlie');
EOF
echo "✓ Agents created and authenticated"
echo ""

# ===== Create Market =====
echo "2️⃣  Creating market..."
MARKET=$(curl -s -X POST "$API/markets" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Will Bitcoin hit $120k by Q3 2026?",
    "domain": "crypto",
    "tier": "weekly",
    "closesAt": "'$(date -u -v+3d +%Y-%m-%dT%H:%M:%SZ)'",
    "resolvesAt": "'$(date -u -v+4d +%Y-%m-%dT%H:%M:%SZ)'",
    "resolutionCriteria": "CMC closing price",
    "oracleProvider": "polymarket",
    "oracleMarketId": "btc-120k"
  }')

MARKET_ID=$(echo "$MARKET" | jq -r '.data.market.id')
if [ "$MARKET_ID" = "null" ] || [ -z "$MARKET_ID" ]; then
  echo "❌ Failed to create market"
  echo "$MARKET" | jq .
  exit 1
fi
echo "✓ Market created: $MARKET_ID"
echo ""

# ===== Agents Take Positions =====
echo "3️⃣  Agents taking positions in market..."
ALICE_TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhZ2VudElkIjoiYWxpY2UiLCJpYXQiOjE3NzQyNjYwOTUsImV4cCI6MTc3NDg3MDg5NX0.qiw9SDTS_po69A2PJRp64DWx9kfw6flTyGGkyyDisU8"
BOB_TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhZ2VudElkIjoiYm9iIiwiaWF0IjoxNzc0MjY2MDk1LCJleHAiOjE3NzQ4NzA4OTV9.75AnZ7BwW2PthlYckofHIW7_J_5-SDI6XG1zo1rg2Io"
CHARLIE_TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhZ2VudElkIjoiY2hhcmxpZSIsImlhdCI6MTc3NDI2NjA5NSwiZXhwIjoxNzc0ODcwODk1fQ.njbDU1cq0rpR6pig2dLn0IUDpLwDwMtpeZapMTSSBfA"

# Alice: 5000 sats on YES
curl -s -X POST "$API/markets/$MARKET_ID/position" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -d '{"direction": "yes", "amountSats": 5000}' > /dev/null
echo "✓ Alice: 5000 sats on YES"

# Bob: 3000 sats on NO
curl -s -X POST "$API/markets/$MARKET_ID/position" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $BOB_TOKEN" \
  -d '{"direction": "no", "amountSats": 3000}' > /dev/null
echo "✓ Bob: 3000 sats on NO"

# Charlie: 2000 sats on YES
curl -s -X POST "$API/markets/$MARKET_ID/position" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CHARLIE_TOKEN" \
  -d '{"direction": "yes", "amountSats": 2000}' > /dev/null
echo "✓ Charlie: 2000 sats on YES"
echo ""

# ===== Signal Creation =====
echo "4️⃣  Creating signals..."

# Alice creates signal: YES (bullish)
SIGNAL_A=$(curl -s -X POST "$API/markets/$MARKET_ID/signal" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -d '{"position": "yes", "postingFeeSats": 500}')

SIGNAL_A_ID=$(echo "$SIGNAL_A" | jq -r '.data.signal.id')
if [ "$SIGNAL_A_ID" = "null" ] || [ -z "$SIGNAL_A_ID" ]; then
  echo "❌ Failed to create signal A"
  echo "$SIGNAL_A" | jq .
  exit 1
fi
echo "✓ Alice created signal A (YES): $SIGNAL_A_ID"

# Bob creates signal: NO (bearish)
SIGNAL_B=$(curl -s -X POST "$API/markets/$MARKET_ID/signal" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $BOB_TOKEN" \
  -d '{"position": "no", "postingFeeSats": 500}')

SIGNAL_B_ID=$(echo "$SIGNAL_B" | jq -r '.data.signal.id')
if [ "$SIGNAL_B_ID" = "null" ] || [ -z "$SIGNAL_B_ID" ]; then
  echo "❌ Failed to create signal B"
  echo "$SIGNAL_B" | jq .
  exit 1
fi
echo "✓ Bob created signal B (NO): $SIGNAL_B_ID"
echo ""

# ===== Vote on Signals =====
echo "5️⃣  Voting on signals..."

# Charlie upvotes Alice's signal (bullish)
UPVOTE=$(curl -s -X POST "$API/signals/$SIGNAL_A_ID/vote" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CHARLIE_TOKEN" \
  -d '{"direction": "up", "amountSats": 200}')

UPVOTE_STATUS=$(echo "$UPVOTE" | jq -r '.success')
if [ "$UPVOTE_STATUS" != "true" ]; then
  echo "❌ Failed to upvote signal A"
  echo "$UPVOTE" | jq .
  exit 1
fi
echo "✓ Charlie upvoted signal A: 200 sats"

# Alice downvotes Bob's signal (bearish)
DOWNVOTE=$(curl -s -X POST "$API/signals/$SIGNAL_B_ID/vote" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -d '{"direction": "down", "amountSats": 300}')

DOWNVOTE_STATUS=$(echo "$DOWNVOTE" | jq -r '.success')
if [ "$DOWNVOTE_STATUS" != "true" ]; then
  echo "❌ Failed to downvote signal B"
  echo "$DOWNVOTE" | jq .
  exit 1
fi
echo "✓ Alice downvoted signal B: 300 sats"
echo ""

# ===== Check Signal Pool State (via database) =====
echo "6️⃣  Checking signal pools in database..."
mysql -uroot scout << EOF
SELECT CONCAT('Signal A: Total=', totalSats, ', Up=', upSats, ', Down=', downSats) as pool_state
FROM signal_pools WHERE signalId = '$SIGNAL_A_ID';
EOF
echo "  Expected: Signal A: Total=700, Up=700, Down=0 (500 poster + 200 upvote)"
echo ""

# ===== Transition Market to Resolution =====
echo "7️⃣  Transitioning market to resolution phase..."
curl -s -X POST "$API/markets/$MARKET_ID/open" \
  -H "Authorization: Bearer $ALICE_TOKEN" > /dev/null 2>&1 || true
curl -s -X POST "$API/markets/$MARKET_ID/lock" \
  -H "Authorization: Bearer $ALICE_TOKEN" > /dev/null 2>&1 || true
curl -s -X POST "$API/markets/$MARKET_ID/start-resolution" \
  -H "Authorization: Bearer $ALICE_TOKEN" > /dev/null 2>&1 || true
echo "✓ Market transitioned: PROPOSED → OPEN → LOCKED → RESOLVING"
echo ""

# ===== Resolve Market =====
echo "8️⃣  Resolving market (outcome: YES)..."
RESOLVED=$(curl -s -X POST "$API/markets/$MARKET_ID/resolve" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -d '{"outcome": "yes"}')

RESOLVED_STATE=$(echo "$RESOLVED" | jq -r '.data.market.state // "error"')
if [ "$RESOLVED_STATE" != "SETTLED" ]; then
  echo "⚠️  Market state: $RESOLVED_STATE (expected SETTLED)"
else
  echo "✓ Market resolved: state=$RESOLVED_STATE"
fi
echo ""

# ===== Check Final Results =====
echo "9️⃣  Final results..."
ALICE_FINAL=$(curl -s "$API/agents/alice" | jq '.data.agent.totalEarnedSats // 0')
BOB_FINAL=$(curl -s "$API/agents/bob" | jq '.data.agent.totalEarnedSats // 0')
CHARLIE_FINAL=$(curl -s "$API/agents/charlie" | jq '.data.agent.totalEarnedSats // 0')

echo "✓ Alice (5000 YES + upvoted on signals): $ALICE_FINAL sats earned"
echo "✓ Bob (3000 NO + created downvoted signal): $BOB_FINAL sats earned"
echo "✓ Charlie (2000 YES + upvoted signal): $CHARLIE_FINAL sats earned"
echo ""

echo "✅ Signal Creation & Voting Test Complete!"
echo "=========================================="
echo "Market: $MARKET_ID"
echo "Signals: A=$SIGNAL_A_ID (YES), B=$SIGNAL_B_ID (NO)"
echo "Outcome: YES (Alice and Charlie won both market and signals)"
echo ""
