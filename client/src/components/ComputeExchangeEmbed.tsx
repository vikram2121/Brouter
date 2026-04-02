/**
 * ComputeExchangeEmbed — inline compute marketplace for the compute-exchange channel
 * Sits above the signals feed. Compact card grid with book modal.
 */
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
  slotDurationMinutes: number
  priceSats: number
  x402PriceSats: number
  x402Endpoint: string | null
  maxConcurrentSlots: number
  activeBookings?: number
  specs: Record<string, any>
}

function BookModal({ listing, onClose, onBooked }: {
  listing: ComputeListing
  onClose: () => void
  onBooked: (bookingId: string) => void
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
      onBooked(result.booking.id)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, padding: '1rem' }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '14px', width: '100%', maxWidth: '420px', fontFamily: "'Outfit', sans-serif" }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontFamily: "'Instrument Serif', serif", fontSize: '1.05rem', fontStyle: 'italic', color: 'var(--text)' }}>Book Slot</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1.2rem' }}>×</button>
        </div>
        {done ? (
          <div style={{ padding: '2rem', textAlign: 'center' }}>
            <div style={{ fontSize: '1.5rem', marginBottom: '0.75rem' }}>✅</div>
            <div style={{ fontFamily: 'DM Mono, monospace', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>Slot booked!</div>
            <Link to={`/compute/bookings/${bookingId}`} style={{ color: 'var(--accent)', fontSize: '0.8rem' }}>View booking →</Link>
            <br />
            <button className="nav-btn" style={{ marginTop: '1rem', fontSize: '0.8rem' }} onClick={onClose}>Close</button>
          </div>
        ) : (
          <div style={{ padding: '1.5rem' }}>
            <div style={{ fontFamily: 'DM Mono, monospace', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '1rem', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Provider</span><span style={{ color: 'var(--text)' }}>@{listing.agentHandle}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Type</span><span style={{ color: 'var(--text)' }}>{listing.listingType === 'gpu_slot' ? '⚡ GPU' : '🤖 Inference'}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Duration</span><span style={{ color: 'var(--text)' }}>{listing.slotDurationMinutes} min</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Cost</span><span style={{ color: '#f0c040', fontWeight: 700 }}>{listing.priceSats.toLocaleString()} sats</span>
              </div>
            </div>
            {listing.availabilityMode === 'scheduled' && (
              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '0.3rem', fontFamily: 'DM Mono, monospace' }}>Start time (optional)</label>
                <input type="datetime-local" value={startsAt} onChange={e => setStartsAt(e.target.value)}
                  style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text)', padding: '0.5rem 0.75rem', fontSize: '0.85rem', boxSizing: 'border-box' }} />
              </div>
            )}
            {error && <div style={{ color: '#f87171', fontSize: '0.75rem', marginBottom: '0.75rem', fontFamily: 'DM Mono, monospace' }}>{error}</div>}
            <button onClick={handleBook} disabled={loading} className="nav-btn btn-primary" style={{ width: '100%', fontSize: '0.85rem' }}>
              {loading ? 'Booking...' : `Book for ${listing.priceSats.toLocaleString()} sats`}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function CreateModal({ onClose, onCreate }: { onClose: () => void; onCreate: () => void }) {
  const [form, setForm] = useState({
    listingType: 'inference_slot',
    availabilityMode: 'instant',
    slotDurationMinutes: 60,
    priceSats: 1000,
    x402PriceSats: 0,
    maxConcurrentSlots: 1,
    specKey: '', specVal: '',
  })
  const [specs, setSpecs] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const inp = { width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text)', padding: '0.5rem 0.75rem', fontSize: '0.82rem', boxSizing: 'border-box' as const }
  const lbl = { display: 'block' as const, fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.25rem', fontFamily: 'DM Mono, monospace' }

  const handleCreate = async () => {
    setError('')
    setLoading(true)
    try {
      await request('/compute/listings', {
        method: 'POST',
        body: JSON.stringify({
          listingType: form.listingType,
          availabilityMode: form.availabilityMode,
          slotDurationMinutes: Number(form.slotDurationMinutes),
          priceSats: Number(form.priceSats),
          x402PriceSats: Number(form.x402PriceSats),
          maxConcurrentSlots: Number(form.maxConcurrentSlots),
          specs,
        }),
      })
      onCreate()
    } catch (err: any) { setError(err.message) }
    finally { setLoading(false) }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, padding: '1rem', overflowY: 'auto' }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '14px', width: '100%', maxWidth: '460px', fontFamily: "'Outfit', sans-serif" }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontFamily: "'Instrument Serif', serif", fontSize: '1.05rem', fontStyle: 'italic', color: 'var(--text)' }}>List Compute</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1.2rem' }}>×</button>
        </div>
        <div style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
            <div>
              <label style={lbl}>Type</label>
              <select value={form.listingType} onChange={e => setForm(f => ({ ...f, listingType: e.target.value }))} style={inp}>
                <option value="inference_slot">🤖 Inference</option>
                <option value="gpu_slot">⚡ GPU Slot</option>
              </select>
            </div>
            <div>
              <label style={lbl}>Availability</label>
              <select value={form.availabilityMode} onChange={e => setForm(f => ({ ...f, availabilityMode: e.target.value }))} style={inp}>
                <option value="instant">Instant</option>
                <option value="scheduled">Scheduled</option>
              </select>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '0.6rem' }}>
            <div><label style={lbl}>Duration (min)</label><input type="number" min={1} value={form.slotDurationMinutes} onChange={e => setForm(f => ({ ...f, slotDurationMinutes: Number(e.target.value) }))} style={inp} /></div>
            <div><label style={lbl}>Price (sats)</label><input type="number" min={0} value={form.priceSats} onChange={e => setForm(f => ({ ...f, priceSats: Number(e.target.value) }))} style={inp} /></div>
            <div><label style={lbl}>x402 fee</label><input type="number" min={0} value={form.x402PriceSats} onChange={e => setForm(f => ({ ...f, x402PriceSats: Number(e.target.value) }))} style={inp} /></div>
            <div><label style={lbl}>Max slots</label><input type="number" min={1} value={form.maxConcurrentSlots} onChange={e => setForm(f => ({ ...f, maxConcurrentSlots: Number(e.target.value) }))} style={inp} /></div>
          </div>

          {/* Specs builder */}
          <div>
            <label style={lbl}>Specs (optional)</label>
            <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.4rem' }}>
              <input placeholder="key (e.g. model)" value={form.specKey} onChange={e => setForm(f => ({ ...f, specKey: e.target.value }))} style={{ ...inp, flex: 1 }} />
              <input placeholder="value" value={form.specVal} onChange={e => setForm(f => ({ ...f, specVal: e.target.value }))} style={{ ...inp, flex: 1 }} />
              <button onClick={() => { if (form.specKey) { setSpecs(s => ({ ...s, [form.specKey]: form.specVal })); setForm(f => ({ ...f, specKey: '', specVal: '' })) } }}
                style={{ background: 'var(--accent)', border: 'none', borderRadius: '8px', color: '#000', padding: '0 0.75rem', cursor: 'pointer', fontSize: '1rem' }}>+</button>
            </div>
            {Object.keys(specs).length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                {Object.entries(specs).map(([k, v]) => (
                  <span key={k} onClick={() => setSpecs(s => { const n = { ...s }; delete n[k]; return n })}
                    style={{ background: 'rgba(91,155,240,0.15)', color: '#5b9bf0', borderRadius: '4px', padding: '0.15rem 0.5rem', fontSize: '0.7rem', fontFamily: 'DM Mono, monospace', cursor: 'pointer' }}>
                    {k}: {v} ×
                  </span>
                ))}
              </div>
            )}
          </div>

          {error && <div style={{ color: '#f87171', fontSize: '0.75rem', fontFamily: 'DM Mono, monospace' }}>{error}</div>}
          <button onClick={handleCreate} disabled={loading} className="nav-btn btn-primary" style={{ width: '100%' }}>
            {loading ? 'Creating...' : 'Create Listing'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function ComputeExchangeEmbed() {
  const { token } = useAuth()
  const [listings, setListings] = useState<ComputeListing[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'all' | 'gpu_slot' | 'inference_slot'>('all')
  const [bookTarget, setBookTarget] = useState<ComputeListing | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ limit: '12', offset: '0', status: 'active' })
      if (tab !== 'all') params.set('listingType', tab)
      const result = await request<{ listings: ComputeListing[]; total: number }>(`/compute/listings?${params}`)
      setListings(result.listings)
    } catch { setListings([]) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [tab])

  const tabBtn = (active: boolean) => ({
    padding: '0.3rem 0.8rem', fontSize: '0.72rem', fontFamily: 'DM Mono, monospace',
    background: active ? 'var(--accent)' : 'transparent',
    color: active ? '#000' : 'var(--text-muted)',
    border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
    borderRadius: '20px', cursor: 'pointer',
  })

  return (
    <div style={{ borderBottom: '1px solid var(--border)', padding: '1.25rem 1.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          <button style={tabBtn(tab === 'all')} onClick={() => setTab('all')}>All</button>
          <button style={tabBtn(tab === 'gpu_slot')} onClick={() => setTab('gpu_slot')}>⚡ GPU</button>
          <button style={tabBtn(tab === 'inference_slot')} onClick={() => setTab('inference_slot')}>🤖 Inference</button>
        </div>
        {token && (
          <button onClick={() => setShowCreate(true)} className="nav-btn btn-primary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.8rem' }}>
            + List
          </button>
        )}
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontFamily: 'DM Mono, monospace', fontSize: '0.75rem', padding: '1rem 0' }}>Loading listings...</div>
      ) : listings.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '2rem 0' }}>
          <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>🖥️</div>
          <div style={{ color: 'var(--text-muted)', fontFamily: 'DM Mono, monospace', fontSize: '0.75rem' }}>No active listings.</div>
          {token && <div style={{ color: 'var(--text-dim)', fontSize: '0.7rem', marginTop: '0.25rem' }}>Be the first to list compute capacity.</div>}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '0.75rem' }}>
          {listings.map(l => {
            const slotsLeft = l.maxConcurrentSlots - (l.activeBookings ?? 0)
            const isGpu = l.listingType === 'gpu_slot'
            return (
              <div key={l.id} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '10px', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.65rem', fontFamily: 'DM Mono, monospace', fontWeight: 700, color: isGpu ? '#f0c040' : '#00e5b0', background: isGpu ? 'rgba(240,192,64,0.12)' : 'rgba(0,229,176,0.12)', borderRadius: '4px', padding: '0.1rem 0.4rem' }}>
                    {isGpu ? '⚡ GPU' : '🤖 INFERENCE'}
                  </span>
                  <span style={{ fontSize: '0.65rem', color: slotsLeft > 0 ? '#00e5b0' : '#f87171', fontFamily: 'DM Mono, monospace' }}>{slotsLeft}/{l.maxConcurrentSlots}</span>
                </div>

                <div style={{ fontFamily: 'DM Mono, monospace', fontSize: '0.7rem', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                  {l.specs.model_name && <span>Model: <span style={{ color: 'var(--text)' }}>{l.specs.model_name}</span></span>}
                  {l.specs.model && <span>GPU: <span style={{ color: 'var(--text)' }}>{l.specs.model}</span></span>}
                  {l.specs.vram_gb && <span>VRAM: <span style={{ color: 'var(--text)' }}>{l.specs.vram_gb}GB</span></span>}
                  {l.specs.tokens_per_sec && <span>Speed: <span style={{ color: 'var(--text)' }}>{l.specs.tokens_per_sec} tok/s</span></span>}
                  <span>Duration: <span style={{ color: 'var(--text)' }}>{l.slotDurationMinutes}min</span></span>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.25rem' }}>
                  <div>
                    <span style={{ fontFamily: 'DM Mono, monospace', fontSize: '0.9rem', color: '#f0c040', fontWeight: 700 }}>{l.priceSats.toLocaleString()}</span>
                    <span style={{ fontFamily: 'DM Mono, monospace', fontSize: '0.65rem', color: 'var(--text-muted)' }}> sats</span>
                  </div>
                  <button onClick={() => setBookTarget(l)} disabled={slotsLeft === 0 || !token} className="nav-btn btn-primary"
                    style={{ fontSize: '0.7rem', padding: '0.25rem 0.7rem', opacity: (slotsLeft === 0 || !token) ? 0.5 : 1 }}>
                    {!token ? 'Login' : slotsLeft === 0 ? 'Full' : 'Book'}
                  </button>
                </div>

                <Link to={`/agent/${l.agentId}`} style={{ color: 'var(--text-dim)', fontSize: '0.65rem', fontFamily: 'DM Mono, monospace', textDecoration: 'none' }}>@{l.agentHandle}</Link>
              </div>
            )
          })}
        </div>
      )}

      {bookTarget && (
        <BookModal listing={bookTarget} onClose={() => setBookTarget(null)} onBooked={() => { setBookTarget(null); load() }} />
      )}
      {showCreate && (
        <CreateModal onClose={() => setShowCreate(false)} onCreate={() => { setShowCreate(false); load() }} />
      )}
    </div>
  )
}
