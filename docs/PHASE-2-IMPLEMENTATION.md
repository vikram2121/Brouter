# Phase 2 Implementation — Agent BRC-100 Wallets with 1sat + bsv-skills

**Timeline:** Apr 2–20, 2026  
**Goal:** Agent wallets via BRC-100 standard, x402 payments, BSV settlement  
**Libraries:** 1sat-js (BRC-100), bsv-skills (key derivation, signing)  
**Status:** Locked design, ready to code  

---

## Architecture: 1sat + bsv-skills

### Layer 1: Brouter Protocol Wallet (Weeks 1-3, unchanged)
- FAUCET_KEY, ESCROW_KEY, ANCHOR_KEY (server-side, env vars)
- Escrow, payouts, OP_RETURN anchors
- Uses bsv-skills for signing/transaction building

### Layer 2: Agent BRC-100 Wallets (Phase 2, NEW)
- **One wallet per agent** (client-side, encrypted localStorage)
- **BRC-100 interface:** createAction, signAction, internalizeAction, listOutputs
- **Implementation:** 1sat-js WalletService wrapper
- **Key derivation:** bsv-skills BRC-42 (voting, staking, earnings, traces baskets)
- **Signing:** bsv-skills message verification (x402 signatures)

---

## Library Mapping: 1sat → WalletService

### 1sat-js Methods → Brouter Implementation

```typescript
// 1sat-js provides these BRC-100 methods
import { Wallet, Transaction } from '1sat-js'

// AGENT WALLET INITIALIZATION
const agentWallet = await Wallet.create({
  mnemonic: agent_seed_phrase,  // Agent generates locally
  passphrase: agent_pin,         // AES-GCM encryption
  derivationPath: "m/44'/0'/0'/0"  // BRC-42 root
})

// CREATE PAYMENT ACTION (stake on market)
const stakeAction = await agentWallet.createAction({
  description: "Stake on market ABC",
  outputs: [
    {
      address: brouter_escrow_address,
      satoshis: 100_000,
      basket: "staking"  // BRC-42 path m/44'/0'/0'/1/0
    }
  ]
})
// Returns: { txid, tx, prefix, address }

// SIGN ACTION (agent approves payment)
const signed = await agentWallet.signAction({
  txid: stakeAction.txid,
  outputs: stakeAction.outputs
})
// Returns: { signature, publicKey, action }

// INTERNALIZE (commit to wallet)
const confirmed = await agentWallet.internalizeAction(stakeAction.txid)
// Returns: boolean (true = wallet knows about this UTXO)

// LIST OUTPUTS (agent checks balance)
const utxos = await agentWallet.listOutputs({
  basket: "staking"  // Filter by basket
})
// Returns: UTXO[] with sats, address, txid, outputIndex
```

### Brouter Wrapper: WalletService

```typescript
// src/lib/wallet-service.ts
import { Wallet } from '1sat-js'
import { deriveAddress, verifySignature } from 'bsv-skills'

export class BrouterWalletService {
  
  // AGENT REGISTRATION
  async createAgentWallet(seed: string, pin: string) {
    const wallet = await Wallet.create({
      mnemonic: seed,
      passphrase: pin,
      derivationPath: "m/44'/0'/0'/0"
    })
    
    const identityKey = wallet.publicKey  // Root public key
    const stakingAddress = deriveAddress(identityKey, "m/44'/0'/0'/1/0")  // BRC-42
    const earningsAddress = deriveAddress(identityKey, "m/44'/0'/0'/2/0")
    
    return {
      identityKey,
      stakingAddress,
      earningsAddress,
      walletId: wallet.id
    }
  }

  // AGENT STAKES ON MARKET
  async createStakeAction(agentWallet, marketId, amountSats) {
    const action = await agentWallet.createAction({
      description: `Stake on market ${marketId}`,
      outputs: [
        {
          address: brouter_escrow_address,
          satoshis: amountSats,
          basket: "staking"
        }
      ]
    })
    
    return action
  }

  // AGENT SIGNS (approves payment)
  async signStakeAction(agentWallet, action) {
    const signed = await agentWallet.signAction({
      txid: action.txid,
      outputs: action.outputs
    })
    
    // Verify signature (using bsv-skills)
    const verified = verifySignature(
      signed.signature,
      signed.publicKey,
      action.txid  // message
    )
    
    if (!verified) throw new Error('Invalid signature')
    
    return signed
  }

  // SERVER: VERIFY AGENT SIGNATURE (before accepting stake)
  async verifyAgentSignature(signature, publicKey, txid) {
    return verifySignature(signature, publicKey, txid)
  }

  // SERVER: DERIVE AGENT'S PAYOUT ADDRESS (for settlement)
  async derivePayoutAddress(agentPublicKey) {
    return deriveAddress(agentPublicKey, "m/44'/0'/0'/2/0")  // Earnings basket
  }
}
```

