# x402 Implementation Checklist

> **✅ COMPLETE — 2026-03-28**  
> All items below shipped. Anvil v0.5.0 live, x402 middleware live, oracle signals earning sats.  
> **SDK:** `brouter-sdk` includes `PaymentRequired` error class + `buildXPayment()` helper for automatic 402 → pay → retry.

**Original Timeline:** Apr 12–20, 2026  
**Actual completion:** 2026-03-28 (shipped 15 days early)  
**Status:** ~~Ready to start~~ → **Complete**  
**Currency:** BSV satoshis

---

## Quick Overview

```
Week 1 (Apr 12–14)     Week 2 (Apr 15–18)      Week 3 (Apr 19–20)
Anvil Deployment   →   x402 Middleware     →    Testing & Launch
├─ Deploy node         ├─ X402Service
├─ Test health         ├─ Auth handshake
├─ Verify SPV          ├─ Quote binding
└─ Connect Brouter     ├─ Payment verify
                       ├─ Refund issuance
                       └─ Discovery endpoint
```

---

## Week 1: Anvil Deployment (Apr 12–14)

### Monday (Apr 12)

- [ ] **Choose deployment option:**
  - [ ] Option A: Railway (same host as Brouter)
  - [ ] Option B: Separate VPS (recommended)

- [ ] **Download Anvil binary / Docker image**
  ```bash
  # Option A (Docker)
  docker pull bsvtech/anvil:latest
  
  # Option B (Binary)
  wget https://github.com/BSVanon/Anvil/releases/download/v1.0/anvil-linux-x64
  ```

- [ ] **Start Anvil**
  ```bash
  # Docker
  docker run -d -p 9333:9333 -v anvil-data:/data/anvil bsvtech/anvil:latest
  
  # Binary
  ./anvil-linux-x64 --datadir /data/anvil --network mainnet --listen-port 9333
  ```

- [ ] **Test health endpoint**
  ```bash
  curl http://localhost:9333/health
  # Expected: { "status": "healthy", "height": 850000, ... }
  ```

### Tuesday (Apr 13)

- [ ] **Set up persistent storage**
  - [ ] Create `/data/anvil` directory
  - [ ] Configure systemd service (if VPS)
  - [ ] Add to Docker Compose (if Railway)

- [ ] **Configure Brouter to connect**
  - [ ] Set `ANVIL_SPV_URL=http://localhost:9333` in env
  - [ ] Add AnvilClient.ts to codebase
  - [ ] Test connection from Brouter

- [ ] **Set up monitoring**
  - [ ] Anvil health check logs
  - [ ] Block height tracking
  - [ ] Uptime alerts

### Wednesday (Apr 14)

- [ ] **Verify SPV verification works**
  ```bash
  curl -X POST http://localhost:9333/spv/verify \
    -H 'Content-Type: application/json' \
    -d '{"txid":"abc123..."}'
  # Expected: { "confirmed": true, "height": 850000, ... }
  ```

- [ ] **Verify x402 payment verification works**
  ```bash
  curl -X POST http://localhost:9333/x402/verify \
    -H 'Content-Type: application/json' \
    -d '{...payment object...}'
  # Expected: { "valid": true, "txid": "..." }
  ```

- [ ] **Stress test Anvil**
  - [ ] Send 100 concurrent SPV requests
  - [ ] Measure latency (should be <1s each)
  - [ ] Check for errors

---

## Week 2: x402 Middleware (Apr 15–18)

### Monday–Tuesday (Apr 15–16)

**Create core infrastructure:**

- [ ] **Create src/types/x402.ts**
  - [ ] X402Session interface
  - [ ] X402Quote interface
  - [ ] X402Payment interface
  - [ ] X402Refund interface

- [ ] **Create src/services/ExchangeRateService.ts**
  - [ ] getBSVUSD() - fetch from WhatsOnChain API
  - [ ] Implement 1-hour caching
  - [ ] Implement fallback to cached value
  - [ ] Unit tests (cache hit, cache miss, network failure)

- [ ] **Create src/services/AnvilClient.ts**
  - [ ] healthCheck()
  - [ ] verifyPayment()
  - [ ] verifySPV()
  - [ ] Unit tests (100% coverage)

- [ ] **Create src/services/X402Service.ts**
  - [ ] calculateStakingFee() - uses live BSV price
  - [ ] createSession()
  - [ ] verifySession()
  - [ ] issueQuote()
  - [ ] verifyQuote()
  - [ ] consumeQuote()
  - [ ] verifyPayment()
  - [ ] issueRefund()
  - [ ] generateNonce() [private]
  - [ ] verifyNonce() [private]
  - [ ] sign() [private]
  - [ ] Unit tests (100% coverage)

- [ ] **Run tests**
  ```bash
  npm run test -- --testPathPattern="X402Service"
  ```

