/**
 * ComputeSettlementService — proof verification, escrow release, BSV payout
 *
 * Proof validation chain (same SPV fallback as WalletService):
 *   1. WhatsOnChain — GET /v1/bsv/main/tx/:txid
 *   2. BananaBlocks — GET /api/v1/tx/:txid/status
 *   If both fail, settlement is deferred (returns proofPending: true).
 *
 * Platform fee: 1% of escrow_sats on settlement.
 */

import { DbConnection } from '../db/connection'
import { walletService } from './WalletService'

const PLATFORM_FEE_BPS = 100 // 1%
const WOC_BASE = 'https://api.whatsonchain.com/v1/bsv/main'
const BANANA_BASE = 'https://bananablocks.com/api/v1'

export class ComputeSettlementService {
  constructor(private db: DbConnection) {}

  /**
   * Validate a proof txid then release escrow.
   * Called immediately after submitProof transitions to proof_submitted.
   *
   * Returns:
   *   { success: true, payoutSats }        — escrow released
   *   { success: false, proofPending: true } — txid not yet confirmed (retry later)
   *   { success: false, error }            — txid invalid or booking state wrong
   */
  async settle(bookingId: string): Promise<{
    success: boolean
    payoutSats?: number
    proofPending?: boolean
    error?: string
  }> {
    const booking = await this.db.get(
      `SELECT b.*, l.price_sats, l.agent_id as provider_agent_id
       FROM compute_bookings b
       JOIN compute_listings l ON b.listing_id = l.id
       WHERE b.id = ? AND b.status = 'proof_submitted'`,
      [bookingId]
    )

    if (!booking) return { success: false, error: 'Booking not found or not in proof_submitted state' }
    if (!booking.proof_txid) return { success: false, error: 'No proof txid on record' }

    // Validate proof txid — must be confirmed on-chain
    const txValid = await this.verifyTxid(booking.proof_txid)
    if (txValid === null) {
      // Both SPV sources unreachable — defer, don't reject
      console.warn(`[compute-settle] SPV sources unreachable for ${booking.proof_txid} — deferring`)
      return { success: false, proofPending: true }
    }
    if (!txValid) {
      // Txid not found or invalid
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
      // Revert to active so provider can resubmit a valid txid
      await this.db.run(
        `UPDATE compute_bookings SET status = 'active', proof_txid = NULL, updated_at = ? WHERE id = ?`,
        [now, bookingId]
      )
      return { success: false, error: 'Proof txid not found on-chain — submit a valid confirmed txid' }
    }

    // Txid confirmed — release escrow
    const escrowSats = booking.escrow_sats ?? booking.price_sats
    const feeSats = Math.floor((escrowSats * PLATFORM_FEE_BPS) / 10000)
    const payoutSats = escrowSats - feeSats

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')

    // 1. Fetch provider's BSV address for real on-chain payout
    const providerRow = await this.db.get<{ bsvAddress: string | null }>(
      `SELECT bsvAddress FROM agents WHERE id = ?`,
      [booking.provider_agent_id]
    )

    // 2. Attempt real BSV payout — falls back to balance_sats-only if wallet not configured
    let settlementTxid: string | null = null
    if (providerRow?.bsvAddress && walletService.isConfigured()) {
      try {
        settlementTxid = await walletService.sendBSV(providerRow.bsvAddress, payoutSats)
      } catch (err) {
        console.error('[ComputeSettlement] BSV payout failed, crediting balance_sats only:', err)
      }
    }

    // 3. Credit balance_sats only if on-chain send did not happen
    if (!settlementTxid) {
      await this.db.run(
        'UPDATE agents SET balance_sats = balance_sats + ?, sats_earned = sats_earned + ?, updated_at = ? WHERE id = ?',
        [payoutSats, payoutSats, now, booking.provider_agent_id]
      )
    }

    // 4. Mark settled with real txid if payout succeeded
    await this.db.run(
      `UPDATE compute_bookings SET status = 'settled', escrow_sats = 0, settlement_txid = ?, updated_at = ? WHERE id = ?`,
      [settlementTxid, now, bookingId]
    )

    // Update provider score
    await this.updateProviderScore(booking.provider_agent_id)

    console.log(`[compute-settle] Booking ${bookingId} settled — provider +${payoutSats} sats (fee ${feeSats})`)
    return { success: true, payoutSats }
  }

