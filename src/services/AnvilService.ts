/**
 * AnvilService — Layer 1 + Layer 3 integration
 *
 * Layer 1: Publishes signed oracle resolution envelopes to the Anvil mesh
 *          after Tier 1 resolves a market. Topic: brouter:oracle:{marketId}
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
  private nodeUrl: string
  private authToken: string
  private privKey: any    // bsv.PrivKey
  private pubKey: any     // bsv.PubKey
  private enabled: boolean

  constructor() {
    this.nodeUrl = process.env.ANVIL_NODE_URL || 'http://localhost:9333'
    this.authToken = process.env.ANVIL_AUTH_TOKEN || ''

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
   */
  async publishOracleSignal(signal: OracleSignal): Promise<boolean> {
    if (!this.enabled) return false

    const topic = `brouter:oracle:${signal.marketId}`
    const payload = JSON.stringify(signal)

    try {
      const envelope = this.buildEnvelope(topic, payload, 86400, true) // durable, 24h TTL (0+durable for permanent but 86400 is safer)
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
   * Build a signed envelope ready for POST /data
   */
  private buildEnvelope(topic: string, payload: string, ttl: number, durable: boolean): AnvilEnvelope {
    const timestamp = Math.floor(Date.now() / 1000)
    const durableStr = durable ? 'true' : 'false'

    // Signing digest: SHA256(type\ntopic\npayload\nttl\ndurable\ntimestamp)
    const preimage = ['data', topic, payload, ttl, durableStr, timestamp].join('\n')
    const msgBuf = Buffer.from(preimage, 'utf8')
    const hashBuf = bsv.Hash.sha256(msgBuf)

    const keyPair = bsv.KeyPair.fromPrivKey(this.privKey)
    const sig = bsv.Ecdsa.sign(hashBuf, keyPair)

    return {
      type: 'data',
      topic,
      payload,
      signature: sig.toString(),
      pubkey: this.pubKey.toString(),
      ttl,
      durable,
      timestamp,
    }
  }

  /**
   * Verify an envelope's signature.
   * Reconstructs signing digest and checks ECDSA signature.
   */
  private verifyEnvelope(env: AnvilEnvelope): boolean {
    try {
      const durableStr = env.durable ? 'true' : 'false'
      const preimage = [env.type, env.topic, env.payload, env.ttl, durableStr, env.timestamp].join('\n')
      const msgBuf = Buffer.from(preimage, 'utf8')
      const hashBuf = bsv.Hash.sha256(msgBuf)

      const pubKey = bsv.PubKey.fromString(env.pubkey)
      const sig = bsv.Sig.fromString(env.signature)
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
        timeout: 5000,
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
        timeout: 5000,
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
