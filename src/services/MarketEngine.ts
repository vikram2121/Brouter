/**
 * MarketEngine
 * Manages six-state market lifecycle: PROPOSED → OPEN → LOCKED → RESOLVING → SETTLED → ARCHIVED
 * Every state transition must be anchored on-chain before DB update.
 * Uses MarketStateLog for immutable audit trail.
 */

import { nanoid } from 'nanoid'
import {
  Market,
  MarketState,
  MarketDomain,
  MarketTier,
  Outcome,
  StateTransitionEvent
} from '../types/market-v3'
import { MarketStateLogService } from './MarketStateLog'

export interface CreateMarketInput {
  title: string
  description?: string
  domain: MarketDomain
  tier: MarketTier
  closesAt: Date
  resolvesAt: Date
  resolutionCriteria: string
  oracleProvider?: string
  oracleMarketId?: string
  oracleField?: string
  oracleThreshold?: string
  minDurationHours?: number
  minStakeToOpenSats?: number
  createdBy?: string
}

export interface StateTransitionInput {
  marketId: string
  toState: MarketState
  triggeredBy: string
  anchorTxid?: string
  context?: Record<string, unknown>
}

export class MarketEngine {
  private stateLog: MarketStateLogService

  constructor(private db: any) {
    this.stateLog = new MarketStateLogService(db)
  }

  /**
   * Create a new market (starts in PROPOSED state)
   */
  async create(input: CreateMarketInput): Promise<Market> {
    // Validation
    if (!input.title?.trim()) throw new Error('title required')
    if (input.title.trim().length > 500) throw new Error('title too long (max 500 chars)')
    if (input.closesAt >= input.resolvesAt) throw new Error('closesAt must be before resolvesAt')

    const minDuration = input.minDurationHours || 48
    const hoursDiff = (input.closesAt.getTime() - Date.now()) / (1000 * 60 * 60)
    if (hoursDiff < minDuration) throw new Error(`closesAt must be at least ${minDuration} hours from now`)

    if (!input.resolutionCriteria?.trim()) throw new Error('resolutionCriteria required')

    // Create market
    const id = nanoid()
    const now = new Date()
    const nowStr = now.toISOString().slice(0, 19).replace('T', ' ')

    const sql = `
      INSERT INTO markets (
        id, title, description, domain, tier, state,
        proposedAt, closesAt, resolvesAt, minDurationHours,
        resolutionCriteria, oracleProvider, oracleMarketId,
        oracleField, oracleThreshold, minStakeToOpenSats,
        createdBy, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `

    await this.db.run(sql, [
      id,
      input.title.trim(),
      input.description?.trim() ?? null,
      input.domain,
      input.tier,
      'PROPOSED',
      nowStr,
      input.closesAt.toISOString().slice(0, 19).replace('T', ' '),
      input.resolvesAt.toISOString().slice(0, 19).replace('T', ' '),
      input.minDurationHours || 48,
      input.resolutionCriteria.trim(),
      input.oracleProvider || null,
      input.oracleMarketId || null,
      input.oracleField || null,
      input.oracleThreshold || null,
      input.minStakeToOpenSats || 0,
      input.createdBy || null,
      nowStr,
      nowStr
    ])

    // Log initial state (PROPOSED)
    await this.stateLog.log({
      marketId: id,
      fromState: null,
      toState: 'PROPOSED',
      triggeredBy: input.createdBy || 'system',
      timestamp: now
    })

    return this.get(id)
  }

  /**
   * Get market by ID
   */
  async get(id: string): Promise<Market> {
    const row = await this.db.get('SELECT * FROM markets WHERE id = ?', [id])
    if (!row) throw new Error(`Market ${id} not found`)
    return this.mapRow(row)
  }

  /**
   * List markets by state
   */
  async listByState(state: MarketState, limit = 100): Promise<Market[]> {
    const rows = await this.db.all(
      'SELECT * FROM markets WHERE state = ? ORDER BY createdAt DESC LIMIT ?',
      [state, limit]
    )
    return rows.map((r: any) => this.mapRow(r))
  }

  /**
   * List markets by domain
   */
  async listByDomain(domain: MarketDomain, limit = 100): Promise<Market[]> {
    const rows = await this.db.all(
      'SELECT * FROM markets WHERE domain = ? ORDER BY createdAt DESC LIMIT ?',
      [domain, limit]
    )
    return rows.map((r: any) => this.mapRow(r))
  }

  /**
   * List open markets (accepting stakes)
   */
  async listOpen(limit = 100): Promise<Market[]> {
    const rows = await this.db.all(
      'SELECT * FROM markets WHERE state = ? ORDER BY closesAt ASC LIMIT ?',
      ['OPEN', limit]
    )
    return rows.map((r: any) => this.mapRow(r))
  }

