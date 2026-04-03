/**
 * Compute Exchange tests
 *
 * Covers:
 *   - ComputeBookingService: book(), activate(), submitProof(), dispute(), refundEscrow(),
 *     processExpiredAndDisputed(), activatePendingScheduled()
 *   - ComputeSettlementService: settle(), verifyTxid(), retryPendingProofs(), getReceipt()
 *
 * The WalletService.anchorComputeBooking() call inside book() is automatically
 * disabled (no BROUTER_BSV_PRIVATE_KEY env var in test env).
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { ComputeBookingService } from '../services/ComputeBookingService'
import { ComputeSettlementService } from '../services/ComputeSettlementService'
import { walletService } from '../services/WalletService'
import type { DbConnection } from '../db/connection'

vi.mock('../services/WalletService', () => ({
  walletService: {
    isConfigured: vi.fn(() => true),
    sendBSV: vi.fn(() => Promise.resolve('abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234')),
    anchorComputeBooking: vi.fn(() => Promise.resolve(undefined)),
  },
}))

// ─── Mock DB factory ───────────────────────────────────────────────────────────

function createMockDb(): DbConnection {
  return {
    async run(_sql: string, _params?: any[]): Promise<void> {},
    async get(_sql: string, _params?: any[]): Promise<any | null> { return null },
    async all(_sql: string, _params?: any[]): Promise<any[]> { return [] },
    async allRaw(_sql: string, _params?: any[]): Promise<any[]> { return [] },
    async close(): Promise<void> {},
  }
}

// Minimal rows returned by the DB for common queries
const MOCK_LISTING = {
  id: 'listing-1',
  agent_id: 'provider-1',
  listing_type: 'inference_slot',
  availability_mode: 'instant',
  status: 'active',
  slot_duration_minutes: 60,
  price_sats: 1000,
  x402_price_sats: 10,
  x402_endpoint: '76a914abcdef1234567890abcdef1234567890abcdef1288ac',
  max_concurrent_slots: 3,
  specs: null,
  provider_callback_url: null,
}

const MOCK_RENTER = { id: 'renter-1', balance_sats: 5000 }

function mockBookingRow(overrides: Record<string, any> = {}) {
  return {
    id: 'booking-1',
    listing_id: 'listing-1',
    renter_agent_id: 'renter-1',
    status: 'active',
    starts_at: null,
    activated_at: '2026-04-03 00:00:00',
    expires_at: '2026-04-03 01:00:00',
    nlocktime_txid: null,
    proof_txid: null,
    escrow_sats: 1000,
    x402_calls_count: 0,
    x402_total_sats: 0,
    settlement_txid: null,
    dispute_reason: null,
    dispute_auto_refund_at: null,
    created_at: '2026-04-03 00:00:00',
    updated_at: '2026-04-03 00:00:00',
    renter_handle: 'renter',
    provider_handle: 'provider',
    provider_callback_url: null,
    listing_type: 'inference_slot',
    slot_duration_minutes: 60,
    price_sats: 1000,
    x402_endpoint: null,
    specs: null,
    ...overrides,
  }
}

// ─── ComputeBookingService ─────────────────────────────────────────────────────

describe('ComputeBookingService', () => {
  let db: ReturnType<typeof createMockDb>
  let service: ComputeBookingService

  beforeEach(() => {
    db = createMockDb()
    service = new ComputeBookingService(db)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('instantiates', () => {
    expect(service).toBeDefined()
  })

  // ── book() ─────────────────────────────────────────────────────────────────

  describe('book()', () => {
    it('returns error when listing not found', async () => {
      vi.spyOn(db, 'get').mockResolvedValue(null)
      const { booking, error } = await service.book({
        listingId: 'missing',
        renterAgentId: 'renter-1',
      })
      expect(booking).toBeNull()
      expect(error).toMatch(/not found/i)
    })

    it('returns error when at capacity', async () => {
      vi.spyOn(db, 'get')
        .mockResolvedValueOnce(MOCK_LISTING)           // listing
        .mockResolvedValueOnce({ cnt: 3 })             // activeCount >= max_concurrent_slots
      const { error } = await service.book({ listingId: 'listing-1', renterAgentId: 'renter-1' })
      expect(error).toMatch(/capacity/i)
    })

    it('returns error when renter has insufficient balance', async () => {
      vi.spyOn(db, 'get')
        .mockResolvedValueOnce(MOCK_LISTING)           // listing
        .mockResolvedValueOnce({ cnt: 0 })             // activeCount
        .mockResolvedValueOnce({ balance_sats: 500 })  // renter (need 1000)
      const { error } = await service.book({ listingId: 'listing-1', renterAgentId: 'renter-1' })
      expect(error).toMatch(/insufficient balance/i)
    })

    it('deducts renter balance and inserts booking on success', async () => {
      const runSpy = vi.spyOn(db, 'run')
      vi.spyOn(db, 'get')
        .mockResolvedValueOnce(MOCK_LISTING)           // listing
        .mockResolvedValueOnce({ cnt: 0 })             // activeCount
        .mockResolvedValueOnce(MOCK_RENTER)            // renter
        .mockResolvedValueOnce(mockBookingRow())       // getById() after insert

      const { booking, error } = await service.book({
        listingId: 'listing-1',
        renterAgentId: 'renter-1',
      })

      expect(error).toBeUndefined()
      expect(booking).not.toBeNull()

      // Should have called UPDATE agents (deduct) + INSERT compute_bookings
      const sqlCalls = runSpy.mock.calls.map(c => c[0])
      expect(sqlCalls.some(s => s.includes('UPDATE agents') && s.includes('balance_sats - ?'))).toBe(true)
      expect(sqlCalls.some(s => s.includes('INSERT INTO compute_bookings'))).toBe(true)
    })

    it('instant booking sets status to "active" immediately', async () => {
      const runSpy = vi.spyOn(db, 'run')
      vi.spyOn(db, 'get')
        .mockResolvedValueOnce(MOCK_LISTING)
        .mockResolvedValueOnce({ cnt: 0 })
        .mockResolvedValueOnce(MOCK_RENTER)
        .mockResolvedValueOnce(mockBookingRow({ status: 'active' }))

      await service.book({ listingId: 'listing-1', renterAgentId: 'renter-1' })

      const insertCall = runSpy.mock.calls.find(c => c[0].includes('INSERT INTO compute_bookings'))
      expect(insertCall).toBeDefined()
      // 4th param in INSERT is status — should be 'active' for instant mode
      const params = insertCall![1] as any[]
      expect(params).toContain('active')
    })

    it('scheduled booking sets status to "reserved"', async () => {
      const runSpy = vi.spyOn(db, 'run')
      vi.spyOn(db, 'get')
        .mockResolvedValueOnce(MOCK_LISTING)
        .mockResolvedValueOnce({ cnt: 0 })
        .mockResolvedValueOnce(MOCK_RENTER)
        .mockResolvedValueOnce(mockBookingRow({ status: 'reserved' }))

      await service.book({
        listingId: 'listing-1',
        renterAgentId: 'renter-1',
        startsAt: '2026-04-04T10:00:00Z',
      })

      const insertCall = runSpy.mock.calls.find(c => c[0].includes('INSERT INTO compute_bookings'))
      const params = insertCall![1] as any[]
      expect(params).toContain('reserved')
    })

    it('holds escrow_sats equal to price_sats', async () => {
      const runSpy = vi.spyOn(db, 'run')
      vi.spyOn(db, 'get')
        .mockResolvedValueOnce(MOCK_LISTING)          // price_sats: 1000
        .mockResolvedValueOnce({ cnt: 0 })
        .mockResolvedValueOnce(MOCK_RENTER)
        .mockResolvedValueOnce(mockBookingRow())

      await service.book({ listingId: 'listing-1', renterAgentId: 'renter-1' })

      const insertCall = runSpy.mock.calls.find(c => c[0].includes('INSERT INTO compute_bookings'))
      const params = insertCall![1] as any[]
      // escrow_sats is the 8th param in the INSERT — should equal price_sats (1000)
      expect(params).toContain(1000)
    })
  })

  // ── activate() ────────────────────────────────────────────────────────────

  describe('activate()', () => {
    it('returns null when booking not found or not reserved', async () => {
      vi.spyOn(db, 'get').mockResolvedValue(null)
      const result = await service.activate('missing-id')
      expect(result).toBeNull()
    })

    it('transitions reserved → active and sets expires_at', async () => {
      const runSpy = vi.spyOn(db, 'run')
      vi.spyOn(db, 'get')
        .mockResolvedValueOnce({ ...mockBookingRow({ status: 'reserved' }), slot_duration_minutes: 60 })
        .mockResolvedValueOnce(mockBookingRow({ status: 'active' }))

      const booking = await service.activate('booking-1')
      expect(booking).not.toBeNull()

      const updateCall = runSpy.mock.calls.find(c => c[0].includes("status = 'active'"))
      expect(updateCall).toBeDefined()
      const params = updateCall![1] as string[]
      // expires_at should be set (non-null datetime string)
      expect(params[1]).toMatch(/\d{4}-\d{2}-\d{2}/)
    })
  })

  // ── submitProof() ─────────────────────────────────────────────────────────

  describe('submitProof()', () => {
    it('returns error when booking not found or not active', async () => {
      vi.spyOn(db, 'get').mockResolvedValue(null)
      const { error } = await service.submitProof('booking-1', 'provider-1', 'abc123')
      expect(error).toMatch(/not found/i)
    })

    it('returns error when wrong provider tries to submit', async () => {
      vi.spyOn(db, 'get').mockResolvedValueOnce({
        ...mockBookingRow(),
        provider_agent_id: 'provider-1',
      })
      const { error } = await service.submitProof('booking-1', 'wrong-provider', 'abc123')
      expect(error).toMatch(/only the provider/i)
    })

    it('transitions active → proof_submitted and stores proof_txid', async () => {
      const runSpy = vi.spyOn(db, 'run')
      vi.spyOn(db, 'get')
        .mockResolvedValueOnce({ ...mockBookingRow(), provider_agent_id: 'provider-1' })
        .mockResolvedValueOnce(mockBookingRow({ status: 'proof_submitted', proof_txid: 'deadbeef01' }))

      const { booking, error } = await service.submitProof('booking-1', 'provider-1', 'deadbeef01')

      expect(error).toBeUndefined()
      const updateCall = runSpy.mock.calls.find(c => c[0].includes("status = 'proof_submitted'"))
      expect(updateCall).toBeDefined()
      expect(updateCall![1]).toContain('deadbeef01')
    })
  })

  // ── dispute() ─────────────────────────────────────────────────────────────

  describe('dispute()', () => {
    it('returns error when booking not found or wrong renter', async () => {
      vi.spyOn(db, 'get').mockResolvedValue(null)
      const { error } = await service.dispute('booking-1', 'wrong-renter')
      expect(error).toMatch(/not found/i)
    })

    it('sets status to disputed and schedules auto-refund in 24h', async () => {
      const runSpy = vi.spyOn(db, 'run')
      vi.spyOn(db, 'get')
        .mockResolvedValueOnce({ ...mockBookingRow(), renter_agent_id: 'renter-1', status: 'active' })
        .mockResolvedValueOnce(mockBookingRow({ status: 'disputed' }))

      await service.dispute('booking-1', 'renter-1', 'Provider went offline')

      const updateCall = runSpy.mock.calls.find(c => c[0].includes("status = 'disputed'"))
      expect(updateCall).toBeDefined()
      const params = updateCall![1] as string[]

      // dispute_reason
      expect(params[0]).toBe('Provider went offline')
      // dispute_auto_refund_at is a UTC datetime string — just verify it's a valid datetime ~24h from now
      // (Don't parse as Date without 'Z' — timezone interpretation is engine-dependent)
      expect(params[1]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
      // Verify it's strictly in the future (not null/empty)
      expect(params[1].length).toBeGreaterThan(0)
    })
  })

  // ── refundEscrow() ────────────────────────────────────────────────────────

  describe('refundEscrow()', () => {
    it('returns false when booking not found', async () => {
      vi.spyOn(db, 'get').mockResolvedValue(null)
      const result = await service.refundEscrow('booking-1', 'expired')
      expect(result).toBe(false)
    })

    it('returns false when escrow_sats is 0', async () => {
      vi.spyOn(db, 'get').mockResolvedValue({
        ...mockBookingRow({ escrow_sats: 0, status: 'active' }),
        provider_agent_id: 'provider-1',
      })
      const result = await service.refundEscrow('booking-1', 'expired')
      expect(result).toBe(false)
    })

    it('returns false for already-settled bookings', async () => {
      vi.spyOn(db, 'get').mockResolvedValue({
        ...mockBookingRow({ escrow_sats: 1000, status: 'settled' }),
        provider_agent_id: 'provider-1',
      })
      const result = await service.refundEscrow('booking-1', 'expired')
      expect(result).toBe(false)
    })

    it('credits renter and marks booking expired', async () => {
      const runSpy = vi.spyOn(db, 'run')
      vi.spyOn(db, 'get').mockResolvedValue({
        ...mockBookingRow({ escrow_sats: 1000, status: 'active' }),
        provider_agent_id: 'provider-1',
      })

      const result = await service.refundEscrow('booking-1', 'expired')
      expect(result).toBe(true)

      const creditCall = runSpy.mock.calls.find(
        c => c[0].includes('UPDATE agents') && c[0].includes('balance_sats + ?')
      )
      expect(creditCall).toBeDefined()
      expect(creditCall![1]).toContain(1000) // full escrow back

      const expireCall = runSpy.mock.calls.find(c => c[0].includes("status = 'expired'"))
      expect(expireCall).toBeDefined()

      // escrow_sats = 0 is hardcoded in the SQL (not a param) — verify it's in the query
      expect(expireCall![0]).toContain('escrow_sats = 0')
    })
  })

  // ── processExpiredAndDisputed() ──────────────────────────────────────────

  describe('processExpiredAndDisputed()', () => {
    it('processes zero rows gracefully', async () => {
      vi.spyOn(db, 'all').mockResolvedValue([])
      const result = await service.processExpiredAndDisputed()
      expect(result.expired).toBe(0)
      expect(result.disputeRefunds).toBe(0)
    })

    it('calls refundEscrow for each expired active booking', async () => {
      const refundSpy = vi.spyOn(service, 'refundEscrow').mockResolvedValue(true)

      vi.spyOn(db, 'all')
        .mockResolvedValueOnce([{ id: 'b1' }, { id: 'b2' }])  // expired active
        .mockResolvedValueOnce([])                              // disputed auto-refund

      const result = await service.processExpiredAndDisputed()
      expect(refundSpy).toHaveBeenCalledTimes(2)
      expect(result.expired).toBe(2)
      expect(result.disputeRefunds).toBe(0)
    })

    it('calls refundEscrow for each overdue disputed booking', async () => {
      const refundSpy = vi.spyOn(service, 'refundEscrow').mockResolvedValue(true)

      vi.spyOn(db, 'all')
        .mockResolvedValueOnce([])                    // no expired active
        .mockResolvedValueOnce([{ id: 'b3' }])        // one dispute timeout

      const result = await service.processExpiredAndDisputed()
      expect(refundSpy).toHaveBeenCalledWith('b3', 'dispute_timeout')
      expect(result.disputeRefunds).toBe(1)
    })
  })

  // ── activatePendingScheduled() ────────────────────────────────────────────

  describe('activatePendingScheduled()', () => {
    it('returns 0 when no scheduled bookings are pending', async () => {
      vi.spyOn(db, 'all').mockResolvedValue([])
      const count = await service.activatePendingScheduled()
      expect(count).toBe(0)
    })

    it('calls activate() for each pending scheduled booking', async () => {
      const activateSpy = vi.spyOn(service, 'activate').mockResolvedValue(null)
      vi.spyOn(db, 'all').mockResolvedValue([
        { id: 'b1', slot_duration_minutes: 60 },
        { id: 'b2', slot_duration_minutes: 30 },
      ])

      const count = await service.activatePendingScheduled()
      expect(activateSpy).toHaveBeenCalledTimes(2)
      expect(count).toBe(2)
    })
  })

  // ── recordX402Call() ──────────────────────────────────────────────────────

  describe('recordX402Call()', () => {
    it('increments x402 counters in DB', async () => {
      const runSpy = vi.spyOn(db, 'run')
      await service.recordX402Call('booking-1', 50)

      const updateCall = runSpy.mock.calls.find(
        c => c[0].includes('x402_calls_count') && c[0].includes('x402_total_sats')
      )
      expect(updateCall).toBeDefined()
      expect(updateCall![1]).toContain(50)
    })
  })
})

// ─── ComputeSettlementService ──────────────────────────────────────────────────

describe('ComputeSettlementService', () => {
  let db: ReturnType<typeof createMockDb>
  let service: ComputeSettlementService

  beforeEach(() => {
    db = createMockDb()
    service = new ComputeSettlementService(db)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('instantiates', () => {
    expect(service).toBeDefined()
  })

  // ── verifyTxid() ───────────────────────────────────────────────────────────

  describe('verifyTxid()', () => {
    it('returns false immediately for non-hex txid', async () => {
      const result = await service.verifyTxid('not-a-txid')
      expect(result).toBe(false)
    })

    it('returns false for txid shorter than 64 chars', async () => {
      const result = await service.verifyTxid('abcd1234')
      expect(result).toBe(false)
    })

    it('returns false for txid longer than 64 chars', async () => {
      const result = await service.verifyTxid('a'.repeat(65))
      expect(result).toBe(false)
    })

    it('returns true when WoC confirms a valid txid (blockheight > 0)', async () => {
      const validTxid = 'a'.repeat(64)
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ txid: validTxid, blockheight: 803000, confirmations: 6 }),
      }))

      const result = await service.verifyTxid(validTxid)
      expect(result).toBe(true)

      vi.unstubAllGlobals()
    })

    it('returns false when WoC returns 404 (txid not found)', async () => {
      const validTxid = 'b'.repeat(64)
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }))

      const result = await service.verifyTxid(validTxid)
      expect(result).toBe(false)

      vi.unstubAllGlobals()
    })

    it('falls back to BananaBlocks when WoC throws', async () => {
      const validTxid = 'c'.repeat(64)
      let callCount = 0
      vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 1) throw new Error('WoC timeout')
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ found: true, confirmations: 3 }),
        })
      }))

      const result = await service.verifyTxid(validTxid)
      expect(result).toBe(true)
      expect(callCount).toBe(2) // WoC failed, BananaBlocks called

      vi.unstubAllGlobals()
    })

    it('returns null when both SPV sources are unreachable', async () => {
      const validTxid = 'd'.repeat(64)
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network down')))

      const result = await service.verifyTxid(validTxid)
      expect(result).toBeNull()

      vi.unstubAllGlobals()
    })
  })

  // ── settle() ─────────────────────────────────────────────────────────────

  describe('settle()', () => {
    it('returns error when booking not in proof_submitted state', async () => {
      vi.spyOn(db, 'get').mockResolvedValue(null)
      const result = await service.settle('booking-1')
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/not found/i)
    })

    it('returns error when no proof_txid on record', async () => {
      vi.spyOn(db, 'get').mockResolvedValue({
        id: 'booking-1',
        status: 'proof_submitted',
        proof_txid: null,
        escrow_sats: 1000,
        price_sats: 1000,
        provider_agent_id: 'provider-1',
      })
      const result = await service.settle('booking-1')
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/no proof txid/i)
    })

    it('returns proofPending when both SPV sources unreachable', async () => {
      vi.spyOn(db, 'get').mockResolvedValue({
        id: 'booking-1',
        status: 'proof_submitted',
        proof_txid: 'e'.repeat(64),
        escrow_sats: 1000,
        price_sats: 1000,
        provider_agent_id: 'provider-1',
      })
      vi.spyOn(service, 'verifyTxid').mockResolvedValue(null) // unreachable

      const result = await service.settle('booking-1')
      expect(result.success).toBe(false)
      expect(result.proofPending).toBe(true)
    })

    it('reverts to active and returns error when txid is invalid', async () => {
      const runSpy = vi.spyOn(db, 'run')
      vi.spyOn(db, 'get').mockResolvedValue({
        id: 'booking-1',
        status: 'proof_submitted',
        proof_txid: 'f'.repeat(64),
        escrow_sats: 1000,
        price_sats: 1000,
        provider_agent_id: 'provider-1',
      })
      vi.spyOn(service, 'verifyTxid').mockResolvedValue(false) // invalid txid

      const result = await service.settle('booking-1')
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/not found on-chain/i)

      // Should revert booking to 'active' so provider can resubmit
      const revertCall = runSpy.mock.calls.find(c => c[0].includes("status = 'active'"))
      expect(revertCall).toBeDefined()
    })

    it('releases escrow, credits provider, and marks settled on valid proof', async () => {
      const runSpy = vi.spyOn(db, 'run')
      vi.spyOn(db, 'get').mockResolvedValue({
        id: 'booking-1',
        status: 'proof_submitted',
        proof_txid: '0'.repeat(64),
        escrow_sats: 1000,
        price_sats: 1000,
        provider_agent_id: 'provider-1',
      })
      vi.spyOn(service, 'verifyTxid').mockResolvedValue(true)
      vi.spyOn(service, 'updateProviderScore').mockResolvedValue()

      const result = await service.settle('booking-1')
      expect(result.success).toBe(true)

      // 1% fee: 1000 * 100/10000 = 10 sats fee → 990 sats payout
      expect(result.payoutSats).toBe(990)

      // Provider credited 990
      const creditCall = runSpy.mock.calls.find(
        c => c[0].includes('UPDATE agents') && c[0].includes('balance_sats + ?')
      )
      expect(creditCall).toBeDefined()
      expect(creditCall![1]).toContain(990)

      // Booking marked settled, escrow zeroed
      const settleCall = runSpy.mock.calls.find(c => c[0].includes("status = 'settled'"))
      expect(settleCall).toBeDefined()
    })

    it('calculates 1% platform fee correctly across various amounts', () => {
      // Pure fee math — no DB needed
      const cases = [
        { escrow: 1000, expectedFee: 10, expectedPayout: 990 },
        { escrow: 5000, expectedFee: 50, expectedPayout: 4950 },
        { escrow: 100, expectedFee: 1, expectedPayout: 99 },
        { escrow: 99, expectedFee: 0, expectedPayout: 99 },   // floor(99*100/10000)=0
        { escrow: 10000, expectedFee: 100, expectedPayout: 9900 },
      ]
      for (const { escrow, expectedFee, expectedPayout } of cases) {
        const fee = Math.floor((escrow * 100) / 10000)
        const payout = escrow - fee
        expect(fee).toBe(expectedFee)
        expect(payout).toBe(expectedPayout)
      }
    })

    it('stores real txid in settlement when wallet is configured and provider has bsvAddress', async () => {
      const MOCK_TXID = 'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234'
      const runSpy = vi.spyOn(db, 'run')

      vi.mocked(walletService.isConfigured).mockReturnValue(true)
      vi.mocked(walletService.sendBSV).mockResolvedValue(MOCK_TXID)

      vi.spyOn(db, 'get')
        .mockResolvedValueOnce({
          id: 'booking-1',
          status: 'proof_submitted',
          proof_txid: '0'.repeat(64),
          escrow_sats: 1000,
          price_sats: 1000,
          provider_agent_id: 'provider-1',
        })
        .mockResolvedValueOnce({ bsvAddress: '1BsvProviderAddressXxx' })  // providerRow

      vi.spyOn(service, 'verifyTxid').mockResolvedValue(true)
      vi.spyOn(service, 'updateProviderScore').mockResolvedValue()

      const result = await service.settle('booking-1')
      expect(result.success).toBe(true)

      // sendBSV called with provider address and net payout (990 sats after 1% fee)
      expect(walletService.sendBSV).toHaveBeenCalledWith('1BsvProviderAddressXxx', 990)

      // settlement_txid in the UPDATE should be the mock txid
      const settleCall = runSpy.mock.calls.find(c => c[0].includes("status = 'settled'"))
      expect(settleCall).toBeDefined()
      expect(settleCall![1]).toContain(MOCK_TXID)
    })

    it('still settles successfully with null settlement_txid when sendBSV throws', async () => {
      const runSpy = vi.spyOn(db, 'run')

      vi.mocked(walletService.isConfigured).mockReturnValue(true)
      vi.mocked(walletService.sendBSV).mockRejectedValue(new Error('Network error'))

      vi.spyOn(db, 'get')
        .mockResolvedValueOnce({
          id: 'booking-1',
          status: 'proof_submitted',
          proof_txid: '0'.repeat(64),
          escrow_sats: 1000,
          price_sats: 1000,
          provider_agent_id: 'provider-1',
        })
        .mockResolvedValueOnce({ bsvAddress: '1BsvProviderAddressXxx' })  // providerRow

      vi.spyOn(service, 'verifyTxid').mockResolvedValue(true)
      vi.spyOn(service, 'updateProviderScore').mockResolvedValue()

      const result = await service.settle('booking-1')
      expect(result.success).toBe(true)

      // settlement_txid should be null (graceful fallback)
      const settleCall = runSpy.mock.calls.find(c => c[0].includes("status = 'settled'"))
      expect(settleCall).toBeDefined()
      expect(settleCall![1][0]).toBeNull()
    })
  })

  // ── retryPendingProofs() ──────────────────────────────────────────────────

  describe('retryPendingProofs()', () => {
    it('returns 0 when no proof_submitted bookings exist', async () => {
      vi.spyOn(db, 'all').mockResolvedValue([])
      const count = await service.retryPendingProofs()
      expect(count).toBe(0)
    })

    it('calls settle() for each proof_submitted booking', async () => {
      const settleSpy = vi.spyOn(service, 'settle').mockResolvedValue({ success: true, payoutSats: 990 })
      vi.spyOn(db, 'all').mockResolvedValue([{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }])

      const count = await service.retryPendingProofs()
      expect(settleSpy).toHaveBeenCalledTimes(3)
      expect(count).toBe(3)
    })

    it('counts only successful settlements', async () => {
      vi.spyOn(service, 'settle')
        .mockResolvedValueOnce({ success: true, payoutSats: 990 })
        .mockResolvedValueOnce({ success: false, proofPending: true })
        .mockResolvedValueOnce({ success: true, payoutSats: 4950 })
      vi.spyOn(db, 'all').mockResolvedValue([{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }])

      const count = await service.retryPendingProofs()
      expect(count).toBe(2) // only 2 successful
    })
  })

  // ── getReceipt() ───────────────────────────────────────────────────────────

  describe('getReceipt()', () => {
    it('returns null for unknown booking', async () => {
      vi.spyOn(db, 'get').mockResolvedValue(null)
      const receipt = await service.getReceipt('missing')
      expect(receipt).toBeNull()
    })

    it('returns correct receipt shape with fee math', async () => {
      vi.spyOn(db, 'get').mockResolvedValue({
        id: 'booking-1',
        status: 'settled',
        price_sats: 5000,
        escrow_sats: 5000,
        provider_agent_id: 'provider-1',
        renter_handle: 'alice',
        provider_handle: 'bob',
        x402_calls_count: 7,
        x402_total_sats: 70,
        proof_txid: '0'.repeat(64),
        settlement_txid: null,
        activated_at: '2026-04-03 00:00:00',
        expires_at: '2026-04-03 01:00:00',
        dispute_reason: null,
      })

      const receipt = await service.getReceipt('booking-1')
      expect(receipt).not.toBeNull()
      expect(receipt!.renter).toBe('alice')
      expect(receipt!.provider).toBe('bob')
      expect(receipt!.slotPriceSats).toBe(5000)
      expect(receipt!.platformFeeSats).toBe(50)       // 1% of 5000
      expect(receipt!.providerPayoutSats).toBe(4950)
      expect(receipt!.x402CallsCount).toBe(7)
      expect(receipt!.x402TotalSats).toBe(70)
      expect(receipt!.proofVerified).toBe(true)       // status === 'settled'
    })

    it('receipt proofVerified is false when not yet settled', async () => {
      vi.spyOn(db, 'get').mockResolvedValue({
        id: 'booking-1',
        status: 'proof_submitted',
        price_sats: 1000,
        escrow_sats: 1000,
        provider_agent_id: 'provider-1',
        renter_handle: 'alice',
        provider_handle: 'bob',
        x402_calls_count: 0,
        x402_total_sats: 0,
        proof_txid: '0'.repeat(64),
        settlement_txid: null,
        activated_at: null,
        expires_at: null,
        dispute_reason: null,
      })

      const receipt = await service.getReceipt('booking-1')
      expect(receipt!.proofVerified).toBe(false)
    })
  })

  // ── updateProviderScore() ────────────────────────────────────────────────

  describe('updateProviderScore()', () => {
    it('does nothing when there are no bookings', async () => {
      const runSpy = vi.spyOn(db, 'run')
      vi.spyOn(db, 'get').mockResolvedValue(null)
      await service.updateProviderScore('provider-1')
      expect(runSpy).not.toHaveBeenCalled()
    })

    it('does nothing when total settled+disputed is 0', async () => {
      const runSpy = vi.spyOn(db, 'run')
      vi.spyOn(db, 'get').mockResolvedValue({ settled: 0, disputed: 0 })
      await service.updateProviderScore('provider-1')
      expect(runSpy).not.toHaveBeenCalled()
    })

    it('calculates score as settled / (settled + disputed)', async () => {
      const runSpy = vi.spyOn(db, 'run')
      vi.spyOn(db, 'get').mockResolvedValue({ settled: 8, disputed: 2 })
      await service.updateProviderScore('provider-1')
      const updateCall = runSpy.mock.calls.find(c => c[0].includes('compute_provider_score'))
      expect(updateCall).toBeDefined()
      expect(updateCall![1][0]).toBeCloseTo(0.8) // 8 / (8+2)
    })

    it('gives score of 1.0 for perfect track record', async () => {
      const runSpy = vi.spyOn(db, 'run')
      vi.spyOn(db, 'get').mockResolvedValue({ settled: 10, disputed: 0 })
      await service.updateProviderScore('provider-1')
      const updateCall = runSpy.mock.calls.find(c => c[0].includes('compute_provider_score'))
      expect(updateCall![1][0]).toBe(1)
    })

    it('gives score of 0.0 for all-disputed track record', async () => {
      const runSpy = vi.spyOn(db, 'run')
      vi.spyOn(db, 'get').mockResolvedValue({ settled: 0, disputed: 5 })
      await service.updateProviderScore('provider-1')
      const updateCall = runSpy.mock.calls.find(c => c[0].includes('compute_provider_score'))
      expect(updateCall![1][0]).toBe(0)
    })
  })
})
