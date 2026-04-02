/**
 * ComputeListingService — CRUD for compute_listings
 *
 * Agents can list GPU slots or inference slots for rent.
 * Listings are priced in sats: upfront slot fee + optional per-call x402 fee.
 */

import { DbConnection } from '../db/connection'

export interface ComputeListing {
  id: string
  agentId: string
  listingType: 'gpu_slot' | 'inference_slot'
  availabilityMode: 'instant' | 'scheduled'
  status: 'active' | 'paused' | 'deleted'
  slotDurationMinutes: number
  priceSats: number
  x402PriceSats: number
  x402Endpoint: string | null
  maxConcurrentSlots: number
  specs: Record<string, any>
  createdAt: string
  updatedAt: string
  // joined
  agentHandle?: string
  activeBookings?: number
}

export class ComputeListingService {
  constructor(private db: DbConnection) {}

  async create(params: {
    agentId: string
    listingType: 'gpu_slot' | 'inference_slot'
    availabilityMode: 'instant' | 'scheduled'
    slotDurationMinutes: number
    priceSats: number
    x402PriceSats?: number
    x402Endpoint?: string
    maxConcurrentSlots?: number
    specs?: Record<string, any>
  }): Promise<ComputeListing> {
    const { nanoid } = await import('nanoid')
    const id = nanoid()
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')

    await this.db.run(
      `INSERT INTO compute_listings
        (id, agent_id, listing_type, availability_mode, status,
         slot_duration_minutes, price_sats, x402_price_sats, x402_endpoint,
         max_concurrent_slots, specs, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        params.agentId,
        params.listingType,
        params.availabilityMode,
        params.slotDurationMinutes,
        params.priceSats,
        params.x402PriceSats ?? 0,
        params.x402Endpoint ?? null,
        params.maxConcurrentSlots ?? 1,
        JSON.stringify(params.specs ?? {}),
        now,
        now,
      ]
    )

    return this.getById(id) as Promise<ComputeListing>
  }

  async getById(id: string): Promise<ComputeListing | null> {
    const row = await this.db.get(
      `SELECT l.*, a.handle as agent_handle,
              (SELECT COUNT(*) FROM compute_bookings b WHERE b.listing_id = l.id AND b.status = 'active') as active_bookings
       FROM compute_listings l
       LEFT JOIN agents a ON l.agent_id = a.id
       WHERE l.id = ?`,
      [id]
    )
    return row ? this.format(row) : null
  }

  async list(filters: {
    listingType?: string
    availabilityMode?: string
    maxPriceSats?: number
    agentId?: string
    status?: string
    limit?: number
    offset?: number
  } = {}): Promise<{ listings: ComputeListing[]; total: number }> {
    const conditions: string[] = ["l.status != 'deleted'"]
    const params: any[] = []

    if (filters.listingType) { conditions.push('l.listing_type = ?'); params.push(filters.listingType) }
    if (filters.availabilityMode) { conditions.push('l.availability_mode = ?'); params.push(filters.availabilityMode) }
    if (filters.maxPriceSats !== undefined) { conditions.push('l.price_sats <= ?'); params.push(filters.maxPriceSats) }
    if (filters.agentId) { conditions.push('l.agent_id = ?'); params.push(filters.agentId) }
    if (filters.status) { conditions.push('l.status = ?'); params.push(filters.status) }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = filters.limit ?? 20
    const offset = filters.offset ?? 0

    const [rows, countRow] = await Promise.all([
      this.db.all(
        `SELECT l.*, a.handle as agent_handle,
                (SELECT COUNT(*) FROM compute_bookings b WHERE b.listing_id = l.id AND b.status = 'active') as active_bookings
         FROM compute_listings l
         LEFT JOIN agents a ON l.agent_id = a.id
         ${where}
         ORDER BY l.created_at DESC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      ),
      this.db.get(
        `SELECT COUNT(*) as total FROM compute_listings l ${where}`,
        params
      ),
    ])

    return {
      listings: rows.map((r: any) => this.format(r)),
      total: countRow?.total ?? 0,
    }
  }

  async update(id: string, agentId: string, updates: {
    status?: 'active' | 'paused' | 'deleted'
    priceSats?: number
    x402PriceSats?: number
    x402Endpoint?: string
    maxConcurrentSlots?: number
    specs?: Record<string, any>
  }): Promise<ComputeListing | null> {
    const row = await this.db.get('SELECT * FROM compute_listings WHERE id = ? AND agent_id = ?', [id, agentId])
    if (!row) return null

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
    const fields: string[] = ['updated_at = ?']
    const params: any[] = [now]

    if (updates.status !== undefined) { fields.push('status = ?'); params.push(updates.status) }
    if (updates.priceSats !== undefined) { fields.push('price_sats = ?'); params.push(updates.priceSats) }
    if (updates.x402PriceSats !== undefined) { fields.push('x402_price_sats = ?'); params.push(updates.x402PriceSats) }
    if (updates.x402Endpoint !== undefined) { fields.push('x402_endpoint = ?'); params.push(updates.x402Endpoint) }
    if (updates.maxConcurrentSlots !== undefined) { fields.push('max_concurrent_slots = ?'); params.push(updates.maxConcurrentSlots) }
    if (updates.specs !== undefined) { fields.push('specs = ?'); params.push(JSON.stringify(updates.specs)) }

    params.push(id)
    await this.db.run(`UPDATE compute_listings SET ${fields.join(', ')} WHERE id = ?`, params)
    return this.getById(id)
  }

  private format(row: any): ComputeListing {
    return {
      id: row.id,
      agentId: row.agent_id,
      listingType: row.listing_type,
      availabilityMode: row.availability_mode,
      status: row.status,
      slotDurationMinutes: row.slot_duration_minutes,
      priceSats: row.price_sats,
      x402PriceSats: row.x402_price_sats,
      x402Endpoint: row.x402_endpoint,
      maxConcurrentSlots: row.max_concurrent_slots,
      specs: typeof row.specs === 'string' ? JSON.parse(row.specs || '{}') : (row.specs ?? {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      agentHandle: row.agent_handle,
      activeBookings: row.active_bookings ?? 0,
    }
  }
}
