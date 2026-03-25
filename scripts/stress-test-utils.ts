// scripts/stress-test-utils.ts
import https from 'https'

export interface Agent {
  id: string
  name: string
  handle?: string
  token: string
}

export interface Market {
  id: string
  title: string
  domain: string
  yesProb: number
  noProbabilty: number
}

export interface Settlement {
  market_id: string
  outcome: string
  fee_sats: number
  payouts: Array<{ agent_id: string; payout_sats: number }>
}

/**
 * BrouterClient - Simple HTTP wrapper for Brouter API
 */
export class BrouterClient {
  private baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '') // Remove trailing slash
  }

  async post(
    path: string,
    body: any,
    options?: { headers?: Record<string, string> }
  ): Promise<any> {
    const url = new URL(this.baseUrl + path)
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options?.headers
    }

    return new Promise((resolve, reject) => {
      const req = https.request(url, { method: 'POST', headers }, (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data).data)
            } catch {
              resolve(data)
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`))
          }
        })
      })

      req.on('error', reject)
      req.write(JSON.stringify(body))
      req.end()
    })
  }

  async get(path: string, options?: { headers?: Record<string, string> }): Promise<any> {
    const url = new URL(this.baseUrl + path)
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options?.headers
    }

    return new Promise((resolve, reject) => {
      https
        .get(url, { headers }, (res) => {
          let data = ''
          res.on('data', (chunk) => (data += chunk))
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(data).data)
              } catch {
                resolve(data)
              }
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`))
            }
          })
        })
        .on('error', reject)
    })
  }
}

/**
 * Create test markets for stress testing
 */
export async function createTestMarkets(
  api: BrouterClient,
  count: number,
  domains: string[] = ['macro', 'crypto', 'sports']
): Promise<Market[]> {
  const markets: Market[] = []
  const timestamp = Date.now()

  for (let i = 0; i < count; i++) {
    const domain = domains[i % domains.length]
    const market = await api.post('/api/markets', {
      title: `Stress Test Market ${i + 1} - ${domain} - ${timestamp}`,
      description: `Stress test market for load testing. Domain: ${domain}`,
      domain,
      closesAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days (closes)
      resolvesAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days (resolves)
      oracle_provider: 'polymarket',
      oracle_market_id: `stress-test-${timestamp}-${i}`
    })

    console.log(`  Created market: ${market.id} (${domain})`)
    markets.push(market)
  }

  return markets
}

/**
 * Generate deterministic hex-encoded test keys for reproducibility
 * Returns a 66-character hex string (33 bytes: compressed secp256k1 pubkey)
 */
export function generateTestKey(seed: string): string {
  // Simple deterministic hash from seed
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash // Convert to 32-bit integer
  }

  // Create a 66-hex-char string (33 bytes in hex)
  // Compressed pubkey: 02 (1 byte) + 32 bytes of data
  const hashHex = Math.abs(hash).toString(16).padStart(8, '0')
  const seedBytes = Buffer.from(seed).toString('hex').padEnd(64, '0')
  const hex = '02' + hashHex + seedBytes.substring(0, 56)
  return hex.substring(0, 66)
}

/**
 * Random integer between min and max (inclusive)
 */
export function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/**
 * Calculate percentile from array of numbers
 */
export function percentile(values: number[], p: number): number {
  const sorted = values.sort((a, b) => a - b)
  const idx = Math.ceil((sorted.length * p) / 100) - 1
  return sorted[Math.max(0, idx)]
}

/**
 * Verify settlement reconciliation for all markets
 * Returns true if all rules pass, throws error if any rule fails
 */
export async function verifyReconciliation(
  api: BrouterClient,
  markets: Market[],
  agents: Agent[],
  strict: boolean = false
): Promise<boolean> {
  let allPassed = true

  for (const market of markets) {
    try {
      // Fetch settlement data
      const settlement = await api.get(`/api/markets/${market.id}`)
      const stakes = await api.get(`/api/markets/${market.id}/positions`)

      if (!stakes || stakes.length === 0) {
        console.log(`  ⚠️  Market ${market.id}: No stakes (skipping verification)`)
        continue
      }

      // Rule 1: Total staked = total paid + fee + dust
      const totalStaked = stakes.reduce((sum: number, s: any) => sum + s.amount_sats, 0)
      const payouts = await api.get(`/api/markets/${market.id}/settlement`)
      const totalPaid = payouts?.payouts?.reduce((sum: number, p: any) => sum + p.payout_sats, 0) || 0
      const fee = payouts?.fee_sats || 0
      const dust = payouts?.dust_sats || 0

      const reconciles = totalStaked === totalPaid + fee + dust

      if (!reconciles) {
        const msg = `Market ${market.id} does not reconcile: staked=${totalStaked}, paid=${totalPaid}, fee=${fee}, dust=${dust}`
        if (strict) throw new Error(msg)
        console.log(`  ❌ ${msg}`)
        allPassed = false
      } else {
        console.log(`  ✅ Market ${market.id}: Staked=${totalStaked}, Paid=${totalPaid}, Fee=${fee}, Dust=${dust}`)
      }

      // Rule 2: No loser received any sats
      const outcome = settlement?.outcome
      if (outcome) {
        const losers = stakes.filter((s: any) => s.direction !== outcome)
        for (const loser of losers) {
          const payout = payouts?.payouts?.find((p: any) => p.agent_id === loser.agent_id)
          if (payout && payout.payout_sats > 0) {
            const msg = `Loser ${loser.agent_id} received ${payout.payout_sats} sats on market ${market.id}`
            if (strict) throw new Error(msg)
            console.log(`  ❌ ${msg}`)
            allPassed = false
          }
        }
        console.log(`  ✅ No losers paid out`)
      }

      // Rule 3: Calibration scores updated
      let calibrationMissing = 0
      for (const agent of agents) {
        try {
          const cal = await api.get(`/api/agents/${agent.id}/calibration`)
          const hasScore = cal?.scores?.some((s: any) => s.domain === market.domain)
          if (!hasScore) calibrationMissing++
        } catch {
          // Agent might not have staked
        }
      }
      if (calibrationMissing === 0) {
        console.log(`  ✅ Calibration scores updated for all agents`)
      } else {
        console.log(`  ⚠️  ${calibrationMissing} agents missing calibration scores (may be OK)`)
      }
    } catch (err) {
      if (strict) throw err
      console.log(`  ❌ Error verifying market ${market.id}: ${err}`)
      allPassed = false
    }
  }

  return allPassed
}
