/**
 * OracleResolver — Tier 1 resolution
 * Queries Polymarket and Betfair to auto-resolve markets.
 * Returns null if oracle hasn't resolved yet.
 */
import https from 'https'

export type OracleOutcome = 'yes' | 'no' | null

interface OracleResult {
  resolved: boolean
  outcome: OracleOutcome
  source: string
  evidence: string
}

export class OracleResolver {
  /**
   * Query Polymarket for a market outcome by condition_id or slug
   */
  async queryPolymarket(marketId: string): Promise<OracleResult> {
    try {
      const data = await this.get(`https://clob.polymarket.com/markets/${marketId}`)
      if (!data) return { resolved: false, outcome: null, source: 'polymarket', evidence: '' }

      // Polymarket CLOB API: resolved=true when market is settled
      if (data.closed && data.tokens) {
        // Find winning token (price = 1.0 means it won)
        const yesToken = data.tokens.find((t: any) => t.outcome === 'Yes')
        const noToken = data.tokens.find((t: any) => t.outcome === 'No')

        if (yesToken?.winner === true) {
          return {
            resolved: true,
            outcome: 'yes',
            source: 'polymarket',
            evidence: `https://polymarket.com/event/${marketId}`
          }
        }
        if (noToken?.winner === true) {
          return {
            resolved: true,
            outcome: 'no',
            source: 'polymarket',
            evidence: `https://polymarket.com/event/${marketId}`
          }
        }
      }

      return { resolved: false, outcome: null, source: 'polymarket', evidence: '' }
    } catch {
      return { resolved: false, outcome: null, source: 'polymarket', evidence: '' }
    }
  }

  /**
   * Query Betfair for a market outcome by market_id
   */
  async queryBetfair(marketId: string): Promise<OracleResult> {
    try {
      // Betfair Exchange API (public endpoint for settled markets)
      const data = await this.get(
        `https://api.betfair.com/exchange/betting/rest/v1.0/listMarketBook/?marketIds=${marketId}`
      )
      if (!data || !Array.isArray(data) || data.length === 0) {
        return { resolved: false, outcome: null, source: 'betfair', evidence: '' }
      }

      const market = data[0]
      if (market.status === 'CLOSED') {
        // Find winner: runner with status WINNER
        const winner = market.runners?.find((r: any) => r.status === 'WINNER')
        if (winner) {
          // Map runner name to yes/no (Betfair markets use "Yes"/"No" runner names)
          const outcome = winner.runnerName?.toLowerCase() === 'yes' ? 'yes' : 'no'
          return {
            resolved: true,
            outcome,
            source: 'betfair',
            evidence: `https://www.betfair.com/exchange/plus/betting/market/${marketId}`
          }
        }
      }

      return { resolved: false, outcome: null, source: 'betfair', evidence: '' }
    } catch {
      return { resolved: false, outcome: null, source: 'betfair', evidence: '' }
    }
  }

  /**
   * Try all configured oracles for a market.
   * Returns first resolved result, or null if none resolved.
   */
  async resolve(oracleProvider: string, oracleMarketId: string): Promise<OracleResult | null> {
    const provider = oracleProvider?.toLowerCase()

    if (provider === 'polymarket') {
      const result = await this.queryPolymarket(oracleMarketId)
      if (result.resolved) return result
    }

    if (provider === 'betfair') {
      const result = await this.queryBetfair(oracleMarketId)
      if (result.resolved) return result
    }

    // 'manual' or unknown provider → no oracle
    return null
  }

  private get(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = https.get(url, { timeout: 10000 }, (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch {
            resolve(null)
          }
        })
      })
      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy()
        reject(new Error('Oracle request timed out'))
      })
    })
  }
}
