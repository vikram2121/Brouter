/**
 * PolymarketFeed — pulls live markets from the Polymarket Gamma API
 * and seeds them into Brouter as rapid/weekly markets.
 *
 * No API key required. Public endpoint.
 * Base: https://gamma-api.polymarket.com
 *
 * Strategy:
 *  - Fetch top-volume binary (Yes/No) markets ending within 7 days
 *  - Skip any already mirrored (tracked via polymarket_condition_id in markets table)
 *  - Map to Brouter market tiers: <24h → rapid, <7d → weekly
 *  - Resolution: OracleResolver checks Polymarket resolution status
 */

import { Database } from '../db/connection'
import { MarketService } from './MarketService'

const GAMMA_API = 'https://gamma-api.polymarket.com'
const FETCH_LIMIT = 50
const MAX_SEED_PER_RUN = 5

interface PolymarketMarket {
  id: string
  question: string
  conditionId: string
  description: string
  endDate: string
  resolutionSource: string
  outcomes: string
  outcomePrices: string
  volume24hr: number
  volumeNum: number
  liquidityNum: number
  active: boolean
  closed: boolean
  restricted: boolean
  new: boolean
}

export class PolymarketFeed {
  private db: Database
  private marketService: MarketService

  constructor(db: Database) {
    this.db = db
    this.marketService = new MarketService(db)
  }

  /**
   * Ensure the polymarket_condition_id column exists on the markets table.
   * Called once at startup.
   */
  async migrate(): Promise<void> {
    try {
      await this.db.run(
        `ALTER TABLE markets ADD COLUMN polymarket_condition_id VARCHAR(255) NULL`
      )
    } catch { /* column already exists */ }
    try {
      await this.db.run(
        `ALTER TABLE markets ADD COLUMN polymarket_prices VARCHAR(255) NULL`
      )
    } catch { /* already exists */ }
  }

