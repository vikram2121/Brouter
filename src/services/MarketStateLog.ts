/**
 * MarketStateLog
 * Immutable audit trail for market state transitions.
 * Every state change creates one log entry; never updated or deleted.
 */

import { MarketStateLog, StateTransitionEvent, MarketState } from '../types/market-v3'

export class MarketStateLogService {
  constructor(private db: any) {}

  /**
   * Log a state transition
   * @param event State transition event (toState required, fromState optional)
   * @returns Inserted log entry
   */
  async log(event: StateTransitionEvent): Promise<MarketStateLog> {
    const sql = `
      INSERT INTO market_state_log
        (marketId, fromState, toState, triggeredBy, anchorTxid, loggedAt)
      VALUES
        (?, ?, ?, ?, ?, ?)
    `

    const result = await this.db.run(sql, [
      event.marketId,
      event.fromState,
      event.toState,
      event.triggeredBy,
      event.anchorTxid || null,
      event.timestamp.toISOString().slice(0, 19).replace('T', ' ')
    ])

    return this.get(result.lastID)
  }

  /**
   * Get a single log entry
   */
  async get(id: number): Promise<MarketStateLog> {
    const row = await this.db.get(
      'SELECT * FROM market_state_log WHERE id = ?',
      [id]
    )
    if (!row) throw new Error(`Log entry ${id} not found`)
    return this.mapRow(row)
  }

  /**
   * Get all transitions for a market, ordered chronologically
   */
  async getMarketHistory(marketId: string): Promise<MarketStateLog[]> {
    const rows = await this.db.all(
      'SELECT * FROM market_state_log WHERE marketId = ? ORDER BY loggedAt ASC',
      [marketId]
    )
    return rows.map((r: any) => this.mapRow(r))
  }

  /**
   * Get all transitions to a specific state
   */
  async getByState(toState: MarketState, limit = 100): Promise<MarketStateLog[]> {
    const rows = await this.db.all(
      'SELECT * FROM market_state_log WHERE toState = ? ORDER BY loggedAt DESC LIMIT ?',
      [toState, limit]
    )
    return rows.map((r: any) => this.mapRow(r))
  }

  /**
   * Get the last transition for a market
   */
  async getLastTransition(marketId: string): Promise<MarketStateLog | null> {
    const row = await this.db.get(
      'SELECT * FROM market_state_log WHERE marketId = ? ORDER BY loggedAt DESC LIMIT 1',
      [marketId]
    )
    return row ? this.mapRow(row) : null
  }

  /**
   * Get transitions triggered by an agent
   */
  async getByTriggeredBy(agentId: string, limit = 100): Promise<MarketStateLog[]> {
    const rows = await this.db.all(
      'SELECT * FROM market_state_log WHERE triggeredBy = ? ORDER BY loggedAt DESC LIMIT ?',
      [agentId, limit]
    )
    return rows.map((r: any) => this.mapRow(r))
  }

  /**
   * Get transitions in a time range
   */
  async getInRange(startAt: Date, endAt: Date, limit = 1000): Promise<MarketStateLog[]> {
    const rows = await this.db.all(
      `SELECT * FROM market_state_log
       WHERE loggedAt >= ? AND loggedAt <= ?
       ORDER BY loggedAt DESC
       LIMIT ?`,
      [
        startAt.toISOString().slice(0, 19).replace('T', ' '),
        endAt.toISOString().slice(0, 19).replace('T', ' '),
        limit
      ]
    )
    return rows.map((r: any) => this.mapRow(r))
  }

  /**
   * Check if a specific state transition exists
   */
  async hasTransition(
    marketId: string,
    fromState: MarketState | null,
    toState: MarketState
  ): Promise<boolean> {
    const row = await this.db.get(
      'SELECT 1 FROM market_state_log WHERE marketId = ? AND fromState IS ? AND toState = ? LIMIT 1',
      [marketId, fromState, toState]
    )
    return !!row
  }

  /**
   * Get state at a specific point in time
   */
  async getStateAt(marketId: string, at: Date): Promise<MarketState | null> {
    const row = await this.db.get(
      `SELECT toState FROM market_state_log
       WHERE marketId = ? AND loggedAt <= ?
       ORDER BY loggedAt DESC
       LIMIT 1`,
      [
        marketId,
        at.toISOString().slice(0, 19).replace('T', ' ')
      ]
    )
    return row ? row.toState : null
  }

  /**
   * Verify consistency: market state should match last log entry
   */
  async verifyConsistency(marketId: string, expectedState: MarketState): Promise<boolean> {
    const lastLog = await this.getLastTransition(marketId)
    if (!lastLog) return false
    return lastLog.toState === expectedState
  }

  private mapRow(r: any): MarketStateLog {
    return {
      id: r.id,
      marketId: r.marketId,
      fromState: r.fromState,
      toState: r.toState,
      triggeredBy: r.triggeredBy,
      anchorTxid: r.anchorTxid,
      loggedAt: new Date(r.loggedAt)
    }
  }
}
