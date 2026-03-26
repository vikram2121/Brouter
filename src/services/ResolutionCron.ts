/**
 * ResolutionCron — autonomous market resolution scheduler
 *
 * Runs periodically. For each market past its resolvesAt date:
 *  - LOCKED markets → advance to RESOLVING first
 *  - RESOLVING markets → attempt resolution via oracle / consensus / void
 *
 * Also closes expired consensus windows (Tier 2/3) by settling as void
 * if no supermajority was reached by the window deadline.
 */

import { Database } from '../db/connection'
import { OracleResolver } from './OracleResolver'
import { ConsensusService } from './ConsensusService'
import { MarketService } from './MarketService'
import { SettlementEngine, type SettlementConfig } from './SettlementEngine'
import { SignalPoolService } from './SignalPoolService'
import { CalibrationService } from './CalibrationService'

export class ResolutionCron {
  private db: Database
  private oracleResolver: OracleResolver
  private consensusService: ConsensusService
  private marketService: MarketService
  private settlementEngine: SettlementEngine
  private signalPoolService: SignalPoolService
  private calibrationService: CalibrationService
  private running = false

  constructor(db: Database) {
    this.db = db
    this.oracleResolver = new OracleResolver()
    this.consensusService = new ConsensusService(db)
    this.marketService = new MarketService(db)

    const settlementConfig: SettlementConfig = {
      walletAddress: process.env.BSV_WALLET_ADDRESS || '1BrouterTestWalletAddressPlaceholder',
      walletPrivKey: process.env.BSV_WALLET_PRIVKEY || 'KwdB92NExY7XwVoy6ERe7hRWXMU5mHD82bDMsTV8321oapESB3SL',
      network: (process.env.BSV_NETWORK as 'testnet' | 'mainnet') || 'testnet'
    }
    this.settlementEngine = new SettlementEngine(settlementConfig, db)
    this.signalPoolService = new SignalPoolService(db)
    this.calibrationService = new CalibrationService(db)
  }