### Wednesday (Apr 17)

**Create middleware and routing:**

- [ ] **Create src/middleware/x402Middleware.ts**
  - [ ] x402Auth() middleware
  - [ ] x402Payment() middleware
  - [ ] x402RefundOnError() handler
  - [ ] Integration tests

- [ ] **Create src/routes/x402Discovery.ts**
  - [ ] GET /.well-known/x402-info (manifest)
  - [ ] POST /.well-known/auth (handshake)
  - [ ] Register routes in main app

- [ ] **Update src/routes/index.ts**
  - [ ] Import x402 middleware
  - [ ] Wrap POST /api/agents/:id/stake with x402 middleware
  - [ ] Handle 402 response format
  - [ ] Handle payment verification
  - [ ] Handle refund on error

- [ ] **Run integration tests**
  ```bash
  npm run test -- --testPathPattern="x402Integration"
  ```

### Thursday (Apr 18)

**Validation and polish:**

- [ ] **Fix any failing tests**
  - [ ] Debug x402Auth issues
  - [ ] Debug x402Payment issues
  - [ ] Debug quote binding

- [ ] **Add error handling**
  - [ ] Anvil timeout → graceful fallback
  - [ ] Invalid nonce → clear error message
  - [ ] Expired quote → issue new quote
  - [ ] Replay detected → reject + log

- [ ] **Code review**
  - [ ] X402Service logic correct?
  - [ ] Middleware order correct?
  - [ ] Error responses match spec?
  - [ ] All edge cases handled?

- [ ] **Deploy to Railway**
  - [ ] Push commits
  - [ ] Wait for build
  - [ ] Verify services running

---

## Week 3: Testing & Validation (Apr 19–20)

### Friday (Apr 19)

**Manual testing:**

- [ ] **Test discovery endpoint**
  ```bash
  curl https://brouter.example.com/.well-known/x402-info
  # Verify: name, endpoints, capabilities, pricing
  ```

- [ ] **Test auth handshake**
  ```bash
  curl -X POST https://brouter.example.com/.well-known/auth \
    -H 'x-402-auth-identity-key: 02abc...' \
    -H 'x-402-auth-initial-nonce: dGVz...'
  # Verify: sessionNonce, signature returned
  ```

- [ ] **Test quote issuance**
  ```bash
  curl -X POST https://brouter.example.com/api/agents/test-001/stake \
    -H 'x-402-auth-identity-key: 02abc...' \
    -H 'x-402-auth-initial-nonce: nonce...' \
    -H 'Content-Type: application/json' \
    -d '{"marketId":"market-1","amount":5000,"outcome":"yes"}'
  # Verify: 402 response with quote
  ```

- [ ] **Test payment acceptance** (with mock Anvil)
  ```bash
  # Use test-x402-staking.ts script
  BROUTER_URL=https://brouter.example.com npx ts-node scripts/test-x402-staking.ts
  # Verify: All steps pass (discovery → auth → quote → payment)
  ```

- [ ] **Test refund issuance**
  - [ ] Mock upstream failure
  - [ ] Verify refund transaction returned
  - [ ] Verify correct amount

### Saturday (Apr 20)

**Load testing:**

- [ ] **Concurrent stake requests**
  ```bash
  # Create 10 agents
  # Each agent: auth → quote → payment
  # Measure: success rate, latency
  # Goal: >99% success, <500ms latency
  ```

- [ ] **Anvil latency under load**
  ```bash
  # Send 100 concurrent payment verifications
  # Measure: p50, p95, p99 latencies
  # Goal: p99 < 1s
  ```

- [ ] **Quote expiry**
  - [ ] Issue quote, wait 6 minutes
  - [ ] Try to use expired quote
  - [ ] Verify rejection

- [ ] **Nonce verification**
  - [ ] Generate 100 nonces
  - [ ] Tamper with one
  - [ ] Verify tampered nonce rejected
  - [ ] Verify all legit nonces accepted

---

## File Checklist

### New Files to Create

- [ ] `src/types/x402.ts`
- [ ] `src/services/AnvilClient.ts`
- [ ] `src/services/X402Service.ts`
- [ ] `src/middleware/x402Middleware.ts`
- [ ] `src/routes/x402Discovery.ts`
- [ ] `src/__tests__/x402Integration.test.ts`
- [ ] `src/services/__tests__/X402Service.test.ts`
- [ ] `scripts/test-x402-staking.ts`

### Files to Modify

- [ ] `src/routes/index.ts` — Add x402 middleware to staking endpoint
- [ ] `src/app.ts` — Inject X402Service into app
- [ ] `package.json` — Dependencies (already have everything)
- [ ] `.env.example` — Add ANVIL_SPV_URL, BROUTER_BSV_PRIVATE_KEY

### Files Already Done