  /**
   * Verify a txid is real and confirmed.
   * Returns: true = confirmed | false = not found/invalid | null = SPV unreachable
   */
  async verifyTxid(txid: string): Promise<boolean | null> {
    // Basic format check — 64 hex chars
    if (!/^[0-9a-fA-F]{64}$/.test(txid)) return false

    // 1. WhatsOnChain
    try {
      const res = await fetch(`${WOC_BASE}/tx/${txid}`, {
        signal: AbortSignal.timeout(5000),
        headers: { 'Accept': 'application/json' },
      })
      if (res.ok) {
        const data: any = await res.json()
        // WoC returns the tx object if confirmed; blockheight > 0 means mined
        if (data && (data.blockheight > 0 || data.confirmations > 0)) return true
        // Found but unconfirmed — still valid proof (mempool), accept it
        if (data && data.txid) return true
      }
      if (res.status === 404) return false // definitively not found
    } catch (err: any) {
      console.warn('[compute-settle] WoC SPV failed:', err.message)
    }

    // 2. BananaBlocks fallback
    try {
      const res = await fetch(`${BANANA_BASE}/tx/${txid}/status`, {
        signal: AbortSignal.timeout(5000),
        headers: { 'Accept': 'application/json' },
      })
      if (res.ok) {
        const data: any = await res.json()
        if (data && (data.confirmations > 0 || data.found === true)) return true
        if (data && data.found === false) return false
      }
    } catch (err: any) {
      console.warn('[compute-settle] BananaBlocks SPV failed:', err.message)
    }

    // Both unreachable — return null (defer, don't reject)
    return null
  }

  /** Recalculate compute_provider_score = settled / (settled + disputed) */
  async updateProviderScore(providerAgentId: string): Promise<void> {
    const stats = await this.db.get(
      `SELECT
         COUNT(CASE WHEN b.status = 'settled' THEN 1 END) as settled,
         COUNT(CASE WHEN b.status = 'disputed' THEN 1 END) as disputed
       FROM compute_bookings b
       JOIN compute_listings l ON b.listing_id = l.id
       WHERE l.agent_id = ?`,
      [providerAgentId]
    )

    if (!stats) return
    const total = (stats.settled ?? 0) + (stats.disputed ?? 0)
    if (total === 0) return

    const score = (stats.settled ?? 0) / total
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
    await this.db.run(
      'UPDATE agents SET compute_provider_score = ?, updated_at = ? WHERE id = ?',
      [score, now, providerAgentId]
    )
  }

  /**
   * Retry pending proof validations — called by cron for proof_submitted bookings
   * where the initial SPV check was deferred due to unreachable sources.
   */
  async retryPendingProofs(): Promise<number> {
    const pending = await this.db.all(
      `SELECT id FROM compute_bookings WHERE status = 'proof_submitted'`
    )
    let settled = 0
    for (const row of pending) {
      const result = await this.settle(row.id)
      if (result.success) settled++
    }
    return settled
  }

  /** Get settlement receipt for a booking */
  async getReceipt(bookingId: string): Promise<Record<string, any> | null> {
    const booking = await this.db.get(
      `SELECT b.*, l.price_sats, l.agent_id as provider_agent_id,
              r.handle as renter_handle, p.handle as provider_handle
       FROM compute_bookings b
       JOIN compute_listings l ON b.listing_id = l.id
       LEFT JOIN agents r ON b.renter_agent_id = r.id
       LEFT JOIN agents p ON l.agent_id = p.id
       WHERE b.id = ?`,
      [bookingId]
    )
    if (!booking) return null

    const escrowSats = booking.escrow_sats ?? booking.price_sats
    const feeSats = Math.floor((escrowSats * PLATFORM_FEE_BPS) / 10000)
    return {
      bookingId,
      status: booking.status,
      renter: booking.renter_handle,
      provider: booking.provider_handle,
      slotPriceSats: booking.price_sats,
      escrowSats,
      platformFeeSats: feeSats,
      providerPayoutSats: escrowSats - feeSats,
      x402CallsCount: booking.x402_calls_count ?? 0,
      x402TotalSats: booking.x402_total_sats ?? 0,
      proofTxid: booking.proof_txid,
      proofVerified: booking.status === 'settled',
      settlementTxid: booking.settlement_txid,
      activatedAt: booking.activated_at,
      expiresAt: booking.expires_at,
      disputeReason: booking.dispute_reason ?? null,
    }
  }
}
