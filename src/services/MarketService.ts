import { nanoid } from 'nanoid'

export interface Market {
  id: string
  title: string
  description: string | null
  domain: 'crypto' | 'macro' | 'sports' | 'politics' | 'science' | 'agent-meta'
  tier: 'rapid' | 'weekly' | 'anchor'
  state: 'PROPOSED' | 'OPEN' | 'LOCKED' | 'RESOLVING' | 'SETTLED' | 'ARCHIVED'
  closesAt: Date
  resolvesAt: Date
  resolutionCriteria: string
  oracleProvider: string | null
  oracleMarketId: string | null
  outcome: 'yes' | 'no' | 'void' | null
  resolvedOutcome: 'yes' | 'no' | 'void' | null
  totalYesSats: number
  totalNoSats: number
  agentCount: number
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
}

export interface MarketPosition {
  id: string
  marketId: string
  agentId: string
  direction: 'yes' | 'no'
  amountSats: number
  createdAt: Date
}

export class MarketService {
  constructor(private db: any) {}

  async create(
    title: string,
    description: string | null,
    domain: 'crypto' | 'macro' | 'sports' | 'politics' | 'science' | 'agent-meta' = 'crypto',
    tier: 'rapid' | 'weekly' | 'anchor' = 'weekly',
    closesAt: Date,
    resolvesAt: Date,
    resolutionCriteria: string,
    oracleProvider: string | null = null,
    oracleMarketId: string | null = null,
    createdBy: string | null = null,
    resolutionMechanism: 'oracle_auto' | 'consensus' | 'manual' = 'oracle_auto',
    consensusWindowHours: number = 24,
    consensusMinStakeSats: number = 1000,
    consensusSupermajorityPct: number = 66
  ): Promise<Market> {
    // Validation
    if (!title?.trim()) throw new Error('title required')
    if (title.trim().length > 500) throw new Error('title too long (max 500 chars)')
    if (!['crypto', 'macro', 'sports', 'politics', 'science', 'agent-meta'].includes(domain))
      throw new Error('domain must be one of: crypto, macro, sports, politics, science, agent-meta')
    if (!['rapid', 'weekly', 'anchor'].includes(tier)) throw new Error('tier must be rapid, weekly, or anchor')
    
    const now = new Date()
    if (closesAt <= now) throw new Error('closesAt must be in the future')
    if (resolvesAt <= closesAt) throw new Error('resolvesAt must be after closesAt')
    if (!resolutionCriteria?.trim()) throw new Error('resolutionCriteria required')

    // Tier-aware minimum duration
    const minDurationByTier: Record<string, number> = { rapid: 1, weekly: 48, anchor: 168 }
    const minDurationHours = minDurationByTier[tier] ?? 48
    const minClosesAtTime = new Date(now.getTime() + minDurationHours * 60 * 60 * 1000)
    if (closesAt < minClosesAtTime) {
      throw new Error(`Market must close at least ${minDurationHours} hour(s) in the future for tier "${tier}"`)
    }

    // Tier-aware lock window (minutes before close)
    const lockMinutesByTier: Record<string, number> = { rapid: 5, weekly: 60, anchor: 120 }
    const lockMinutesBeforeClose = lockMinutesByTier[tier] ?? 60

    const id = nanoid()
    const nowStr = now.toISOString().slice(0, 19).replace('T', ' ')
    const closesAtStr = closesAt.toISOString().slice(0, 19).replace('T', ' ')
    const resolvesAtStr = resolvesAt.toISOString().slice(0, 19).replace('T', ' ')

    // Create market in PROPOSED state
    await this.db.run(
      `INSERT INTO markets (
        id, title, description, domain, tier, state, proposedAt,
        closesAt, resolvesAt, minDurationHours, lockMinutesBeforeClose,
        resolutionCriteria, oracleProvider, oracleMarketId,
        resolution_mechanism, consensus_window_hours, consensus_min_stake_sats, consensus_supermajority_pct,
        totalYesSats, totalNoSats, agentCount,
        createdBy, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?)`,
      [
        id,
        title.trim(),
        description?.trim() ?? null,
        domain,
        tier,
        'PROPOSED',
        nowStr,
        closesAtStr,
        resolvesAtStr,
        minDurationHours,
        lockMinutesBeforeClose,
        resolutionCriteria.trim(),
        oracleProvider?.trim() ?? null,
        oracleMarketId?.trim() ?? null,
        resolutionMechanism,
        consensusWindowHours,
        consensusMinStakeSats,
        consensusSupermajorityPct,
        createdBy ?? null,
        nowStr,
        nowStr
      ]
    )

    // Log state transition: PROPOSED (immutable audit trail)
    await this.db.run(
      `INSERT INTO market_state_log (marketId, fromState, toState, triggeredBy, loggedAt)
       VALUES (?, NULL, ?, ?, ?)`,
      [id, 'PROPOSED', createdBy ?? null, nowStr]
    )

    return (await this.get(id))!
  }

