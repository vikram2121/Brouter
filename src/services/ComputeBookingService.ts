/**
 * ComputeBookingService — reservation flow, slot activation, expiry
 *
 * State machine:
 *   reserved → active → proof_submitted → settled
 *                      ↘ disputed  (renter raises, or auto after expiry+grace)
 *                      ↘ expired   (slot window passed, no proof → auto-refund)
 *
 * Escrow:
 *   - On book:    price_sats deducted from renter balance → held in escrow_sats
 *   - On settle:  escrow released to provider (minus 1% fee)
 *   - On expired/dispute-timeout: escrow refunded to renter
 */

import { DbConnection } from '../db/connection'
import { walletService } from './WalletService'

export interface ComputeBooking {
  id: string
  listingId: string
  renterAgentId: string
  status: 'reserved' | 'active' | 'proof_submitted' | 'settled' | 'disputed' | 'expired'
  startsAt: string | null
  activatedAt: string | null
  expiresAt: string | null
  nlockTimeTxid: string | null
  proofTxid: string | null
  escrowSats: number
  x402CallsCount: number
  x402TotalSats: number
  settlementTxid: string | null
  disputeReason: string | null
  disputeAutoRefundAt: string | null
  createdAt: string
  updatedAt: string
  // joined
  listing?: any
  renterHandle?: string
  providerHandle?: string
  providerCallbackUrl?: string
}

export class ComputeBookingService {
  constructor(private db: DbConnection) {}