  /**
   * Transition market to new state
   * Strict validation: only allowed transitions, anchored on-chain first
   *
   * Allowed transitions:
   * - PROPOSED → OPEN (if minStakeToOpenSats met)
   * - OPEN → LOCKED (at closesAt time)
   * - LOCKED → RESOLVING (at resolvesAt time, oracle checked)
   * - RESOLVING → SETTLED (with outcome)
   * - SETTLED → ARCHIVED (manual, cleanup)
   */
  async transitionState(input: StateTransitionInput): Promise<Market> {
    const market = await this.get(input.marketId)
    this.validateTransition(market.state, input.toState)

    // BSV anchor must be present for most transitions
    if (!input.anchorTxid && input.toState !== 'PROPOSED') {
      throw new Error(`anchorTxid required for transition to ${input.toState}`)
    }

    const now = new Date()
    const nowStr = now.toISOString().slice(0, 19).replace('T', ' ')

    // Build update object
    const updates: Record<string, any> = {
      state: input.toState,
      updatedAt: nowStr
    }

    // Set transition timestamp and anchor
    switch (input.toState) {
      case 'OPEN':
        updates.openedAt = nowStr
        updates.openAnchorTxid = input.anchorTxid
        break
      case 'LOCKED':
        updates.lockedAt = nowStr
        updates.lockAnchorTxid = input.anchorTxid
        break
      case 'RESOLVING':
        updates.resolvingAt = nowStr
        break
      case 'SETTLED':
        updates.settledAt = nowStr
        updates.resolutionAnchorTxid = input.anchorTxid
        // Handle outcome from context
        if (input.context?.outcome) {
          updates.outcome = input.context.outcome
          updates.resolvedBy = input.context.resolvedBy || 'oracle'
        }
        break
      case 'ARCHIVED':
        updates.archivedAt = nowStr
        break
    }

    // Update market
    const setClauses = Object.entries(updates)
      .map(([key, _]) => `${key} = ?`)
      .join(', ')
    const values = [...Object.values(updates), input.marketId]

    await this.db.run(
      `UPDATE markets SET ${setClauses} WHERE id = ?`,
      values
    )

    // Log state transition
    await this.stateLog.log({
      marketId: input.marketId,
      fromState: market.state,
      toState: input.toState,
      triggeredBy: input.triggeredBy,
      anchorTxid: input.anchorTxid,
      timestamp: now,
      context: input.context
    })

    return this.get(input.marketId)
  }

  /**
   * Validate that a state transition is legal
   */
  private validateTransition(fromState: MarketState, toState: MarketState): void {
    const allowed: Record<MarketState, MarketState[]> = {
      PROPOSED: ['OPEN'],
      OPEN: ['LOCKED'],
      LOCKED: ['RESOLVING'],
      RESOLVING: ['SETTLED'],
      SETTLED: ['ARCHIVED'],
      ARCHIVED: []
    }

    if (!allowed[fromState]?.includes(toState)) {
      throw new Error(
        `Invalid transition: ${fromState} → ${toState}. ` +
        `Allowed: ${allowed[fromState]?.join(', ') || 'none'}`
      )
    }
  }

  /**
   * Get state history for a market
   */
  async getHistory(marketId: string) {
    return this.stateLog.getMarketHistory(marketId)
  }

  /**
   * Get current state
   */
  async getState(marketId: string): Promise<MarketState> {
    const market = await this.get(marketId)
    return market.state
  }

  private mapRow(r: any): Market {
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      domain: r.domain,
      tier: r.tier,
      state: r.state,

      proposedAt: new Date(r.proposedAt),
      openedAt: r.openedAt ? new Date(r.openedAt) : undefined,
      lockedAt: r.lockedAt ? new Date(r.lockedAt) : undefined,
      resolvingAt: r.resolvingAt ? new Date(r.resolvingAt) : undefined,
      settledAt: r.settledAt ? new Date(r.settledAt) : undefined,
      archivedAt: r.archivedAt ? new Date(r.archivedAt) : undefined,

      closesAt: new Date(r.closesAt),
      resolvesAt: new Date(r.resolvesAt),
      minDurationHours: r.minDurationHours,
      lockMinutesBeforeClose: r.lockMinutesBeforeClose || 60,

      resolutionCriteria: r.resolutionCriteria,
      oracleProvider: r.oracleProvider,
      oracleMarketId: r.oracleMarketId,
      oracleField: r.oracleField,
      oracleThreshold: r.oracleThreshold,

      outcome: r.outcome,
      resolvedBy: r.resolvedBy,
      disputeWindowEndsAt: r.disputeWindowEndsAt ? new Date(r.disputeWindowEndsAt) : undefined,

      minStakeToOpenSats: r.minStakeToOpenSats || 0,

      totalYesSats: r.totalYesSats || 0,
      totalNoSats: r.totalNoSats || 0,
      agentCount: r.agentCount || 0,

      proposalAnchorTxid: r.proposalAnchorTxid,
      openAnchorTxid: r.openAnchorTxid,
      lockAnchorTxid: r.lockAnchorTxid,
      resolutionAnchorTxid: r.resolutionAnchorTxid,
      settlementAnchorTxid: r.settlementAnchorTxid,

      createdBy: r.createdBy,
      createdAt: new Date(r.createdAt),
      updatedAt: new Date(r.updatedAt)
    }
  }
}
