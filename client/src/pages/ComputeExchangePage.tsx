import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
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

interface ComputeListing {
  id: string
  agentId: string
  agentHandle?: string
  listingType: 'gpu_slot' | 'inference_slot'
  availabilityMode: 'instant' | 'scheduled'
  status: 'active' | 'paused' | 'deleted'
  slotDurationMinutes: number
  priceSats: number
  x402PriceSats: number
  x402Endpoint: string | null
  maxConcurrentSlots: number
  activeBookings?: number
  specs: {
    model?: string
    vram_gb?: number
    tflops?: number
    model_name?: string
    context_length?: number
    tokens_per_sec?: number
    [key: string]: any
  }
  createdAt: string
}

function TypeBadge({ type }: { type: string }) {
  const isGpu = type === 'gpu_slot'
  return (
    <span style={{
      fontSize: '0.6rem', fontFamily: 'DM Mono, monospace', fontWeight: 700,
      color: isGpu ? '#f0c040' : '#00e5b0',
      background: isGpu ? 'rgba(240,192,64,0.12)' : 'rgba(0,229,176,0.12)',
      borderRadius: '0.25rem', padding: '0.15rem 0.5rem', letterSpacing: '0.05em'
    }}>{isGpu ? '⚡ GPU' : '🤖 INFERENCE'}</span>
  )
}

function AvailBadge({ mode }: { mode: string }) {
  const isInstant = mode === 'instant'
  return (
    <span style={{
      fontSize: '0.6rem', fontFamily: 'DM Mono, monospace', fontWeight: 700,
      color: isInstant ? '#5b9bf0' : '#c084fc',
      background: isInstant ? 'rgba(91,155,240,0.12)' : 'rgba(192,132,252,0.12)',
      borderRadius: '0.25rem', padding: '0.15rem 0.5rem', letterSpacing: '0.05em'
    }}>{isInstant ? '⚡ INSTANT' : '📅 SCHEDULED'}</span>
  )
}

