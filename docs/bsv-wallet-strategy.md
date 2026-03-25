# BSV Wallet & Key Management Strategy

**Status:** Design Phase (implement Week 3)  
**Scope:** Brouter protocol wallet, agent payouts, transaction signing  
**Deadline:** Mar 22 (finalize design), Mar 28 (implement)

**See Also:** `WALLET-ARCHITECTURE.md` (permanent reference for how wallets interact and BSV flows through system)

---

## Overview

Brouter holds agent stakes in escrow and distributes payouts after settlement. All movements are anchored on BSV.

**Three wallet concerns:**
1. **Brouter Protocol Wallet** — holds escrow, sends payouts, anchors market decisions
2. **Agent BSV Addresses** — where agents receive winnings
3. **Transaction Signing** — secure signing of OP_RETURN anchors and payout transactions

---

## Brouter Protocol Wallet

### Generation (Week 3, Task 0)

**Option A: Fresh HD Wallet (Recommended)**
```javascript
const bsv = require('bsv');

// Generate new hierarchical deterministic (HD) wallet
const mnemonic = bsv.Mnemonic.fromRandom();
const xprv = mnemonic.toHDPrivateKey();
const xpub = xprv.hdPublicKey;

// Derive first non-hardened key for Agent payouts
const payoutKey = xprv.derive("m/44'/0'/0'/0/0");
const payoutAddress = payoutKey.publicKey.toAddress().toString();

// Store securely
process.env.BROUTER_BSV_XPRV = xprv.toString();
process.env.BROUTER_PAYOUT_ADDRESS = payoutAddress;
```

**Option B: Single Key (Simpler)**
```javascript
const key = bsv.PrivateKey.fromRandom();
const address = key.publicAddress;

process.env.BROUTER_BSV_PRIVATE_KEY = key.toString();
process.env.BROUTER_BSV_ADDRESS = address;
```

**Recommendation:** Option A (HD wallet)
- Allows key rotation without changing agent payouts
- Can derive separate keys per domain/tier
- Better for multi-sig if needed later

---

## Agent Wallet Registration

### In agent.md Spec

Add to agent profile:

```yaml
Agent:
  id: string                          # UUID or public key hash
  name: string                        # Display name
  description: string                 # Bio/credentials
  publicKey: string (hex)             # Ed25519 or secp256k1 (for verification)
  
  # NEW: Wallet address
  bsvAddress: string (optional)       # e.g., "bitcoincash:qz2..."
  addressVerifiedAt: timestamp        # When agent proved ownership
  addressVerificationTx: string       # BSV tx proving agent signature
```

### Address Verification Flow

**Day 1: Agent registers**
```
1. Agent provides BSV address (gets from wallet app)
2. Brouter generates random challenge: rand256()
3. Brouter stores unverified: agents.bsvAddress, agents.addressVerificationTx = NULL
```

**Day 2: Agent proves ownership**
```
1. Brouter sends: "Sign this message with your BSV key: {challenge}"
2. Agent signs in their wallet app (Handcash, BSV wallet, etc.)
3. Agent submits signature + address
4. Brouter verifies: publicKey_recover(message, signature) == address
5. If valid: set agents.addressVerifiedAt = NOW()
6. If invalid: reject, ask agent to try again
```

**Week 4 Staking:**
```
When agent stakes, settlement engine checks:
- addressVerifiedAt IS NOT NULL (address is verified)
- Otherwise: reject stake, "Please verify BSV address first"
```

---

## Payout Transaction Flow

### Settlement Phase (Week 3, SettlementEngine.sendPayouts)

**Input:** List of {agentId, payoutSats}

```javascript
async function sendPayouts(settlements: SettlementInstruction[]): Promise<string[]> {
  // 1. Group payouts by agent
  const agentPayouts = groupBy(settlements, 'agentId');
  
  // 2. Fetch agent BSV addresses from agents table
  const addresses = await db.query(`
    SELECT id, bsvAddress, payoutSats
    FROM agents
    WHERE id IN (${agentIds})
      AND bsvAddress IS NOT NULL
      AND addressVerifiedAt IS NOT NULL
  `);
  
  // 3. Batch payouts (50 agents per tx for cost efficiency)
  const batches = chunk(addresses, 50);
  const txids = [];
  
  for (const batch of batches) {
    // Build transaction
    const tx = new bsv.Transaction();
    let totalInput = 0;
    
    // Add inputs from Brouter's UTXO pool
    const utxos = await getBrouterUTXOs(
      sum(batch, 'payoutSats') + 1000  // + fee
    );
    
    for (const utxo of utxos) {
      tx.from(utxo);
      totalInput += utxo.satoshis;
    }
    
    // Add outputs (one per agent)
    for (const agent of batch) {
      tx.to(agent.bsvAddress, agent.payoutSats);
    }
    
    // Add change back to Brouter
    const fee = estimateFee(tx.size);
    const change = totalInput - sum(batch, 'payoutSats') - fee;
    if (change > 0) {
      tx.to(BROUTER_PAYOUT_ADDRESS, change);
    }
    
    // Sign with Brouter's key
    tx.sign(BROUTER_BSV_PRIVATE_KEY);
    
    // Broadcast
    const txid = await broadcast(tx);
    txids.push(txid);
    
    // Log: stakes.payoutTxid = txid
    await db.query(`
      UPDATE stakes
      SET payoutTxid = %s
      WHERE agentId IN (${batch.map(a => a.id)})
        AND state = 'SETTLED'
    `, txid);
  }
  
  return txids;
}
```

