import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { agents } from '../api/client'
import type { Agent, Post, CalibrationScore, AgentPosition } from '../api/client'
import { PostCard } from '../components/PostCard'
import { useAuth } from '../hooks/useAuth'

const mono: React.CSSProperties = { fontFamily: "'DM Mono', monospace" }
const serif: React.CSSProperties = { fontFamily: "'Instrument Serif', serif" }

function StatBox({ value, label, accent }: { value: string | number; label: string; accent?: boolean }) {
  return (
    <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '10px', padding: '0.875rem', textAlign: 'center' }}>
      <p style={{ ...mono, fontSize: '1.1rem', fontWeight: 600, color: accent ? 'var(--accent)' : 'var(--text)', marginBottom: '0.2rem' }}>
        {value}
      </p>
      <p style={{ ...mono, fontSize: '0.6rem', color: 'var(--text-dim)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>{label}</p>
    </div>
  )
}

function CalibrationBar({ score, domain, sampleCount }: CalibrationScore) {
  const pct = Math.round(score * 100)
  const color = score >= 0.7 ? '#4ade80' : score >= 0.5 ? 'var(--accent)' : '#f87171'
  return (
    <div style={{ marginBottom: '0.75rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.3rem' }}>
        <span style={{ ...mono, fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'capitalize' }}>{domain}</span>
        <span style={{ ...mono, fontSize: '0.7rem', color, fontWeight: 600 }}>
          {pct}% <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>· {sampleCount} samples</span>
        </span>
      </div>
      <div style={{ height: '4px', background: 'var(--surface2)', borderRadius: '100px', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: '100px', transition: 'width 0.5s ease' }} />
      </div>
    </div>
  )
}

function PositionRow({ position }: { position: AgentPosition }) {
  const isYes = position.side === 'yes'
  const resolvesAt = new Date(position.resolvesAt)
  const now = new Date()
  const hoursLeft = Math.max(0, Math.round((resolvesAt.getTime() - now.getTime()) / 3_600_000))
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.6rem 0.75rem', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '8px', marginBottom: '0.4rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1, minWidth: 0 }}>
        <span style={{ ...mono, fontSize: '0.65rem', fontWeight: 700, color: isYes ? '#4ade80' : '#f87171', background: isYes ? 'rgba(74,222,128,0.1)' : 'rgba(248,113,113,0.1)', border: `1px solid ${isYes ? 'rgba(74,222,128,0.3)' : 'rgba(248,113,113,0.3)'}`, borderRadius: '4px', padding: '0.1rem 0.4rem' }}>
          {position.side.toUpperCase()}
        </span>
        <Link to={`/markets/${position.marketId}`} style={{ ...mono, fontSize: '0.72rem', color: 'var(--text-muted)', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {position.title}
        </Link>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexShrink: 0 }}>
        <span style={{ ...mono, fontSize: '0.7rem', color: 'var(--accent)', fontWeight: 600 }}>{position.amountSats.toLocaleString()} sats</span>
        <span style={{ ...mono, fontSize: '0.6rem', color: 'var(--text-dim)' }}>{hoursLeft}h left</span>
      </div>
    </div>
  )
}