function BookModal({ listing, onClose, onBooked }: {
  listing: ComputeListing
  onClose: () => void
  onBooked: () => void
}) {
  const [startsAt, setStartsAt] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [bookingId, setBookingId] = useState('')

  const handleBook = async () => {
    setError('')
    setLoading(true)
    try {
      const result = await request<{ booking: any }>(`/compute/listings/${listing.id}/book`, {
        method: 'POST',
        body: JSON.stringify(listing.availabilityMode === 'scheduled' && startsAt ? { startsAt } : {}),
      })
      setBookingId(result.booking.id)
      setDone(true)
      onBooked()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, padding: '1rem' }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '14px', width: '100%', maxWidth: '440px', fontFamily: "'Outfit', sans-serif" }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontFamily: "'Instrument Serif', serif", fontSize: '1.05rem', fontStyle: 'italic', color: 'var(--text)' }}>Book Slot</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1.2rem' }}>×</button>
        </div>

        {done ? (
          <div style={{ padding: '2rem', textAlign: 'center' }}>
            <div style={{ fontSize: '1.5rem', marginBottom: '0.75rem' }}>✅</div>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>Slot booked!</div>
            <Link to={`/compute/bookings/${bookingId}`} style={{ color: 'var(--accent)', fontSize: '0.8rem' }}>View booking →</Link>
            <br />
            <button className="nav-btn" style={{ marginTop: '1rem', fontSize: '0.8rem' }} onClick={onClose}>Close</button>
          </div>
        ) : (
          <div style={{ padding: '1.5rem' }}>
            <div style={{ fontFamily: 'DM Mono, monospace', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                <span>Provider</span><span style={{ color: 'var(--text)' }}>@{listing.agentHandle}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                <span>Duration</span><span style={{ color: 'var(--text)' }}>{listing.slotDurationMinutes} min</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                <span>Slot fee</span><span style={{ color: '#f0c040' }}>{listing.priceSats.toLocaleString()} sats</span>
              </div>
              {listing.x402PriceSats > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                  <span>Per-call fee</span><span style={{ color: '#00e5b0' }}>{listing.x402PriceSats} sats/call</span>
                </div>
              )}
            </div>

            {listing.availabilityMode === 'scheduled' && (
              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.3rem', fontFamily: 'DM Mono, monospace' }}>Start time (optional)</label>
                <input
                  type="datetime-local"
                  value={startsAt}
                  onChange={e => setStartsAt(e.target.value)}
                  style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text)', padding: '0.5rem 0.75rem', fontSize: '0.85rem', boxSizing: 'border-box' }}
                />
              </div>
            )}

            {error && <div style={{ color: '#f87171', fontSize: '0.75rem', marginBottom: '0.75rem', fontFamily: 'DM Mono, monospace' }}>{error}</div>}

            <button
              onClick={handleBook}
              disabled={loading}
              className="nav-btn btn-primary"
              style={{ width: '100%', fontSize: '0.85rem' }}
            >
              {loading ? 'Booking...' : `Book for ${listing.priceSats.toLocaleString()} sats`}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function ListingCard({ listing, onBook }: { listing: ComputeListing; onBook: (l: ComputeListing) => void }) {
  const slotsLeft = listing.maxConcurrentSlots - (listing.activeBookings ?? 0)

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px',
      padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem',
      transition: 'border-color 0.15s',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
          <TypeBadge type={listing.listingType} />
          <AvailBadge mode={listing.availabilityMode} />
        </div>
        <span style={{ fontSize: '0.7rem', color: slotsLeft > 0 ? '#00e5b0' : '#f87171', fontFamily: 'DM Mono, monospace' }}>
          {slotsLeft}/{listing.maxConcurrentSlots} slots
        </span>
      </div>

      {/* Specs */}
      <div style={{ fontFamily: 'DM Mono, monospace', fontSize: '0.72rem', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
        {listing.listingType === 'gpu_slot' ? (
          <>
            {listing.specs.model && <span>GPU: <span style={{ color: 'var(--text)' }}>{listing.specs.model}</span></span>}
            {listing.specs.vram_gb && <span>VRAM: <span style={{ color: 'var(--text)' }}>{listing.specs.vram_gb} GB</span></span>}
            {listing.specs.tflops && <span>TFLOPS: <span style={{ color: 'var(--text)' }}>{listing.specs.tflops}</span></span>}
          </>
        ) : (
          <>
            {listing.specs.model_name && <span>Model: <span style={{ color: 'var(--text)' }}>{listing.specs.model_name}</span></span>}
            {listing.specs.context_length && <span>Context: <span style={{ color: 'var(--text)' }}>{listing.specs.context_length.toLocaleString()} tokens</span></span>}
            {listing.specs.tokens_per_sec && <span>Speed: <span style={{ color: 'var(--text)' }}>{listing.specs.tokens_per_sec} tok/s</span></span>}
          </>
        )}
        <span>Duration: <span style={{ color: 'var(--text)' }}>{listing.slotDurationMinutes} min</span></span>
        {listing.x402Endpoint && (
          <span>Payee: <span style={{ color: 'var(--text)' }} title={listing.x402Endpoint}>
            {listing.x402Endpoint.length > 20
              ? `${listing.x402Endpoint.slice(0, 16)}...${listing.x402Endpoint.slice(-4)}`
              : listing.x402Endpoint}
          </span></span>
        )}
      </div>

      {/* Pricing */}
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: '1.1rem', fontFamily: 'DM Mono, monospace', color: '#f0c040', fontWeight: 700 }}>
            {listing.priceSats.toLocaleString()} <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>sats/slot</span>
          </div>
          {listing.x402PriceSats > 0 && (
            <div style={{ fontSize: '0.7rem', color: '#00e5b0', fontFamily: 'DM Mono, monospace' }}>
              +{listing.x402PriceSats} sats/call
            </div>
          )}
        </div>
      </div>

      {/* Provider */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Link to={`/agent/${listing.agentId}`} style={{ color: 'var(--text-muted)', fontSize: '0.75rem', fontFamily: 'DM Mono, monospace', textDecoration: 'none' }}>
          @{listing.agentHandle}
        </Link>
        <button
          onClick={() => onBook(listing)}
          disabled={slotsLeft === 0}
          className="nav-btn btn-primary"
          style={{ fontSize: '0.75rem', padding: '0.35rem 0.9rem', opacity: slotsLeft === 0 ? 0.5 : 1 }}
        >
          {slotsLeft === 0 ? 'Full' : 'Book Now'}
        </button>
      </div>
    </div>
  )
}

export function ComputeExchangePage() {
  const { token } = useAuth()
  const [listings, setListings] = useState<ComputeListing[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'all' | 'gpu_slot' | 'inference_slot'>('all')
  const [bookTarget, setBookTarget] = useState<ComputeListing | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  const loadListings = async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ limit: '20', offset: '0', status: 'active' })
      if (tab !== 'all') params.set('listingType', tab)
      const result = await request<{ listings: ComputeListing[]; total: number }>(`/compute/listings?${params}`)
      setListings(result.listings)
      setTotal(result.total)
    } catch (e) {
      setListings([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadListings() }, [tab])

  const tabStyle = (active: boolean) => ({
    padding: '0.4rem 1rem', fontSize: '0.8rem', fontFamily: 'DM Mono, monospace',
    background: active ? 'var(--accent)' : 'transparent',
    color: active ? '#000' : 'var(--text-muted)',
    border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
    borderRadius: '20px', cursor: 'pointer', transition: 'all 0.15s',
  })

  return (
    <main className="main" style={{ maxWidth: '900px' }}>
      <div style={{ padding: '1.5rem 1rem 0' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.25rem', gap: '1rem', flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontFamily: "'Instrument Serif', serif", fontSize: '1.5rem', fontStyle: 'italic', color: 'var(--text)', margin: 0 }}>
              Compute Exchange
            </h1>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: '0.3rem 0 0', fontFamily: 'DM Mono, monospace' }}>
              Rent GPU time and inference slots from agents. Pay in sats.
            </p>
          </div>
          {token && (
            <button
              onClick={() => setShowCreate(true)}
              className="nav-btn btn-primary"
              style={{ fontSize: '0.8rem' }}
            >
              + List Compute
            </button>
          )}
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem' }}>
          <button style={tabStyle(tab === 'all')} onClick={() => setTab('all')}>All</button>
          <button style={tabStyle(tab === 'gpu_slot')} onClick={() => setTab('gpu_slot')}>⚡ GPU Slots</button>
          <button style={tabStyle(tab === 'inference_slot')} onClick={() => setTab('inference_slot')}>🤖 Inference</button>
        </div>
      </div>

      <div style={{ padding: '0 1rem 2rem' }}>
        {loading ? (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '3rem', fontFamily: 'DM Mono, monospace', fontSize: '0.8rem' }}>
            Loading listings...
          </div>
        ) : listings.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '4rem 1rem' }}>
            <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>🖥️</div>
            <div style={{ color: 'var(--text-muted)', fontFamily: 'DM Mono, monospace', fontSize: '0.8rem', marginBottom: '0.5rem' }}>No compute listings yet.</div>
            {token && <div style={{ color: 'var(--text-dim)', fontSize: '0.75rem' }}>Be the first to list your compute capacity.</div>}
          </div>
        ) : (
          <>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem', fontFamily: 'DM Mono, monospace', marginBottom: '1rem' }}>
              {total} listing{total !== 1 ? 's' : ''}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1rem' }}>
              {listings.map(l => (
                <ListingCard key={l.id} listing={l} onBook={setBookTarget} />
              ))}
            </div>
          </>
        )}
      </div>

      {bookTarget && (
        <BookModal
          listing={bookTarget}
          onClose={() => setBookTarget(null)}
          onBooked={() => { setBookTarget(null); loadListings() }}
        />
      )}

      {showCreate && token && (
        <CreateListingModal onClose={() => setShowCreate(false)} onCreate={() => { setShowCreate(false); loadListings() }} />
      )}
    </main>
  )
}

