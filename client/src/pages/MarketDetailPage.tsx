import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { markets as marketsApi, type Market, type MarketPosition } from '../api/client'
import { useAuth } from '../hooks/useAuth'

const TIER_LABEL: Record<string, string> = {
  rapid: '⚡ Rapid',
  weekly: '📅 Weekly',
  anchor: '⚓ Anchor'
}

const TIER_COLOR: Record<string, string> = {
  rapid: 'var(--coral)',
  weekly: 'var(--gold)',
  anchor: 'var(--accent)'
}

function timeRemaining(dateStr: string): string {
  const diff = new Date(dateStr).getTime() - Date.now()
  if (diff <= 0) return 'Expired'
  const h = Math.floor(diff / 3_600_000)
  if (h < 24) return `${h}h ${Math.floor((diff % 3_600_000) / 60_000)}m remaining`
  const d = Math.floor(h / 24)
  const hRem = h % 24
  return `${d}d ${hRem}h remaining`
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  })
}

function odds(yesSats: number, noSats: number) {
  const total = yesSats + noSats
  if (total === 0) return { yes: 50, no: 50 }
  return {
    yes: Math.round((yesSats / total) * 100),
    no: Math.round((noSats / total) * 100)
  }
}

export default function MarketDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { agent } = useAuth()
  const [market, setMarket] = useState<Market | null>(null)
  const [positions, setPositions] = useState<MarketPosition[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Stake form state
  const [direction, setDirection] = useState<'yes' | 'no' | null>(null)
  const [amount, setAmount] = useState('100')
  const [staking, setStaking] = useState(false)
  const [stakeError, setStakeError] = useState('')
  const [stakeSuccess, setStakeSuccess] = useState('')

  useEffect(() => {
    if (!id) return
    marketsApi.get(id)
      .then(d => {
        setMarket(d.market)
        setPositions(d.positions)
      })
      .catch(() => setError('Market not found'))
      .finally(() => setLoading(false))
  }, [id])

  async function handleStake() {
    if (!direction || !id) return
    const sats = parseInt(amount, 10)
    if (isNaN(sats) || sats < 1) { setStakeError('Enter a valid amount'); return }

    setStaking(true)
    setStakeError('')
    setStakeSuccess('')

    try {
      await marketsApi.takePosition(id, direction, sats)
      // Refresh market + positions
      const updated = await marketsApi.get(id)
      setMarket(updated.market)
      setPositions(updated.positions)
      setStakeSuccess(`Staked ${sats} sats on ${direction.toUpperCase()}`)
      setDirection(null)
      setAmount('100')
    } catch (e: any) {
      setStakeError(e.message || 'Stake failed')
    } finally {
      setStaking(false)
    }
  }

  if (loading) return (
    <div style={{ padding: '2rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: '0.875rem' }}>
      Loading market…
    </div>
  )

  if (error || !market) return (
    <div style={{ padding: '2rem' }}>
      <div style={{ color: 'var(--coral)', fontFamily: 'var(--font-mono)', fontSize: '0.875rem', marginBottom: '1rem' }}>
        {error || 'Market not found'}
      </div>
      <Link to="/markets" style={{ color: 'var(--accent)', fontSize: '0.875rem', fontFamily: 'var(--font-mono)' }}>
        ← Back to Markets
      </Link>
    </div>
  )

  const o = odds(market.totalYesSats, market.totalNoSats)
  const total = market.totalYesSats + market.totalNoSats
  const expired = new Date(market.resolvesAt) < new Date()
  const resolved = market.outcome !== null
  const canStake = agent && !expired && !resolved
  const tierColor = TIER_COLOR[market.tier]

  // My existing position
  const myPosition = positions.find(p => p.agentId === agent?.id)

  return (
    <div style={{ padding: '1.5rem', maxWidth: '700px', margin: '0 auto' }}>
      {/* Back */}
      <Link to="/markets" style={{ color: 'var(--text-muted)', fontSize: '0.8rem', fontFamily: 'var(--font-mono)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '0.25rem', marginBottom: '1.25rem' }}>
        ← Markets
      </Link>

      {/* Market card */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px', padding: '1.5rem', marginBottom: '1.5rem' }}>
        {/* Tier + status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
          <span style={{
            fontSize: '0.7rem', fontFamily: 'var(--font-mono)', color: tierColor,
            background: `color-mix(in srgb, ${tierColor} 12%, transparent)`,
            border: `1px solid color-mix(in srgb, ${tierColor} 25%, transparent)`,
            padding: '0.15rem 0.5rem', borderRadius: '4px', textTransform: 'uppercase', letterSpacing: '0.05em'
          }}>
            {TIER_LABEL[market.tier]}
          </span>
          {resolved ? (
            <span style={{
              fontSize: '0.7rem', fontFamily: 'var(--font-mono)', padding: '0.15rem 0.5rem', borderRadius: '4px',
              color: market.outcome === 'yes' ? 'var(--accent)' : 'var(--coral)',
              background: market.outcome === 'yes' ? 'var(--accent-dim)' : 'var(--coral-dim)',
              border: `1px solid ${market.outcome === 'yes' ? 'var(--accent-border)' : 'rgba(255,107,91,0.25)'}`
            }}>
              ✓ Resolved: {market.outcome?.toUpperCase()}
            </span>
          ) : expired ? (
            <span style={{ fontSize: '0.7rem', fontFamily: 'var(--font-mono)', color: 'var(--coral)' }}>Awaiting resolution</span>
          ) : (
            <span style={{ fontSize: '0.7rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
              {timeRemaining(market.resolvesAt)}
            </span>
          )}
        </div>

        {/* Title */}
        <h1 style={{ fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontSize: '1.4rem', color: 'var(--text)', margin: '0 0 1.25rem', lineHeight: 1.3 }}>
          {market.title}
        </h1>

        {/* Odds bar */}
        <div style={{ marginBottom: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '1rem', fontWeight: 600, color: 'var(--accent)' }}>
              YES {o.yes}%
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              {total.toLocaleString()} sats staked
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '1rem', fontWeight: 600, color: 'var(--coral)' }}>
              NO {o.no}%
            </span>
          </div>
          <div style={{ height: '10px', background: 'var(--surface2)', borderRadius: '5px', overflow: 'hidden' }}>
            <div style={{
              height: '100%', width: `${o.yes}%`,
              background: `linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 60%, var(--coral)))`,
              borderRadius: '5px', transition: 'width 0.4s ease'
            }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.35rem' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--text-dim)' }}>
              {market.totalYesSats.toLocaleString()} sats
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--text-dim)' }}>
              {market.totalNoSats.toLocaleString()} sats
            </span>
          </div>
        </div>

        {/* My position badge */}
        {myPosition && (
          <div style={{
            background: myPosition.direction === 'yes' ? 'var(--accent-dim)' : 'var(--coral-dim)',
            border: `1px solid ${myPosition.direction === 'yes' ? 'var(--accent-border)' : 'rgba(255,107,91,0.25)'}`,
            borderRadius: '8px', padding: '0.6rem 0.875rem', marginBottom: '1rem',
            fontSize: '0.8rem', fontFamily: 'var(--font-mono)',
            color: myPosition.direction === 'yes' ? 'var(--accent)' : 'var(--coral)'
          }}>
            Your position: {myPosition.direction.toUpperCase()} · {myPosition.amountSats.toLocaleString()} sats
          </div>
        )}

        {/* Stake form */}
        {canStake && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '1.25rem' }}>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: '0 0 0.75rem', fontFamily: 'var(--font-mono)' }}>
              Take a position
            </p>

            {/* YES / NO buttons */}
            <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '0.875rem' }}>
              <button
                onClick={() => setDirection('yes')}
                style={{
                  flex: 1, padding: '0.6rem', borderRadius: '8px', border: '1px solid',
                  borderColor: direction === 'yes' ? 'var(--accent)' : 'var(--border)',
                  background: direction === 'yes' ? 'var(--accent-dim)' : 'var(--surface2)',
                  color: direction === 'yes' ? 'var(--accent)' : 'var(--text-muted)',
                  fontFamily: 'var(--font-mono)', fontSize: '0.875rem', fontWeight: 600,
                  cursor: 'pointer', transition: 'all 0.15s'
                }}
              >
                ↑ YES
              </button>
              <button
                onClick={() => setDirection('no')}
                style={{
                  flex: 1, padding: '0.6rem', borderRadius: '8px', border: '1px solid',
                  borderColor: direction === 'no' ? 'var(--coral)' : 'var(--border)',
                  background: direction === 'no' ? 'var(--coral-dim)' : 'var(--surface2)',
                  color: direction === 'no' ? 'var(--coral)' : 'var(--text-muted)',
                  fontFamily: 'var(--font-mono)', fontSize: '0.875rem', fontWeight: 600,
                  cursor: 'pointer', transition: 'all 0.15s'
                }}
              >
                ↓ NO
              </button>
            </div>

            {/* Amount + submit */}
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input
                type="number"
                min="1"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder="sats"
                style={{
                  flex: 1, background: 'var(--surface2)', border: '1px solid var(--border)',
                  borderRadius: '8px', padding: '0.6rem 0.75rem', color: 'var(--text)',
                  fontFamily: 'var(--font-mono)', fontSize: '0.875rem', outline: 'none'
                }}
              />
              <button
                onClick={handleStake}
                disabled={!direction || staking}
                style={{
                  padding: '0.6rem 1.25rem', borderRadius: '8px', border: 'none',
                  background: direction ? 'var(--accent)' : 'var(--surface2)',
                  color: direction ? '#000' : 'var(--text-dim)',
                  fontFamily: 'var(--font-mono)', fontSize: '0.875rem', fontWeight: 600,
                  cursor: direction ? 'pointer' : 'not-allowed', transition: 'all 0.15s'
                }}
              >
                {staking ? 'Staking…' : 'Stake'}
              </button>
            </div>

            {stakeError && (
              <p style={{ color: 'var(--coral)', fontSize: '0.8rem', fontFamily: 'var(--font-mono)', margin: '0.5rem 0 0' }}>
                {stakeError}
              </p>
            )}
            {stakeSuccess && (
              <p style={{ color: 'var(--accent)', fontSize: '0.8rem', fontFamily: 'var(--font-mono)', margin: '0.5rem 0 0' }}>
                ✓ {stakeSuccess}
              </p>
            )}
          </div>
        )}

        {!agent && !resolved && (
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: '0.75rem' }}>
            Log in to take a position.
          </p>
        )}
      </div>

      {/* Resolution info */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px', padding: '1.25rem', marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '0.7rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 0.75rem' }}>
          Resolution
        </h2>
        {market.description && (
          <p style={{ color: 'var(--text)', fontSize: '0.875rem', lineHeight: 1.6, margin: '0 0 0.75rem' }}>
            {market.description}
          </p>
        )}
        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', lineHeight: 1.5, margin: '0 0 0.5rem' }}>
          <strong style={{ color: 'var(--text-dim)' }}>Criteria:</strong> {market.resolutionCriteria}
        </p>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: '0 0 0.5rem' }}>
          <strong style={{ color: 'var(--text-dim)' }}>Source:</strong>{' '}
          <span style={{ fontFamily: 'var(--font-mono)' }}>{market.resolutionSource}</span>
        </p>
        <p style={{ color: 'var(--text-dim)', fontSize: '0.8rem', fontFamily: 'var(--font-mono)', margin: 0 }}>
          Resolves {formatDate(market.resolvesAt)}
        </p>
      </div>

      {/* Positions leaderboard */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px', padding: '1.25rem' }}>
        <h2 style={{ fontSize: '0.7rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 0.875rem' }}>
          Positions · {positions.length} agent{positions.length !== 1 ? 's' : ''}
        </h2>

        {positions.length === 0 ? (
          <p style={{ color: 'var(--text-dim)', fontSize: '0.875rem', fontFamily: 'var(--font-mono)' }}>
            No positions yet. Be the first.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {positions.map((pos, i) => (
              <div key={pos.id} style={{
                display: 'flex', alignItems: 'center', gap: '0.75rem',
                padding: '0.6rem 0.75rem', borderRadius: '8px',
                background: pos.agentId === agent?.id ? 'var(--accent-dim)' : 'var(--surface2)',
                border: `1px solid ${pos.agentId === agent?.id ? 'var(--accent-border)' : 'transparent'}`
              }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--text-dim)', width: '1.5rem' }}>
                  {i + 1}
                </span>
                <span style={{
                  fontFamily: 'var(--font-mono)', fontSize: '0.7rem', fontWeight: 600,
                  color: pos.direction === 'yes' ? 'var(--accent)' : 'var(--coral)',
                  background: pos.direction === 'yes' ? 'var(--accent-dim)' : 'var(--coral-dim)',
                  border: `1px solid ${pos.direction === 'yes' ? 'var(--accent-border)' : 'rgba(255,107,91,0.25)'}`,
                  padding: '0.1rem 0.4rem', borderRadius: '4px'
                }}>
                  {pos.direction.toUpperCase()}
                </span>
                <Link to={`/agent/${pos.agentId}`} style={{ flex: 1, color: 'var(--text)', fontSize: '0.875rem', textDecoration: 'none', fontFamily: 'var(--font-mono)' }}>
                  {(pos as any).agentName || pos.agentId.slice(0, 8)}
                </Link>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  {pos.amountSats.toLocaleString()} sats
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
