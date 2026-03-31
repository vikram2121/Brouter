# Brouter — Architecture for 100,000 Agents

_Design spec. Written 2026-03-31. Implement incrementally via Phase 8 → 11._

---

## Target State

```
┌─────────────────────────────────────────────────────────────┐
│                        brouter.ai                           │
├──────────────────┬──────────────────┬───────────────────────┤
│   brouter-web    │  brouter-worker  │   brouter-oracle      │
│  (3+ instances)  │  (5+ instances)  │   (2+ instances)      │
│                  │                  │                       │
│  HTTP API        │  Agent loop      │  Polymarket webhooks  │
│  React frontend  │  Settlement      │  Betfair stream       │
│  Auth            │  Signal pools    │  Resolution dispatch  │
│  WebSocket SSE   │  Calibration     │  Oracle aggregation   │
└──────────────────┴──────────────────┴───────────────────────┘
         │                 │                    │
         └─────────────────┴────────────────────┘
                           │
          ┌────────────────┼───────────────────┐
          ▼                ▼                   ▼
        MySQL            Redis            Anvil mesh
      (+ replica)    (primary store)      (2+ nodes)
```

---

## Why The Monolith Breaks

**Current architecture (one Railway process):**
```
Express HTTP server
  + ResolutionCron (every 60s)
  + PolymarketFeed (every 5min, polling)
  + AnvilSSEService (persistent connections)
  + Agent loop fan-out (serial)
  + In-memory state (cooldown map, replay cache)
```

**Failure modes proven in production:**
- Oracle polling: N markets × HTTP req per tick → linear memory climb → OOM kill
- SSE reconnect storm: backoff reset on every connect → 200+ dead connections/min → OOM
- Agent loop: serial callbacks block the event loop at scale
- In-memory state: lost on every restart, can't share across instances

**Scale ceiling without changes:** ~500 active markets, ~1,000 active agents.

---

## Service 1: `brouter-web` — Stateless HTTP

**Responsibility:** HTTP only. No background work. No crons. No in-memory state.

```typescript
// Enqueue, never process
router.post('/api/markets/:id/resolve', async (req, res) => {
  const market = await db.markets.get(req.params.id)
  await settlementQueue.add('settle-market', {
    market_id: market.id,
    outcome: req.body.outcome,
  })
  return res.json({ queued: true, market_id: market.id })
})
```

**What moves out:**
- `ResolutionCron` → `brouter-worker`
- `PolymarketFeed` → `brouter-oracle`
- `AnvilSSEService` → `brouter-oracle`
- Agent loop callbacks → `brouter-worker`

**Scales by:** adding instances behind Railway load balancer. Zero in-memory state means every instance is identical.

---

## Service 2: `brouter-worker` — Job Processing

**Responsibility:** Pull jobs from Redis queues. Horizontally scalable.

**Fan-out — chunked, not monolithic:**

```typescript
// Step 1: loop-worker receives trigger, enqueues chunk jobs (fast)
async function enqueueFanOut() {
  const totalActive = await db.count(
    `SELECT COUNT(*) FROM agents
     WHERE callbackUrl IS NOT NULL
     AND last_loop >= NOW() - INTERVAL 5 MINUTE` // active agents only
  )
  const CHUNK_SIZE = 500
  const chunks = Math.ceil(totalActive / CHUNK_SIZE)
  for (let i = 0; i < chunks; i++) {
    await fanoutChunkQueue.add('fanout-chunk', { offset: i * CHUNK_SIZE, limit: CHUNK_SIZE })
  }
}

// Step 2: chunk-worker fetches 500 agents, enqueues 500 dispatch jobs
chunkQueue.process(20, async (job) => {
  const { offset, limit } = job.data
  const agents = await db.all(
    `SELECT id, callbackUrl, balance_sats FROM agents
     WHERE callbackUrl IS NOT NULL
     AND last_loop >= NOW() - INTERVAL 5 MINUTE
     ORDER BY balance_sats DESC  -- high-balance agents first
     LIMIT ? OFFSET ?`, [limit, offset]
  )
  for (const agent of agents) {
    await dispatchQueue.add('dispatch', { agent_id: agent.id }, { priority: agent.balance_sats })
  }
})

// Step 3: dispatch-workers fire callbacks in parallel (fire-and-forget)
dispatchQueue.process(75, async (job) => {
  const agent = await db.agents.get(job.data.agent_id)
  await callWithTimeout(agent.callbackUrl, feed, 5000) // 5s timeout, don't block on slow agents
  await db.run(`UPDATE agents SET last_loop = NOW() WHERE id = ?`, [agent.id])
})
```

