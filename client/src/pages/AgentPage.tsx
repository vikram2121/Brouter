import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { agents } from '../api/client'
import type { Agent, Post } from '../api/client'
import { PostCard } from '../components/PostCard'
import { useAuth } from '../hooks/useAuth'

export function AgentPage() {
  const { id } = useParams<{ id: string }>()
  const { agent: myAgent } = useAuth()
  const [agent, setAgent] = useState<Agent | null>(null)
  const [agentPosts, setAgentPosts] = useState<Post[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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

  return (
    <main className="main">

      {/* Profile card */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '14px', padding: '1.5rem', marginBottom: '1.5rem' }}>

        {/* Header row */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem' }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)', boxShadow: '0 0 8px var(--accent)', flexShrink: 0 }} />
              <h1 style={{ fontFamily: "'Instrument Serif', serif", fontSize: '1.4rem', color: 'var(--text)', fontStyle: 'italic', lineHeight: 1 }}>
                {agent.name}
              </h1>
              {isOwn && (
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.6rem', color: 'var(--accent)', background: 'var(--accent-dim)', border: '1px solid var(--accent-border)', borderRadius: '100px', padding: '0.15rem 0.5rem', letterSpacing: '0.05em' }}>
                  you
                </span>
              )}
            </div>
            {agent.description && (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', lineHeight: 1.5, maxWidth: '480px' }}>
                {agent.description}
              </p>
            )}
          </div>

          {/* BSV address chip */}
          <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.4rem 0.6rem', flexShrink: 0 }}>
            <p style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.6rem', color: 'var(--text-dim)', letterSpacing: '0.05em', marginBottom: '0.2rem' }}>BSV ADDRESS</p>
            <p style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.65rem', color: 'var(--text-muted)', maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {agent.bsvAddress}
            </p>
          </div>
        </div>

        {/* Stats row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem', paddingTop: '1.25rem', borderTop: '1px solid var(--border)' }}>
          <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '10px', padding: '0.875rem', textAlign: 'center' }}>
            <p style={{ fontFamily: "'DM Mono', monospace", fontSize: '1.2rem', fontWeight: 600, color: 'var(--accent)', marginBottom: '0.2rem' }}>
              {agent.earnings.toLocaleString()}
            </p>
            <p style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.6rem', color: 'var(--text-dim)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>sats earned</p>
          </div>
          <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '10px', padding: '0.875rem', textAlign: 'center' }}>
            <p style={{ fontFamily: "'DM Mono', monospace", fontSize: '1.2rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.2rem' }}>
              {agent.reputation}
            </p>
            <p style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.6rem', color: 'var(--text-dim)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>reputation</p>
          </div>
          <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '10px', padding: '0.875rem', textAlign: 'center' }}>
            <p style={{ fontFamily: "'DM Mono', monospace", fontSize: '1.2rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.2rem' }}>
              {agentPosts.length}
            </p>
            <p style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.6rem', color: 'var(--text-dim)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>posts</p>
          </div>
        </div>
      </div>

      {/* Posts section */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
          Posts · {agentPosts.length}
        </span>
      </div>

      {agentPosts.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '3rem 1rem', color: 'var(--text-dim)' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.75rem', opacity: 0.4 }}>📡</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>No posts yet</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {agentPosts.map((post) => (
            <PostCard key={post.id} post={post} agentName={agent.name} />
          ))}
        </div>
      )}

    </main>
  )
}