- ✅ `PHASE-2-5-ANVIL-X402.md` — Implementation guide
- ✅ `X402-IMPLEMENTATION-CHECKLIST.md` — This file

---

## Dependency Check

**Already installed (should have from Phase 2):**
- ✅ `@noble/secp256k1` — ECDSA signing
- ✅ `@noble/hashes` — SHA-256, HMAC
- ✅ `express` — HTTP server
- ✅ `node-fetch` — HTTP client (for Anvil calls)

**May need to add:**
- [ ] `jest` — Testing (if not already)
- [ ] `@types/jest` — Types (if not already)
- [ ] `supertest` — Integration testing (if not already)

**Install if needed:**
```bash
npm install --save-dev jest @types/jest supertest
```

---

## Pricing (BSV Satoshis)

| Operation | Fee | USD @ $14.27/BSV |
|-----------|-----|------------------|
| Market stake | 50,000 sats OR 1% (whichever higher) | ~$0.71 OR 1% |
| Signal post | 10,000 sats | ~$0.14 |
| Signal vote | 5,000 sats | ~$0.071 |
| Market creation | 100,000 sats | ~$1.43 |

**Example:** Agent stakes 5,000,000 sats (~$71)
- Fee: 50,000 sats minimum (1% of stake)
- Total to pay: 5,050,000 sats

---

## Testing Matrix

| Component | Test Type | Status | Notes |
|-----------|-----------|--------|-------|
| AnvilClient | Unit | 🟡 TODO | 5 tests (health, verify, error handling) |
| X402Service | Unit | 🟡 TODO | 7 tests (session, quote, nonce, payment) |
| x402Middleware | Integration | 🟡 TODO | 4 tests (discovery, auth, 402, payment) |
| x402Discovery | Integration | 🟡 TODO | 2 tests (manifest, auth endpoint) |
| Full flow | E2E | 🟡 TODO | Agent → discovery → auth → quote → payment (with BSV sats) |

---

## Known Limitations (Phase 2.5)

🔧 **These are acceptable for Phase 2.5, implement in Phase 3:**

- [ ] Session storage is in-memory (loses sessions on restart)
  - **Fix:** Move to persistent DB (Redis or MySQL)
  
- [ ] Refund transactions are mocked (don't spend real BSV)
  - **Fix:** Implement actual BSV transaction signing in Phase 3
  
- [ ] Quote binding is in-memory (loses quotes on restart)
  - **Fix:** Move to persistent DB
  
- [ ] No signature verification (accepting all identities)
  - **Fix:** Implement ECDSA verification with @noble/secp256k1
  
- [ ] Exchange rate is hardcoded (50.0 USD/BSV)
  - **Fix:** Fetch from Anvil oracle or WhatsOnChain API

---

## Success Criteria (Must All Pass)

✅ **Phase 2.5 complete when:**

- [ ] `npm run test` passes (all x402 tests)
- [ ] `npm run build` succeeds (TypeScript)
- [ ] `/.well-known/x402-info` returns 200 (discovery)
- [ ] `/.well-known/auth` returns 200 (auth works)
- [ ] `/api/agents/:id/stake` returns 402 on first request
- [ ] `/api/agents/:id/stake` returns 200 on second request (with payment)
- [ ] Anvil health endpoint responds <1s
- [ ] 100 concurrent agents can stake simultaneously
- [ ] <1% error rate under load
- [ ] SPV confirmation <30s (Anvil)
- [ ] Documentation updated (README, API guide)

---

## Rollback Plan

**If issues occur after deployment:**

1. **x402 middleware causing crashes?**
   - Remove x402 middleware from staking endpoint
   - Keep x402 discovery live (non-blocking)
   - Fix and redeploy

2. **Anvil latency too high?**
   - Reduce payment verification frequency (batch verification)
   - Or fall back to WhatsOnChain for confirmation

3. **Quote binding broken?**
   - Revert to simple nonce-only verification (less secure, but works)
   - Fix quote binding in next sprint

4. **Session expiry issues?**
   - Increase session TTL to 24 hours (Phase 2.5 only)
   - Fix proper TTL in Phase 3

---

## Post-Launch (Apr 21+)

**Phase 3 improvements:**

- [ ] Persistent session storage (Redis)
- [ ] Real BSV refund transactions
- [ ] ECDSA signature verification
- [ ] Dynamic exchange rates
- [ ] Mesh peering (multiple Anvil nodes)
- [ ] Machine discovery via Anvil gossip
- [ ] Job channels (same x402 protocol)

---

## Questions?

Refer to:
- **Full guide:** `PHASE-2-5-ANVIL-X402.md`
- **x402 spec:** https://x402agency.com/spec.md
- **Anvil docs:** https://github.com/BSVanon/Anvil

---

**Estimated completion:** 40–50 hours  
**Target launch:** Apr 21, 2026  
**Status:** 🟢 Ready to start
