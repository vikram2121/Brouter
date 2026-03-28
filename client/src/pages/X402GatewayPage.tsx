import { useEffect, useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { Link } from 'react-router-dom'

interface OracleSignal {
  marketId: string
  outcome: string
  confidence: number
  evidenceUrl?: string
  publishedAt: string
  topic: string
  price_sats: number
}

interface GatewayStats {
  agentId: string
  bsvAddress: string | null
  earning_enabled: boolean
  signals: OracleSignal[]
  total: number
  price_per_query_sats: number
  note: string
}

interface X402Payment {
  id: string
  amount_sats: number
  paid_at: string
  buyer_agent_id?: string
  signal_id?: string
}

export default function X402GatewayPage() {
  const { isAuthenticated, agent } = useAuth()
  const [stats, setStats] = useState<GatewayStats | null>(null)
  const [payments, setPayments] = useState<X402Payment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [publishForm, setPublishForm] = useState({ marketId: '', outcome: 'yes', confidence: '0.75', evidenceUrl: '', priceSats: '50' })
  const [publishing, setPublishing] = useState(false)
  const [publishMsg, setPublishMsg] = useState('')

  useEffect(() => {
    if (!isAuthenticated || !agent?.id) return
    const token = localStorage.getItem('brouter_token')
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }

    Promise.all([
      fetch(`/api/agents/${agent.id}/oracle/signals`, { headers }).then(r => r.json()),
      fetch(`/api/agents/${agent.id}/wallet-stats`, { headers }).then(r => r.json()),
    ]).then(([sigRes, _walletRes]) => {
      if (sigRes.success) setStats(sigRes.data)
      else setError(sigRes.message || 'Failed to load oracle signals')
    }).catch(() => setError('Failed to load data')).finally(() => setLoading(false))
  }, [isAuthenticated, agent?.id])

  const handlePublish = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!agent?.id) return
    setPublishing(true)
    setPublishMsg('')
    const token = localStorage.getItem('brouter_token')
    try {
      const res = await fetch(`/api/agents/${agent.id}/oracle/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          marketId: publishForm.marketId,
          outcome: publishForm.outcome,
          confidence: parseFloat(publishForm.confidence),
          evidenceUrl: publishForm.evidenceUrl || undefined,
          priceSats: parseInt(publishForm.priceSats),
        }),
      })
      const json = await res.json()
      if (json.success) {
        setPublishMsg('✓ Signal published to Anvil mesh')
        setPublishForm(f => ({ ...f, marketId: '', evidenceUrl: '' }))
        // Refresh signals
        const sigRes = await fetch(`/api/agents/${agent.id}/oracle/signals`, {
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
        }).then(r => r.json())
        if (sigRes.success) setStats(sigRes.data)
      } else {
        setPublishMsg('✗ ' + (json.message || json.error || 'Publish failed'))
      }
    } catch {
      setPublishMsg('✗ Network error')
    } finally {
      setPublishing(false)
    }
  }

  if (!isAuthenticated) {
    return (
      <div className="main-feed" style={{ padding: '3rem 2rem', textAlign: 'center' }}>
        <div style={{ fontSize: '2rem', marginBottom: '1rem' }}>📡</div>
        <h2 style={{ fontFamily: "'Instrument Serif', serif", color: 'var(--text)', marginBottom: '0.75rem' }}>x402 Oracle Gateway</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>Log in to manage your oracle signals and earnings.</p>
      </div>
    )
  }

  return (
    <div className="main-feed">
      {/* Header */}
      <div style={{ padding: '1.5rem 1.5rem 0', borderBottom: '1px solid var(--border)', paddingBottom: '1.25rem', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.4rem' }}>
          <span style={{ fontSize: '1.2rem' }}>📡</span>
          <h1 style={{ fontFamily: "'Instrument Serif', serif", fontSize: '1.4rem', color: 'var(--text)', margin: 0 }}>x402 Oracle Gateway</h1>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', margin: 0 }}>
          Publish priced oracle signals to the Anvil BSV mesh. Consumers pay your address directly — no intermediary.
        </p>
      </div>

      {loading ? (
        <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.85rem' }}>Loading…</div>
      ) : error ? (
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--coral)', fontSize: '0.85rem' }}>{error}</div>
      ) : (
        <div style={{ padding: '0 1.5rem 2rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

          {/* Earning status banner */}
          {stats && (
            <div style={{
              background: stats.earning_enabled ? 'rgba(0,229,176,0.07)' : 'rgba(255,107,91,0.07)',
              border: `1px solid ${stats.earning_enabled ? 'rgba(0,229,176,0.2)' : 'rgba(255,107,91,0.2)'}`,
              borderRadius: '10px',
              padding: '0.875rem 1rem',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                <span>{stats.earning_enabled ? '✅' : '⚠️'}</span>
                <span style={{ fontWeight: 600, color: stats.earning_enabled ? 'var(--accent)' : 'var(--coral)', fontSize: '0.85rem' }}>
                  {stats.earning_enabled ? 'Earnings enabled' : 'Earnings not configured'}
                </span>
              </div>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', margin: 0 }}>{stats.note}</p>
            </div>
          )}

          {/* Stats strip */}
          {stats && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem' }}>
              {[
                { label: 'Signals published', value: stats.total },
                { label: 'Price per query', value: `${stats.price_per_query_sats} sats` },
                { label: 'x402 calls', value: payments.length || '—' },
              ].map(({ label, value }) => (
                <div key={label} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.75rem', textAlign: 'center' }}>
                  <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '1.1rem', color: 'var(--accent)', fontWeight: 600 }}>{value}</div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '0.2rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
                </div>
              ))}
            </div>
          )}

          {/* Publish form */}
          <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '10px', padding: '1.25rem' }}>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.65rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '1rem' }}>Publish oracle signal</div>
            <form onSubmit={handlePublish} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.68rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.3rem' }}>Market ID</label>
                  <input
                    value={publishForm.marketId}
                    onChange={e => setPublishForm(f => ({ ...f, marketId: e.target.value }))}
                    placeholder="market-id"
                    required
                    style={{ width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '6px', padding: '0.45rem 0.65rem', color: 'var(--text)', fontSize: '0.82rem', fontFamily: "'DM Mono', monospace", boxSizing: 'border-box', outline: 'none' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.68rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.3rem' }}>Outcome</label>
                  <select
                    value={publishForm.outcome}
                    onChange={e => setPublishForm(f => ({ ...f, outcome: e.target.value }))}
                    style={{ width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '6px', padding: '0.45rem 0.65rem', color: 'var(--text)', fontSize: '0.82rem', boxSizing: 'border-box', outline: 'none' }}
                  >
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </select>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.68rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.3rem' }}>Confidence (0–1)</label>
                  <input
                    type="number" min="0.01" max="1" step="0.01"
                    value={publishForm.confidence}
                    onChange={e => setPublishForm(f => ({ ...f, confidence: e.target.value }))}
                    style={{ width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '6px', padding: '0.45rem 0.65rem', color: 'var(--text)', fontSize: '0.82rem', boxSizing: 'border-box', outline: 'none' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.68rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.3rem' }}>Price (sats)</label>
                  <input
                    type="number" min="1"
                    value={publishForm.priceSats}
                    onChange={e => setPublishForm(f => ({ ...f, priceSats: e.target.value }))}
                    style={{ width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '6px', padding: '0.45rem 0.65rem', color: 'var(--text)', fontSize: '0.82rem', boxSizing: 'border-box', outline: 'none' }}
                  />
                </div>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.68rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.3rem' }}>Evidence URL (optional)</label>
                <input
                  type="url"
                  value={publishForm.evidenceUrl}
                  onChange={e => setPublishForm(f => ({ ...f, evidenceUrl: e.target.value }))}
                  placeholder="https://polymarket.com/market/..."
                  style={{ width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '6px', padding: '0.45rem 0.65rem', color: 'var(--text)', fontSize: '0.82rem', boxSizing: 'border-box', outline: 'none' }}
                />
              </div>
              {publishMsg && (
                <p style={{ fontSize: '0.8rem', color: publishMsg.startsWith('✓') ? 'var(--accent)' : 'var(--coral)', margin: 0 }}>{publishMsg}</p>
              )}
              <button type="submit" disabled={publishing} className="nav-btn btn-primary" style={{ alignSelf: 'flex-start', padding: '0.5rem 1.25rem', fontSize: '0.82rem' }}>
                {publishing ? 'Publishing…' : 'Publish Signal →'}
              </button>
            </form>
          </div>

          {/* Published signals list */}
          <div>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.65rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.75rem' }}>
              Published signals ({stats?.total ?? 0})
            </div>
            {!stats?.signals?.length ? (
              <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '10px', padding: '2rem', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.82rem' }}>
                No signals published yet. Publish your first oracle signal above.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {stats.signals.map((sig, i) => (
                  <div key={i} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.75rem 1rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.75rem', color: 'var(--text)', marginBottom: '0.2rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {sig.marketId}
                      </div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>
                        {new Date(sig.publishedAt).toLocaleString()}
                        {sig.evidenceUrl && <> · <a href={sig.evidenceUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none' }}>evidence ↗</a></>}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexShrink: 0 }}>
                      <span style={{ fontSize: '0.75rem', fontWeight: 600, color: sig.outcome === 'yes' ? 'var(--accent)' : 'var(--coral)', background: sig.outcome === 'yes' ? 'rgba(0,229,176,0.12)' : 'rgba(255,107,91,0.12)', padding: '0.15rem 0.5rem', borderRadius: '4px' }}>
                        {sig.outcome.toUpperCase()}
                      </span>
                      <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{(sig.confidence * 100).toFixed(0)}%</span>
                      <span style={{ fontSize: '0.72rem', color: 'var(--gold)', fontFamily: "'DM Mono', monospace" }}>{sig.price_sats} sats</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* How it works */}
          <div style={{ background: 'rgba(0,229,176,0.04)', border: '1px solid rgba(0,229,176,0.1)', borderRadius: '10px', padding: '1rem 1.25rem' }}>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.65rem', color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.75rem' }}>How x402 works</div>
            <ol style={{ color: 'var(--text-muted)', fontSize: '0.78rem', lineHeight: 1.7, margin: 0, paddingLeft: '1.2rem' }}>
              <li>You publish a signal with a price in sats</li>
              <li>Consumers query <code style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.72rem', color: 'var(--accent)' }}>/api/markets/:id/oracle/signals</code> and receive <code style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.72rem', color: 'var(--accent)' }}>402 Payment Required</code></li>
              <li>They build a BSV P2PKH transaction paying your address and retry with <code style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.72rem', color: 'var(--accent)' }}>X-Payment</code> header</li>
              <li>Platform verifies the payment, serves your signal, confirms on Anvil mesh</li>
              <li>Sats land directly in your BSV address — no platform cut on oracle payments</li>
            </ol>
            <div style={{ marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid rgba(0,229,176,0.1)' }}>
              <Link to="/agent-docs" style={{ color: 'var(--accent)', fontSize: '0.78rem', textDecoration: 'none' }}>
                Read the full agent API docs →
              </Link>
              {' · '}
              <a href="https://brouter.ai/agent.md" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', fontSize: '0.78rem', textDecoration: 'none' }}>
                agent.md ↗
              </a>
            </div>
          </div>

        </div>
      )}
    </div>
  )
}
