/**
 * WalletService — Phase 2
 * BRC-100 compatible BSV wallet using @bsv/sdk
 * TODO: implement on Mar 29
 * 
 * Install when ready:
 *   npm install @bsv/sdk
 */

export interface Keypair {
  privateKey: string   // WIF format
  publicKey: string    // compressed hex
  address: string      // BSV address (P2PKH)
}

export interface WalletBalance {
  address: string
  confirmedSats: number
  unconfirmedSats: number
  totalSats: number
}

export interface TxResult {
  txId: string
  fee: number
}

// WhatsOnChain endpoints
const WOC_BASE = 'https://api.whatsonchain.com/v1/bsv'
export const TESTNET = `${WOC_BASE}/testnet`
export const MAINNET = `${WOC_BASE}/main`

export class WalletService {
  private network: string

  constructor(network: 'testnet' | 'mainnet' = 'testnet') {
    this.network = network === 'testnet' ? TESTNET : MAINNET
  }

  // Generate a real BSV keypair using secp256k1
  // TODO: use @bsv/sdk PrivateKey.fromRandom()
  generateKeypair(): Keypair {
    throw new Error('Not implemented — Phase 2 (install @bsv/sdk first)')
  }

  // Get balance from WhatsOnChain
  async getBalance(address: string): Promise<WalletBalance> {
    const res = await fetch(`${this.network}/address/${address}/balance`)
    const data = await res.json() as { confirmed?: number; unconfirmed?: number }
    return {
      address,
      confirmedSats: data.confirmed ?? 0,
      unconfirmedSats: data.unconfirmed ?? 0,
      totalSats: (data.confirmed ?? 0) + (data.unconfirmed ?? 0),
    }
  }

  // Request testnet faucet funding
  // https://faucet.bitcoinsv.io/
  async requestFaucet(address: string): Promise<string> {
    const res = await fetch('https://faucet.bitcoinsv.io/api/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, amount: 500 }),
    })
    const data = await res.json() as { txId: string }
    return data.txId
  }

  // Send BSV payment
  // TODO: implement with @bsv/sdk Transaction builder
  async send(_fromPrivKey: string, _toAddress: string, _sats: number): Promise<TxResult> {
    throw new Error('Not implemented — Phase 2')
  }

  // Write OP_RETURN anchor (daily batch of posts)
  // TODO: implement with @bsv/sdk
  async anchorToChain(_data: string): Promise<TxResult> {
    throw new Error('Not implemented — Phase 2')
  }

  // Broadcast raw tx via WhatsOnChain
  async broadcast(rawTxHex: string): Promise<string> {
    const res = await fetch(`${this.network}/tx/raw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txhex: rawTxHex }),
    })
    const txId = await res.text()
    return txId.replace(/"/g, '')
  }
}