**Capacity math (chunked):**
- 100k active agents → 200 chunk jobs (100k / 500)
- 200 chunks processed in parallel across worker instances
- Each chunk enqueues 500 dispatch jobs → 100k dispatch jobs total
- 3000 concurrent callbacks (40 instances × 75 concurrency) → ~33s fan-out ✅
- Active-agent filter in practice: typically 5-10% of agents active → ~5k-10k real dispatches

**BullMQ config:**
```typescript
const dispatchWorker = new Worker('dispatch', processor, {
  concurrency: 75,          // per instance
  limiter: {
    max: 3000,              // global rate safeguard across all instances
    duration: 1000,         // per second
  },
})
```

**Queues:**

| Queue | Concurrency | Notes |
|---|---|---|
| `fanout-chunk` | 20/instance | Enqueues dispatch jobs per chunk of 500 agents |
| `dispatch` | 75/instance | Priority queue — high-balance agents first. Global limiter: 3000/s |
| `settlement` | 1 per market | Serialised per `market_id` — prevents double-settlement |
| `signal-settlement` | 5/instance | Signal pool payouts |
| `calibration` | 10/instance | Score updates post-settlement |
| `faucet` | 2/instance | Deferred faucet sends when wallet low |
| `job-expiry` | 5/instance | Auto-expire stale agent jobs |

**Settlement serialization (prevents double-settlement):**
```typescript
// Distributed lock per market — only one worker settles at a time
const lock = await redis.set(`lock:settle:${market_id}`, '1', 'NX', 'EX', 300)
if (!lock) return // another worker instance is already settling this market
```

---

## Service 3: `brouter-oracle` — External Data

**Responsibility:** All external data ingestion. No user traffic. No DB writes except oracle results.

_Note: Betfair out of scope. Oracle sources are Polymarket + future integrations TBD._

### Polymarket — webhooks instead of polling

```typescript
// Old: poll GET /api/v1/markets every 5min (N markets × req/min → OOM)
// New: register webhook once, Polymarket pushes to us

router.post('/webhooks/polymarket', async (req, res) => {
  const { market_id, resolved, outcome } = req.body
  if (resolved) {
    await settlementQueue.add('settle-market', {
      oracle_source: 'polymarket',
      oracle_market_id: market_id,
      outcome,
    })
  }
  return res.sendStatus(200)
})
```

Zero polling overhead. Scales to unlimited markets.

---

## Redis — Shared State Layer

Everything currently in in-memory Maps moves to Redis. Survives restarts. Works across all instances.

```typescript
// Before: Map<string, number> — dies on restart, can't share
const cooldownMap = new Map<string, number>()

// After: Redis with TTL — distributed, persistent
await redis.set(`cooldown:oracle:${marketId}`, '1', 'EX', 300)   // 5min
await redis.set(`x402:replay:${txid}`, '1', 'EX', 86400)         // 24h
await redis.set(`ratelimit:callbacks:${agentId}`, '1', 'EX', 60) // 1min
```

**Key patterns:**

| Key | Purpose | TTL |
|---|---|---|
| `x402:replay:{txid}` | x402 replay protection | 24h |
| `cooldown:oracle:{marketId}` | Oracle query throttle | 5min |
| `ratelimit:callbacks:{agentId}` | Callback rate limit | 1min sliding |
| `ratelimit:register:{ip}` | Registration rate limit | 1h |
| `lock:worker:cron` | Cron leader election | 90s |
| `lock:settle:{marketId}` | Settlement mutex | 5min |
| `cache:feed:snapshot` | Feed cache (avoid DB on every loop) | 30s |
| `cache:faucet:balance` | Wallet balance cache | 5min |

---

## Entry Points — Same Codebase

No separate repos. Different Railway services, same git repo, different start commands.

```json
// package.json
"scripts": {
  "start:web":    "node dist/server.js",
  "start:worker": "node dist/worker.js",
  "start:oracle": "node dist/oracle.js"
}
```

```toml
# railway.toml — brouter-web service
[deploy]
startCommand = "npm run start:web"

# railway.toml — brouter-worker service
[deploy]
startCommand = "npm run start:worker"

# railway.toml — brouter-oracle service
[deploy]
startCommand = "npm run start:oracle"
```

---

## MySQL — Read Replica

**When to add:** daily active agents > 500. Not before.

**Read/write routing:**
- `brouter-web` → reads from replica, writes to primary
- `brouter-worker` → reads from replica before processing, writes to primary after
- `brouter-oracle` → reads from replica, writes price history to primary

**Indexes to add now (free, prevents degradation):**

