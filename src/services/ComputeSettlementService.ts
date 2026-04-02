/**
 * ComputeSettlementService — proof verification, escrow release, BSV payout
 *
 * Platform fee: 1% of price_sats on settlement.
 */

import { DbConnection } from '../db/connection'

const PLATFORM_FEE_BPS = 100 // 1%

export class ComputeSettlementService {
  constructor(private db: DbConnection) {}

  async settle(bookingId: string): Promise<{ success: boolean; payoutSats?: number; error?: string }> {
    const booking = await this.db.get(
      `SELECT b.*, l.price_sats, l.agent_id as provider_agent_id
       FROM compute_bookings b
       JOIN compute_listings l ON b.listing_id = l.id
       WHERE b.id = ? AND b.status = 'completed'`,
      [bookingId]
    )

    if (!booking) return { success: false, error: 'Booking not found or not in completed state' }

    const feeSats = Math.floor((booking.price_sats * PLATFORM_FEE_BPS) / 10000)
    const payoutSats = booking.price_sats - feeSats

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')

    // Credit provider
    await this.db.run(
      'UPDATE agents SET balance_sats = balance_sats + ?, sats_earned = sats_earned + ?, updated_at = ? WHERE id = ?',
      [payoutSats, payoutSats, now, booking.provider_agent_id]
    )

    // Mark settled
    await this.db.run(
      `UPDATE compute_bookings SET status = 'settled', updated_at = ? WHERE id = ?`,
      [now, bookingId]
    )

    // Update provider compute_provider_score
    await this.updateProviderScore(booking.provider_agent_id)

    return { success: true, payoutSats }
  }

  /** Recalculate compute_provider_score = clean_settlements / (clean_settlements + disputes) */
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

    const feeSats = Math.floor((booking.price_sats * PLATFORM_FEE_BPS) / 10000)
    return {
      bookingId,
      status: booking.status,
      renter: booking.renter_handle,
      provider: booking.provider_handle,
      slotPriceSats: booking.price_sats,
      platformFeeSats: feeSats,
      providerPayoutSats: booking.price_sats - feeSats,
      x402CallsCount: booking.x402_calls_count ?? 0,
      x402TotalSats: booking.x402_total_sats ?? 0,
      proofTxid: booking.proof_txid,
      settlementTxid: booking.settlement_txid,
      activatedAt: booking.activated_at,
      expiresAt: booking.expires_at,
    }
  }
}