  async book(params: {
    listingId: string
    renterAgentId: string
    startsAt?: string
  }): Promise<{ booking: ComputeBooking; error?: string }> {
    const { nanoid } = await import('nanoid')

    // Load listing
    const listing = await this.db.get(
      `SELECT l.*, a.callback_url as provider_callback_url
       FROM compute_listings l
       JOIN agents a ON l.agent_id = a.id
       WHERE l.id = ? AND l.status = 'active'`,
      [params.listingId]
    )
    if (!listing) return { booking: null as any, error: 'Listing not found or not active' }

    // Check concurrent slot cap
    const activeCount = await this.db.get(
      `SELECT COUNT(*) as cnt FROM compute_bookings
       WHERE listing_id = ? AND status IN ('active', 'reserved')`,
      [params.listingId]
    )
    if ((activeCount?.cnt ?? 0) >= listing.max_concurrent_slots) {
      return { booking: null as any, error: 'No slots available — listing at capacity' }
    }

    // Check renter balance
    const renter = await this.db.get('SELECT balance_sats FROM agents WHERE id = ?', [params.renterAgentId])
    if (!renter || renter.balance_sats < listing.price_sats) {
      return { booking: null as any, error: `Insufficient balance: need ${listing.price_sats} sats` }
    }

    const id = nanoid()
    const now = new Date()
    const nowStr = now.toISOString().slice(0, 19).replace('T', ' ')

    const isInstant = !params.startsAt
    let activatedAt: string | null = null
    let expiresAt: string | null = null
    let status: string = 'reserved'

    if (isInstant) {
      status = 'active'
      activatedAt = nowStr
      const exp = new Date(now.getTime() + listing.slot_duration_minutes * 60 * 1000)
      expiresAt = exp.toISOString().slice(0, 19).replace('T', ' ')
    }

    // Deduct from renter balance → held in escrow_sats
    await this.db.run(
      'UPDATE agents SET balance_sats = balance_sats - ? WHERE id = ?',
      [listing.price_sats, params.renterAgentId]
    )

    await this.db.run(
      `INSERT INTO compute_bookings
        (id, listing_id, renter_agent_id, status, starts_at, activated_at, expires_at,
         escrow_sats, x402_calls_count, x402_total_sats, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      [
        id,
        params.listingId,
        params.renterAgentId,
        status,
        params.startsAt ?? null,
        activatedAt,
        expiresAt,
        listing.price_sats,   // escrow_sats — held until settled or refunded
        nowStr,
        nowStr,
      ]
    )

    const booking = await this.getById(id)

    // Anchor booking on-chain — fire-and-forget, non-fatal
    walletService.anchorComputeBooking({
      bookingId: id,
      listingId: params.listingId,
      renterAgentId: params.renterAgentId,
      escrowSats: listing.price_sats,
    }).then((anchorTxid) => {
      if (anchorTxid) {
        this.db.run(
          `UPDATE compute_bookings SET nlocktime_txid = ?, updated_at = ? WHERE id = ?`,
          [anchorTxid, new Date().toISOString().slice(0, 19).replace('T', ' '), id]
        ).catch(() => {})
      }
    }).catch(() => {})

    // Fire callback to provider so they know someone booked them
    if (listing.provider_callback_url) {
      this.notifyProvider(listing.provider_callback_url, {
        event: 'compute.booking_received',
        bookingId: id,
        listingId: params.listingId,
        renterAgentId: params.renterAgentId,
        escrowSats: listing.price_sats,
        status,
        startsAt: params.startsAt ?? null,
        activatedAt,
        expiresAt,
        timestamp: new Date().toISOString(),
      })
    }

    return { booking: booking! }
  }

  async activate(bookingId: string): Promise<ComputeBooking | null> {
    const row = await this.db.get(
      `SELECT b.*, l.slot_duration_minutes, a.callback_url as provider_callback_url
       FROM compute_bookings b
       JOIN compute_listings l ON b.listing_id = l.id
       JOIN agents a ON l.agent_id = a.id
       WHERE b.id = ? AND b.status = 'reserved'`,
      [bookingId]
    )
    if (!row) return null

    const now = new Date()
    const activatedAt = now.toISOString().slice(0, 19).replace('T', ' ')
    const exp = new Date(now.getTime() + row.slot_duration_minutes * 60 * 1000)
    const expiresAt = exp.toISOString().slice(0, 19).replace('T', ' ')

    await this.db.run(
      `UPDATE compute_bookings SET status = 'active', activated_at = ?, expires_at = ?, updated_at = ? WHERE id = ?`,
      [activatedAt, expiresAt, activatedAt, bookingId]
    )

    // Notify provider of activation
    if (row.provider_callback_url) {
      this.notifyProvider(row.provider_callback_url, {
        event: 'compute.slot_activated',
        bookingId,
        activatedAt,
        expiresAt,
        timestamp: new Date().toISOString(),
      })
    }

    return this.getById(bookingId)
  }

  /**
   * Provider submits proof — transitions to proof_submitted.
   * Settlement service then validates the txid before releasing escrow.
   */
  async submitProof(bookingId: string, providerAgentId: string, proofTxid: string): Promise<{ booking: ComputeBooking | null; error?: string }> {
    const row = await this.db.get(
      `SELECT b.*, l.agent_id as provider_agent_id FROM compute_bookings b
       JOIN compute_listings l ON b.listing_id = l.id
       WHERE b.id = ? AND b.status = 'active'`,
      [bookingId]
    )
    if (!row) return { booking: null, error: 'Booking not found or not active' }
    if (row.provider_agent_id !== providerAgentId) return { booking: null, error: 'Only the provider can submit proof' }

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
    await this.db.run(
      `UPDATE compute_bookings SET status = 'proof_submitted', proof_txid = ?, updated_at = ? WHERE id = ?`,
      [proofTxid, now, bookingId]
    )
    return { booking: await this.getById(bookingId) }
  }

  async dispute(bookingId: string, renterAgentId: string, reason?: string): Promise<{ booking: ComputeBooking | null; error?: string }> {
    const row = await this.db.get(
      `SELECT * FROM compute_bookings WHERE id = ? AND renter_agent_id = ? AND status IN ('active', 'proof_submitted')`,
      [bookingId, renterAgentId]
    )
    if (!row) return { booking: null, error: 'Booking not found, not active, or not your booking' }

    const now = new Date()
    const nowStr = now.toISOString().slice(0, 19).replace('T', ' ')
    // Auto-refund 24h after dispute if still unresolved
    const autoRefundAt = new Date(now.getTime() + 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 19).replace('T', ' ')

    await this.db.run(
      `UPDATE compute_bookings
       SET status = 'disputed', dispute_reason = ?, dispute_auto_refund_at = ?, updated_at = ?
       WHERE id = ?`,
      [reason ?? null, autoRefundAt, nowStr, bookingId]
    )
    return { booking: await this.getById(bookingId) }
  }

  /**
   * Auto-refund renter from escrow — called by cron for expired or timed-out disputed bookings.
   */
  async refundEscrow(bookingId: string, reason: 'expired' | 'dispute_timeout'): Promise<boolean> {
    const row = await this.db.get(
      `SELECT b.*, l.agent_id as provider_agent_id
       FROM compute_bookings b
       JOIN compute_listings l ON b.listing_id = l.id
       WHERE b.id = ?`,
      [bookingId]
    )
    if (!row || row.escrow_sats <= 0) return false
    if (!['active', 'disputed', 'reserved'].includes(row.status)) return false

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')

    // Refund escrow to renter
    await this.db.run(
      'UPDATE agents SET balance_sats = balance_sats + ? WHERE id = ?',
      [row.escrow_sats, row.renter_agent_id]
    )

    await this.db.run(
      `UPDATE compute_bookings
       SET status = 'expired', escrow_sats = 0, updated_at = ?
       WHERE id = ?`,
      [now, bookingId]
    )

    console.log(`[compute] Refunded ${row.escrow_sats} sats to ${row.renter_agent_id} — booking ${bookingId} (${reason})`)
    return true
  }

  async recordX402Call(bookingId: string, sats: number): Promise<void> {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
    await this.db.run(
      `UPDATE compute_bookings
       SET x402_calls_count = x402_calls_count + 1,
           x402_total_sats = x402_total_sats + ?,
           updated_at = ?
       WHERE id = ?`,
      [sats, now, bookingId]
    )
  }

  async getById(id: string): Promise<ComputeBooking | null> {
    const row = await this.db.get(
      `SELECT b.*,
              r.handle as renter_handle,
              p.handle as provider_handle,
              l.listing_type, l.slot_duration_minutes, l.price_sats, l.x402_endpoint, l.specs,
              a.callback_url as provider_callback_url
       FROM compute_bookings b
       LEFT JOIN agents r ON b.renter_agent_id = r.id
       LEFT JOIN compute_listings l ON b.listing_id = l.id
       LEFT JOIN agents a ON l.agent_id = a.id
       LEFT JOIN agents p ON l.agent_id = p.id
       WHERE b.id = ?`,
      [id]
    )
    return row ? this.format(row) : null
  }

  async list(filters: {
    renterAgentId?: string
    providerAgentId?: string
    listingId?: string
    status?: string
    limit?: number
    offset?: number
  } = {}): Promise<{ bookings: ComputeBooking[]; total: number }> {
    const conditions: string[] = []
    const params: any[] = []

    if (filters.renterAgentId) { conditions.push('b.renter_agent_id = ?'); params.push(filters.renterAgentId) }
    if (filters.listingId) { conditions.push('b.listing_id = ?'); params.push(filters.listingId) }
    if (filters.status) { conditions.push('b.status = ?'); params.push(filters.status) }
    if (filters.providerAgentId) { conditions.push('l.agent_id = ?'); params.push(filters.providerAgentId) }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = filters.limit ?? 20
    const offset = filters.offset ?? 0

    const [rows, countRow] = await Promise.all([
      this.db.all(
        `SELECT b.*, r.handle as renter_handle, p.handle as provider_handle,
                l.listing_type, l.slot_duration_minutes, l.price_sats, l.x402_endpoint, l.specs
         FROM compute_bookings b
         LEFT JOIN agents r ON b.renter_agent_id = r.id
         LEFT JOIN compute_listings l ON b.listing_id = l.id
         LEFT JOIN agents p ON l.agent_id = p.id
         ${where}
         ORDER BY b.created_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      ),
      this.db.get(
        `SELECT COUNT(*) as total FROM compute_bookings b
         LEFT JOIN compute_listings l ON b.listing_id = l.id
         ${where}`,
        params
      ),
    ])

    return {
      bookings: rows.map((r: any) => this.format(r)),
      total: countRow?.total ?? 0,
    }
  }

  /** Called by ResolutionCron — activate scheduled bookings whose starts_at has passed */
  async activatePendingScheduled(): Promise<number> {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
    const pending = await this.db.all(
      `SELECT b.id, l.slot_duration_minutes FROM compute_bookings b
       JOIN compute_listings l ON b.listing_id = l.id
       WHERE b.status = 'reserved' AND b.starts_at <= ?`,
      [now]
    )
    for (const row of pending) {
      await this.activate(row.id)
    }
    return pending.length
  }

  /**
   * Called by ResolutionCron — auto-refund expired slots with no proof (after 5-min grace).
   * Also auto-refund disputed bookings where dispute_auto_refund_at has passed.
   */
  async processExpiredAndDisputed(): Promise<{ expired: number; disputeRefunds: number }> {
    const graceMs = 5 * 60 * 1000
    const cutoff = new Date(Date.now() - graceMs).toISOString().slice(0, 19).replace('T', ' ')
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')

    // Expired active slots with no proof
    const expiredRows = await this.db.all(
      `SELECT id FROM compute_bookings
       WHERE status = 'active' AND expires_at < ? AND proof_txid IS NULL`,
      [cutoff]
    )
    let expired = 0
    for (const row of expiredRows) {
      const ok = await this.refundEscrow(row.id, 'expired')
      if (ok) expired++
    }

    // Disputed bookings past their auto-refund deadline
    const disputeRows = await this.db.all(
      `SELECT id FROM compute_bookings
       WHERE status = 'disputed' AND dispute_auto_refund_at IS NOT NULL AND dispute_auto_refund_at <= ?`,
      [now]
    )
    let disputeRefunds = 0
    for (const row of disputeRows) {
      const ok = await this.refundEscrow(row.id, 'dispute_timeout')
      if (ok) disputeRefunds++
    }

    return { expired, disputeRefunds }
  }

  /** Fire-and-forget webhook to provider's callbackUrl */
  private notifyProvider(callbackUrl: string, payload: Record<string, any>): void {
    fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Brouter-Event': payload.event },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    }).catch((err: any) => console.warn(`[compute] provider callback failed (${callbackUrl}):`, err.message))
  }

  private format(row: any): ComputeBooking {
    return {
      id: row.id,
      listingId: row.listing_id,
      renterAgentId: row.renter_agent_id,
      status: row.status,
      startsAt: row.starts_at,
      activatedAt: row.activated_at,
      expiresAt: row.expires_at,
      nlockTimeTxid: row.nlocktime_txid,
      proofTxid: row.proof_txid,
      escrowSats: row.escrow_sats ?? 0,
      x402CallsCount: row.x402_calls_count ?? 0,
      x402TotalSats: row.x402_total_sats ?? 0,
      settlementTxid: row.settlement_txid,
      disputeReason: row.dispute_reason ?? null,
      disputeAutoRefundAt: row.dispute_auto_refund_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      renterHandle: row.renter_handle,
      providerHandle: row.provider_handle,
      providerCallbackUrl: row.provider_callback_url,
    }
  }
}
