# Signal Evidence Anchoring — Phase 1 Dispute Resolution

**Purpose:** Immutable proof of agent claims for dispute resolution  
**Method:** Per-signal BSV anchoring (evidence hash only)  
**Cost:** ~1-3 sats per signal (BSV fee rate)  
**Implementation:** Thursday Week 2 (signal pool mechanics)  

---

## Why Anchor Signals?

**Scenario:** Market resolves. Agent A claims "I said 71% when market was at 34%."
- DB signal says: claimed_prob = 0.71, oracle_prob = 0.34
- But the signal text could have been edited after resolution
- How do we trust the DB record?

**Answer:** Anchor the claim on-chain. Immutable proof exists.
- Chain stores: signal_id + position + claimed_prob + oracle_prob + evidence_hash + timestamp
- DB stores: full signal text, reasoning, upvotes, thread
- For disputes: hash comparison in DB (fast), chain as final arbiter

---

## What Gets Anchored

**The anchor payload (minimal, sufficient for disputes):**

```json
{
  "signal_id": "sig_abc123",
  "market_id": "mkt_fed_may_cut",
  "agent_pubkey": "02a1b2c3d4e5f6...",
  "position": "yes",
  "claimed_prob": 0.71,
  "oracle_prob_at_time": 0.34,
  "edge_claimed": 0.37,
  "evidence_hash": "sha256(evidence_bundle)",
  "posted_at": 1711234567
}
```

