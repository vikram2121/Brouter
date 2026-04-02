import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'

const BASE = '/api'

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem('brouter_token')
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...((opts.headers as Record<string, string>) ?? {}),
    },
  })
  const data = await res.json()
  if (!data.success) throw new Error(data.error || 'Request failed')
  return data.data
}

interface ComputeBooking {
  id: string
  listingId: string
  renterAgentId: string
  renterHandle?: string
  providerHandle?: string
  status: 'reserved' | 'active' | 'completed' | 'settled' | 'disputed'
  startsAt: string | null
  activatedAt: string | null
  expiresAt: string | null
  proofTxid: string | null
  x402CallsCount: number
  x402TotalSats: number
  settlementTxid: string | null
  createdAt: string
  listing?: {
    listingType: string
    slotDurationMinutes: number
    priceSats: number
    x402Endpoint: string | null
    specs: Record<string, any>
  }
}

interface Receipt {
  bookingId: string
  status: string
  renter: string
  provider: string
  slotPriceSats: number
  platformFeeSats: number
  providerPayoutSats: number
  x402CallsCount: number
  x402TotalSats: number
  proofTxid: string | null
  activatedAt: string | null
  expiresAt: string | null
}

function StatusBadge({ status }: { status: string }) {
  const cfg: Record<string, { label: string; color: string; bg: string }> = {
    reserved:  { label: 'RESERVED',  color: '#5b9bf0', bg: 'rgba(91,155,240,0.12)' },
    active:    { label: 'ACTIVE',    color: '#00e5b0', bg: 'rgba(0,229,176,0.12)' },
    completed: { label: 'COMPLETED', color: '#f0c040', bg: 'rgba(240,192,64,0.12)' },
    settled:   { label: 'SETTLED',   color: '#c084fc', bg: 'rgba(192,132,252,0.12)' },
    disputed:  { label: 'DISPUTED',  color: '#f87171', bg: 'rgba(248,113,113,0.12)' },
  }
  const c = cfg[status] ?? cfg.reserved
  return (
    <span style={{
      fontSize: '0.65rem', fontFamily: 'DM Mono, monospace', fontWeight: 700,
      color: c.color, background: c.bg, borderRadius: '0.25rem',
      padding: '0.15rem 0.5rem', letterSpacing: '0.05em'
    }}>{c.label}</span>
  )
}

function Row({ label, value, accent }: { label: string; value: any; accent?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem', fontFamily: 'DM Mono, monospace' }}>{label}</span>
      <span style={{ color: accent ?? 'var(--text)', fontSize: '0.8rem', fontFamily: 'DM Mono, monospace', fontWeight: 500 }}>{value}</span>
    </div>
  )
}

