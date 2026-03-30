/**
 * RapidMarketSeeder — keeps ~5 hourly prediction markets open at all times.
 *
 * After each ResolutionCron tick, checks how many rapid markets are OPEN.
 * If below MIN_OPEN (5), seeds new ones from a rotating template pool.
 * Templates span crypto, macro, tech, sports, science, politics, agent-meta.
 */

import { Database } from '../db/connection'
import { MarketService } from './MarketService'

const MIN_OPEN = 5
const HORIZON_HOURS = 1 // rapid tier = resolves in 1 hour

interface MarketTemplate {
  title: string
  description: string
  domain: 'crypto' | 'macro' | 'sports' | 'politics' | 'science' | 'agent-meta'
  resolutionCriteria: string
  tags?: string[]
}

// 40 templates across varied domains — cycles through, never repeats within a 40-market window
const TEMPLATES: MarketTemplate[] = [
  // ─── CRYPTO ────────────────────────────────────────────────────────────────
  {
    title: 'Will BTC trade above its opening price within the next hour?',
    description: 'Resolves YES if BTC/USD spot price on Binance is higher in 1 hour than at market open.',
    domain: 'crypto',
    resolutionCriteria: 'BTC/USD spot price on Binance at close > price at open.',
  },
  {
    title: 'Will BSV hashrate increase in the next hour?',
    description: 'Resolves YES if the 1-hour average BSV hashrate is higher at close than at open.',
    domain: 'crypto',
    resolutionCriteria: 'BSV hashrate (WhatsMiner / pool data) at close > at open.',
  },
  {
    title: 'Will ETH/BTC ratio rise in the next hour?',
    description: 'Resolves YES if ETH/BTC closes higher than it opened.',
    domain: 'crypto',
    resolutionCriteria: 'ETH/BTC ratio on Binance at close > at open.',
  },
  {
    title: 'Will any crypto in the top 10 move more than 3% in the next hour?',
    description: 'Resolves YES if any top-10 market-cap asset (CoinGecko) moves ±3% in the next hour.',
    domain: 'crypto',
    resolutionCriteria: 'Any CoinGecko top-10 asset with abs(Δ%) > 3 in the next hour.',
  },
  {
    title: 'Will crypto Fear & Greed index change category in the next hour?',
    description: 'Resolves YES if the Alternative.me Fear & Greed index crosses a category boundary.',
    domain: 'crypto',
    resolutionCriteria: 'Fear & Greed Index category changes within the hour (e.g. Fear → Neutral).',
  },
  {
    title: 'Will BTC dominance rise in the next hour?',
    description: 'Resolves YES if BTC.D (CoinGecko) increases over the next hour.',
    domain: 'crypto',
    resolutionCriteria: 'BTC dominance percentage at close > at open.',
  },
  {
    title: 'Will a new BSV block be mined in the next 10 minutes?',
    description: 'Resolves YES if WhatsOnChain shows a new BSV block confirmed within 10 minutes of open.',
    domain: 'crypto',
    resolutionCriteria: 'A new BSV block appears in WhatsOnChain within 10 minutes of market open.',
  },
  {
    title: 'Will SOL outperform BTC over the next hour?',
    description: 'Resolves YES if SOL/USD return > BTC/USD return in the next hour.',
    domain: 'crypto',
    resolutionCriteria: 'SOL return % > BTC return % over 1 hour (Binance spot).',
  },

  // ─── MACRO ─────────────────────────────────────────────────────────────────
  {
    title: 'Will USD/EUR strengthen in the next hour?',
    description: 'Resolves YES if USD/EUR rate is higher (more dollars per euro) at close.',
    domain: 'macro',
    resolutionCriteria: 'USD/EUR spot (Yahoo Finance or Forex API) at close > at open.',
  },
  {
    title: 'Will gold spot price rise in the next hour?',
    description: 'Resolves YES if XAU/USD is higher at close than at open.',
    domain: 'macro',
    resolutionCriteria: 'XAU/USD spot price at close > at open.',
  },
  {
    title: 'Will crude oil (WTI) price increase in the next hour?',
    description: 'Resolves YES if WTI crude oil price is higher at close.',
    domain: 'macro',
    resolutionCriteria: 'WTI crude oil (USD/barrel) at close > at open.',
  },
  {
    title: 'Will the S&P 500 futures be up in the next hour?',
    description: 'Resolves YES if SPX futures are green at close.',
    domain: 'macro',
    resolutionCriteria: 'S&P 500 futures (ES1!) at close > at open.',
  },
  {
    title: 'Will the 10-year US Treasury yield change more than 2bps in the next hour?',
    description: 'Resolves YES if the 10Y UST yield moves more than 2 basis points.',
    domain: 'macro',
    resolutionCriteria: 'abs(UST 10Y yield close - open) > 0.02%.',
  },

  // ─── TECH / AI ─────────────────────────────────────────────────────────────
  {
    title: 'Will a new AI model be announced in the next hour?',
    description: 'Resolves YES if a major AI lab (OpenAI, Anthropic, Google, Meta) announces a new model in the next hour.',
    domain: 'science',
    resolutionCriteria: 'Public announcement of a new AI model by a top-5 lab, verifiable via official blog or tweet.',
  },
  {
    title: 'Will Hacker News front page feature an AI story in the next hour?',
    description: 'Resolves YES if any story with "AI", "LLM", "GPT", or "model" is in the top 10 at close.',
    domain: 'science',
    resolutionCriteria: 'HN front page (news.ycombinator.com) top-10 includes an AI-related headline at close.',
  },
  {
    title: 'Will GitHub report any service degradation in the next hour?',
    description: 'Resolves YES if githubstatus.com shows any non-operational component at close.',
    domain: 'science',
    resolutionCriteria: 'githubstatus.com shows any component not at "Operational" status.',
  },
  {
    title: 'Will any major cloud provider (AWS/GCP/Azure) report an incident in the next hour?',
    description: 'Resolves YES if any of the three major cloud providers post a new incident.',
    domain: 'science',
    resolutionCriteria: 'New incident posted on status.aws.amazon.com, status.cloud.google.com, or azure.status.microsoft.com.',
  },

  // ─── SPORTS ────────────────────────────────────────────────────────────────
  {
    title: 'Will a goal be scored in any live top-5 league football match in the next hour?',
    description: 'Resolves YES if any live Premier League, La Liga, Bundesliga, Serie A, or Ligue 1 match has a goal.',
    domain: 'sports',
    resolutionCriteria: 'A goal is scored in any live top-5 league match within the hour (API-Football).',
  },
  {
    title: 'Will any tennis match currently live end in the next hour?',
    description: 'Resolves YES if any ATP/WTA match on a live tracker concludes within the hour.',
    domain: 'sports',
    resolutionCriteria: 'An ATP or WTA match concludes (final score posted) within 1 hour.',
  },
  {
    title: 'Will the home team win in the next live football match to finish?',
    description: 'Resolves YES if the next live football match to end results in a home win.',
    domain: 'sports',
    resolutionCriteria: 'First football match to conclude after market open: home goals > away goals.',
  },

  // ─── POLITICS ──────────────────────────────────────────────────────────────
  {
    title: 'Will a G7 leader make a public statement in the next hour?',
    description: 'Resolves YES if an official statement or press release is posted by any G7 government in the next hour.',
    domain: 'politics',
    resolutionCriteria: 'Official government website or verified social media posts a statement from a G7 head of state.',
  },
  {
    title: 'Will a new US executive order be published in the next hour?',
    description: 'Resolves YES if federalregister.gov lists a new executive order.',
    domain: 'politics',
    resolutionCriteria: 'New executive order or presidential action published on federalregister.gov.',
  },
  {
    title: 'Will a central bank tweet in the next hour?',
    description: 'Resolves YES if the Fed, ECB, or BoE posts on X/Twitter within the hour.',
    domain: 'politics',
    resolutionCriteria: '@federalreserve, @ecb, or @bankofengland tweets within 1 hour of market open.',
  },

  // ─── SCIENCE / NATURE ──────────────────────────────────────────────────────
  {
    title: 'Will a magnitude 3.0+ earthquake occur anywhere in the next hour?',
    description: 'Resolves YES if USGS real-time feed logs any M3.0+ earthquake globally.',
    domain: 'science',
    resolutionCriteria: 'USGS earthquake feed (earthquake.usgs.gov/earthquakes/feed) logs M3.0+ event.',
  },
  {
    title: 'Will a new NASA APOD be published today?',
    description: 'Resolves YES if NASA Astronomy Picture of the Day is updated for today.',
    domain: 'science',
    resolutionCriteria: 'api.nasa.gov/planetary/apod returns today\'s date.',
  },
  {
    title: 'Will ISS pass over a major city in the next hour?',
    description: 'Resolves YES if the ISS passes within 30° elevation over any of the top-20 largest cities.',
    domain: 'science',
    resolutionCriteria: 'ISS tracker (wheretheiss.at) records a pass over London, NYC, Tokyo, Delhi, etc. within the hour.',
  },
  {
    title: 'Will a new arXiv AI paper be submitted in the next hour?',
    description: 'Resolves YES if any new AI/ML paper appears on arXiv within the hour.',
    domain: 'science',
    resolutionCriteria: 'arXiv new submissions feed (cs.AI or cs.LG) has at least one entry within the hour.',
  },

  // ─── AGENT-META ────────────────────────────────────────────────────────────
  {
    title: 'Will any Brouter agent post a signal in the next hour?',
    description: 'Resolves YES if the Brouter feed has at least 1 new signal posted in the next hour.',
    domain: 'agent-meta',
    resolutionCriteria: 'GET /api/posts returns at least 1 post with createdAt within the hour.',
  },
  {
    title: 'Will total Brouter sats staked increase in the next hour?',
    description: 'Resolves YES if the sum of staked sats across all markets grows over the next hour.',
    domain: 'agent-meta',
    resolutionCriteria: 'Sum of stakeAmount from signals at close > at open.',
  },
  {
    title: 'Will a new agent register on Brouter in the next hour?',
    description: 'Resolves YES if the agent count on Brouter increases by at least 1.',
    domain: 'agent-meta',
    resolutionCriteria: 'GET /api/agents total count at close > at open.',
  },
  {
    title: 'Will the top-earning Brouter agent post in the next hour?',
    description: 'Resolves YES if the highest-earnings agent (by sats) posts at least one signal.',
    domain: 'agent-meta',
    resolutionCriteria: 'Top agent by earnings on GET /api/agents has a post with createdAt in the next hour.',
  },
  {
    title: 'Will more YES positions be staked than NO positions in the next hour?',
    description: 'Resolves YES if the sum of YES stakes across all new positions exceeds NO stakes.',
    domain: 'agent-meta',
    resolutionCriteria: 'Sum of YES position sats created in the hour > sum of NO position sats created in the hour.',
  },
  {
    title: 'Will any market resolve on Brouter in the next hour?',
    description: 'Resolves YES if any market transitions to SETTLED state within the hour.',
    domain: 'agent-meta',
    resolutionCriteria: 'A market row with outcome IS NOT NULL and updatedAt within the hour exists.',
  },

  // ─── MORE CRYPTO ───────────────────────────────────────────────────────────
  {
    title: 'Will the next BSV transaction in the mempool be above 1000 sats?',
    description: 'Resolves YES if the next unconfirmed BSV transaction is greater than 1000 satoshis.',
    domain: 'crypto',
    resolutionCriteria: 'First new BSV mempool transaction after market open has output value > 1000 sats.',
  },
  {
    title: 'Will USDT depeg more than 0.1% in the next hour?',
    description: 'Resolves YES if USDT/USD moves outside the 0.999–1.001 range.',
    domain: 'crypto',
    resolutionCriteria: 'USDT/USD on Binance goes below 0.999 or above 1.001 at any point in the hour.',
  },
  {
    title: 'Will any DeFi protocol report a security incident in the next hour?',
    description: 'Resolves YES if Rekt.news or DeFi Monitor posts a new incident.',
    domain: 'crypto',
    resolutionCriteria: 'A new entry on rekt.news or a security alert on Twitter with >1000 retweets.',
  },

  // ─── MORE MACRO ────────────────────────────────────────────────────────────
  {
    title: 'Will VIX change by more than 2% in the next hour?',
    description: 'Resolves YES if the CBOE Volatility Index moves more than 2% in either direction.',
    domain: 'macro',
    resolutionCriteria: 'abs(VIX close - VIX open) / VIX open > 0.02.',
  },
  {
    title: 'Will DXY (Dollar Index) rise in the next hour?',
    description: 'Resolves YES if DXY closes higher than it opened.',
    domain: 'macro',
    resolutionCriteria: 'DXY at close > DXY at open (TradingView or Yahoo Finance).',
  },
]

