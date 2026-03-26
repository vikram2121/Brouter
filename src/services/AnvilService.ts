/**
 * AnvilService — Layer 1 + Layer 2 + Layer 3 integration
 *
 * Layer 1: Publishes signed oracle resolution envelopes to the Anvil mesh
 *          after Tier 1 resolves a market. Topic: brouter:oracle:{marketId}
 *
 * Layer 2: x402 monetisation — agents embed their BSV address (passthrough model)
 *          in published envelopes. Consumers pay the agent directly on-chain;
 *          the node verifies payment but never touches the funds.
 *          Price: ANVIL_ORACLE_PRICE_SATS (default 10 sats per query)
 *
 * Layer 3: Queries the mesh for oracle signals from other publishers,
 *          aggregating for multi-source consensus.
 *
 * Non-fatal: all methods log errors but never throw — Brouter continues
 * operating normally if Anvil is unreachable.
 */

import https from 'https'
import http from 'http'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bsv = require('bsv')

export interface OracleSignal {
  marketId: string
  outcome: 'yes' | 'no'
  confidence: number       // 0.0 – 1.0
  source: string           // e.g. 'polymarket', 'betfair', 'brouter'
  evidenceUrl: string
  resolvedAt: number       // unix epoch seconds
  // x402 monetisation (optional — present when signal was published with a price)
  monetization?: {
    model: string
    payee_locking_script_hex: string
    price_sats: number
  }
  payment_txid?: string    // set by server after payment verified
}

export interface MonetisedPublishOptions {
  /** Agent BSV address — if provided, enables x402 passthrough monetisation */
  agentBsvAddress?: string
  /** Price in sats for consumers to read this signal (default: ANVIL_ORACLE_PRICE_SATS or 10) */
  priceSats?: number
}

interface AnvilEnvelope {
  type: 'data'
  topic: string
  payload: string
  signature: string
  pubkey: string
  ttl: number
  durable: boolean
  timestamp: number
  monetization?: object
}

interface AnvilQueryResponse {
  count: number
  envelopes: AnvilEnvelope[]
  topic: string
}

export class AnvilService {
  public nodeUrl: string
  private authToken: string
  private privKey: any    // bsv.PrivKey
  private pubKey: any     // bsv.PubKey
  public enabled: boolean
  private defaultPriceSats: number