---

## On-Chain Anchors (Market Decisions)

### OP_RETURN Format

Every state transition (except PROPOSED) requires an on-chain anchor:

```
OP_RETURN
  "BROUTER"
  "{market_id}"
  "{state_transition}" (e.g., "OPEN")
  "{timestamp}"
  "{outcome}" (if RESOLVING/SETTLED, else "")
```

**Example (market resolves YES):**
```
OP_RETURN "BROUTER" "market_abc123" "RESOLVING" "1711057200" "yes"
```

**Cost:** ~150 bytes ≈ 75 satoshis per anchor

### Implementation (Week 3, SettlementEngine.anchorToBSV)

```javascript
async function anchorToBSV(
  marketId: string,
  toState: string,
  outcome?: Outcome
): Promise<string> {
  const tx = new bsv.Transaction();
  
  // Input: Brouter's UTXO (dust amount + fee)
  const utxo = await getBrouterUTXO(1000);  // 1000 sats
  tx.from(utxo);
  
  // OP_RETURN output
  const script = bsv.Script.buildDataOut([
    Buffer.from("BROUTER"),
    Buffer.from(marketId),
    Buffer.from(toState),
    Buffer.from(Math.floor(Date.now() / 1000).toString()),
    outcome ? Buffer.from(outcome.toLowerCase()) : Buffer.alloc(0)
  ]);
  
  tx.addOutput(new bsv.Transaction.Output({
    script: script,
    satoshis: 0  // OP_RETURN outputs have 0 value
  }));
  
  // Change back to Brouter
  const fee = 100;
  const change = utxo.satoshis - fee;
  if (change > 0) {
    tx.to(BROUTER_PAYOUT_ADDRESS, change);
  }
  
  // Sign & broadcast
  tx.sign(BROUTER_BSV_PRIVATE_KEY);
  const txid = await broadcast(tx);
  
  log.info("anchor_created", marketId, toState, txid);
  return txid;
}
```

---

## Key Storage (Development vs Production)

### Development (Week 3–4)

**Store in `.env`:**
```bash
# .env.local
BROUTER_BSV_XPRV="xprv_..."
BROUTER_BSV_ADDRESS="bsv_..."
BROUTER_PAYOUT_ADDRESS="bsv_..."
```

**Risk:** Low (testnet, small amounts)

### Production (Post-Apr 1)

**Options:**

**A: AWS Secrets Manager** (Recommended)
```javascript
const secret = await secretsManager.getSecretValue({
  SecretId: "brouter/bsv/xprv"
});
const xprv = JSON.parse(secret.SecretString).xprv;
```

**B: Hardware Wallet** (Most Secure)
- Ledger + Trezor SDK
- Keys never leave hardware
- Slower (network latency for each signature)

**C: AWS KMS** (Encryption at rest)
```javascript
const encrypted = kms.encrypt({ Key: "alias/brouter-bsv", Plaintext: xprv });
// Decrypt only when signing
```

**Recommendation for MVP:** AWS Secrets Manager
- No hardware required
- Scales to millions of requests
- Audit trail built-in

---

## UTXO Management

### Brouter's UTXO Pool

Brouter needs liquid UTXOs to:
1. Pay agents (small, frequent)
2. Anchor decisions (tiny OP_RETURNs)
3. Fund x402 payments

**Strategy:**

```javascript
async function maintainUTXOPool() {
  const minUTXOs = 100;  // Always have 100+ UTXOs ready
  const utxoAmount = 5000;  // Each ~5000 sats
  
  const current = await getBrouterUTXOCount();
  
  if (current < minUTXOs) {
    // Consolidate: send change outputs back to self
    const consolidation = new bsv.Transaction();
    
    const dustUTXOs = await getBrouterUTXOsUnder(1000);  // < 1000 sats
    for (const utxo of dustUTXOs) {
      consolidation.from(utxo);
    }
    
    const totalDust = sum(dustUTXOs, 'satoshis');
    const fee = 200;
    
    // Consolidate into one fresh output
    consolidation.to(BROUTER_PAYOUT_ADDRESS, totalDust - fee);
    consolidation.sign(BROUTER_BSV_PRIVATE_KEY);
    
    await broadcast(consolidation);
    log.info("utxo.consolidated", dustUTXOs.length);
  }
}
```

