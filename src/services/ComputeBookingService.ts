/**
 * ComputeBookingService — reservation flow, slot activation, expiry
 *
 * State machine:
 *   reserved → active → completed → settled
 *                      ↘ disputed
 */

import { DbConnection } from '../db/connection'

export interface ComputeBooking {
  id: string
  listingId: string
  renterAgentId: string
  status: 'reserved' | 'active' | 'completed' | 'settled' | 'disputed'
  startsAt: string | null
  activatedAt: string | null
  expiresAt: string | null
  nlockTimeTxid: string | null
  proofTxid: string | null
  x402CallsCount: number
  x402TotalSats: number
  settlementTxid: string | null
  createdAt: string
  updatedAt: string
  // joined
  listing?: any
  renterHandle?: string
  providerHandle?: string
}

export class ComputeBookingService {
  constructor(private db: DbConnection) {}

  async book(params: {
    listingId: string
    renterAgentId: string
    startsAt?: string // ISO string for scheduled; omit for instant
  }): Promise<{ booking: ComputeBooking; error?: string }> {
    const { nanoid } = await import('nanoid')

    // Load listing
    const listing = await this.db.get(
      `SELECT * FROM compute_listings WHERE id = ? AND status = 'active'`,
      [params.listingId]
    )
    if (!listing) return { booking: null as any, error: 'Listing not found or not active' }

    // Check concurrent slot cap (atomic: count active bookings)
    const activeCount = await this.db.get(
      `SELECT COUNT(*) as cnt FROM compute_bookings WHERE listing_id = ? AND status = 'active'`,
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

    // Deduct balance
    await this.db.run(
      'UPDATE agents SET balance_sats = balance_sats - ? WHERE id = ?',
      [listing.price_sats, params.renterAgentId]
    )

    await this.db.run(
      `INSERT INTO compute_bookings
        (id, listing_id, renter_agent_id, status, starts_at, activated_at, expires_at,
         x402_calls_count, x402_total_sats, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      [
        id,
        params.listingId,
        params.renterAgentId,
        status,
        params.startsAt ?? null,
        activatedAt,
        expiresAt,
        nowStr,
        nowStr,
      ]
    )

    const booking = await this.getById(id)
    return { booking: booking! }
  }

  async activate(bookingId: string): Promise<ComputeBooking | null> {
    const row = await this.db.get(
      `SELECT b.*, l.slot_duration_minutes FROM compute_bookings b
       JOIN compute_listings l ON b.listing_id = l.id
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
    return this.getById(bookingId)
  }

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
      `UPDATE compute_bookings SET status = 'completed', proof_txid = ?, updated_at = ? WHERE id = ?`,
      [proofTxid, now, bookingId]
    )
    return { booking: await this.getById(bookingId) }
  }

  async dispute(bookingId: string, renterAgentId: string): Promise<{ booking: ComputeBooking | null; error?: string }> {
    const row = await this.db.get(
      `SELECT * FROM compute_bookings WHERE id = ? AND renter_agent_id = ? AND status = 'active'`,
      [bookingId, renterAgentId]
    )
    if (!row) return { booking: null, error: 'Booking not found, not active, or not your booking' }

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
    await this.db.run(
      `UPDATE compute_bookings SET status = 'disputed', updated_at = ? WHERE id = ?`,
      [now, bookingId]
    )
    return { booking: await this.getById(bookingId) }
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
              l.listing_type, l.slot_duration_minutes, l.price_sats, l.x402_endpoint, l.specs
       FROM compute_bookings b
       LEFT JOIN agents r ON b.renter_agent_id = r.id
       LEFT JOIN compute_listings l ON b.listing_id = l.id
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

  /** Called by ResolutionCron — auto-dispute expired active slots with no proof (after 5-min grace) */
  async autoDisputeExpired(): Promise<number> {
    const graceMs = 5 * 60 * 1000
    const cutoff = new Date(Date.now() - graceMs).toISOString().slice(0, 19).replace('T', ' ')
    const expired = await this.db.all(
      `SELECT id FROM compute_bookings
       WHERE status = 'active' AND expires_at < ? AND proof_txid IS NULL`,
      [cutoff]
    )
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
    for (const row of expired) {
      await this.db.run(
        `UPDATE compute_bookings SET status = 'disputed', updated_at = ? WHERE id = ?`,
        [now, row.id]
      )
    }
    return expired.length
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
      x402CallsCount: row.x402_calls_count ?? 0,
      x402TotalSats: row.x402_total_sats ?? 0,
      settlementTxid: row.settlement_txid,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      renterHandle: row.renter_handle,
      providerHandle: row.provider_handle,
    }
  }
}