  async list(tier?: string, domain?: string, state?: string, limit = 50): Promise<Market[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 100)
    let query = 'SELECT * FROM markets WHERE 1=1'
    const params: any[] = []

    if (tier) {
      query += ' AND tier = ?'
      params.push(tier)
    }
    if (domain) {
      query += ' AND domain = ?'
      params.push(domain)
    }
    if (state) {
      query += ' AND state = ?'
      params.push(state)
    }

    query += ` ORDER BY closesAt ASC LIMIT ${safeLimit}`

    const rows = await this.db.all(query, params)
    return rows.map((r: any) => this.mapRow(r))
  }

  async get(id: string): Promise<Market | null> {
    const row = await this.db.get('SELECT * FROM markets WHERE id = ?', [id])
    return row ? this.mapRow(row) : null
  }

  async getPositions(marketId: string): Promise<MarketPosition[]> {
    const rows = await this.db.all(
      `SELECT s.id, s.marketId, s.agentId, s.direction, s.amountSats, s.createdAt
       FROM stakes s
       WHERE s.marketId = ?
       ORDER BY s.amountSats DESC`,
      [marketId]
    )
    return rows.map((r: any) => ({
      id: r.id,
      marketId: r.marketId,
      agentId: r.agentId,
      direction: r.direction,
      amountSats: r.amountSats,
      createdAt: new Date(r.createdAt)
    }))
  }

  async takePosition(
    marketId: string,
    agentId: string,
    direction: 'yes' | 'no',
    amountSats: number
  ): Promise<MarketPosition> {
    if (amountSats < 1) throw new Error('Amount must be at least 1 sat')
    if (!['yes', 'no'].includes(direction)) throw new Error('Direction must be yes or no')

    const market = await this.get(marketId)
    if (!market) throw new Error('Market not found')
    if (market.state === 'SETTLED' || market.state === 'ARCHIVED') throw new Error('Market has already settled')
    if (new Date() > market.closesAt) throw new Error('Market has closed')

    // Create stake (immutable append-only)
    const id = nanoid()
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')

    // Insert stake with minimal fields; odds/probability fields get defaults
    await this.db.run(
      `INSERT INTO stakes (id, marketId, agentId, direction, amountSats, oddsAtStake, impliedProbability, consensusAfter, createdAt)
       VALUES (?, ?, ?, ?, ?, 1.0, 0.5, 0.5, ?)`,
      [id, marketId, agentId, direction, amountSats, now]
    )

    // Update denormalized market totals
    const col = direction === 'yes' ? 'totalYesSats' : 'totalNoSats'
    await this.db.run(
      `UPDATE markets SET ${col} = ${col} + ?, agentCount = (
         SELECT COUNT(DISTINCT agentId) FROM stakes WHERE marketId = ?
       ), updatedAt = NOW() WHERE id = ?`,
      [amountSats, marketId, marketId]
    )

    const stake = await this.db.get('SELECT * FROM stakes WHERE id = ?', [id])
    return {
      id: stake.id,
      marketId: stake.marketId,
      agentId: stake.agentId,
      direction: stake.direction,
      amountSats: stake.amountSats,
      createdAt: new Date(stake.createdAt)
    }
  }

  async resolve(
    marketId: string,
    outcome: 'yes' | 'no' | 'void',
    resolvedBy: string
  ): Promise<Market> {
    const market = await this.get(marketId)
    if (!market) throw new Error('Market not found')
    if (market.resolvedOutcome !== null) throw new Error('Market already resolved')
    if (market.state !== 'RESOLVING') throw new Error(`Market must be in RESOLVING state, currently ${market.state}`)

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')

    // Update market with resolution and transition to SETTLED
    await this.db.run(
      `UPDATE markets SET state = 'SETTLED', resolvedOutcome = ?, settledAt = ?, updatedAt = NOW() WHERE id = ?`,
      [outcome, now, marketId]
    )

    // Log state transition to SETTLED
    await this.db.run(
      `INSERT INTO market_state_log (marketId, fromState, toState, triggeredBy, oracleOutcome, oracleSource, loggedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [marketId, 'RESOLVING', 'SETTLED', resolvedBy, outcome, 'manual', now]
    )

    return (await this.get(marketId))!
  }

  /**
   * State transition: PROPOSED → OPEN
   * Market becomes available for staking
   */
  async open(marketId: string): Promise<Market> {
    const market = await this.get(marketId)
    if (!market) throw new Error('Market not found')
    if (market.state !== 'PROPOSED') throw new Error(`Market must be in PROPOSED state, currently ${market.state}`)

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')

    await this.db.run(
      `UPDATE markets SET state = 'OPEN', openedAt = ?, updatedAt = NOW() WHERE id = ?`,
      [now, marketId]
    )

    await this.db.run(
      `INSERT INTO market_state_log (marketId, fromState, toState, loggedAt) VALUES (?, ?, ?, ?)`,
      [marketId, 'PROPOSED', 'OPEN', now]
    )

    return (await this.get(marketId))!
  }

  /**
   * State transition: OPEN → LOCKED
   * Market closes to new positions; final odds are locked in
   */
  async lock(marketId: string): Promise<Market> {
    const market = await this.get(marketId)
    if (!market) throw new Error('Market not found')
    if (market.state !== 'OPEN') throw new Error(`Market must be in OPEN state, currently ${market.state}`)

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')

    await this.db.run(
      `UPDATE markets SET state = 'LOCKED', lockedAt = ?, updatedAt = NOW() WHERE id = ?`,
      [now, marketId]
    )

    await this.db.run(
      `INSERT INTO market_state_log (marketId, fromState, toState, loggedAt) VALUES (?, ?, ?, ?)`,
      [marketId, 'OPEN', 'LOCKED', now]
    )

    return (await this.get(marketId))!
  }

  /**
   * State transition: LOCKED → RESOLVING
   * Market enters resolution phase (waiting for oracle or manual input)
   */
  async startResolution(marketId: string): Promise<Market> {
    const market = await this.get(marketId)
    if (!market) throw new Error('Market not found')
    if (market.state !== 'LOCKED') throw new Error(`Market must be in LOCKED state, currently ${market.state}`)

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')

    await this.db.run(
      `UPDATE markets SET state = 'RESOLVING', resolvingAt = ?, updatedAt = NOW() WHERE id = ?`,
      [now, marketId]
    )

    await this.db.run(
      `INSERT INTO market_state_log (marketId, fromState, toState, loggedAt) VALUES (?, ?, ?, ?)`,
      [marketId, 'LOCKED', 'RESOLVING', now]
    )

    return (await this.get(marketId))!
  }

  private mapRow(r: any): Market {
    return {
      id: r.id,
      title: r.title,
      description: r.description ?? null,
      domain: r.domain,
      tier: r.tier,
      state: r.state,
      closesAt: new Date(r.closesAt),
      resolvesAt: new Date(r.resolvesAt),
      resolutionCriteria: r.resolutionCriteria,
      oracleProvider: r.oracleProvider ?? null,
      oracleMarketId: r.oracleMarketId ?? null,
      outcome: r.outcome,
      resolvedOutcome: r.resolvedOutcome,
      totalYesSats: Number(r.totalYesSats),
      totalNoSats: Number(r.totalNoSats),
      agentCount: Number(r.agentCount),
      createdBy: r.createdBy ?? null,
      createdAt: new Date(r.createdAt),
      updatedAt: new Date(r.updatedAt)
    }
  }
}
