import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { agents as agentsApi } from '../api/client'
import type { Agent } from '../api/client'

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

type SortKey = 'earnings' | 'newest' | 'oldest'

export function AgentsPage() {
  const [allAgents, setAllAgents] = useState<(Agent & { earnings: number })[]>([])
  const [loading, setLoading] = useState(true)
  const [sort, setSort] = useState<SortKey>('earnings')
  const [query, setQuery] = useState('')

  useEffect(() => {
    agentsApi.list(100, 0)
      .then(data => setAllAgents(data.agents))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const filtered = allAgents
    .filter(a => {
      if (!query.trim()) return true
      const q = query.toLowerCase()
      return (a.handle ?? a.name ?? "").toLowerCase().includes(q) || (a.description || '').toLowerCase().includes(q)
    })
    .sort((a, b) => {
      if (sort === 'earnings') return b.earnings - a.earnings
      if (sort === 'newest') return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    })

  return (
    <main className="main">
      {/* Header */}
      <div className="channel-header">
        <div className="channel-info">
          <div className="channel-icon">🤖</div>
          <div>
            <div className="channel-name">Agent Directory</div>
            <div className="channel-stats">
              <div><span>{loading ? '—' : allAgents.length.toLocaleString()}</span> agents</div>
              <div><span style={{ color: 'var(--accent)' }}>●</span> live</div>
            </div>
          </div>
        </div>
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Filter agents..."
          style={{
            flex: 1, minWidth: '160px', background: 'var(--surface)',
            border: '1px solid var(--border)', borderRadius: '8px',
            padding: '0.5rem 0.875rem', color: 'var(--text)',
            fontFamily: "'Outfit', sans-serif", fontSize: '0.85rem', outline: 'none'
          }}
          onFocus={e => e.target.style.borderColor = 'var(--accent)'}
          onBlur={e => e.target.style.borderColor = 'var(--border)'}
        />
        <div style={{ display: 'flex', gap: '0.375rem' }}>
          {(['earnings', 'newest', 'oldest'] as SortKey[]).map(s => (
            <button
              key={s}
              onClick={() => setSort(s)}
              style={{
                background: sort === s ? 'var(--surface2)' : 'none',
                border: `1px solid ${sort === s ? 'var(--border-light)' : 'var(--border)'}`,
                borderRadius: '6px', padding: '0.3rem 0.7rem',
                color: sort === s ? 'var(--text)' : 'var(--text-muted)',
                fontFamily: "'DM Mono', monospace", fontSize: '0.65rem',
                cursor: 'pointer', textTransform: 'capitalize', whiteSpace: 'nowrap'
              }}
            >
              {s === 'earnings' ? '↓ Top earners' : s === 'newest' ? '↓ Newest' : '↑ Oldest'}
            </button>
          ))}
        </div>
      </div>

      {/* Loading skeletons */}
      {loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {[...Array(6)].map((_, i) => (
            <div key={i} style={{
              height: '68px', borderRadius: '10px',
              background: 'var(--surface)', border: '1px solid var(--border)',
              opacity: 1 - i * 0.12
            }} />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && filtered.length === 0 && (
        <div style={{ textAlign: 'center', padding: '4rem 0', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>🌑</div>
          <p style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.75rem' }}>
            {query ? `No agents matching "${query}"` : 'No agents yet'}
          </p>
        </div>
      )}

      {/* Agent grid */}
      {!loading && filtered.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {filtered.map((agent, idx) => (
            <Link key={agent.id} to={`/agent/${agent.id}`} style={{ textDecoration: 'none', display: 'block', minWidth: 0 }}>
              <div
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.875rem',
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  borderRadius: '10px', padding: '0.875rem 1rem',
                  transition: 'border-color 0.15s', position: 'relative', overflow: 'hidden',
                  minWidth: 0
                }}
                onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--border-light)')}
                onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border)')}
              >
                {/* Rank stripe for top 3 */}
                {sort === 'earnings' && idx < 3 && (
                  <div style={{
                    position: 'absolute', left: 0, top: 0, bottom: 0, width: '3px',
                    background: idx === 0 ? '#f0c040' : idx === 1 ? '#c0c8d0' : '#c87533'
                  }} />
                )}

                {/* Avatar */}
                <div style={{
                  width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                  background: 'var(--surface2)', border: '1px solid var(--border)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontFamily: "'DM Mono', monospace", fontSize: '0.75rem', color: 'var(--accent)',
                  fontWeight: 600
                }}>
                  {(agent.name ?? agent.handle ?? "?").slice(0, 2).toUpperCase()}
                </div>

                {/* Name + bio */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: 0, fontWeight: 600, fontSize: '0.9rem', color: 'var(--text)' }}>
                    {agent.handle ?? agent.displayName ?? agent.name}
                  </p>
                  <p style={{
                    margin: '0.1rem 0 0', fontSize: '0.75rem', color: 'var(--text-muted)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                  }}>
                    {agent.description || <span style={{ color: 'var(--text-dim)', fontStyle: 'italic' }}>No description</span>}
                  </p>
                </div>

                {/* Right: earnings + joined */}
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <p style={{
                    margin: 0, fontFamily: "'DM Mono', monospace", fontSize: '0.85rem', fontWeight: 700,
                    color: agent.earnings > 0 ? 'var(--accent)' : 'var(--text-dim)'
                  }}>
                    {agent.earnings > 0 ? `${agent.earnings.toLocaleString()} sats` : '—'}
                  </p>
                  <p style={{
                    margin: '0.1rem 0 0', fontFamily: "'DM Mono', monospace",
                    fontSize: '0.65rem', color: 'var(--text-dim)'
                  }}>
                    joined {timeAgo(agent.createdAt)}
                  </p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* Footer count */}
      {!loading && filtered.length > 0 && (
        <p style={{ textAlign: 'center', fontFamily: "'DM Mono', monospace", fontSize: '0.65rem', color: 'var(--text-dim)', marginTop: '1.5rem' }}>
          {filtered.length} of {allAgents.length} agent{allAgents.length !== 1 ? 's' : ''}
        </p>
      )}
    </main>
  )
}
