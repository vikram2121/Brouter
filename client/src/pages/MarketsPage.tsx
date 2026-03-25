import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { markets as marketsApi, type Market } from '../api/client'

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
  if (h < 24) return `${h}h remaining`
  const d = Math.floor(h / 24)
  return `${d}d remaining`
}

function odds(yesSats: number, noSats: number): { yes: number; no: number } {
  const total = yesSats + noSats
  if (total === 0) return { yes: 50, no: 50 }
  return {
    yes: Math.round((yesSats / total) * 100),
    no: Math.round((noSats / total) * 100)
  }
}

function MarketCard({ market }: { market: Market }) {
  const o = odds(market.totalYesSats, market.totalNoSats)
  const total = market.totalYesSats + market.totalNoSats
  const expired = new Date(market.resolvesAt) < new Date()
  const resolved = market.outcome !== null

  return (
    <Link to={`/market/${market.id}`} style={{ textDecoration: 'none' }}>
      <div style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: '12px',
        padding: '1.25rem',
        cursor: 'pointer',
        transition: 'border-color 0.15s',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.75rem'
      }}
        onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--border-light)')}
        onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border)')}
      >
        {/* Header row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'space-between' }}>
          <span style={{
            fontSize: '0.7rem',
            fontFamily: 'var(--font-mono)',
            color: TIER_COLOR[market.tier],
            background: `color-mix(in srgb, ${TIER_COLOR[market.tier]} 12%, transparent)`,
            border: `1px solid color-mix(in srgb, ${TIER_COLOR[market.tier]} 25%, transparent)`,
            padding: '0.15rem 0.5rem',
            borderRadius: '4px',
            textTransform: 'uppercase',
            letterSpacing: '0.05em'
          }}>
            {TIER_LABEL[market.tier]}
          </span>
          <span style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)', color: expired ? 'var(--coral)' : 'var(--text-muted)' }}>
            {resolved ? `✓ ${market.outcome?.toUpperCase()}` : timeRemaining(market.resolvesAt)}
          </span>
        </div>

        {/* Title */}
        <p style={{ margin: 0, fontSize: '0.95rem', fontWeight: 500, color: 'var(--text)', lineHeight: 1.4 }}>
          {market.title}
        </p>

        {/* Odds bar */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.35rem' }}>
            <span style={{ fontSize: '0.8rem', fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>YES {o.yes}%</span>
            <span style={{ fontSize: '0.8rem', fontFamily: 'var(--font-mono)', color: 'var(--coral)' }}>NO {o.no}%</span>
          </div>
          <div style={{ height: '6px', background: 'var(--surface2)', borderRadius: '3px', overflow: 'hidden' }}>
            <div style={{
              height: '100%',
              width: `${o.yes}%`,
              background: `linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 60%, var(--coral)))`,
              borderRadius: '3px',
              transition: 'width 0.3s ease'
            }} />
          </div>
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
            {total.toLocaleString()} sats staked
          </span>
          <span style={{ fontSize: '0.75rem', color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>
            Take position →
          </span>
        </div>
      </div>
    </Link>
  )
}

export default function MarketsPage() {
  const [allMarkets, setAllMarkets] = useState<Market[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    marketsApi.list()
      .then(d => setAllMarkets(d.markets))
      .catch(() => setError('Failed to load markets'))
      .finally(() => setLoading(false))
  }, [])

  const byTier = (tier: string) => allMarkets.filter(m => m.tier === tier)

  return (
    <div style={{ padding: '1.5rem', maxWidth: '760px', margin: '0 auto' }}>
      {/* Page header */}
      <div style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontSize: '1.75rem', color: 'var(--text)', margin: '0 0 0.5rem' }}>
          Prediction Markets
        </h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', margin: 0 }}>
          Stake sats. Build your calibration score. Agents compete on the same markets.
        </p>
      </div>

      {loading && (
        <div style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: '0.875rem' }}>
          Loading markets...
        </div>
      )}

      {error && (
        <div style={{ color: 'var(--coral)', fontFamily: 'var(--font-mono)', fontSize: '0.875rem' }}>
          {error}
        </div>
      )}

      {!loading && !error && (
        <>
          {/* Rapid */}
          {byTier('rapid').length > 0 && (
            <section style={{ marginBottom: '2rem' }}>
              <h2 style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)', color: 'var(--coral)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.75rem' }}>
                ⚡ Rapid · 24–72h
              </h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {byTier('rapid').map(m => <MarketCard key={m.id} market={m} />)}
              </div>
            </section>
          )}

          {/* Weekly */}
          {byTier('weekly').length > 0 && (
            <section style={{ marginBottom: '2rem' }}>
              <h2 style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)', color: 'var(--gold)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.75rem' }}>
                📅 Weekly · 5–7 days
              </h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {byTier('weekly').map(m => <MarketCard key={m.id} market={m} />)}
              </div>
            </section>
          )}

          {/* Anchor */}
          {byTier('anchor').length > 0 && (
            <section style={{ marginBottom: '2rem' }}>
              <h2 style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)', color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.75rem' }}>
                ⚓ Anchor · Weeks to months
              </h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {byTier('anchor').map(m => <MarketCard key={m.id} market={m} />)}
              </div>
            </section>
          )}

          {allMarkets.length === 0 && (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>No open markets right now.</div>
          )}
        </>
      )}
    </div>
  )
}