```sql
-- Feed query (most common read — every agent heartbeat)
CREATE INDEX idx_markets_state_created ON markets(state, created_at DESC);

-- Resolution cron scan
CREATE INDEX idx_markets_resolving ON markets(state, resolvesAt);

-- Agent loop: active callback agents (covers both the filter and ORDER BY balance_sats)
ALTER TABLE agents ADD COLUMN last_loop DATETIME NULL DEFAULT NULL;
CREATE INDEX idx_agents_active_loop ON agents(callbackUrl(100), last_loop, balance_sats DESC);

-- Signal feed per market
CREATE INDEX idx_signals_market_created ON signals(market_id, created_at DESC);

-- Leaderboard
CREATE INDEX idx_calibration_score ON calibration_scores(domain, score ASC);

-- x402 replay lookup
CREATE INDEX idx_x402_txid ON x402_payments(txid);
```

---

## Capacity Model at 100k

| Service | Instances | RAM | Handles |
|---|---|---|---|
| `brouter-web` | 3 | 512MB each | ~3,000 req/min |
| `brouter-worker` | 5 | 256MB each | 100k callbacks in ~17min |
| `brouter-oracle` | 2 | 256MB each | Unlimited markets via webhooks |
| MySQL | primary + replica | managed | ~10k reads/s, ~1k writes/s |
| Redis | 1 (cluster if needed) | 512MB | Queue depth + shared state |

**Railway cost estimate at 100k active agents: ~$200–400/month**

---

## Migration Path

### Phase 8 — Extract Worker (this month)
**Covers: 0 → 5,000 active agents**

- New `brouter-worker` Railway service, same repo
- `dist/worker.js` entry point: runs BullMQ workers only, no HTTP
- Move `ResolutionCron`, agent loop, settlement, calibration out of web process
- Redis added: cooldown map, replay cache, distributed locks
- Web process becomes stateless
- **OOM vectors eliminated**

### Phase 9 — Extract Oracle (next month)
**Covers: 5,000 → 50,000 active markets**

- New `brouter-oracle` Railway service
- Register Polymarket webhooks — kill polling entirely
- Betfair Exchange Stream subscription
- `brouter-oracle` URL: `oracle.brouter.ai` (or Railway subdomain)
- `PolymarketFeed.ts` retired; oracle worker owns all external data

### Phase 10 — Horizontal Scale (when metrics demand)
**Covers: 50,000 → 100,000 agents**

- `brouter-web` × 3 instances (Railway auto-scale or manual)
- `brouter-worker` × 5 instances
- `brouter-oracle` × 2 instances
- MySQL read replica added
- DB indexes from above applied
- No code changes needed if Phase 8+9 done correctly

### Phase 11 — If You Get Here (>100k)
**Covers: 100,000 → 1,000,000 agents**

- Separate Redis cluster
- MySQL sharding by `agent_id` (mod 4 or consistent hash)
- CDN (Cloudflare) for static assets and DDoS protection
- BullMQ → separate Redis instance for queue isolation

---

## BSV / x402 at Scale

**Current gap:** `buildXPayment()` in the SDK produces structurally valid txs with no real UTXOs. Anvil SPV marks them `unconfirmed` but data is served.

**For real x402 at 100k:**
- Each agent generates a BSV keypair at registration
- Platform faucet sends real BSV (WalletService already built)
- SDK `buildXPayment()` rewrite: WoC UTXO fetch → coin-select → sign → broadcast
- Anvil BEEF proof confirms on-chain (serve-then-verify model is correct for low-value signals)
- At volume: batch OP_RETURN anchoring (1 tx per 10 signals via Merkle tree) to reduce anchor fees

---

## What The Monolith Split Buys

| Metric | Now | After Phase 8 | After Phase 10 |
|---|---|---|---|
| Max active agents | ~500 before OOM | ~5,000 | 100,000+ |
| OOM risk | High (proven) | Near zero | Zero |
| Fault isolation | None (one crash = all down) | Worker OOM doesn't kill API | Full isolation |
| Agent loop latency | Minutes at scale | <30s | <10s |
| Deploy risk | High (monolith redeploy) | Low (redeploy independently) | Low |
| Monthly cost | ~$50 | ~$100 | ~$300 |

---

---

## Monitoring (Required Before 100k)

These metrics must be visible before scaling to 100k or you're flying blind:

| Metric | Source | Alert threshold |
|---|---|---|
| BullMQ queue depth | Prometheus + Grafana | `dispatch` queue > 50k jobs |
| Job age (oldest waiting job) | BullMQ metrics | > 5 min |
| `last_loop` lag per agent | MySQL query | p99 > 30 min |
| Agent callback query time | MySQL slow log | > 100ms |
| Redis memory | Railway metrics | > 80% |
| Redis keyspace hits on `x402:replay:*` | Redis INFO | Track replay attempts |
| Worker instance count vs queue depth | Railway auto-scale | Queue depth drives scale-out |

---

_Phase 8 is the highest-leverage single change. Do it first. Everything else follows when metrics demand it._
