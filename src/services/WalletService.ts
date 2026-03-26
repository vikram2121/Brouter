/**
 * WalletService
 * Handles BSV wallet operations: balance checking, faucet sends, payout transactions
 */

import { getPublicKey } from '@noble/secp256k1'
import crypto from 'crypto'

export interface UTXO {
  txid: string
  vout: number
  satoshis: number
  script: string
}

export class WalletService {
  private privateKeyHex: string
  private walletAddress: string
  private network: 'mainnet' | 'testnet' = 'mainnet'

  constructor() {
    // Use env vars if available, otherwise use placeholders (Phase 1 testing)
    this.privateKeyHex = process.env.BROUTER_BSV_PRIVATE_KEY || 'KwdB92NExY7XwVoy6ERe7hRWXMU5mHD82bDMsTV8321oapESB3SL'
    this.walletAddress = process.env.BROUTER_BSV_ADDRESS || '1BrouterTestWalletAddressPlaceholder'
    
    // Log startup state
    console.log('[WalletService] Initialized with:', {
      hasPrivateKey: !!process.env.BROUTER_BSV_PRIVATE_KEY,
      address: this.walletAddress
    })
  }

  /**
   * Get Brouter's wallet address
   */
  getAddress(): string {
    return this.walletAddress
  }

  /**
   * Get wallet balance from BSV API
   * Uses WhatsOnChain API for balance queries (free, no auth needed)
   */
  async getBalance(): Promise<{
    confirmed: number
    unconfirmed: number
    total: number
  }> {
    try {
      const url = `https://api.whatsonchain.com/v1/bsv/main/address/${this.walletAddress}/balance`
      const response = await fetch(url)
      
      if (!response.ok) {
        throw new Error(`WhatsOnChain API error: ${response.status}`)
      }

      const data = (await response.json()) as {
        confirmed: number
        unconfirmed: number
      }
      
      return {
        confirmed: data.confirmed || 0,
        unconfirmed: data.unconfirmed || 0,
        total: (data.confirmed || 0) + (data.unconfirmed || 0)
      }
    } catch (error) {
      console.error('[WalletService] Balance check failed:', error)
      throw error
    }
  }

  /**
   * Get UTXOs for the Brouter wallet
   * Used for building transactions
   */
  async getUTXOs(): Promise<UTXO[]> {
    try {
      const url = `https://api.whatsonchain.com/v1/bsv/main/address/${this.walletAddress}/unspent`
      
      // Add 5 second timeout to prevent hanging
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      
      const response = await fetch(url, { signal: controller.signal })
      clearTimeout(timeout)

      if (!response.ok) {
        throw new Error(`WhatsOnChain API error: ${response.status}`)
      }

      const utxos = (await response.json()) as Array<{
        tx_hash: string
        tx_pos: number
        value: number
        script: string
      }>

      return utxos.map((u) => ({
        txid: u.tx_hash,
        vout: u.tx_pos,
        satoshis: u.value,
        script: u.script
      }))
    } catch (error) {
      console.error('[WalletService] UTXO fetch failed:', error)
      throw error
    }
  }

