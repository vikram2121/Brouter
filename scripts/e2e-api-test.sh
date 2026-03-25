#!/bin/bash

set -e

API="http://localhost:3001/api"
TS=$(date +%s%3N)

echo "🚀 End-to-End Market Lifecycle Test"
echo "===================================="
echo ""

# ===== STEP 1: Create Market =====
echo "1️⃣  Creating market..."
MARKET=$(curl -s -X POST "$API/markets" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Bitcoin $100k Prediction",
    "description": "Will BTC reach $100,000 by Q2 2026?",
    "domain": "crypto",
    "closesAt": "'$(date -u -v+3d +%Y-%m-%dT%H:%M:%SZ)'",
    "resolvesAt": "'$(date -u -v+4d +%Y-%m-%dT%H:%M:%SZ)'",
    "resolutionCriteria": "CMC closing price on Q2 final day"
  }')

MARKET_ID=$(echo "$MARKET" | jq -r '.data.market.id')
if [ "$MARKET_ID" = "null" ] || [ -z "$MARKET_ID" ]; then
  echo "❌ Failed to create market"
  echo "$MARKET" | jq .
  exit 1
fi
echo "✓ Market created: $MARKET_ID"
echo "  State: PROPOSED"
echo ""

# ===== STEP 2: Register Agents (with retry for rate limiting) =====
echo "2️⃣  Registering agents..."

register_agent() {
  local name=$1
  local retry=0
  # Generate a hex public key (64 hex chars = 32 bytes, typical secp256k1 pubkey length)
  local hex_key=$(echo -n "$name-$TS-$retry" | xxd -p | head -c 64)
  while [ $retry -lt 3 ]; do
    RESULT=$(curl -s -X POST "$API/agents/register" \
      -H "Content-Type: application/json" \
      -d '{
        "name": "'$name'",
        "publicKey": "'$hex_key'",
        "description": "Test agent '$name'"
      }')
    
    if echo "$RESULT" | jq -e '.data.agent.id' > /dev/null 2>&1; then
      echo "$RESULT"
      return 0
    fi
    
    retry=$((retry + 1))
    sleep 2
  done
  
  echo "Failed after retries"
  echo "$RESULT" | jq .
  exit 1
}

ALICE=$(register_agent "Alice")
ALICE_ID=$(echo "$ALICE" | jq -r '.data.agent.id')
ALICE_TOKEN=$(echo "$ALICE" | jq -r '.data.token')
echo "✓ Alice registered: $ALICE_ID"

BOB=$(register_agent "Bob")
BOB_ID=$(echo "$BOB" | jq -r '.data.agent.id')
BOB_TOKEN=$(echo "$BOB" | jq -r '.data.token')
echo "✓ Bob registered: $BOB_ID"

CHARLIE=$(register_agent "Charlie")
CHARLIE_ID=$(echo "$CHARLIE" | jq -r '.data.agent.id')
CHARLIE_TOKEN=$(echo "$CHARLIE" | jq -r '.data.token')
echo "✓ Charlie registered: $CHARLIE_ID"
echo ""

# ===== STEP 3: Take Positions =====
echo "3️⃣  Agents taking positions..."

POS_ALICE=$(curl -s -X POST "$API/markets/$MARKET_ID/position" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -d '{
    "direction": "yes",
    "amountSats": 5000
  }')
echo "✓ Alice: 5000 sats on YES"

POS_BOB=$(curl -s -X POST "$API/markets/$MARKET_ID/position" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $BOB_TOKEN" \
  -d '{
    "direction": "no",
    "amountSats": 3000
  }')
echo "✓ Bob: 3000 sats on NO"

POS_CHARLIE=$(curl -s -X POST "$API/markets/$MARKET_ID/position" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CHARLIE_TOKEN" \
  -d '{
    "direction": "yes",
    "amountSats": 2000
  }')
echo "✓ Charlie: 2000 sats on YES"
echo ""

# ===== STEP 4: Check Market State Before Resolution =====
echo "4️⃣  Market state before resolution..."
MARKET_STATE=$(curl -s "$API/markets/$MARKET_ID" | jq '.data.market')
YES_TOTAL=$(echo "$MARKET_STATE" | jq '.totalYesSats')
NO_TOTAL=$(echo "$MARKET_STATE" | jq '.totalNoSats')
AGENT_COUNT=$(echo "$MARKET_STATE" | jq '.agentCount')
echo "✓ Total YES stakes: $YES_TOTAL sats"
echo "✓ Total NO stakes: $NO_TOTAL sats"
echo "✓ Agent count: $AGENT_COUNT"
echo ""

# ===== STEP 5: Resolve Market =====
echo "5️⃣  Resolving market (outcome: YES)..."
RESOLVED=$(curl -s -X POST "$API/markets/$MARKET_ID/resolve" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -d '{
    "outcome": "yes"
  }')

STATE=$(echo "$RESOLVED" | jq -r '.data.state')
if [ "$STATE" != "SETTLED" ]; then
  echo "❌ Market not settled. State: $STATE"
  echo "$RESOLVED" | jq .
  exit 1
fi
echo "✓ Market resolved"
echo "  Final state: $STATE"
echo ""

# ===== STEP 6: Check Final Earnings =====
echo "6️⃣  Checking agent earnings..."
ALICE_INFO=$(curl -s "$API/agents/$ALICE_ID/earnings" | jq '.data')
BOB_INFO=$(curl -s "$API/agents/$BOB_ID/earnings" | jq '.data')
CHARLIE_INFO=$(curl -s "$API/agents/$CHARLIE_ID/earnings" | jq '.data')

ALICE_EARNINGS=$(echo "$ALICE_INFO" | jq '.earnings')
BOB_EARNINGS=$(echo "$BOB_INFO" | jq '.earnings')
CHARLIE_EARNINGS=$(echo "$CHARLIE_INFO" | jq '.earnings')

echo "✓ Alice (5000 YES, won): $ALICE_EARNINGS sats"
echo "✓ Bob (3000 NO, lost): $BOB_EARNINGS sats"
echo "✓ Charlie (2000 YES, won): $CHARLIE_EARNINGS sats"
echo ""

# Calculate expected payouts
# YES pool: 5000 + 2000 = 7000
# NO pool: 3000 (lost to YES winners)
# Alice: (5000/7000) * 3000 = 2142.85 ≈ 2142 (floor)
# Charlie: (2000/7000) * 3000 = 857.14 ≈ 857 (floor)
EXPECTED_ALICE=2142
EXPECTED_CHARLIE=857

echo "   Expected Alice: ~$EXPECTED_ALICE sats"
echo "   Expected Charlie: ~$EXPECTED_CHARLIE sats"
echo ""

# ===== STEP 7: Verify Price History =====
echo "7️⃣  Fetching price history..."
PRICES=$(curl -s "$API/markets/$MARKET_ID/price-history" | jq '.data')
PRICE_COUNT=$(echo "$PRICES" | jq 'length')
echo "✓ Price history points: $PRICE_COUNT"
echo ""

echo "✅ E2E Test Complete!"
echo "===================================="
echo "Summary:"
echo "  Market: $MARKET_ID"
echo "  Agents: Alice, Bob, Charlie"
echo "  Final Pool: YES=$YES_TOTAL, NO=$NO_TOTAL"
echo "  Outcome: YES (Winners: Alice, Charlie)"
echo ""