  /**
   * Fetch active binary markets from Polymarket sorted by 24h volume.
   */
  private async fetchPolymarkets(): Promise<PolymarketMarket[]> {
    const url = `${GAMMA_API}/markets?limit=${FETCH_LIMIT}&active=true&closed=false&order=volume24hr&ascending=false`
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'brouter/1.0' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`Polymarket API ${res.status}`)
    return res.json() as Promise<PolymarketMarket[]>
  }

  /**
   * Check which condition IDs are already mirrored.
   */
  private async getExistingConditionIds(): Promise<Set<string>> {
    const rows = await this.db.all(
      `SELECT polymarket_condition_id FROM markets WHERE polymarket_condition_id IS NOT NULL`
    ).catch(() => [])
    return new Set(rows.map((r: any) => r.polymarket_condition_id))
  }

  /**
   * Map Polymarket domain tag to Brouter domain.
   */
  private inferDomain(question: string, resolutionSource: string): 'crypto' | 'macro' | 'sports' | 'politics' | 'science' | 'agent-meta' {
    const q = question.toLowerCase()
    const src = (resolutionSource || '').toLowerCase()
    if (q.includes('bitcoin') || q.includes('btc') || q.includes('eth') || q.includes('crypto') || q.includes('bsv') || q.includes('sol') || q.includes('coin')) return 'crypto'
    if (q.includes('nba') || q.includes('nfl') || q.includes('fifa') || q.includes('soccer') || q.includes('football') || q.includes('basketball') || q.includes('tennis') || q.includes(' vs ') || src.includes('espn') || src.includes('hltv') || src.includes('mlb') || src.includes('nhl')) return 'sports'
    if (q.includes('trump') || q.includes('president') || q.includes('congress') || q.includes('senate') || q.includes('election') || q.includes('democrat') || q.includes('republican') || q.includes('nato') || q.includes('iran') || q.includes('war') || q.includes('ceasefire') || q.includes('government')) return 'politics'
    if (q.includes('fed ') || q.includes('gdp') || q.includes('inflation') || q.includes('interest rate') || q.includes('oil') || q.includes('gold') || q.includes('stock') || q.includes('s&p') || q.includes('recession')) return 'macro'
    if (q.includes('ai') || q.includes('openai') || q.includes('gpt') || q.includes('climate') || q.includes('nasa') || q.includes('space') || q.includes('earthquake') || q.includes('science')) return 'science'
    return 'macro' // default
  }

  /**
   * Main: fetch from Polymarket, seed new markets into Brouter.
   * Returns number of markets seeded.
   */
  async topUp(targetOpenCount = 5): Promise<number> {
    try {
      await this.migrate()

      // How many open Polymarket-sourced markets do we already have?
      const existingOpen = await this.db.get(
        `SELECT COUNT(*) as n FROM markets
         WHERE polymarket_condition_id IS NOT NULL
           AND state IN ('OPEN', 'LOCKED', 'RESOLVING')`
      ).catch(() => ({ n: 0 }))

      const currentOpen = existingOpen?.n ?? 0
      const needed = Math.max(0, targetOpenCount - currentOpen)
      if (needed === 0) return 0

      const markets = await this.fetchPolymarkets()
      const existing = await this.getExistingConditionIds()

      const now = new Date()
      const maxEndDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) // 7 days out

      // Filter: binary Yes/No, not already mirrored, ends within 7 days, has volume
      const eligible = markets.filter(m => {
        if (!m.conditionId) return false
        if (existing.has(m.conditionId)) return false
        if (!m.endDate) return false
        const end = new Date(m.endDate)
        if (isNaN(end.getTime())) return false
        if (end < now) return false // already ended
        if (end > maxEndDate) return false // too far out for rapid

        // Binary Yes/No only
        let outcomes: string[] = []
        try { outcomes = JSON.parse(m.outcomes) } catch { return false }
        if (sorted(outcomes.map(o => o.toLowerCase())).join(',') !== 'no,yes') return false

        return true
      })

      if (eligible.length === 0) {
        console.log('[polymarket] No eligible new markets found')
        return 0
      }

      // Sort by 24h volume descending — take the most active ones first
      eligible.sort((a, b) => (b.volume24hr ?? 0) - (a.volume24hr ?? 0))

      const toCreate = eligible.slice(0, Math.min(needed, MAX_SEED_PER_RUN))
      let seeded = 0

      for (const pm of toCreate) {
        try {
          const endDate = new Date(pm.endDate)
          const hoursToEnd = (endDate.getTime() - now.getTime()) / 3_600_000
          const tier: 'rapid' | 'weekly' = hoursToEnd <= 24 ? 'rapid' : 'weekly'

          // closesAt = endDate, resolvesAt = endDate + 10 min buffer
          const closesAt = endDate
          const resolvesAt = new Date(endDate.getTime() + 10 * 60 * 1000)

          const domain = this.inferDomain(pm.question, pm.resolutionSource)

          // Build description with current Polymarket odds
          let oddsNote = ''
          try {
            const prices = JSON.parse(pm.outcomePrices)
            const yesOdds = Math.round(parseFloat(prices[0]) * 100)
            oddsNote = ` Polymarket consensus: ${yesOdds}% YES.`
          } catch {}

          const description = (pm.description || pm.question).slice(0, 500) + oddsNote

          const resolutionCriteria = `Mirrors Polymarket market (conditionId: ${pm.conditionId}). Resolution source: ${pm.resolutionSource || 'Polymarket oracle'}. Resolves YES/NO matching Polymarket outcome.`

          const market = await this.marketService.create(
            pm.question.slice(0, 200),
            description,
            domain,
            tier,
            closesAt,
            resolvesAt,
            resolutionCriteria,
            'polymarket',          // oracleProvider
            pm.conditionId,        // oracleMarketId
            'polymarket-feed',     // createdBy
            'oracle_auto',         // resolution mechanism
            24,
            100
          )

          // Store the condition ID and current prices for oracle resolution
          await this.db.run(
            `UPDATE markets SET polymarket_condition_id = ?, polymarket_prices = ? WHERE id = ?`,
            [pm.conditionId, pm.outcomePrices, market.id]
          )

          // Open immediately (markets start as PROPOSED)
          await this.marketService.open(market.id)

          seeded++
          console.log(`[polymarket] Mirrored: "${pm.question.slice(0, 60)}" (${tier}, ${domain})`)
        } catch (err: any) {
          console.error(`[polymarket] Failed to seed "${pm.question.slice(0, 40)}":`, err.message)
        }
      }

      return seeded
    } catch (err: any) {
      console.error('[polymarket] Feed error:', err.message)
      return 0
    }
  }
}

function sorted(arr: string[]): string[] {
  return [...arr].sort()
}