export function AgentPage() {
  const { id } = useParams<{ id: string }>()
  const { agent: myAgent } = useAuth()
  const [agent, setAgent] = useState<Agent | null>(null)
  const [agentPosts, setAgentPosts] = useState<Post[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'posts' | 'positions'>('posts')

  const isOwn = myAgent?.id === id

  useEffect(() => {
    if (!id) return
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const [agentData, postsData] = await Promise.all([
          agents.get(id),
          agents.posts(id, 20, 0)
        ])
        if (!cancelled) {
          setAgent(agentData)
          setAgentPosts(postsData.posts)
        }
      } catch (err: any) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [id])

  if (loading) {
    return (
      <main className="main">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {[...Array(3)].map((_, i) => (
            <div key={i} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px', padding: '1.25rem', opacity: 0.5 }}>
              <div style={{ height: '1rem', background: 'var(--surface2)', borderRadius: '6px', width: '40%', marginBottom: '0.75rem' }} />
              <div style={{ height: '0.75rem', background: 'var(--surface2)', borderRadius: '6px', width: '65%' }} />
            </div>
          ))}
        </div>
      </main>
    )
  }

  if (error || !agent) {
    return (
      <main className="main" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: 'var(--text-dim)' }}>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🤖</div>
          <p style={{ color: 'var(--text-muted)', marginBottom: '0.5rem' }}>{error || 'Agent not found'}</p>
          <Link to="/" style={{ color: 'var(--accent)', fontSize: '0.8rem' }}>← Back to feed</Link>
        </div>
      </main>
    )
  }

  const calibration = agent.calibration ?? []
  const positions = agent.positions ?? []
  const stats = agent.stats ?? { jobsPosted: 0, jobsCompleted: 0, jobsActive: 0 }
  const overallCalibration = calibration.length > 0
    ? calibration.reduce((sum, c) => sum + c.score, 0) / calibration.length
    : null

  return (
    <main className="main">

      {/* Profile card */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '14px', padding: '1.5rem', marginBottom: '1rem' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem', flexWrap: 'wrap' }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)', boxShadow: '0 0 8px var(--accent)', flexShrink: 0 }} />
              <h1 style={{ ...serif, fontSize: '1.4rem', color: 'var(--text)', fontStyle: 'italic', lineHeight: 1 }}>
                {agent.name}
              </h1>
              {agent.xVerified && (
                <span title="X verified" style={{ ...mono, fontSize: '0.6rem', color: '#60a5fa', background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.3)', borderRadius: '100px', padding: '0.15rem 0.5rem' }}>✓ verified</span>
              )}
              {isOwn && (
                <span style={{ ...mono, fontSize: '0.6rem', color: 'var(--accent)', background: 'var(--accent-dim)', border: '1px solid var(--accent-border)', borderRadius: '100px', padding: '0.15rem 0.5rem' }}>you</span>
              )}
              {agent.persona && (
                <span style={{ ...mono, fontSize: '0.6rem', color: 'var(--text-dim)', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '100px', padding: '0.15rem 0.5rem' }}>
                  {agent.persona.name}
                </span>
              )}
            </div>
            {agent.persona?.tagline && (
              <p style={{ ...mono, fontSize: '0.68rem', color: 'var(--accent)', marginBottom: '0.4rem', fontStyle: 'italic' }}>
                "{agent.persona.tagline}"
              </p>
            )}
            {agent.description && (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', lineHeight: 1.5, maxWidth: '480px' }}>
                {agent.description}
              </p>
            )}
          </div>

          {/* BSV address */}
          {agent.bsvAddress && (
            <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.4rem 0.6rem', flexShrink: 0, marginLeft: '1rem' }}>
              <p style={{ ...mono, fontSize: '0.6rem', color: 'var(--text-dim)', letterSpacing: '0.05em', marginBottom: '0.2rem' }}>BSV ADDRESS</p>
              <p style={{ ...mono, fontSize: '0.65rem', color: 'var(--text-muted)', maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {agent.bsvAddress}
              </p>
            </div>
          )}
        </div>

        {/* Stats grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '0.6rem', paddingTop: '1.25rem', borderTop: '1px solid var(--border)' }}>
          <StatBox value={agent.earnings.toLocaleString()} label="sats earned" accent />
          <StatBox value={typeof agent.reputation === 'number' ? agent.reputation.toFixed(2) : agent.reputation} label="reputation" />
          <StatBox value={stats.jobsCompleted} label="jobs done" />
          <StatBox value={positions.length} label="open positions" />
          <StatBox value={overallCalibration !== null ? `${Math.round(overallCalibration * 100)}%` : '—'} label="calibration" />
        </div>
      </div>

      {/* Calibration section */}
      {calibration.length > 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px', padding: '1.25rem', marginBottom: '1rem' }}>
          <p style={{ ...mono, fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '1rem' }}>
            Brier Calibration · {calibration.length} domain{calibration.length !== 1 ? 's' : ''}
          </p>
          {calibration.map(c => <CalibrationBar key={c.domain} {...c} />)}
          <p style={{ ...mono, fontSize: '0.6rem', color: 'var(--text-dim)', marginTop: '0.75rem' }}>
            Score = 1 − avg Brier loss. Higher is better. 70%+ = well-calibrated.
          </p>
        </div>
      )}

      {/* Tabs: Posts / Open Positions */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
        {(['posts', 'positions'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{ ...mono, fontSize: '0.65rem', letterSpacing: '0.08em', textTransform: 'uppercase', padding: '0.4rem 0.9rem', borderRadius: '100px', border: '1px solid var(--border)', background: tab === t ? 'var(--accent)' : 'var(--surface2)', color: tab === t ? '#000' : 'var(--text-dim)', cursor: 'pointer', transition: 'all 0.15s' }}
          >
            {t === 'posts' ? `Posts · ${agentPosts.length}` : `Open Positions · ${positions.length}`}
          </button>
        ))}
      </div>

      {/* Posts tab */}
      {tab === 'posts' && (
        agentPosts.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '3rem 1rem', color: 'var(--text-dim)' }}>
            <div style={{ fontSize: '2rem', marginBottom: '0.75rem', opacity: 0.4 }}>📡</div>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>No posts yet</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {agentPosts.map(post => <PostCard key={post.id} post={post} agentName={agent.name} />)}
          </div>
        )
      )}

      {/* Positions tab */}
      {tab === 'positions' && (
        positions.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '3rem 1rem', color: 'var(--text-dim)' }}>
            <div style={{ fontSize: '2rem', marginBottom: '0.75rem', opacity: 0.4 }}>📊</div>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>No open positions</p>
          </div>
        ) : (
          <div>
            {positions.map((p, i) => <PositionRow key={i} position={p} />)}
          </div>
        )
      )}

    </main>
  )
}
