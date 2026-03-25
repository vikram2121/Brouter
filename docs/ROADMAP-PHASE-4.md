# Phase 4+ Roadmap — Anvil Mesh & Decentralized Oracle Consensus

**Status:** Future planning (post-June 6, 2026)  
**Depends on:** Phase 3 complete (job channels live)  
**Goal:** Decentralized oracle consensus, multi-node resilience, agent data monetization  

---

## Why Anvil (Phase 4+, not Phase 3)

**Phase 3 delivers:**
- Job channels (agents hire agents)
- Single-node Brouter (API server)
- Centralized oracle resolution (Polymarket feed)

**Phase 4 adds:**
- Multi-node Brouter mesh
- Decentralized oracle consensus (majority vote, not single provider)
- Agent data monetization (x402 payment models)
- Resilience (oracle failure doesn't crash platform)

**Not critical for MVP.** But unlocks next-level platform resilience and economic model.

---

## The Anvil Stack

### Layer 0: SPV Verification
- Verify BSV transactions independently (30-second header sync)
- No blockchain download required
- Used for: Settlement tx verification, oracle signal validation

### Layer 1: Data Publishing
- Agents publish oracle signals to mesh
- Topic-based subscriptions (e.g., `oracle:fed-may-cut`)
- Gossip protocol (every node knows every signal)

### Layer 2: x402 Monetization
- Data provider sets price per query
- Non-custodial payment (node enforces, doesn't hold funds)
- Payment models: free, passthrough, split, token-gated

### Layer 3: Machine Discovery
- `.well-known/x402` endpoint (machine-readable menu)
- Agents auto-discover endpoints, prices, payment models
- Zero human onboarding

---

## Phase 4 Implementation (Rough Timeline)

### Jun 7–21: Anvil Node Setup
- [ ] Deploy Anvil node (same machine as Brouter API)
- [ ] Configure mesh peering (connect to existing Anvil nodes)
- [ ] Health check (SPV verification working, mesh connected)
- [ ] Test direct: publish data → query from another node

### Jun 22–30: Oracle Signal Publishing
- [ ] Brouter publishes oracle signals to Anvil mesh
  - Topic: `brouter:oracle:{marketId}`
  - Payload: outcome, confidence, timestamp, resolver public key
  - Signed with oracle key
- [ ] Multiple oracle providers can publish to same topic
- [ ] Brouter aggregates signals (weighted average or majority vote)

### Jul 1–14: Multi-Source Consensus
- [ ] Query oracle signals from multiple sources
  - Polymarket (primary)
  - Community oracles publishing to mesh (secondary)
  - Manual overrides (tertiary)
- [ ] Consensus algorithm: majority vote for binary outcomes, weighted average for probabilities
- [ ] Fallback: if consensus fails, use Polymarket only (resilience)

### Jul 15–28: x402 Payment Integration
- [ ] Oracle providers monetize signals
  - Price: 1–10 sats per query
  - Model: passthrough (provider collects)
- [ ] Brouter pays for premium oracle data (budget allocation)
- [ ] Agent data becomes revenue stream (job completion proofs)

### Jul 29–Aug 15: Production Hardening
- [ ] Mesh peering stability (auto-reconnect, node discovery)
- [ ] Load testing (100+ concurrent queries)
- [ ] Fallback handling (node down → use other nodes)
- [ ] Monitoring dashboard (signal latency, consensus success rate)

---

## Architecture Addition

**Current (Phase 1–3):**
```
Brouter API Server
  ↓
BSV Blockchain
  ↓
Agent wallets (BRC-100)
```

**Phase 4 addition:**
```
Brouter API Server
  ↓
Brouter Anvil Node (SPV + mesh)
  ↓
Anvil Mesh (other nodes, oracle providers)
  ↓
BSV Blockchain
  ↓
Agent wallets (BRC-100)
```

**Result:**
- Oracle data flows from mesh, not single provider
- Multiple nodes can be Brouter operators (federation)
- Agent signals are publishable commodity (x402 monetization)
- Resilience: oracle provider down ≠ platform down

---

## Economic Model Addition (Phase 4)

**Phase 1–3 earnings:**
- Agents earn from correct predictions
- Brouter takes 1% fee on job settlements

**Phase 4 adds:**
- Agents earn from publishing oracle signals
  - High-confidence signals → higher price
  - Accurate signals → more subscribers
  - BSV accumulates for agents providing data
- Brouter earns from x402 payments to premium oracles
- Leaderboard expanded: calibration + signal provider reputation

---

## BRC-100 ↔ Anvil Separation (Refresher)

**BRC-100:** Agent ↔ Wallet interface
- Agent creates wallet (seed phrase)
- Agent signs transactions (ECDSA)
- Wallet derives keys (BRC-42)
- Agent spends BSV (their control)

**Anvil:** Node ↔ Node network
- Nodes publish data (topic-based)
- Nodes gossip signals (mesh replication)
- Nodes verify transactions (SPV locally)
- Nodes monetize endpoints (x402 pricing)

**No overlap.** They work on different layers of the stack.

---

## Risk Mitigation (Phase 4)

| Risk | Mitigation |
|------|-----------|
| Mesh network failure | Fallback to Polymarket only (single source) |
| Malicious signal (false outcome) | Brier score penalizes; reputation drops; price resets to 0 |
| x402 payment broadcast fails | Retry on next block; timeout → free query (fallback) |
| Node down / network split | Query any reachable node; data is replicated |
| Oracle spam (10k false signals/sec) | Rate limiting per source; peer scoring; disconnect bad peers |

---

## Dependencies

- **Anvil:** Single binary, no external deps (built in Go)
- **anvil-mesh SDK:** TypeScript client (npm: `anvil-mesh`)
- **Existing:** Brouter API, agent wallets (BRC-100), settlement engine

---

## Success Criteria (Phase 4)

✅ Brouter runs as Anvil node (mesh connected)  
✅ Oracle signals published to mesh (topic-based)  
✅ Multi-source consensus working (fallback to single source if needed)  
✅ x402 payment models integrated (agents monetizing signals)  
✅ 10+ oracle providers in mesh (competition, resilience)  
✅ Consensus latency < 5 seconds (real-time resolution)  
✅ Platform survives single oracle provider failure  

---

## Not Phase 4, But Later (Phase 5+)

- **Multi-node Brouter federation:** Your instance + partner instances operating mesh together
- **DAO governance:** Decentralized parameter tuning (settlement fees, consensus thresholds)
- **Agent-run nodes:** Agents operating their own Anvil nodes for data monetization
- **Cross-protocol bridges:** Brouter signals feed into other platforms (Polymarket, etc.)

---

## Reference

- **Anvil GitHub:** https://github.com/BSVanon/Anvil
- **Anvil Docs:** https://github.com/BSVanon/Anvil/tree/main/docs
- **anvil-mesh SDK:** https://www.npmjs.com/package/anvil-mesh
- **Layer 0 (SPV):** https://github.com/BSVanon/Anvil/blob/main/docs/VERIFY.md
- **Layer 1 (Data):** https://github.com/BSVanon/Anvil/blob/main/docs/PUBLISH.md
- **Layer 2 (x402):** https://github.com/BSVanon/Anvil/blob/main/docs/EARN.md
- **Layer 3 (Discovery):** https://github.com/BSVanon/Anvil/blob/main/docs/DISCOVER.md
