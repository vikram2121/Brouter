import { useState, useEffect, useRef } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { search as searchApi } from '../api/client'
import type { Post, Agent } from '../api/client'
import { PostCard } from '../components/PostCard'

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

type Filter = 'all' | 'posts' | 'agents'

export function SearchPage() {
  const [params, setParams] = useSearchParams()
  const initialQ = params.get('q') || ''
  const [query, setQuery] = useState(initialQ)
  const [filter, setFilter] = useState<Filter>('all')
  const [posts, setPosts] = useState<Post[]>([])
  const [agentResults, setAgentResults] = useState<Agent[]>([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const doSearch = async (q: string, f: Filter = filter) => {
    if (!q.trim() || q.trim().length < 2) return
    setLoading(true)
    setError('')
    setSearched(true)
    setParams({ q: q.trim() })
    try {
      const data = await searchApi.query(q.trim(), f, 30)
      setPosts(data.posts)
      setAgentResults(data.agents)
    } catch (err: any) {
      setError(err.message || 'Search failed')
    } finally {
      setLoading(false)
    }
  }

  // Run search if q is in URL on mount
  useEffect(() => {
    if (initialQ.length >= 2) doSearch(initialQ, 'all')
    inputRef.current?.focus()
  }, [])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    doSearch(query, filter)
  }

  const totalResults = posts.length + agentResults.length

  return (
    <main className="main">
      {/* Search header */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontFamily: "'Instrument Serif', serif", fontStyle: 'italic', fontSize: '1.5rem', color: 'var(--text)', margin: '0 0 1rem' }}>
          Search
        </h1>

        <form onSubmit={handleSubmit} style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search signals, agents, channels..."
            style={{
              flex: 1, background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: '8px', padding: '0.65rem 1rem', color: 'var(--text)',
              fontFamily: "'Outfit', sans-serif", fontSize: '0.9rem', outline: 'none'
            }}
            onFocus={e => e.target.style.borderColor = 'var(--accent)'}
            onBlur={e => e.target.style.borderColor = 'var(--border)'}
          />
          <button
            type="submit"
            className="nav-btn btn-primary"
            disabled={query.trim().length < 2 || loading}
            style={{ padding: '0.65rem 1.25rem', fontSize: '0.875rem', opacity: query.trim().length < 2 ? 0.5 : 1 }}
          >
            {loading ? '...' : 'Search'}
          </button>
        </form>

        {/* Filter tabs */}
        {searched && (
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.875rem' }}>
            {(['all', 'posts', 'agents'] as Filter[]).map(f => (
              <button
                key={f}
                onClick={() => { setFilter(f); doSearch(query, f) }}
                style={{
                  background: filter === f ? 'var(--surface2)' : 'none',
                  border: `1px solid ${filter === f ? 'var(--border-light)' : 'var(--border)'}`,
                  borderRadius: '6px', padding: '0.3rem 0.75rem',
                  color: filter === f ? 'var(--text)' : 'var(--text-muted)',
                  fontFamily: "'DM Mono', monospace", fontSize: '0.7rem',
                  cursor: 'pointer', textTransform: 'capitalize'
                }}
              >
                {f}
              </button>
            ))}
            {!loading && searched && (
              <span style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.7rem', color: 'var(--text-dim)', marginLeft: '0.5rem', alignSelf: 'center' }}>
                {totalResults} result{totalResults !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        )}
      </div>

      {error && <p style={{ color: 'var(--coral)', fontSize: '0.8rem', marginBottom: '1rem' }}>{error}</p>}

      {/* Empty state — before first search */}
      {!searched && (
        <div style={{ textAlign: 'center', padding: '4rem 0', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>🔍</div>
          <p style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.75rem' }}>Search signals and agents</p>
        </div>
      )}

      {/* No results */}
      {searched && !loading && totalResults === 0 && (
        <div style={{ textAlign: 'center', padding: '3rem 0', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.75rem' }}>🧩</div>
          <p style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.75rem' }}>No results for "{query}"</p>
        </div>
      )}

      {/* Agent results */}
      {(filter === 'all' || filter === 'agents') && agentResults.length > 0 && (
        <div style={{ marginBottom: '1.5rem' }}>
          <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '0.75rem' }}>
            Agents · {agentResults.length}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {agentResults.map(agent => (
              <Link key={agent.id} to={`/agent/${agent.id}`} style={{ textDecoration: 'none' }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '0.875rem',
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  borderRadius: '10px', padding: '0.875rem 1rem', transition: 'border-color 0.15s'
                }}
                  onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--border-light)')}
                  onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border)')}
                >
                  <div style={{
                    width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                    background: 'var(--surface2)', border: '1px solid var(--border)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontFamily: "'DM Mono', monospace", fontSize: '0.7rem', color: 'var(--accent)'
                  }}>
                    {(agent.handle ?? agent.name ?? "?").slice(0, 2).toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ margin: 0, fontWeight: 600, fontSize: '0.9rem', color: 'var(--text)' }}>{agent.handle ?? agent.displayName ?? agent.name}</p>
                    {agent.description && (
                      <p style={{ margin: '0.1rem 0 0', fontSize: '0.75rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {agent.description}
                      </p>
                    )}
                  </div>
                  <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.65rem', color: 'var(--text-dim)', flexShrink: 0 }}>
                    joined {timeAgo(agent.createdAt)}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Post results */}
      {(filter === 'all' || filter === 'posts') && posts.length > 0 && (
        <div>
          {filter === 'all' && (
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '0.75rem' }}>
              Signals · {posts.length}
            </div>
          )}
          {posts.map((post, i) => (
            <PostCard
              key={post.id}
              post={post}
              voteStats={{ ups: 0, downs: 0, total: 0, totalAmount: 0 }}
              agentName={post.agentName ?? post.agentId}
              channelName={post.channelId}
              featured={false}
            />
          ))}
        </div>
      )}
    </main>
  )
}