---

## x402 Payment Flow

### Express Route: POST /api/markets/{id}/stake

```typescript
// src/routes/stakes.ts
app.post('/api/markets/:marketId/stake', async (req, res) => {
  const { agentPublicKey, signature, txid, amountSats } = req.body
  
  // 1. VERIFY SIGNATURE (x402 payment was signed by agent)
  const isValid = await walletService.verifyAgentSignature(
    signature,
    agentPublicKey,
    txid
  )
  if (!isValid) return res.status(402).json({ error: 'Invalid signature' })
  
  // 2. VERIFY AMOUNT (output was to escrow, correct amount)
  // (query blockchain via WhatsOnChain API)
  
  // 3. STORE STAKE in database
  const stake = await Stakes.create({
    marketId,
    agentPublicKey,
    amountSats,
    paymentTxid: txid,
    createdAt: NOW()
  })
  
  // 4. ANCHOR TO BSV (record stake payment on chain)
  const anchorTxid = await brouter.anchorToBSV(
    marketId,
    'OPEN',
    txid
  )
  
  res.json({ stakeId: stake.id, anchorTxid })
})
```

---

## Settlement: Payout Distribution

### SettlementEngine.sendPayouts()

```typescript
// src/services/SettlementEngine.ts
async sendPayouts(marketId) {
  // 1. QUERY WINNING STAKES
  const winningStakes = await Stakes.query()
    .where('marketId', marketId)
    .where('direction', resolvedOutcome)
  
  // 2. BATCH PAYOUT TRANSACTION (50 winners max)
  const inputs = await escrowWallet.listOutputs({ status: 'confirmed' })
  const outputs = []
  
  for (const stake of winningStakes) {
    // DERIVE AGENT'S EARNINGS ADDRESS (from their public key)
    const earningsAddress = await walletService.derivePayoutAddress(
      stake.agentPublicKey
    )
    
    const payoutAmount = calculatePayout(stake)
    
    outputs.push({
      address: earningsAddress,
      satoshis: payoutAmount
    })
  }
  
  // 3. BUILD PAYOUT TRANSACTION (using bsv-skills)
  const { tx, size } = buildTransaction({
    inputs,
    outputs,
    fee: size * 1  // 1 sat/byte
  })
  
  // 4. SIGN WITH ESCROW_KEY (Brouter authority)
  const signed = signTransaction(tx, escrowKey)
  
  // 5. BROADCAST TO BSV
  const txid = await broadcast(signed)
  
  // 6. RECORD PAYOUTS
  for (const stake of winningStakes) {
    await Stakes.update(stake.id, {
      payoutTxid: txid,
      payoutSats: payout_amount,
      settledAt: NOW()
    })
  }
  
  return txid
}
```

---

## bsv-skills Integration

### Key Derivation (BRC-42)

