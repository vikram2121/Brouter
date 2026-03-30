/**
 * WalletService
 * Handles real BSV transactions: faucet sends, future settlement payouts,
 * and OP_RETURN signal anchoring (Brouter covers the fee, agent signs the claim).
 * Uses bsv library for signing + WhatsOnChain for UTXO fetching and broadcast.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const bsv = require('bsv')
import { buildAnchorPayload, hashAnchorPayload, buildOpReturnData } from '../signal-anchor'

export interface UTXO {
  txid: string
  vout: number
  satoshis: number
  script: string
}

export class WalletService {
  private wif: string
  private address: string

  constructor() {
    this.wif = process.env.BROUTER_BSV_PRIVATE_KEY || ''
    if (this.wif) {
      try {
        const privKey = bsv.PrivKey.fromWif(this.wif)
        const pubKey = bsv.PubKey.fromPrivKey(privKey)
        this.address = bsv.Address.fromPubKey(pubKey).toString()
      } catch {
        console.error('[WalletService] Invalid BROUTER_BSV_PRIVATE_KEY — falling back to mock mode')
        this.address = ''
      }
    } else {
      this.address = ''
    }
    console.log('[WalletService] Initialized:', {
      realMode: !!this.wif && !!this.address,
      address: this.address || '(mock mode)',
    })
  }

  getAddress(): string {
    return this.address
  }

  isConfigured(): boolean {
    return !!this.wif && !!this.address
  }

  /**
   * Get wallet balance from WhatsOnChain
   */
  async getBalance(): Promise<{ confirmed: number; unconfirmed: number; total: number }> {
    if (!this.address) return { confirmed: 0, unconfirmed: 0, total: 0 }
    const res = await fetch(`https://api.whatsonchain.com/v1/bsv/main/address/${this.address}/balance`)
    if (!res.ok) throw new Error(`WhatsOnChain balance error: ${res.status}`)
    const data = await res.json() as { confirmed: number; unconfirmed: number }
    return { confirmed: data.confirmed || 0, unconfirmed: data.unconfirmed || 0, total: (data.confirmed || 0) + (data.unconfirmed || 0) }
  }

  /**
   * Fetch UTXOs from WhatsOnChain
   */
  async getUTXOs(): Promise<UTXO[]> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)
    const res = await fetch(
      `https://api.whatsonchain.com/v1/bsv/main/address/${this.address}/unspent`,
      { signal: controller.signal }
    )
    clearTimeout(timeout)
    if (!res.ok) throw new Error(`WhatsOnChain UTXO error: ${res.status}`)
    const utxos = await res.json() as Array<{ tx_hash: string; tx_pos: number; value: number }>
    return utxos.map(u => ({
      txid: u.tx_hash,
      vout: u.tx_pos,
      satoshis: u.value,
      script: bsv.Address.fromString(this.address).toTxOutScript().toHex()
    }))
  }

  /**
   * Send BSV to a recipient address.
   * Builds a real P2PKH transaction, signs it, and broadcasts via WhatsOnChain.
   * Falls back to mock TXID if wallet not configured (dev/test mode).
   *
   * @param to   Recipient BSV address
   * @param amountSats Amount in satoshis
   * @returns Real transaction TXID (or mock_ prefix in mock mode)
   */
  async sendBSV(to: string, amountSats: number): Promise<string> {
    if (!this.isConfigured()) {
      console.warn('[WalletService] No private key — returning mock TXID')
      return 'mock_' + Date.now()
    }

    // 1. Validate recipient address
    try {
      bsv.Address.fromString(to)
    } catch {
      throw new Error(`Invalid BSV recipient address: ${to}`)
    }

    // 2. Fetch UTXOs
    const utxos = await this.getUTXOs()
    if (!utxos.length) throw new Error('No UTXOs available in server wallet')

    // 3. Coin selection — smallest-first to keep UTXO set clean
    const FEE_PER_KB = 500 // sats/kb, conservative
    const ESTIMATED_TX_BYTES = 250 // typical P2PKH tx
    const fee = Math.ceil((ESTIMATED_TX_BYTES / 1000) * FEE_PER_KB)
    const needed = amountSats + fee

    const sorted = [...utxos].sort((a, b) => a.satoshis - b.satoshis)
    const selected: UTXO[] = []
    let totalIn = 0
    for (const u of sorted) {
      selected.push(u)
      totalIn += u.satoshis
      if (totalIn >= needed) break
    }
    if (totalIn < needed) {
      throw new Error(`Insufficient wallet balance: have ${totalIn} sats, need ${needed} (${amountSats} + ${fee} fee)`)
    }

    const change = totalIn - amountSats - fee

    // 4. Build transaction
    const privKey = bsv.PrivKey.fromWif(this.wif)
    const pubKey = bsv.PubKey.fromPrivKey(privKey)
    const fromAddr = bsv.Address.fromPubKey(pubKey)
    const toAddr = bsv.Address.fromString(to)

    const txBuilder = new bsv.TxBuilder()
    txBuilder.setFeePerKbNum(FEE_PER_KB)
    txBuilder.setChangeAddress(fromAddr)

    // Add inputs
    for (const u of selected) {
      const txHashBuf = Buffer.from(u.txid, 'hex').reverse()
      const scriptPubKey = fromAddr.toTxOutScript()
      txBuilder.inputFromPubKeyHash(
        txHashBuf,
        u.vout,
        bsv.TxOut.fromProperties(new bsv.Bn(u.satoshis), scriptPubKey)
      )
    }

    // Add output to recipient
    txBuilder.outputToAddress(bsv.Bn(amountSats), toAddr)

    // Build + sign
    txBuilder.build({ useAllInputs: true })
    txBuilder.signWithKeyPairs([bsv.KeyPair.fromPrivKey(privKey)])

    const tx = txBuilder.tx
    const txHex = tx.toHex()
    const txid = tx.id()

    console.log(`[WalletService] Broadcasting tx: ${txid} (${amountSats} sats → ${to})`)

    // 5. Broadcast via WhatsOnChain
    const broadcastRes = await fetch('https://api.whatsonchain.com/v1/bsv/main/tx/raw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txhex: txHex })
    })

    if (!broadcastRes.ok) {
      const errText = await broadcastRes.text()
      throw new Error(`Broadcast failed (${broadcastRes.status}): ${errText}`)
    }

    const broadcastedTxid = (await broadcastRes.json()) as string
    console.log(`[WalletService] ✅ Broadcast confirmed txid: ${broadcastedTxid}`)
    return broadcastedTxid || txid
  }

  /**
   * Anchor a signal on-chain via OP_RETURN.
   * Brouter pays the fee (~1-3 sats). The OP_RETURN contains:
   *   BRT\x01SIGNAL\x01 + SHA256(anchor payload)
   * where the anchor payload includes the agent's pubkey as authorship proof.
   *
   * Non-blocking — caller should fire-and-forget. Returns txid or null on failure.
   */
  async anchorSignal(opts: {
    signalId: string
    marketId: string
    agentPubkey: string
    position: 'yes' | 'no'
    claimedProb: number
    oracleProbAtTime: number
    edgeClaimed: number
    evidenceText: string
    postedAt: number
  }): Promise<string | null> {
    if (!this.isConfigured()) {
      console.warn('[WalletService] anchorSignal: no private key — skipping anchor')
      return null
    }

    try {
      const evidenceHash = require('crypto')
        .createHash('sha256')
        .update(opts.evidenceText || opts.signalId)
        .digest('hex')

      const payload = buildAnchorPayload(
        opts.signalId,
        opts.marketId,
        opts.agentPubkey,
        opts.position,
        opts.claimedProb,
        opts.oracleProbAtTime,
        opts.edgeClaimed,
        evidenceHash,
        opts.postedAt
      )

      const payloadHash = hashAnchorPayload(payload)
      const opReturnData = buildOpReturnData(payloadHash)

      // Fetch UTXOs for fee funding
      const utxos = await this.getUTXOs()
      if (!utxos.length) {
        console.warn('[WalletService] anchorSignal: no UTXOs — skipping anchor')
        return null
      }

      const privKey = bsv.PrivKey.fromWif(this.wif)
      const pubKey = bsv.PubKey.fromPrivKey(privKey)
      const fromAddr = bsv.Address.fromPubKey(pubKey)

      // Pick smallest UTXO >= 500 sats (enough for fee + dust)
      const ANCHOR_FEE = 500
      const utxo = utxos.sort((a: UTXO, b: UTXO) => a.satoshis - b.satoshis)
        .find((u: UTXO) => u.satoshis >= ANCHOR_FEE)

      if (!utxo) {
        console.warn('[WalletService] anchorSignal: no UTXO with enough sats for fee')
        return null
      }

      // Build tx: one input, one OP_RETURN output, change back to wallet
      const txHashBuf = Buffer.from(utxo.txid, 'hex').reverse()
      const scriptPubKey = fromAddr.toTxOutScript()

      // Build tx manually — TxBuilder rejects 0-sat OP_RETURN via isNonSpendable check
      // So we: build a change-only tx first, then inject the OP_RETURN output before signing
      const FEE_SATS = 150 // ~150 sats for anchor tx (246 bytes at ~0.6 sat/byte — 5x above BSV minimum)
      const OP_RETURN_SATS = 1 // BSV relay requires at least 1 sat on OP_RETURN outputs
      const changeSats = utxo.satoshis - FEE_SATS - OP_RETURN_SATS

      // OP_RETURN script — use fromOpReturnData (handles encoding correctly)
      const opReturnScript = bsv.Script.fromOpReturnData(opReturnData)

      const tx = new bsv.Tx()

      // Input
      tx.addTxIn(
        Buffer.from(utxo.txid, 'hex').reverse(),
        utxo.vout,
        new bsv.Script(), // empty — filled by signing below
        0xffffffff
      )

      // Output 0: OP_RETURN (1 sat — BSV relay rejects dust at 0)
      tx.addTxOut(new bsv.Bn(OP_RETURN_SATS), opReturnScript)

      // Output 1: change back to wallet
      tx.addTxOut(new bsv.Bn(changeSats), fromAddr.toTxOutScript())

      // Sign input: P2PKH scriptSig = <sig> <pubkey>
      const keyPair = bsv.KeyPair.fromPrivKey(privKey)
      const sig = tx.sign(
        keyPair,
        bsv.Sig.SIGHASH_ALL | bsv.Sig.SIGHASH_FORKID,
        0,
        scriptPubKey,
        new bsv.Bn(utxo.satoshis)
      )
      const scriptSig = new bsv.Script()
      scriptSig.writeBuffer(sig.toTxFormat())
      scriptSig.writeBuffer(pubKey.toBuffer())
      tx.txIns[0].setScript(scriptSig)
      const txHex = tx.toHex()
      const txid = tx.id()

      // Broadcast via WhatsOnChain
      const broadcastRes = await fetch('https://api.whatsonchain.com/v1/bsv/main/tx/raw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txhex: txHex })
      })

      if (!broadcastRes.ok) {
        const errText = await broadcastRes.text()
        console.warn(`[WalletService] anchorSignal broadcast failed: ${errText}`)
        return null
      }

      const broadcastedTxid = (await broadcastRes.json()) as string
      const finalTxid = broadcastedTxid || txid
      console.log(`[WalletService] ✅ Signal anchored on-chain: signalId=${opts.signalId} txid=${finalTxid}`)
      return finalTxid
    } catch (err: any) {
      console.warn(`[WalletService] anchorSignal failed (non-fatal): ${err.message}`)
      return null
    }
  }
}

export const walletService = new WalletService()