export function ComputeBookingPage() {
  const { id } = useParams<{ id: string }>()
  const { agent } = useAuth()
  const agentId = agent?.id
  const [booking, setBooking] = useState<ComputeBooking | null>(null)
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const [loading, setLoading] = useState(true)
  const [proofInput, setProofInput] = useState('')
  const [actionLoading, setActionLoading] = useState(false)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const { booking: b } = await request<{ booking: ComputeBooking }>(`/compute/bookings/${id}`)
      setBooking(b)
      if (b.status === 'settled') {
        const { receipt: r } = await request<{ receipt: Receipt }>(`/compute/bookings/${id}/receipt`)
        setReceipt(r)
      }
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [id])

  const submitProof = async () => {
    if (!proofInput.trim()) return setError('Proof txid is required')
    setError('')
    setActionLoading(true)
    try {
      await request(`/compute/bookings/${id}/proof`, {
        method: 'POST',
        body: JSON.stringify({ proofTxid: proofInput.trim() }),
      })
      setMsg('Proof submitted — booking auto-settled!')
      load()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setActionLoading(false)
    }
  }

  const raiseDispute = async () => {
    if (!window.confirm('Are you sure you want to raise a dispute? This will freeze the escrow for review.')) return
    setError('')
    setActionLoading(true)
    try {
      await request(`/compute/bookings/${id}/dispute`, { method: 'POST' })
      setMsg('Dispute raised — escrow frozen for review.')
      load()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setActionLoading(false)
    }
  }

  if (loading) return (
    <main className="main" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ color: 'var(--text-muted)', fontFamily: 'DM Mono, monospace', fontSize: '0.8rem' }}>Loading...</div>
    </main>
  )

  if (error && !booking) return (
    <main className="main" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ color: '#f87171', fontFamily: 'DM Mono, monospace', fontSize: '0.8rem', marginBottom: '1rem' }}>{error}</div>
        <Link to="/compute" style={{ color: 'var(--accent)', fontSize: '0.8rem' }}>← Back to Exchange</Link>
      </div>
    </main>
  )

  if (!booking) return null

  const isRenter = agentId === booking.renterAgentId
  const now = new Date()
  const isExpired = booking.expiresAt ? new Date(booking.expiresAt) < now : false
  const timeLeft = booking.expiresAt && !isExpired
    ? Math.max(0, Math.floor((new Date(booking.expiresAt).getTime() - now.getTime()) / 1000 / 60))
    : null

  return (
    <main className="main" style={{ maxWidth: '600px' }}>
      <div style={{ padding: '1.5rem 1rem' }}>
        <Link to="/compute" style={{ color: 'var(--text-muted)', fontSize: '0.75rem', fontFamily: 'DM Mono, monospace', textDecoration: 'none', display: 'inline-block', marginBottom: '1.25rem' }}>
          ← Compute Exchange
        </Link>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem' }}>
          <div>
            <h1 style={{ fontFamily: "'Instrument Serif', serif", fontSize: '1.4rem', fontStyle: 'italic', color: 'var(--text)', margin: '0 0 0.3rem' }}>
              Booking
            </h1>
            <div style={{ fontFamily: 'DM Mono, monospace', fontSize: '0.65rem', color: 'var(--text-dim)' }}>{booking.id}</div>
          </div>
          <StatusBadge status={booking.status} />
        </div>

        {/* Core details */}
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px', padding: '1.25rem', marginBottom: '1rem' }}>
          <Row label="Renter" value={`@${booking.renterHandle}`} />
          <Row label="Provider" value={`@${booking.providerHandle}`} />
          {booking.listing && (
            <>
              <Row label="Type" value={booking.listing.listingType === 'gpu_slot' ? '⚡ GPU Slot' : '🤖 Inference Slot'} />
              <Row label="Slot price" value={`${booking.listing.priceSats?.toLocaleString()} sats`} accent="#f0c040" />
              <Row label="Duration" value={`${booking.listing.slotDurationMinutes} min`} />
            </>
          )}
          {booking.activatedAt && <Row label="Activated" value={new Date(booking.activatedAt).toLocaleString()} />}
          {booking.expiresAt && (
            <Row
              label="Expires"
              value={isExpired ? 'Expired' : `${new Date(booking.expiresAt).toLocaleString()} (${timeLeft}m left)`}
              accent={isExpired ? '#f87171' : '#00e5b0'}
            />
          )}
          {booking.x402CallsCount > 0 && (
            <>
              <Row label="x402 calls" value={booking.x402CallsCount.toLocaleString()} />
              <Row label="x402 sats" value={`${booking.x402TotalSats.toLocaleString()} sats`} accent="#00e5b0" />
            </>
          )}
          {booking.proofTxid && <Row label="Proof txid" value={`${booking.proofTxid.slice(0, 16)}…`} />}
        </div>

        {/* Settlement receipt */}
        {receipt && (
          <div style={{ background: 'var(--surface)', border: '1px solid rgba(192,132,252,0.3)', borderRadius: '12px', padding: '1.25rem', marginBottom: '1rem' }}>
            <div style={{ fontFamily: 'DM Mono, monospace', fontSize: '0.7rem', color: '#c084fc', marginBottom: '0.75rem', letterSpacing: '0.05em' }}>SETTLEMENT RECEIPT</div>
            <Row label="Slot price" value={`${receipt.slotPriceSats.toLocaleString()} sats`} />
            <Row label="Platform fee (1%)" value={`${receipt.platformFeeSats} sats`} />
            <Row label="Provider payout" value={`${receipt.providerPayoutSats.toLocaleString()} sats`} accent="#00e5b0" />
          </div>
        )}

        {/* Actions */}
        {msg && (
          <div style={{ color: '#00e5b0', fontFamily: 'DM Mono, monospace', fontSize: '0.75rem', marginBottom: '0.75rem', padding: '0.5rem 0.75rem', background: 'rgba(0,229,176,0.08)', borderRadius: '8px' }}>
            {msg}
          </div>
        )}
        {error && (
          <div style={{ color: '#f87171', fontFamily: 'DM Mono, monospace', fontSize: '0.75rem', marginBottom: '0.75rem', padding: '0.5rem 0.75rem', background: 'rgba(248,113,113,0.08)', borderRadius: '8px' }}>
            {error}
          </div>
        )}

        {/* Provider: submit proof */}
        {!isRenter && booking.status === 'active' && (
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px', padding: '1.25rem' }}>
            <div style={{ fontFamily: 'DM Mono, monospace', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>Submit delivery proof</div>
            <input
              type="text"
              placeholder="BSV txid or signed message hash"
              value={proofInput}
              onChange={e => setProofInput(e.target.value)}
              style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text)', padding: '0.5rem 0.75rem', fontSize: '0.8rem', boxSizing: 'border-box', marginBottom: '0.75rem' }}
            />
            <button onClick={submitProof} disabled={actionLoading} className="nav-btn btn-primary" style={{ width: '100%', fontSize: '0.8rem' }}>
              {actionLoading ? 'Submitting...' : 'Submit Proof & Settle'}
            </button>
          </div>
        )}

        {/* Renter: dispute */}
        {isRenter && booking.status === 'active' && (
          <div style={{ marginTop: '0.75rem', textAlign: 'right' }}>
            <button onClick={raiseDispute} disabled={actionLoading} style={{ background: 'none', border: '1px solid rgba(248,113,113,0.4)', color: '#f87171', borderRadius: '8px', padding: '0.4rem 1rem', fontSize: '0.75rem', cursor: 'pointer', fontFamily: 'DM Mono, monospace' }}>
              Raise Dispute
            </button>
          </div>
        )}
      </div>
    </main>
  )
}
