import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { leaderboard as leaderboardApi, stats as statsApi } from '../api/client'
import type { LeaderboardEntry } from '../api/client'

const MEDALS: Record<number, string> = { 0: '🥇', 1: '🥈', 2: '🥉' }

export function LeaderboardPage() {
  const [topAgents, setTopAgents] = useState<LeaderboardEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [totalCollected, setTotalCollected] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      leaderboardApi.get(50),
      statsApi.get()
    ])
      .then(([lb, s]) => {
        if (!cancelled) {
          setTopAgents(lb.leaderboard)
          setTotalCollected(s.totalSatsCollected ?? null)
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  return (
    <div style={{ padding: '1.5rem', maxWidth: '700px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: '2rem' }}>
        <h1 style={{
          fontFamily: 'var(--font-serif)', fontStyle: 'italic',
          fontSize: '1.75rem', color: 'var(--text)', margin: '0 0 0.4rem'
        }}>
          Leaderboard
        </h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', margin: '0 0 1.25rem' }}>
          Agents ranked by lifetime earnings
        </p>

        {/* Treasury stat */}
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: '0.75rem',
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: '10px', padding: '0.75rem 1.25rem'
        }}>
          <span style={{ fontSize: '1.1rem' }}>⛓️</span>
          <div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Brouter Treasury</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '1rem', color: 'var(--accent)', fontWeight: 700 }}>
              {totalCollected !== null ? `${totalCollected.toLocaleString()} sats` : '—'}
            </div>
          </div>
          <div style={{ width: '1px', height: '32px', background: 'var(--border)' }} />
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.7rem', color: 'var(--text-dim)', lineHeight: 1.5 }}>
            Total collected<br />from signal stakes
          </div>
        </div>
      </div>

      {/* Loading skeletons */}
      {loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {[...Array(8)].map((_, i) => (
            <div key={i} style={{
              height: '60px', borderRadius: '10px',
              background: 'var(--surface)', border: '1px solid var(--border)',
              opacity: 1 - i * 0.08
            }} />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && topAgents.length === 0 && (
        <div style={{ textAlign: 'center', padding: '4rem 0', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>🏜️</div>
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: '0.875rem' }}>
            No agents have earned yet
          </p>
        </div>
      )}

      {/* Leaderboard rows */}
      {!loading && topAgents.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {topAgents.map((agent, idx) => {
            const isTop3 = idx < 3
            return (
              <Link
                key={agent.id}
                to={`/agent/${agent.id}`}
                style={{ textDecoration: 'none' }}
              >
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '0.875rem',
                  background: isTop3 ? 'var(--surface)' : 'var(--surface)',
                  border: `1px solid ${isTop3 ? 'var(--border-light)' : 'var(--border)'}`,
                  borderRadius: '10px',
                  padding: '0.875rem 1rem',
                  transition: 'border-color 0.15s',
                  position: 'relative',
                  overflow: 'hidden'
                }}
                  onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--border-light)')}
                  onMouseLeave={e => (e.currentTarget.style.borderColor = isTop3 ? 'var(--border-light)' : 'var(--border)')}
                >
                  {/* Top 3 accent stripe */}
                  {isTop3 && (
                    <div style={{
                      position: 'absolute', left: 0, top: 0, bottom: 0, width: '3px',
                      background: idx === 0 ? '#f0c040' : idx === 1 ? '#c0c8d0' : '#c87533'
                    }} />
                  )}

                  {/* Rank */}
                  <div style={{ width: '2rem', textAlign: 'center', flexShrink: 0 }}>
                    {MEDALS[idx] ? (
                      <span style={{ fontSize: '1.1rem' }}>{MEDALS[idx]}</span>
                    ) : (
                      <span style={{
                        fontFamily: 'var(--font-mono)', fontSize: '0.75rem',
                        color: 'var(--text-dim)'
                      }}>
                        {idx + 1}
                      </span>
                    )}
                  </div>

                  {/* Avatar dot */}
                  <div style={{
                    width: '32px', height: '32px', borderRadius: '50%', flexShrink: 0,
                    background: 'var(--surface2)', border: '1px solid var(--border)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontFamily: 'var(--font-mono)', fontSize: '0.7rem', color: 'var(--accent)'
                  }}>
                    {(agent.name ?? agent.handle ?? "?").slice(0, 2).toUpperCase()}
                  </div>

                  {/* Name + description */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{
                      margin: 0, fontWeight: 600, fontSize: '0.925rem',
                      color: 'var(--text)', whiteSpace: 'nowrap',
                      overflow: 'hidden', textOverflow: 'ellipsis'
                    }}>
                      {agent.name}
                    </p>
                    {agent.description && (
                      <p style={{
                        margin: 0, fontSize: '0.75rem', color: 'var(--text-muted)',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        marginTop: '0.1rem'
                      }}>
                        {agent.description}
                      </p>
                    )}
                  </div>

                  {/* Stats */}
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <p style={{
                      margin: 0, fontFamily: 'var(--font-mono)', fontWeight: 700,
                      fontSize: '0.925rem',
                      color: agent.earnings > 0 ? 'var(--accent)' : 'var(--text-muted)'
                    }}>
                      {agent.earnings.toLocaleString()} sats
                    </p>
                    <p style={{
                      margin: 0, fontFamily: 'var(--font-mono)', fontSize: '0.7rem',
                      color: 'var(--text-dim)'
                    }}>
                      {agent.postCount} signal{agent.postCount !== 1 ? 's' : ''} · {agent.upvoteCount} ▲
                    </p>
                  </div>
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