  /**
   * Send BSV to a recipient address
   * Used for faucet claims and settlement payouts
   *
   * @param to Recipient BSV address
   * @param amountSats Amount in satoshis
   * @param data Optional OP_RETURN data (as array of buffers)
   * @returns Transaction TXID
   */
  async sendBSV(
    to: string,
    amountSats: number,
    data?: Buffer[]
  ): Promise<string> {
    try {
      // Phase 1: Return mock TXID if private key not set
      // Phase 2: Will actually sign and broadcast
      if (!process.env.BROUTER_BSV_PRIVATE_KEY) {
        console.warn('[WalletService] BROUTER_BSV_PRIVATE_KEY not set; returning mock TXID')
        return this.generateMockTxid(to, amountSats)
      }

      // 1. Get UTXOs
      const utxos = await this.getUTXOs()
      if (!utxos.length) {
        throw new Error('No UTXOs available for spending')
      }

      // 2. Select UTXOs to cover amount + fee
      const estimatedFee = 500 // ~500 sats for typical tx
      const needed = amountSats + estimatedFee
      let selectedUTXOs: UTXO[] = []
      let totalInput = 0

      for (const utxo of utxos) {
        selectedUTXOs.push(utxo)
        totalInput += utxo.satoshis
        if (totalInput >= needed) break
      }

      if (totalInput < needed) {
        throw new Error(
          `Insufficient balance: have ${totalInput} sats, need ${needed} sats`
        )
      }

      // 3. Build transaction (simplified; in production use bsv library)
      const change = totalInput - amountSats - estimatedFee

      const txData = {
        inputs: selectedUTXOs.map((u) => ({
          txid: u.txid,
          vout: u.vout,
          satoshis: u.satoshis
        })),
        outputs: [
          {
            address: to,
            satoshis: amountSats
          },
          ...(change > 0
            ? [
                {
                  address: this.walletAddress,
                  satoshis: change
                }
              ]
            : []),
          ...(data
            ? [
                {
                  data: data,
                  satoshis: 0
                }
              ]
            : [])
        ],
        fee: estimatedFee
      }

      // 4. Sign and broadcast
      // TODO (Phase 2): Implement actual BSV transaction signing + broadcast
      // For now, return a mock TXID
      const mockTxid = this.generateMockTxid(to, amountSats)
      console.log('[WalletService] ✓ BSV send queued', {
        to,
        amountSats,
        change,
        fee: estimatedFee,
        txid: mockTxid
      })

      return mockTxid
    } catch (error) {
      console.error('[WalletService] Send failed:', error)
      throw error
    }
  }

  /**
   * Send BSV to multiple recipients in a single transaction (batching for efficiency)
   *
   * @param recipients Array of {address, satoshis}
   * @returns Transaction TXID
   */
  async batchSend(
    recipients: Array<{ address: string; satoshis: number }>
  ): Promise<string> {
    try {
      // 1. Get UTXOs
      const utxos = await this.getUTXOs()
      if (!utxos.length) {
        throw new Error('No UTXOs available for spending')
      }

      // 2. Calculate total and select UTXOs
      const totalOutput = recipients.reduce((sum, r) => sum + r.satoshis, 0)
      const estimatedFee = Math.ceil(recipients.length * 100) // ~100 sats per output
      const needed = totalOutput + estimatedFee
      let selectedUTXOs: UTXO[] = []
      let totalInput = 0

      for (const utxo of utxos) {
        selectedUTXOs.push(utxo)
        totalInput += utxo.satoshis
        if (totalInput >= needed) break
      }

      if (totalInput < needed) {
        throw new Error(
          `Insufficient balance for batch send: have ${totalInput} sats, need ${needed} sats`
        )
      }

      // 3. Build batch transaction
      const change = totalInput - totalOutput - estimatedFee

      const txData = {
        inputs: selectedUTXOs.map((u) => ({
          txid: u.txid,
          vout: u.vout,
          satoshis: u.satoshis
        })),
        outputs: [
          ...recipients.map((r) => ({
            address: r.address,
            satoshis: r.satoshis
          })),
          ...(change > 0
            ? [
                {
                  address: this.walletAddress,
                  satoshis: change
                }
              ]
            : [])
        ],
        fee: estimatedFee
      }

      // 4. Sign and broadcast
      // TODO (Phase 2): Implement actual BSV transaction signing + broadcast
      const mockTxid = this.generateMockTxid(
        recipients.map((r) => r.address).join(','),
        totalOutput
      )
      console.log('[WalletService] ✓ Batch BSV send queued', {
        recipientCount: recipients.length,
        totalOutput,
        change,
        fee: estimatedFee,
        txid: mockTxid
      })

      return mockTxid
    } catch (error) {
      console.error('[WalletService] Batch send failed:', error)
      throw error
    }
  }

  /**
   * Generate mock TXID (for testing; replace with real broadcast in Phase 2)
   */
  private generateMockTxid(data: string, satoshis: number): string {
    const hash = crypto
      .createHash('sha256')
      .update(Buffer.concat([
        Buffer.from(data, 'utf8'),
        Buffer.from(satoshis.toString(), 'utf8'),
        Buffer.from(Date.now().toString(), 'utf8')
      ]))
      .digest()
    return hash.toString('hex')
  }
}

export const walletService = new WalletService()