  constructor() {
    this.nodeUrl = process.env.ANVIL_NODE_URL || 'http://localhost:9333'
    this.authToken = process.env.ANVIL_AUTH_TOKEN || ''
    this.defaultPriceSats = parseInt(process.env.ANVIL_ORACLE_PRICE_SATS || '10', 10)

    const wif = process.env.BROUTER_BSV_PRIVATE_KEY
    if (wif) {
      try {
        this.privKey = bsv.PrivKey.fromWif(wif)
        this.pubKey = bsv.PubKey.fromPrivKey(this.privKey)
        this.enabled = true
        console.log(`[AnvilService] Initialized: node=${this.nodeUrl}`)
      } catch {
        this.enabled = false
        console.warn('[AnvilService] Invalid WIF — disabled')
      }
    } else {
      this.enabled = false
      console.warn('[AnvilService] No BROUTER_BSV_PRIVATE_KEY — Anvil publishing disabled')
    }
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /**
   * Layer 1: Publish an oracle resolution signal to the Anvil mesh.
   * Called after Tier 1 oracle resolves a market.
   *
   * Layer 2: If monetise.agentBsvAddress is provided, embeds x402 passthrough
   * monetisation — consumers pay the agent directly to read this signal.
   */
  async publishOracleSignal(signal: OracleSignal, monetise?: MonetisedPublishOptions): Promise<boolean> {
    if (!this.enabled) return false

    const topic = `brouter:oracle:${signal.marketId}`
    const payload = JSON.stringify(signal)

    try {
      // Layer 2: build monetization block if agent has a BSV address
      let monetization: object | undefined
      if (monetise?.agentBsvAddress) {
        const priceSats = monetise.priceSats ?? this.defaultPriceSats
        const lockingScript = this.addressToLockingScript(monetise.agentBsvAddress)
        if (lockingScript) {
          monetization = {
            model: 'passthrough',
            payee_locking_script_hex: lockingScript,
            price_sats: priceSats,
          }
          console.log(`[AnvilService] 💰 Monetised signal: ${priceSats} sats → ${monetise.agentBsvAddress}`)
        }
      }

      const envelope = this.buildEnvelope(topic, payload, 86400, true, monetization)

      const result = await this.post('/data', envelope)

      if (result?.accepted) {
        console.log(`[AnvilService] ✅ Published oracle signal: topic=${topic} outcome=${signal.outcome}`)
        return true
      } else {
        console.warn(`[AnvilService] ⚠️ Publish not accepted:`, result)
        return false
      }
    } catch (err: any) {
      console.warn(`[AnvilService] ⚠️ Publish failed (non-fatal): ${err.message}`)
      return false
    }
  }

  /**
   * Layer 2: Agent-published monetised signal.
   * Any agent can publish a signal about any market with their BSV address
   * as the payee — consumers pay them directly to read it.
   *
   * Called from POST /api/agents/:id/oracle/publish
   */
  async publishAgentSignal(
    agentId: string,
    signal: OracleSignal,
    agentBsvAddress: string,
    priceSats?: number
  ): Promise<{ accepted: boolean; topic: string; priceSats: number }> {
    const topic = `brouter:oracle:${signal.marketId}`
    const payload = JSON.stringify({ ...signal, publishedBy: agentId })
    const price = priceSats ?? this.defaultPriceSats

    if (!this.enabled) {
      // Mock mode — no Anvil node
      console.log(`[AnvilService] Mock: agent ${agentId} published signal for ${signal.marketId}`)
      return { accepted: true, topic, priceSats: price }
    }

    let monetization: object | undefined
    const lockingScript = this.addressToLockingScript(agentBsvAddress)
    if (lockingScript) {
      monetization = {
        model: 'passthrough',
        payee_locking_script_hex: lockingScript,
        price_sats: price,
      }
    }

    const envelope = this.buildEnvelope(topic, payload, 3600, false, monetization)

    try {
      const result = await this.post('/data', envelope)
      const accepted = result?.accepted === true
      console.log(`[AnvilService] Agent ${agentId} signal: accepted=${accepted} price=${price} sats`)
      return { accepted, topic, priceSats: price }
    } catch (err: any) {
      console.warn(`[AnvilService] ⚠️ Agent publish failed: ${err.message}`)
      return { accepted: false, topic, priceSats: price }
    }
  }

  /**
   * Layer 3: Query mesh for oracle signals for a given marketId.
   * Returns decoded OracleSignal objects, verified signatures only.
   */
  async queryOracleSignals(marketId: string): Promise<OracleSignal[]> {
    if (!this.enabled) return []

    const topic = `brouter:oracle:${marketId}`

    try {
      const response: AnvilQueryResponse = await this.get(`/data?topic=${encodeURIComponent(topic)}&limit=50`)
      if (!response?.envelopes?.length) return []

      const signals: OracleSignal[] = []

      for (const env of response.envelopes) {
        // Verify signature before trusting payload
        if (!this.verifyEnvelope(env)) {
          console.warn(`[AnvilService] ⚠️ Rejected envelope with invalid signature: topic=${env.topic}`)
          continue
        }

        try {
          const signal = JSON.parse(env.payload) as OracleSignal
          if (signal.marketId && signal.outcome && signal.source) {
            signals.push(signal)
          }
        } catch {
          // bad payload — skip
        }
      }

      console.log(`[AnvilService] Queried ${signals.length} verified oracle signals for ${marketId}`)
      return signals
    } catch (err: any) {
      console.warn(`[AnvilService] ⚠️ Query failed (non-fatal): ${err.message}`)
      return []
    }
  }

  /**
   * Layer 3: Multi-source consensus — aggregate signals from the mesh.
   * Returns 'yes' | 'no' | null (null = no consensus).
   * Requires ≥2 independent sources agreeing on the same outcome.
   */
  async getMultiSourceOutcome(marketId: string): Promise<'yes' | 'no' | null> {
    const signals = await this.queryOracleSignals(marketId)
    if (!signals.length) return null

    const sources = new Set<string>()
    let yesCount = 0
    let noCount = 0

    for (const s of signals) {
      // Deduplicate by source (don't count same source twice)
      if (sources.has(s.source)) continue
      sources.add(s.source)

      if (s.outcome === 'yes') yesCount++
      else if (s.outcome === 'no') noCount++
    }

    // Require at least 2 independent sources agreeing
    if (yesCount >= 2 && yesCount > noCount) return 'yes'
    if (noCount >= 2 && noCount > yesCount) return 'no'

    // If only 1 source, still return it (single-source mode)
    if (sources.size === 1) {
      if (yesCount === 1) return 'yes'
      if (noCount === 1) return 'no'
    }

    return null
  }

  /**
   * Convert a BSV address to P2PKH locking script hex (76a914...88ac)
   * Used for x402 passthrough monetisation payee script.
   */
  private addressToLockingScript(address: string): string | null {
    try {
      const addr = bsv.Address.fromString(address)
      const script = addr.toTxOutScript()
      return script.toBuffer().toString('hex')
    } catch {
      console.warn(`[AnvilService] ⚠️ Could not derive locking script for address: ${address}`)
      return null
    }
  }

  /**
   * Build a signed envelope ready for POST /data.
   *
   * Signing digest per Anvil envelope.go SigningDigest():
   *   sha256(type\ntopic\npayload\nttl\ndurable\ntimestamp[\nmonetization fields...])
   *
   * Monetization appended as separate lines: model\npayee_locking_script_hex\nprice_sats
   * Signature: DER hex (not bsv lib toString format)
   */
  private buildEnvelope(
    topic: string,
    payload: string,
    ttl: number,
    durable: boolean,
    monetization?: AnvilEnvelope['monetization']
  ): AnvilEnvelope {
    const timestamp = Math.floor(Date.now() / 1000)
    const durableStr = durable ? 'true' : 'false'

    // Base signing preimage
    let preimage = ['data', topic, payload, ttl, durableStr, timestamp].join('\n')

    // Append monetization fields if present (per envelope.go SigningDigest)
    if (monetization) {
      const m = monetization as any
      preimage += '\n' + m.model
      if (m.payee_locking_script_hex) preimage += '\n' + m.payee_locking_script_hex
      if (m.price_sats > 0) preimage += '\n' + m.price_sats
      if (m.auth_pubkey) preimage += '\n' + m.auth_pubkey
    }

    const msgBuf = Buffer.from(preimage, 'utf8')
    const hashBuf = bsv.Hash.sha256(msgBuf)

    const keyPair = bsv.KeyPair.fromPrivKey(this.privKey)
    const sig = bsv.Ecdsa.sign(hashBuf, keyPair)

    // Anvil expects DER hex: sig.toBuffer() gives DER bytes
    const sigHex = sig.toBuffer().toString('hex')
    const pubkeyHex = this.pubKey.toBuffer().toString('hex')

    const envelope: AnvilEnvelope = {
      type: 'data',
      topic,
      payload,
      signature: sigHex,
      pubkey: pubkeyHex,
      ttl,
      durable,
      timestamp,
    }

    if (monetization) envelope.monetization = monetization
    return envelope
  }

  /**
   * Verify an envelope's signature.
   * Reconstructs signing digest (including monetization) and checks DER ECDSA sig.
   */
  private verifyEnvelope(env: AnvilEnvelope): boolean {
    try {
      const durableStr = env.durable ? 'true' : 'false'
      let preimage = [env.type, env.topic, env.payload, env.ttl, durableStr, env.timestamp].join('\n')

      if (env.monetization) {
        const m = env.monetization as any
        preimage += '\n' + m.model
        if (m.payee_locking_script_hex) preimage += '\n' + m.payee_locking_script_hex
        if (m.price_sats > 0) preimage += '\n' + m.price_sats
        if (m.auth_pubkey) preimage += '\n' + m.auth_pubkey
      }

      const hashBuf = bsv.Hash.sha256(Buffer.from(preimage, 'utf8'))

      // Parse DER hex signature
      const sigBuf = Buffer.from(env.signature, 'hex')
      const sig = bsv.Sig.fromBuffer(sigBuf)
      const pubKey = bsv.PubKey.fromBuffer(Buffer.from(env.pubkey, 'hex'))
      return bsv.Ecdsa.verify(hashBuf, sig, pubKey)
    } catch {
      return false
    }
  }

  /**
   * Node health check
   */
  async healthCheck(): Promise<{ ok: boolean; height?: number }> {
    try {
      const status = await this.get('/status')
      return { ok: true, height: status?.headers?.height }
    } catch {
      return { ok: false }
    }
  }

  private post(path: string, body: object): Promise<any> {
    return new Promise((resolve, reject) => {
      const json = JSON.stringify(body)
      const url = new URL(this.nodeUrl + path)
      const isHttps = url.protocol === 'https:'
      const lib = isHttps ? https : http

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(json),
          ...(this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {}),
        },
        timeout: 10000,
      }

      const req = lib.request(options, (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch { resolve(null) }
        })
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('Anvil request timeout')) })
      req.write(json)
      req.end()
    })
  }

  private get(path: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.nodeUrl + path)
      const isHttps = url.protocol === 'https:'
      const lib = isHttps ? https : http

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers: this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {},
        timeout: 10000,
      }

      const req = lib.request(options, (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch { resolve(null) }
        })
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('Anvil request timeout')) })
      req.end()
    })
  }
}