Runs as cron job every hour.

---

## Security Considerations

### Key Rotation (Post-MVP)

If key is compromised:
```
1. Generate new XPRV
2. Derive new payout address
3. Agents update their registered address to new Brouter address
4. Migrate old agent balances via special transaction
5. Old key marked as revoked in audit log
```

### Multi-Sig (Post-MVP)

For mainnet (>$100k TVL):
```
Brouter 2-of-3 multisig:
- Vikram's hardware wallet (signer 1)
- Operations key in AWS KMS (signer 2)
- Backup key in secure vault (signer 3)

Requires 2 signatures for any payout or anchor.
```

### Rate Limits

```javascript
const rateLimiter = {
  maxPayoutsPerDay: 1_000_000_000,  // 10 BSV/day
  maxSinglePayout: 100_000_000,     // 1 BSV max
  maxAnchorsPerHour: 1000,
  maxTxsPerBlock: 10
};

// Checked before signing any transaction
```

---

## Testing Strategy (Week 3, Task 1)

### Unit Tests

```javascript
// test/bsv-wallet.test.js
describe("BSV Wallet", () => {
  it("generates HD wallet from seed", () => {
    // Mock xprv generation
    // Verify key derivation
  });
  
  it("signs transactions with private key", () => {
    // Create mock transaction
    // Sign with test key
    // Verify signature
  });
  
  it("constructs OP_RETURN correctly", () => {
    // Build OP_RETURN with market data
    // Verify script encoding
  });
  
  it("batches payouts (50 agents per tx)", () => {
    // Mock 150 agents
    // Verify 3 transactions created
  });
  
  it("handles insufficient UTXOs", () => {
    // Mock empty UTXO pool
    // Verify error handling, no broadcast
  });
});
```

### Integration Tests (Week 3, Task 2)

```javascript
// test/settlement-e2e.test.js
describe("Settlement with BSV", () => {
  it("anchors market resolution on-chain", async () => {
    // Create market, resolve it
    // Check: market_state_log.anchorTxid populated
    // Check: OP_RETURN tx found on BSV testnet
  });
  
  it("sends agent payouts in batches", async () => {
    // Settle market with 150 agents
    // Check: 3 payout txs created
    // Check: all agents appear in some tx
    // Check: stakes.payoutTxid populated
  });
  
  it("maintains UTXO pool", async () => {
    // Send 50 payouts
    // Check: UTXO count maintained
  });
});
```

---

## Checklist (Week 3)

- [ ] Generate Brouter protocol wallet (HD seed stored in env)
- [ ] Design agent address verification flow
- [ ] Implement anchorToBSV() (OP_RETURN construction + signing)
- [ ] Implement sendPayouts() (batching, UTXO selection)
- [ ] Implement maintainUTXOPool() (consolidation cron)
- [ ] Add agent.bsvAddress to agents table schema
- [ ] Add address verification table (agents_bsv_verification)
- [ ] Write unit tests (wallet, signing, batching)
- [ ] Write integration tests (E2E with testnet)
- [ ] Document key rotation procedure
- [ ] Document multi-sig setup for post-MVP

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|-----------|
| Private key compromised | Low | Critical | Rotate key, migrate balances |
| Insufficient UTXOs | Medium | High | maintainUTXOPool() cron |
| BSV network congestion | Low | Medium | Batch payouts, adjust fees |
| Agent provides invalid address | Medium | Low | Address verification before payout |
| Double-spend via reorg | Very Low | Medium | Wait 6 confirmations before settling |

---

## Timeline

**Week 3 (Mar 25–29):**
- Day 1–2: Generate wallet, design agent verification
- Day 3–4: Implement anchorToBSV + sendPayouts
- Day 5: Testing + documentation

**Post-MVP (Apr 2+):**
- Multi-sig for production
- Hardware wallet integration
- Key rotation procedures
- Monitoring + alerting

---

## References

- BSV docs: https://docs.bitcoinsv.io/
- bsv.js: https://www.npmjs.com/package/bsv
- Testnet faucet: https://testnet-faucet.bitcoinsv.io/
- OP_RETURN standard: https://wiki.bitcoinsv.io/index.php/RETURN

---

## Questions for Vikram

1. **Mainnet or Testnet for launch?** (Mar 22, launch on testnet; move to mainnet post-Apr 1?)
2. **Hardware wallet now or later?** (MVP: env var in AWS Secrets; production: Ledger?)
3. **Multi-sig threshold?** (MVP: single key; production: 2-of-3?)
4. **Max BSV in Brouter escrow per day?** (Security limit, default 10 BSV)
5. **Agent address verification:** Email OTP or BSV signature required?
