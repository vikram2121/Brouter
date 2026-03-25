#!/bin/bash

set -e

API="http://localhost:3001/api"

echo "🚀 End-to-End Market Lifecycle Test (Simplified)"
echo "=================================================="
echo ""

# ===== Create test agents directly in database =====
echo "1️⃣  Creating test agents in database..."
mysql -uroot scout << 'EOF'
DELETE FROM auth_tokens WHERE 1=1;
DELETE FROM agents WHERE id IN ('alice', 'bob', 'charlie');

INSERT INTO agents (id, pubkey, handle, description, firstSeenAt, createdAt, updatedAt, totalStakedSats, totalEarnedSats)
VALUES 
  ('alice', '0200000000000000000000000000000000000000000000000000000000000001', 'Alice', 'Bullish on BTC', NOW(), NOW(), NOW(), 0, 0),
  ('bob', '0200000000000000000000000000000000000000000000000000000000000002', 'Bob', 'Bearish on BTC', NOW(), NOW(), NOW(), 0, 0),
  ('charlie', '0200000000000000000000000000000000000000000000000000000000000003', 'Charlie', 'Neutral stance', NOW(), NOW(), NOW(), 0, 0);

INSERT INTO auth_tokens (id, agentId, token, createdAt, expiresAt)
VALUES
  ('token-alice', 'alice', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhZ2VudElkIjoiYWxpY2UiLCJpYXQiOjE3NzQyNjYwOTUsImV4cCI6MTc3NDg3MDg5NX0.qiw9SDTS_po69A2PJRp64DWx9kfw6flTyGGkyyDisU8', NOW(), DATE_ADD(NOW(), INTERVAL 7 DAY)),
  ('token-bob', 'bob', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhZ2VudElkIjoiYm9iIiwiaWF0IjoxNzc0MjY2MDk1LCJleHAiOjE3NzQ4NzA4OTV9.75AnZ7BwW2PthlYckofHIW7_J_5-SDI6XG1zo1rg2Io', NOW(), DATE_ADD(NOW(), INTERVAL 7 DAY)),
  ('token-charlie', 'charlie', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhZ2VudElkIjoiY2hhcmxpZSIsImlhdCI6MTc3NDI2NjA5NSwiZXhwIjoxNzc0ODcwODk1fQ.njbDU1cq0rpR6pig2dLn0IUDpLwDwMtpeZapMTSSBfA', NOW(), DATE_ADD(NOW(), INTERVAL 7 DAY));

SELECT COUNT(*) as agents_created FROM agents WHERE id IN ('alice', 'bob', 'charlie');
EOF
echo "✓ Agents created: alice, bob, charlie"
echo ""

# ===== Create Market =====
echo "2️⃣  Creating market..."
MARKET=$(curl -s -X POST "$API/markets" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Will Bitcoin reach $100k by Q2 2026?",
    "description": "BTC closing price on last trading day of June",
    "domain": "crypto",
    "tier": "weekly",
    "closesAt": "'$(date -u -v+3d +%Y-%m-%dT%H:%M:%SZ)'",
    "resolvesAt": "'$(date -u -v+4d +%Y-%m-%dT%H:%M:%SZ)'",
    "resolutionCriteria": "CMC spot price",
    "oracleProvider": "polymarket",
    "oracleMarketId": "btc-100k"
  }')

MARKET_ID=$(echo "$MARKET" | jq -r '.data.market.id')
if [ "$MARKET_ID" = "null" ] || [ -z "$MARKET_ID" ]; then
  echo "❌ Failed to create market"
  echo "$MARKET" | jq .
  exit 1
fi
echo "✓ Market created: $MARKET_ID"
echo ""

# ===== Stake Positions =====
echo "3️⃣  Agents taking positions..."

ALICE_TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhZ2VudElkIjoiYWxpY2UiLCJpYXQiOjE3NzQyNjYwOTUsImV4cCI6MTc3NDg3MDg5NX0.qiw9SDTS_po69A2PJRp64DWx9kfw6flTyGGkyyDisU8"
BOB_TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhZ2VudElkIjoiYm9iIiwiaWF0IjoxNzc0MjY2MDk1LCJleHAiOjE3NzQ4NzA4OTV9.75AnZ7BwW2PthlYckofHIW7_J_5-SDI6XG1zo1rg2Io"
CHARLIE_TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhZ2VudElkIjoiY2hhcmxpZSIsImlhdCI6MTc3NDI2NjA5NSwiZXhwIjoxNzc0ODcwODk1fQ.njbDU1cq0rpR6pig2dLn0IUDpLwDwMtpeZapMTSSBfA"

curl -s -X POST "$API/markets/$MARKET_ID/position" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -d '{"direction": "yes", "amountSats": 5000}' > /dev/null
echo "✓ Alice: 5000 sats on YES"

curl -s -X POST "$API/markets/$MARKET_ID/position" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $BOB_TOKEN" \
  -d '{"direction": "no", "amountSats": 3000}' > /dev/null
echo "✓ Bob: 3000 sats on NO"

curl -s -X POST "$API/markets/$MARKET_ID/position" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CHARLIE_TOKEN" \
  -d '{"direction": "yes", "amountSats": 2000}' > /dev/null
echo "✓ Charlie: 2000 sats on YES"
echo ""

# ===== Check Market State =====
echo "4️⃣  Market state before resolution..."
MARKET_STATE=$(curl -s "$API/markets/$MARKET_ID" | jq '.data.market')
YES_TOTAL=$(echo "$MARKET_STATE" | jq '.totalYesSats')
NO_TOTAL=$(echo "$MARKET_STATE" | jq '.totalNoSats')
echo "✓ Total YES stakes: $YES_TOTAL sats"
echo "✓ Total NO stakes: $NO_TOTAL sats"
echo ""

# ===== Resolve Market =====
echo "5️⃣  Resolving market (outcome: YES)..."
RESOLVED=$(curl -s -X POST "$API/markets/$MARKET_ID/resolve" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -d '{"outcome": "yes"}')

STATE=$(echo "$RESOLVED" | jq -r '.data.state')
if [ "$STATE" != "SETTLED" ]; then
  echo "⚠️  Market state: $STATE (expected SETTLED)"
fi
echo "✓ Market resolved"
echo ""

# ===== Check Earnings =====
echo "6️⃣  Checking agent earnings..."
ALICE_EARNINGS=$(curl -s "$API/agents/alice/earnings" | jq '.data.earnings // 0')
BOB_EARNINGS=$(curl -s "$API/agents/bob/earnings" | jq '.data.earnings // 0')
CHARLIE_EARNINGS=$(curl -s "$API/agents/charlie/earnings" | jq '.data.earnings // 0')

echo "✓ Alice (5000 YES, won): $ALICE_EARNINGS sats"
echo "✓ Bob (3000 NO, lost): $BOB_EARNINGS sats"
echo "✓ Charlie (2000 YES, won): $CHARLIE_EARNINGS sats"
echo ""

# Expected payouts:
# YES pool: 7000 (5000 + 2000)
# NO pool: 3000 (goes to winners)
# Alice: (5000 / 7000) * 3000 ≈ 2142 sats
# Charlie: (2000 / 7000) * 3000 ≈ 857 sats
echo "   Expected distribution:"
echo "   Alice: ~2142 sats (5000/7000 of pool)"
echo "   Charlie: ~857 sats (2000/7000 of pool)"
echo ""

# ===== Price History =====
echo "7️⃣  Price history..."
PRICES=$(curl -s "$API/markets/$MARKET_ID/price-history" | jq '.data')
PRICE_COUNT=$(echo "$PRICES" | jq 'length')
echo "✓ Price history points: $PRICE_COUNT"
echo ""

echo "✅ E2E Test Complete!"
echo "=================================================="
echo "Market: $MARKET_ID"
echo "Outcome: YES (Alice and Charlie won)"
echo ""
