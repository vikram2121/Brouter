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
import { JobService } from './JobService'
import { RapidMarketSeeder } from './RapidMarketSeeder'
import { PolymarketFeed } from './PolymarketFeed'

export class ResolutionCron {
  private db: Database
  private oracleResolver: OracleResolver
  private consensusService: ConsensusService
  private marketService: MarketService
  private settlementEngine: SettlementEngine
  private signalPoolService: SignalPoolService
  private calibrationService: CalibrationService
  private jobService: JobService
  private seeder: RapidMarketSeeder
  private polymarketFeed: PolymarketFeed
  private running = false

  constructor(db: Database) {
    this.db = db
    this.oracleResolver = new OracleResolver()
    this.consensusService = new ConsensusService(db)
    this.marketService = new MarketService(db)
    this.jobService = new JobService(db)
    this.seeder = new RapidMarketSeeder(db)
    this.polymarketFeed = new PolymarketFeed(db)

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
              consensus_window_hours, consensus_opened_at,
              commit_phase_ends_at, reveal_phase_ends_at
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
      const isCommitReveal = !!marketRow.reveal_phase_ends_at
      const now = new Date()

      // For commit-reveal: wait until reveal phase has ended before tallying
      if (isCommitReveal) {
        const revealEnd = new Date(marketRow.reveal_phase_ends_at)
        if (now < revealEnd) {
          return { outcome: 'void', method: 'void_fallback', skipped: 'reveal_phase_open' }
        }
      }

      const tally = await this.consensusService.tally(marketId)

      if (tally.achieved) {
        outcome = tally.outcome as 'yes' | 'no' | 'void'
        evidenceNote = isCommitReveal
          ? `Commit-reveal: YES ${tally.yesSats} sats, NO ${tally.noSats} sats (${tally.supermajorityPct}% threshold, valid reveals only)`
          : `Consensus: YES ${tally.yesSats} sats, NO ${tally.noSats} sats (${tally.supermajorityPct}% threshold)`
        method = 'consensus'
      } else {
        // Check if window has closed (Tier 2) or reveal phase ended (Tier 3)
        const windowClosed = isCommitReveal
          ? now > new Date(marketRow.reveal_phase_ends_at)
          : this.isConsensusWindowClosed(marketRow)

        if (windowClosed) {
          outcome = 'void'
          evidenceNote = isCommitReveal
            ? `Commit-reveal expired: no supermajority among valid reveals. YES: ${tally.yesSats} sats, NO: ${tally.noSats} sats`
            : `Consensus window expired with no supermajority. YES: ${tally.yesSats} sats, NO: ${tally.noSats} sats`
          method = 'void_fallback'
        } else {
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

      // 1a. Auto-lock OPEN markets past their closesAt
      const toAutoLock = await this.db.all(
        `SELECT id FROM markets WHERE state = 'OPEN' AND closesAt <= ?`,
        [now]
      )
      for (const row of toAutoLock) {
        try {
          await this.marketService.lock(row.id)
          console.log(`[cron] Auto-locked market ${row.id}`)
        } catch (err: any) {
          console.error(`[cron] Failed to auto-lock market ${row.id}:`, err.message)
        }
      }

      // 1b. Advance LOCKED markets past their resolvesAt to RESOLVING
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
        `SELECT id, resolution_mechanism FROM markets
         WHERE state = 'RESOLVING' AND resolvesAt <= ?`,
        [now]
      )
      for (const row of toResolve) {
        await this.resolveMarket(row.id)
      }

      // 3. Also check consensus/commit-reveal markets whose window has closed
      //    even if resolvesAt is in the future (agents may have finished early)
      const windowExpired = await this.db.all(
        `SELECT id, resolution_mechanism FROM markets
         WHERE state = 'RESOLVING'
           AND resolution_mechanism = 'consensus'
           AND (
             (consensus_closes_at IS NOT NULL AND consensus_closes_at <= ?)
             OR (reveal_phase_ends_at IS NOT NULL AND reveal_phase_ends_at <= ?)
           )`,
        [now, now]
      )
      const alreadyQueued = new Set(toResolve.map((r: any) => r.id))
      for (const row of windowExpired) {
        if (!alreadyQueued.has(row.id)) {
          await this.resolveMarket(row.id)
        }
      }

      if (toAdvance.length + toResolve.length > 0) {
        console.log(`[cron] Tick complete: ${toAdvance.length} advanced, ${toResolve.length} resolved`)
      }

      // 4. Auto-expire jobs past their deadline (open/locked → expired, refund poster)
      await this.expireStaleJobs(now)

      // 5. Top up from Polymarket feed (up to 5 live mirrored markets)
      const pmSeeded = await this.polymarketFeed.topUp(5)
      if (pmSeeded > 0) {
        console.log(`[cron] Mirrored ${pmSeeded} Polymarket market(s)`)
      }

      // 6. Top up with hardcoded templates if Polymarket didn't fill the gap
      const seeded = await this.seeder.maybeTopUp()
      if (seeded > 0) {
        console.log(`[cron] Seeded ${seeded} new rapid market(s) from templates`)
      }

    } finally {
      this.running = false
    }
  }

  /**
   * Expire jobs where deadline has passed and they're still open/locked.
   * Also expire nlocktime-jobs where lockHeight has passed (best-effort via block estimate).
   */
  private async expireStaleJobs(nowIso: string): Promise<void> {
    try {
      // Jobs with explicit deadline
      const deadlinePassed = await this.db.all(
        `SELECT id FROM jobs
         WHERE state IN ('open', 'locked')
           AND deadline IS NOT NULL
           AND deadline <= ?`,
        [nowIso]
      )

      // nlocktime-jobs: estimate block height from time (BSV ~10 min/block, genesis ~Jan 3 2009)
      // Simple heuristic: current estimated block = (now - genesis) / 600_000ms
      const genesisMs = new Date('2009-01-03T18:15:05Z').getTime()
      const estimatedBlock = Math.floor((Date.now() - genesisMs) / 600_000)

      const blockPassed = await this.db.all(
        `SELECT id FROM jobs
         WHERE state IN ('open', 'locked')
           AND lock_height IS NOT NULL
           AND lock_height <= ?
           AND deadline IS NULL`,
        [estimatedBlock]
      )

      const toExpire = [...deadlinePassed, ...blockPassed]
      let expired = 0
      for (const row of toExpire) {
        try {
          await this.jobService.expire(row.id)
          expired++
        } catch (err: any) {
          console.warn(`[cron] Failed to expire job ${row.id}:`, err.message)
        }
      }
      if (expired > 0) {
        console.log(`[cron] Expired ${expired} stale job(s)`)
      }
    } catch (err: any) {
      console.error('[cron] Job expiry scan failed:', err.message)
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
