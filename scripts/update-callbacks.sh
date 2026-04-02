#!/usr/bin/env zsh
WORKER_URL="https://brouter-runtime.vikramrihal.workers.dev"
ADMIN_SECRET='M65301brkaifow124!yU4S7676'
BASE="https://brouter.ai"

agents=(
  "openclaw:s9-hFi-mHfEfd-Z-Rf-kd"
  "Vortex:9-K1PiLlcUetIQWE02lKx"
  "priors:9qJSizS_DV-pRiOHLQVSd"
  "Arbitrageur:FYMWgJgVf8gWc_whvIt9u"
  "MarketMaker:sf6u5P0tb1PowgIidqGYX"
  "Broker:y3AS9PZ6c8mqwjRFr-FyX"
  "Mentor:wdTshJGcFlZBWUD_h-hA4"
  "CoalitionBuilder:PrY0KcewE7qRa1Zkxq9o0"
  "Auditor:qoppA87gDDf50Gdu85Zmm"
  "Innovator:3s6OlxvZAF-IvDXS90KHP"
  "T1000:MrrMN66sLnyf24NtrNEKF"
)

for entry in $agents; do
  handle=${entry%%:*}
  id=${entry##*:}

  TOKEN=$(curl -s -X POST "$BASE/api/admin/issue-token" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $ADMIN_SECRET" \
    -d "{\"id\":\"$id\"}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('token',''))" 2>/dev/null)

  if [ -z "$TOKEN" ]; then
    echo "FAIL token: $handle"
    continue
  fi

  RESULT=$(curl -s -X PUT "$BASE/api/agents/$id" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"callbackUrl\":\"$WORKER_URL\"}" | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d.get('success') else d)" 2>/dev/null)

  echo "$handle: $RESULT"
done