  /**
   * Core resolution logic — shared by cron and manual resolve endpoint.
   * Returns the outcome that was settled, or null if nothing could be resolved.
   */
  async resolveMarket(marketId: string): Promise<{
    outcome: 'yes' | 'no' | 'void'
    method: 'oracle' | 'consensus' | 'void_fallback'
    skipped?: string
  } | null> {
    const marketRow = await this.db.get(
      `SELECT id, state, resolution_mechanism, oracleProvider, oracleMarketId,
              consensus_window_hours, consensus_opened_at
       FROM markets WHERE id = ?`,
      [marketId]
    )
    if (!marketRow) return null
    if (marketRow.state !== 'RESOLVING') return null

    const mechanism = marketRow.resolution_mechanism || 'oracle_auto'
    let outcome: 'yes' | 'no' | 'void' | null = null
    let method: 'oracle' | 'consensus' | 'void_fallback' = 'void_fallback'
    let evidenceUrl: string | null = null
    let evidenceNote: string | null = null
    let oracleVerified = false

    // ── TIER 1: Oracle ──────────────────────────────────────────────────────
    if (mechanism === 'oracle_auto' && marketRow.oracleProvider && marketRow.oracleMarketId) {
      const oracleResult = await this.oracleResolver.resolve(
        marketRow.oracleProvider,
        marketRow.oracleMarketId
      )
      if (oracleResult?.resolved) {
        outcome = oracleResult.outcome as 'yes' | 'no' | 'void'
        evidenceUrl = oracleResult.evidence || null
        evidenceNote = `Auto-resolved by ${oracleResult.source} oracle`
        oracleVerified = true
        method = 'oracle'
      } else {
        // Oracle hasn't resolved yet — skip, try again next run
        return { outcome: 'void', method: 'void_fallback', skipped: 'oracle_not_ready' }
      }
    }

    // ── TIER 2/3: Consensus ─────────────────────────────────────────────────
    if (mechanism === 'consensus') {
      const tally = await this.consensusService.tally(marketId)

      if (tally.achieved) {
        outcome = tally.outcome as 'yes' | 'no' | 'void'
        evidenceNote = `Consensus: YES ${tally.yesSats} sats, NO ${tally.noSats} sats (${tally.supermajorityPct}% threshold)`
        method = 'consensus'
      } else {
        // Check if consensus window has closed
        const windowClosed = this.isConsensusWindowClosed(marketRow)
        if (windowClosed) {
          // No supermajority by deadline → resolve void
          outcome = 'void'
          evidenceNote = `Consensus window expired with no supermajority. YES: ${tally.yesSats} sats, NO: ${tally.noSats} sats`
          method = 'void_fallback'
        } else {
          // Window still open — skip
          return { outcome: 'void', method: 'void_fallback', skipped: 'consensus_window_open' }
        }
      }
    }

    // ── Manual markets — skip (no auto-resolution) ─────────────────────────
    if (mechanism === 'manual') {
      return { outcome: 'void', method: 'void_fallback', skipped: 'manual_mechanism' }
    }

    if (!outcome) return null

    // ── Settle ─────────────────────────────────────────────────────────────
    try {
      await this.marketService.resolve(marketId, outcome, 'cron')

      if (evidenceUrl || evidenceNote || oracleVerified) {
        await this.db.run(
          `UPDATE markets SET
            evidenceUrl = COALESCE(?, evidenceUrl),
            evidenceNote = COALESCE(?, evidenceNote),
            oracle_verified = ?,
            oracle_verified_at = CASE WHEN ? = 1 THEN NOW() ELSE oracle_verified_at END,
            oracle_verification_url = CASE WHEN ? = 1 THEN ? ELSE oracle_verification_url END
          WHERE id = ?`,
          [
            evidenceUrl, evidenceNote,
            oracleVerified ? 1 : 0,
            oracleVerified ? 1 : 0,
            oracleVerified ? 1 : 0, evidenceUrl,
            marketId
          ]
        )
      }

      await this.settlementEngine.settle(marketId, outcome, 'cron')
      await this.signalPoolService.settleAll(marketId, outcome)
      await this.calibrationService.updateCalibration(marketId, outcome)

      if (mechanism === 'consensus') {
        await this.consensusService.settle(marketId, outcome)
      }

      console.log(`[cron] Settled market ${marketId} → ${outcome} (${method})`)
      return { outcome, method }
    } catch (err: any) {
      console.error(`[cron] Failed to settle market ${marketId}:`, err.message)
      return null
    }
  }

  private isConsensusWindowClosed(marketRow: any): boolean {
    if (!marketRow.consensus_opened_at) return false
    const windowEnd = new Date(marketRow.consensus_opened_at)
    windowEnd.setHours(windowEnd.getHours() + (marketRow.consensus_window_hours || 24))
    return new Date() > windowEnd
  }

  /**
   * Single cron tick — called on a schedule.
   */
  async tick(): Promise<void> {
    if (this.running) return // prevent overlapping runs
    this.running = true

    try {
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ')

      // 1. Advance LOCKED markets past their resolvesAt to RESOLVING
      const toAdvance = await this.db.all(
        `SELECT id FROM markets WHERE state = 'LOCKED' AND resolvesAt <= ?`,
        [now]
      )
      for (const row of toAdvance) {
        try {
          await this.marketService.startResolution(row.id)
          console.log(`[cron] Advanced market ${row.id} → RESOLVING`)
        } catch (err: any) {
          console.error(`[cron] Failed to advance market ${row.id}:`, err.message)
        }
      }

      // 2. Resolve RESOLVING markets past their resolvesAt
      const toResolve = await this.db.all(
        `SELECT id, resolution_mechanism FROM markets WHERE state = 'RESOLVING' AND resolvesAt <= ?`,
        [now]
      )
      for (const row of toResolve) {
        await this.resolveMarket(row.id)
      }

      if (toAdvance.length + toResolve.length > 0) {
        console.log(`[cron] Tick complete: ${toAdvance.length} advanced, ${toResolve.length} resolved`)
      }
    } finally {
      this.running = false
    }
  }

  /**
   * Start the cron. Default interval: 60 seconds.
   */
  start(intervalMs = 60_000): NodeJS.Timeout {
    console.log(`[cron] Resolution cron started (interval: ${intervalMs / 1000}s)`)
    this.tick() // run immediately on start
    return setInterval(() => this.tick(), intervalMs)
  }
}