export class RapidMarketSeeder {
  private db: Database
  private marketService: MarketService

  constructor(db: Database) {
    this.db = db
    this.marketService = new MarketService(db)
  }

  /**
   * Seed up to (MIN_OPEN - currentOpen) new rapid markets.
   * Picks templates not recently used by rotating via a DB cursor.
   */
  async maybeTopUp(): Promise<number> {
    try {
      const openCount = await this.db.get(
        `SELECT COUNT(*) as n FROM markets WHERE tier = 'rapid' AND state = 'OPEN'`
      )
      const current = openCount?.n ?? 0
      const needed = Math.max(0, MIN_OPEN - current)
      if (needed === 0) return 0

      // Find templates not used in the last 40 markets (avoid repeats)
      const recentTitles = await this.db.all(
        `SELECT title FROM markets WHERE tier = 'rapid' ORDER BY createdAt DESC LIMIT 40`
      )
      const usedTitles = new Set(recentTitles.map((r: any) => r.title))
      const available = TEMPLATES.filter(t => !usedTitles.has(t.title))

      // If we've cycled through all, allow repeats
      const pool = available.length >= needed ? available : TEMPLATES

      // Shuffle to get variety
      const shuffled = [...pool].sort(() => Math.random() - 0.5)
      const toCreate = shuffled.slice(0, needed)

      let seeded = 0
      for (const tpl of toCreate) {
        try {
          const now = new Date()
          const closesAt = new Date(now.getTime() + HORIZON_HOURS * 60 * 60 * 1000)
          const resolvesAt = new Date(closesAt.getTime() + 2 * 60 * 1000) // 2 min buffer after close

          await this.marketService.create(
            tpl.title,
            tpl.description,
            tpl.domain,
            'rapid',
            closesAt,
            resolvesAt,
            tpl.resolutionCriteria,
            null, // oracleProvider — consensus-resolved for now
            null,
            'brouter-system', // createdBy
            'consensus',      // resolution mechanism — agents vote
            1,                // consensusWindowHours
            100               // consensusMinStakeSats
          )
          seeded++
          console.log(`[seeder] Created rapid market: "${tpl.title.slice(0, 60)}"`)
        } catch (err: any) {
          console.error(`[seeder] Failed to create market "${tpl.title.slice(0, 40)}":`, err.message)
        }
      }

      return seeded
    } catch (err: any) {
      console.error('[seeder] maybeTopUp error:', err.message)
      return 0
    }
  }
}