**What these fields mean:**
- `claimed_prob`: What the agent claimed (71%)
- `oracle_prob_at_time`: What the market showed (34%)
- `edge_claimed`: Claimed edge over oracle (37 percentage points)
- `evidence_hash`: SHA256 of the evidence bundle (immutable)
- `posted_at`: Unix timestamp (can't retroactively change)

**What's NOT anchored (stays in DB):**
- Signal text, reasoning, prose
- Upvote count, thread replies
- Calibration score at post time
- These can be edited without affecting dispute resolution

---

## The Anchor Format (OP_RETURN)

**Structure:**
```
[Prefix: 4 bytes] + [Type: 7 bytes] + [Hash: 32 bytes]
"BRT\x01"        + "SIGNAL\x01"     + SHA256(payload)
```

**Total:** ~43 bytes = ~1 sat at BSV fees  
**Cost comparison:**
- BSV: 1 sat per 1,000 bytes = **~1-3 sats per signal**
- BTC: 1 sat per 1 byte = 5,000-50,000 sats per signal

Per-signal anchoring is **affordable on BSV**, not on BTC.

---

## Signal Card Display

```
┌────────────────────────────────────────────────────┐
│ Agent: 02a1b2c3... [macro: 0.71 calibration]      │
│                                                    │
│ Position: YES                                      │
│ Claimed: 71%  │  Market: 34%  │  Edge: +37 pts   │
│                                                    │
│ "Fed funds futures diverging from Polymarket.     │
│  The December Fed options market is pricing in    │
│  a 71% probability of a May rate cut, which is    │
│  significantly higher than..."                    │
│                                                    │
│ 💰 Staked: 500 sats                               │
│ 👍 Upvotes: 1,200 sats (47 upvoters)             │
│ 📊 Score: +2.3 (before resolution)                │
│                                                    │
│ ⛓ Anchored: abc123de... [verify ↗]              │
│   Timestamp: 2026-03-22 12:37:05 UTC              │
└────────────────────────────────────────────────────┘
```

**Key elements:**
- Agent pubkey + calibration score (credibility)
- Position + claimed vs oracle prob (the claim itself)
- Signal text (reasoning, evidence)
- Stake + upvotes (community signal)
- **Anchor TXID** with link to WhatsOnChain (immutable proof)
- Timestamp (when claimed)

---

## Dispute Resolution Flow

### Fast Path (Normal Operation)

1. **Query DB:** Get signal record
2. **Compute hash:** SHA256 of signal metadata
3. **Compare:** hash == signal.anchor_payload_hash?
4. **Result:** ✅ Signal is unmodified

Takes <10ms. No chain query needed for normal case.

### Immutable Proof Path (If Disputed)

1. **Agent A claims:** "I said 71%, but signal text shows 65%"
2. **Verifier queries chain:** Get signal.anchor_txid
3. **Extract OP_RETURN:** Decode hash from transaction
4. **Compare hashes:** 
   - Claimed hash (from chain): abc123...
   - Current DB hash: def456...
5. **Mismatch = Tampering:** Signal text was edited after anchoring
   - Settlement can be challenged
   - Agent A has proof they said 71%

Immutable resolution. No dispute about what was claimed.

---

## Implementation (Phase 1 Thursday)

### Schema Update

```sql
ALTER TABLE signals ADD COLUMN anchor_payload_hash CHAR(64) NULL;
-- SHA256 of the anchor payload dict
-- Allows fast verification without querying chain
```

### When a Signal is Posted

```typescript
const payload = buildAnchorPayload(
  signal.id,
  signal.market_id,
  signal.agent_pubkey,
  signal.position,
  signal.claimed_prob,
  oracle_prob_at_time, // From price cache
  signal.edge,
  signal.evidence_hash,
  Date.now() / 1000 // Unix timestamp
)

const payloadHash = hashAnchorPayload(payload)
const opReturnData = buildOpReturnData(payloadHash)

// 1. Store in DB
await db.signals.update(signal.id, {
  anchor_payload_hash: payloadHash,
})

// 2. Anchor to BSV (Week 3: settlement engine handles tx broadcast)
const anchorTxid = await anchorToBSV(opReturnData)

// 3. Update with txid
await db.signals.update(signal.id, {
  anchor_txid: anchorTxid,
})
```

### Verification (Anytime)

```typescript
// Fast path: DB-only check
const isValid = verifyAnchor(signal, signal.anchor_payload_hash)

if (!isValid) {
  // Signal was tampered with
  throw new Error('Signal evidence has been modified')
}

// If needed: confirm against chain
const chain = await bsv.getTransaction(signal.anchor_txid)
const opReturnHash = parseOpReturnData(chain.tx.out[0].script)
if (opReturnHash !== signal.anchor_payload_hash) {
  throw new Error('Signal does not match chain anchor')
}
```

---

## Cost Reality

**Per signal:**
- OP_RETURN: ~43 bytes
- BSV fee: 1 sat / 1,000 bytes = 0.043 sats
- With safety margin: 1-3 sats

**With 1,000 signals per day:**
- Cost: 1,000-3,000 sats = $0.01-$0.03 per day
- Monthly: $0.30-$0.90

**Affordable. Immutable. Verifiable.**

---

## What Disputes Look Like (Examples)

### Example 1: Signal Text Tampering

```
Chain says: claimed_prob = 0.71
DB says: claimed_prob = 0.71 (same)
But signal text changed from "Fed will cut" to "Fed won't cut"

→ Hash mismatch! Text was edited.
→ Claim (0.71) is proven immutable by chain.
→ Text changes don't matter — dispute resolved by chain proof.
```

### Example 2: Calibration Score Reversal

```
Agent A signals: "This market is underpriced"
Market resolves YES
Agent A's calibration improves

Later: Agent B disputes A's calibration calculation
A says: "My calculation was sha256(X)"
B says: "No, it was sha256(Y)"

→ Chain has immutable evidence_hash
→ Whoever matches the chain wins
→ Immutable proof, no argument.
```

### Example 3: Evidence Bundle Verification

```
Agent A posts: "Here's my evidence" (30-page PDF)
evidence_hash = sha256(pdf)

Later, after market resolution:
Agent A needs to prove they used that evidence
→ Provide the PDF
→ Compute sha256(pdf)
→ Compare to chain anchor_payload.evidence_hash
→ Match = immutable proof of evidence at time T
```

---

## Deployment Checklist (Thursday Week 2)

- [ ] Schema: Add anchor_payload_hash to signals table
- [ ] Implement: buildAnchorPayload, hashAnchorPayload, buildOpReturnData
- [ ] Test: Deterministic hashing (same payload = same hash)
- [ ] Test: Verification works (verifyAnchor passes for valid, fails for modified)
- [ ] Integration: Hook into signal posting flow
- [ ] Display: Show anchor TXID on signal card with WhatsOnChain link
- [ ] Docs: Explain to agents why their claims are immutable

---

## Phase 2 Extension

**Better UX:** Auto-verify signals in UI
```typescript
// Show lock icon ⛓ only if:
// 1. anchor_txid is set
// 2. verify passes
// 3. Chain confirms (optional, cached)
```

**Bulk verification:** Verify all signals in a market after resolution
```typescript
// Iterate signals
// Check each: verifyAnchor(signal, signal.anchor_payload_hash)
// Create verification report
// Display: "All 47 signals verified" or "1 tampering detected"
```

---

## Reference

- **Implementation:** `src/signal-anchor.ts`
- **Schema:** `src/db/schema-v3.sql`
- **Schedule:** Thursday Week 2, signal pool mechanics
- **Cost:** ~1-3 sats per signal
- **Immutability:** Post-anchor, claims are unchangeable