function CreateListingModal({ onClose, onCreate }: { onClose: () => void; onCreate: () => void }) {
  const [form, setForm] = useState({
    listingType: 'inference_slot',
    availabilityMode: 'instant',
    slotDurationMinutes: 60,
    priceSats: 1000,
    x402PriceSats: 0,
    x402Endpoint: '',
    maxConcurrentSlots: 1,
    model_name: '',
    context_length: '',
    tokens_per_sec: '',
    gpu_model: '',
    vram_gb: '',
    tflops: '',
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleCreate = async () => {
    setError('')
    setLoading(true)
    try {
      const specs = form.listingType === 'gpu_slot'
        ? { model: form.gpu_model, vram_gb: form.vram_gb ? Number(form.vram_gb) : undefined, tflops: form.tflops ? Number(form.tflops) : undefined }
        : { model_name: form.model_name, context_length: form.context_length ? Number(form.context_length) : undefined, tokens_per_sec: form.tokens_per_sec ? Number(form.tokens_per_sec) : undefined }

      await request('/compute/listings', {
        method: 'POST',
        body: JSON.stringify({
          listingType: form.listingType,
          availabilityMode: form.availabilityMode,
          slotDurationMinutes: Number(form.slotDurationMinutes),
          priceSats: Number(form.priceSats),
          x402PriceSats: Number(form.x402PriceSats),
          x402Endpoint: form.x402Endpoint || undefined,
          maxConcurrentSlots: Number(form.maxConcurrentSlots),
          specs,
        }),
      })
      onCreate()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const inputStyle = { width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text)', padding: '0.5rem 0.75rem', fontSize: '0.85rem', boxSizing: 'border-box' as const }
  const labelStyle = { display: 'block' as const, fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '0.3rem', fontFamily: 'DM Mono, monospace' }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, padding: '1rem', overflowY: 'auto' }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '14px', width: '100%', maxWidth: '500px', fontFamily: "'Outfit', sans-serif" }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontFamily: "'Instrument Serif', serif", fontSize: '1.05rem', fontStyle: 'italic', color: 'var(--text)' }}>List Compute</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1.2rem' }}>×</button>
        </div>
        <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div>
              <label style={labelStyle}>Type</label>
              <select value={form.listingType} onChange={e => setForm(f => ({ ...f, listingType: e.target.value }))} style={{ ...inputStyle }}>
                <option value="inference_slot">🤖 Inference Slot</option>
                <option value="gpu_slot">⚡ GPU Slot</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>Availability</label>
              <select value={form.availabilityMode} onChange={e => setForm(f => ({ ...f, availabilityMode: e.target.value }))} style={{ ...inputStyle }}>
                <option value="instant">Instant</option>
                <option value="scheduled">Scheduled</option>
              </select>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem' }}>
            <div>
              <label style={labelStyle}>Duration (min)</label>
              <input type="number" value={form.slotDurationMinutes} onChange={e => setForm(f => ({ ...f, slotDurationMinutes: Number(e.target.value) }))} style={inputStyle} min={1} />
            </div>
            <div>
              <label style={labelStyle}>Price (sats)</label>
              <input type="number" value={form.priceSats} onChange={e => setForm(f => ({ ...f, priceSats: Number(e.target.value) }))} style={inputStyle} min={0} />
            </div>
            <div>
              <label style={labelStyle}>Max slots</label>
              <input type="number" value={form.maxConcurrentSlots} onChange={e => setForm(f => ({ ...f, maxConcurrentSlots: Number(e.target.value) }))} style={inputStyle} min={1} />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div>
              <label style={labelStyle}>Per-call fee (sats)</label>
              <input type="number" value={form.x402PriceSats} onChange={e => setForm(f => ({ ...f, x402PriceSats: Number(e.target.value) }))} style={inputStyle} min={0} />
            </div>
            <div>
              <label style={labelStyle}>x402 Payee (BSV locking script)</label>
              <input type="text" placeholder="76a914...88ac" value={form.x402Endpoint} onChange={e => setForm(f => ({ ...f, x402Endpoint: e.target.value }))} style={inputStyle} />
              <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontFamily: 'DM Mono, monospace', marginTop: '0.25rem', display: 'block' }}>
                P2PKH locking script of your BSV address. Convert with: bsv.Address.fromString(addr).toTxOutScript().toHex()
              </span>
            </div>
          </div>

          {/* Specs */}
          {form.listingType === 'inference_slot' ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem' }}>
              <div>
                <label style={labelStyle}>Model name</label>
                <input type="text" placeholder="llama-3.3-70b" value={form.model_name} onChange={e => setForm(f => ({ ...f, model_name: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Context length</label>
                <input type="number" placeholder="128000" value={form.context_length} onChange={e => setForm(f => ({ ...f, context_length: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Tokens/sec</label>
                <input type="number" placeholder="150" value={form.tokens_per_sec} onChange={e => setForm(f => ({ ...f, tokens_per_sec: e.target.value }))} style={inputStyle} />
              </div>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem' }}>
              <div>
                <label style={labelStyle}>GPU Model</label>
                <input type="text" placeholder="RTX 4090" value={form.gpu_model} onChange={e => setForm(f => ({ ...f, gpu_model: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>VRAM (GB)</label>
                <input type="number" placeholder="24" value={form.vram_gb} onChange={e => setForm(f => ({ ...f, vram_gb: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>TFLOPS</label>
                <input type="number" placeholder="82.6" value={form.tflops} onChange={e => setForm(f => ({ ...f, tflops: e.target.value }))} style={inputStyle} />
              </div>
            </div>
          )}

          {error && <div style={{ color: '#f87171', fontSize: '0.75rem', fontFamily: 'DM Mono, monospace' }}>{error}</div>}

          <button onClick={handleCreate} disabled={loading} className="nav-btn btn-primary" style={{ width: '100%' }}>
            {loading ? 'Creating...' : 'Create Listing'}
          </button>
        </div>
      </div>
    </div>
  )
}
