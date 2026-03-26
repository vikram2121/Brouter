/**
 * X402Service — BSV x402 payment flow for monetised oracle signal queries
 *
 * Flow:
 *   1. Consumer requests a monetised oracle signal
 *   2. Server returns HTTP 402 with payment instructions (locking script + price)
 *   3. Consumer builds + signs a BSV payment tx, includes it in X-Payment header
 *   4. Server verifies the payment (correct output, correct amount) → serves data
 *
 * Payment format (X-Payment header):
 *   Base64(JSON({ txhex: string, payeeLockingScript: string, priceSats: number }))
 *
 * Verification checks:
 *   - tx hex is valid BSV transaction
 *   - at least one output pays the correct locking script
 *   - that output value >= required priceSats
 *   - txid not already spent (replay protection via in-memory + DB cache)
 */

import crypto from 'crypto'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bsv = require('bsv')
import { DbConnection } from '../db/connection'

export interface PaymentRequest {
  type: 'x402'
  version: '1'
  payeeLockingScript: string   // P2PKH hex for agent's BSV address
  priceSats: number
  description: string
  expiresAt: string            // ISO timestamp (5 min window)
  nonce: string                // Prevent replay of the 402 itself
}

export interface PaymentProof {
  txhex: string
  payeeLockingScript: string
  priceSats: number
}

export interface PaymentResult {
  valid: boolean
  txid?: string
  error?: string
}

export class X402Service {
  // In-memory replay cache: txid → timestamp. Persisted to DB for restarts.
  private replayCache = new Map<string, number>()

  constructor(private db: DbConnection) {
    this.loadReplayCache()
  }

  /**
   * Generate a 402 payment request for a monetised resource.
   */
  generatePaymentRequest(
    payeeBsvAddress: string,
    priceSats: number,
    description: string
  ): PaymentRequest {
    const lockingScript = this.addressToLockingScript(payeeBsvAddress)
    return {
      type: 'x402',
      version: '1',
      payeeLockingScript: lockingScript,
      priceSats,
      description,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      nonce: crypto.randomBytes(16).toString('hex'),
    }
  }

  /**
   * Build the X-402-Payment-Required response headers.
   */
  paymentRequiredHeaders(request: PaymentRequest): Record<string, string> {
    return {
      'X-Payment-Required': Buffer.from(JSON.stringify(request)).toString('base64'),
      'X-Payment-Price-Sats': String(request.priceSats),
      'X-Payment-Payee': request.payeeLockingScript,
    }
  }

  /**
   * Verify an X-Payment header proof sent by the consumer.
   * Returns { valid: true, txid } on success, { valid: false, error } on failure.
   */
  async verifyPayment(
    xPaymentHeader: string,
    expectedLockingScript: string,
    expectedPriceSats: number
  ): Promise<PaymentResult> {
    let proof: PaymentProof
    try {
      proof = JSON.parse(Buffer.from(xPaymentHeader, 'base64').toString('utf8'))
    } catch {
      return { valid: false, error: 'Invalid X-Payment header — expected base64 JSON' }
    }

    if (!proof.txhex) return { valid: false, error: 'Missing txhex in payment proof' }
    if (proof.payeeLockingScript !== expectedLockingScript) {
      return { valid: false, error: 'Payment locking script mismatch' }
    }
    if ((proof.priceSats || 0) < expectedPriceSats) {
      return { valid: false, error: `Payment too low: got ${proof.priceSats}, need ${expectedPriceSats}` }
    }

    // Parse the tx
    let tx: any
    try {
      tx = bsv.Tx.fromHex(proof.txhex)
    } catch {
      return { valid: false, error: 'Invalid tx hex' }
    }

    const txid = tx.hash().reverse().toString('hex')

    // Replay protection
    if (this.replayCache.has(txid)) {
      return { valid: false, error: `Payment already used (txid: ${txid})` }
    }
    const dbUsed = await this.db.get(
      `SELECT txid FROM x402_payments WHERE txid = ?`, [txid]
    ).catch(() => null)
    if (dbUsed) {
      return { valid: false, error: `Payment already used (txid: ${txid})` }
    }

    // Verify at least one output pays the expected locking script >= priceSats
    let paid = false
    for (const txOut of tx.txOuts) {
      const scriptHex = txOut.script?.toHex?.() || ''
      const valueSats = txOut.valueBn ? txOut.valueBn.toNumber() : 0
      if (scriptHex === expectedLockingScript && valueSats >= expectedPriceSats) {
        paid = true
        break
      }
    }

    if (!paid) {
      return {
        valid: false,
        error: `No output found paying ${expectedPriceSats} sats to locking script ${expectedLockingScript.slice(0, 20)}...`,
      }
    }

    // Record payment (replay protection)
    this.replayCache.set(txid, Date.now())
    await this.db.run(
      `INSERT IGNORE INTO x402_payments (txid, locking_script, amount_sats, paid_at) VALUES (?, ?, ?, NOW())`,
      [txid, expectedLockingScript, expectedPriceSats]
    ).catch(() => {/* best-effort, in-memory cache is primary */})

    return { valid: true, txid }
  }

  /**
   * Convert a BSV address to a P2PKH locking script hex.
   */
  addressToLockingScript(address: string): string {
    try {
      const addr = bsv.Address.fromString(address)
      return addr.toTxOutScript().toHex()
    } catch {
      throw new Error(`Invalid BSV address: ${address}`)
    }
  }

  /**
   * Load recently used txids from DB into memory on startup.
   */
  private async loadReplayCache(): Promise<void> {
    try {
      const rows = await this.db.all(
        `SELECT txid, UNIX_TIMESTAMP(paid_at) as ts FROM x402_payments
         WHERE paid_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)`
      )
      for (const row of rows) {
        this.replayCache.set(row.txid, row.ts * 1000)
      }
    } catch {
      // Table may not exist yet — migration will create it
    }
  }
}