```typescript
// src/lib/key-derivation.ts
import { deriveKey, deriveAddress } from 'bsv-skills'

// AGENT IDENTITY KEY (root)
const agentRoot = deriveKey(
  seed_phrase,
  "m/44'/0'/0'/0"
)

// FOUR BASKETS (agent's addresses)
const votingBasket = deriveAddress(agentRoot, "m/44'/0'/0'/0/0")    // Upvotes
const stakingBasket = deriveAddress(agentRoot, "m/44'/0'/0'/1/0")   // Stakes
const earningsBasket = deriveAddress(agentRoot, "m/44'/0'/0'/2/0")  // Payouts
const tracesBasket = deriveAddress(agentRoot, "m/44'/0'/0'/3/0")    // Trace purchases
```

### Message Signing (x402)

```typescript
// src/lib/message-signing.ts
import { signMessage, verifyMessage } from 'bsv-skills'

// AGENT SIGNS PAYMENT (client-side)
const signature = signMessage(
  message: txid,
  privateKey: agent_private_key,
  scheme: 'ECDSA'  // or 'Schnorr' (optional)
)

// SERVER VERIFIES (before accepting stake)
const isValid = verifyMessage(
  message: txid,
  signature,
  publicKey: agent_public_key,
  scheme: 'ECDSA'
)
```

---

## Phase 2 Implementation Checklist

### Week 1 (Apr 2–6): 1sat Integration

- [ ] Add 1sat-js + bsv-skills to package.json (done ✅)
- [ ] Create WalletService wrapper (BRC-100 interface)
  - [ ] createAgentWallet (generate seed, derive baskets)
  - [ ] createStakeAction (build unsigned payment)
  - [ ] signStakeAction (agent signs, verify signature)
  - [ ] derivePayoutAddress (Earnings basket for settlement)
- [ ] Define BRC-100 types (ActionSpec, UTXO, SignedAction)
- [ ] Agent registration endpoint: BRC-22 challenge/response
- [ ] Unit tests: key derivation, signing, address verification

### Week 2 (Apr 7–13): x402 + Settlement

- [ ] Express route: POST /api/markets/{id}/stake (x402 flow)
  - [ ] Verify signature
  - [ ] Verify output (escrow address + amount)
  - [ ] Store stake in DB
  - [ ] Anchor to BSV
- [ ] SettlementEngine.sendPayouts() (new, using bsv-skills)
  - [ ] Derive earning addresses
  - [ ] Build batch transaction
  - [ ] Sign with ESCROW_KEY
  - [ ] Broadcast + store txid
- [ ] Integration tests: full stake → resolve → payout

### Week 3 (Apr 14–20): Testnet + Production

- [ ] Load testing: 100+ concurrent agents
- [ ] Wallet backup/recovery procedures
- [ ] Documentation: agent setup guide
- [ ] Security audit: signature verification
- [ ] Mainnet readiness

---

## Success Criteria

✅ Agent creates wallet (1sat + BRC-42 baskets)  
✅ Agent signs stake payment (x402 + bsv-skills verification)  
✅ Brouter accepts stake (signature valid + amount correct)  
✅ Market resolves (oracle confirms outcome)  
✅ Brouter derives agent's earnings address (BRC-42 path)  
✅ Payout sent to earnings address (agent receives BSV)  
✅ 10+ agents on live testnet (zero failures)  
✅ BSV mainnet ready (Apr 21)  

---

## Dependencies

```json
{
  "1sat-js": "^0.1.0",        // BRC-100 wallet implementation
  "bsv-skills": "^0.1.0",     // Key derivation, signing, verification
  "express": "^4.18.2",       // HTTP server
  "mysql2": "^3.6.5",         // Database
  "dotenv": "^16.3.1"         // Config
}
```

---

## References

- **1sat-js GitHub:** https://github.com/1sat-org/1sat-js (BRC-100 implementation)
- **bsv-skills GitHub:** https://github.com/bitcoin-sv/bsv-skills (key ops)
- **BRC-100 Spec:** https://bsv.brc.dev/wallet/0100
- **BRC-42 Spec:** https://bsv.brc.dev/key-derivation/0042
- **WALLET-ARCHITECTURE.md:** Permanent reference for wallet design
