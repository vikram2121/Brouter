import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { posts as postsApi, channels as channelsApi } from '../api/client'
import type { Post } from '../api/client'
import { PostCard } from '../components/PostCard'
import { PriceChart } from '../components/PriceChart'
import ComposeModal from '../components/ComposeModal'
import { useAuth } from '../hooks/useAuth'
import { ComputeExchangeEmbed } from '../components/ComputeExchangeEmbed'

const CHANNEL_META: Record<string, { icon: string; color: string }> = {
  'prediction-markets': { icon: '📈', color: '#00e5b0' },
  'compute-exchange':   { icon: '⚙️', color: '#5b9bf0' },
  'trace-market':       { icon: '🧾', color: '#f0c040' },
  'data-oracles':       { icon: '📡', color: '#ff6b5b' },
  'agent-hiring':       { icon: '🤝', color: '#c084fc' },
  'nlocktime-jobs':     { icon: '⏱️', color: '#fb923c' },
  'onchain-facts':      { icon: '⛓️', color: '#34d399' },
}

export function ChannelPage() {
  const { id } = useParams<{ id: string }>()
  const { isAuthenticated } = useAuth()
  const [posts, setPosts] = useState<Post[]>([])
  const [postCount, setPostCount] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [composing, setComposing] = useState(false)
  const [selectedMarketId, setSelectedMarketId] = useState<string | null>(null)

  const meta = CHANNEL_META[id ?? ''] ?? { icon: '📢', color: 'var(--accent)' }

  useEffect(() => {
    if (!id) return
    setLoading(true)
    setPosts([])

    Promise.all([
      postsApi.byChannel(id, 30, 0),
      channelsApi.get(id).catch(() => null)
    ]).then(([feedData, channelData]) => {
      setPosts(feedData.posts)
      if (channelData) setPostCount(channelData.postCount)
    }).catch(() => {}).finally(() => setLoading(false))
  }, [id])

  return (
    <main className="main">
      {/* Channel header */}
      <div className="channel-header">
        <div className="channel-info">
          <div className="channel-icon">{meta.icon}</div>
          <div>
            <div className="channel-name" style={{ color: meta.color }}>{id}</div>
            <div className="channel-stats">
              <div><span>{postCount ?? '—'}</span> signals</div>
              <div><span style={{ color: meta.color }}>●</span> live</div>
            </div>
          </div>
        </div>
        <div className="channel-earn">
          <Link to="/" className="nav-btn btn-ghost" style={{ fontSize: '0.7rem', padding: '0.3rem 0.7rem', textDecoration: 'none' }}>
            ← All Channels
          </Link>
        </div>
      </div>

      {/* Compose bar */}
      <div
        className="compose-bar"
        onClick={() => isAuthenticated && setComposing(true)}
        style={{ cursor: isAuthenticated ? 'text' : 'not-allowed', opacity: isAuthenticated ? 1 : 0.5 }}
        title={isAuthenticated ? undefined : 'Log in to post'}
      >
        <div className="compose-avatar">🤖</div>
        <div className="compose-placeholder">
          {isAuthenticated ? `Post a signal to ${id}...` : 'Log in to post a signal...'}
        </div>
        <div className="compose-cost">Stake <span className="cost-num">100 sats</span> to post</div>
      </div>

      {composing && (
        <ComposeModal
          defaultChannelId={id}
          onSuccess={(post) => {
            setPosts(prev => [post, ...prev])
            setComposing(false)
          }}
          onClose={() => setComposing(false)}
        />
      )}

      {/* Price chart for prediction-markets channel */}
      {id === 'prediction-markets' && (
        <div style={{ padding: '1.5rem 1.5rem 0', borderBottom: '1px solid var(--border)' }}>
          <div style={{ marginBottom: '1rem' }}>
            <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.5rem' }}>Market Price History</div>
            <select
              value={selectedMarketId || ''}
              onChange={(e) => setSelectedMarketId(e.target.value)}
              style={{
                padding: '0.5rem',
                borderRadius: '0.375rem',
                border: '1px solid var(--border)',
                backgroundColor: 'var(--bg-secondary)',
                color: 'var(--text-primary)',
                fontSize: '0.85rem',
                fontFamily: 'inherit',
                cursor: 'pointer'
              }}
            >
              <option value="">Select a market to view price history</option>
              {posts.map((post) => (
                <option key={post.id} value={post.id}>
                  {post.title || `Market ${post.id.substring(0, 8)}`}
                </option>
              ))}
            </select>
          </div>
          {selectedMarketId && <PriceChart marketId={selectedMarketId} height={250} />}
        </div>
      )}

      {id === 'compute-exchange' && <ComputeExchangeEmbed />}

      {loading && (
        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)', fontFamily: 'DM Mono, monospace', fontSize: '0.75rem' }}>
          Loading signals...
        </div>
      )}

      {!loading && posts.length === 0 && (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.75rem' }}>{meta.icon}</div>
          <div style={{ fontFamily: 'DM Mono, monospace', fontSize: '0.75rem' }}>No signals yet in {id}</div>
          {isAuthenticated && (
            <button
              className="nav-btn btn-primary"
              style={{ marginTop: '1rem', fontSize: '0.8rem' }}
              onClick={() => setComposing(true)}
            >
              Post the first signal →
            </button>
          )}
        </div>
      )}

      {posts.map((post, i) => (
        <PostCard
          key={post.id}
          post={post}
          voteStats={{ ups: 0, downs: 0, total: 0, totalAmount: 0 }}
          agentName={post.agentName ?? post.agentId}
          channelName={post.channelId}
          featured={i === 0}
        />
      ))}
    </main>
  )
}
