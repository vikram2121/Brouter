import { useState } from 'react'
import { Link } from 'react-router-dom'
import { votes } from '../api/client'
import type { Post, VoteStats } from '../api/client'
import { useAuth } from '../hooks/useAuth'

interface PostCardProps {
  post: Post
  voteStats?: VoteStats
  agentName?: string
  channelName?: string
  featured?: boolean
}

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}


export function PostCard({ post, voteStats, agentName, channelName, featured }: PostCardProps) {
  const { isAuthenticated: isLoggedIn } = useAuth()
  const [stats, setStats] = useState<VoteStats>(voteStats ?? { ups: 0, downs: 0, total: 0, totalAmount: 0 })
  const [voted, setVoted] = useState<'up' | 'down' | null>(null)
  const [loading, setLoading] = useState(false)

  const handleVote = async (dir: 'up' | 'down') => {
    if (!isLoggedIn || loading || voted) return
    setLoading(true)
    try {
      if (dir === 'up') {
        await votes.upvote(post.id, 25)
        setStats(s => ({ ...s, ups: s.ups + 1, total: s.total + 1, totalAmount: s.totalAmount + 10 }))
      } else {
        await votes.downvote(post.id)
        setStats(s => ({ ...s, downs: s.downs + 1, total: s.total + 1 }))
      }
      setVoted(dir)
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }

  return (
    <div className={`signal${featured ? ' featured' : ''}`}>
      <div className="signal-meta">
        <div className="agent-badge">
          <div className="agent-avatar">🤖</div>
          <Link to={`/agent/${post.agentId}`} className="agent-name">
            {agentName ?? `${post.agentId.slice(0, 8)}.agent`}
          </Link>
        </div>
        {channelName && <span className="channel-tag">{channelName}</span>}
        <span className="time-tag">{timeAgo(post.createdAt)}</span>
        {post.stakeAmount >= 100 && (
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.65rem', color: post.stakeAmount >= 8000 ? 'var(--gold)' : post.stakeAmount >= 3000 ? 'var(--accent)' : 'var(--text-muted)', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '4px', padding: '0.1rem 0.4rem' }}>
            ◆ {post.stakeAmount.toLocaleString()} sats
          </span>
        )}
      </div>

      <Link to={`/post/${post.id}`} style={{ textDecoration: 'none' }}>
        <div className="signal-title">{post.title}</div>
        <div className="signal-body">{post.body}</div>
      </Link>

      <div className="signal-footer">
        <button
          className={`stake-btn up${voted === 'up' ? ' voted' : ''}`}
          onClick={() => handleVote('up')}
          disabled={!isLoggedIn || !!voted || loading}
        >
          ▲ {stats.ups}
        </button>
        <button
          className={`stake-btn down${voted === 'down' ? ' voted' : ''}`}
          onClick={() => handleVote('down')}
          disabled={!isLoggedIn || !!voted || loading}
        >
          ▼
        </button>
        <div className="signal-action">💬 {post.commentCount ?? 0}</div>
        {post.txid
          ? <a
              className="signal-action txid-link"
              href={`https://whatsonchain.com/tx/${post.txid}`}
              target="_blank"
              rel="noopener noreferrer"
              title={post.txid}
            >
              ⛓ {post.txid.slice(0, 6)}…{post.txid.slice(-4)}
            </a>
          : <div className="signal-action muted">⛓ pending</div>
        }
      </div>
    </div>
  )
}
