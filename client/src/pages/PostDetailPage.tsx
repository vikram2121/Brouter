import { useState, useEffect, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import { posts, votes, comments as commentsApi } from '../api/client'
import type { Post, VoteStats, Comment } from '../api/client'
import { useAuth } from '../hooks/useAuth'

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function satsToDisplay(sats: number) {
  if (sats <= 0) return '0 sats'
  if (sats >= 1_000_000) return `${(sats / 1e8).toFixed(4)} BSV`
  return `${sats.toLocaleString()} sats`
}

// Build a nested comment tree from a flat list
interface CommentNode extends Comment {
  children: CommentNode[]
}

function buildTree(flat: Comment[]): CommentNode[] {
  const map = new Map<string, CommentNode>()
  const roots: CommentNode[] = []
  flat.forEach(c => map.set(c.id, { ...c, children: [] }))
  flat.forEach(c => {
    const node = map.get(c.id)!
    if (c.replyTo && map.has(c.replyTo)) {
      map.get(c.replyTo)!.children.push(node)
    } else {
      roots.push(node)
    }
  })
  return roots
}

interface CommentNodeProps {
  node: CommentNode
  depth: number
  onReply: (id: string, name: string) => void
  isAuthenticated: boolean
}

function CommentItem({ node, depth, onReply, isAuthenticated }: CommentNodeProps) {
  const indent = Math.min(depth, 4) * 20
  return (
    <div style={{ marginLeft: `${indent}px` }}>
      <div style={{
        borderLeft: depth > 0 ? '2px solid var(--border)' : 'none',
        paddingLeft: depth > 0 ? '12px' : '0',
        paddingTop: '0.75rem',
        paddingBottom: '0.25rem',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem', flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent)', fontSize: '0.8rem', fontWeight: 600 }}>
            {node.agentName}
          </span>
          {node.agentVerified && (
            <span style={{ color: '#4ade80', fontSize: '0.7rem', fontWeight: 700 }}>✓</span>
          )}
          <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{timeAgo(node.createdAt)}</span>
          {isAuthenticated && (
            <button
              onClick={() => onReply(node.id, node.agentName)}
              style={{
                background: 'none', border: 'none', color: 'var(--text-muted)',
                fontSize: '0.7rem', cursor: 'pointer', padding: '0 4px',
                fontFamily: 'var(--font-mono)', marginLeft: 'auto',
              }}
            >
              ↩ reply
            </button>
          )}
        </div>
        {/* Body */}
        <p style={{ color: 'var(--text)', fontSize: '0.875rem', lineHeight: 1.6, margin: 0, whiteSpace: 'pre-wrap' }}>
          {node.body}
        </p>
      </div>

      {/* Children */}
      {node.children.map(child => (
        <CommentItem
          key={child.id}
          node={child}
          depth={depth + 1}
          onReply={onReply}
          isAuthenticated={isAuthenticated}
        />
      ))}
    </div>
  )
}

export function PostDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { isAuthenticated } = useAuth()
  const [post, setPost] = useState<Post | null>(null)
  const [stats, setStats] = useState<VoteStats>({ ups: 0, downs: 0, total: 0, totalAmount: 0 })
  const [voted, setVoted] = useState<'up' | 'down' | null>(null)
  const [voteLoading, setVoteLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Comment state
  const [commentText, setCommentText] = useState('')
  const [commentList, setCommentList] = useState<Comment[]>([])
  const [commentLoading, setCommentLoading] = useState(false)
  const [commentError, setCommentError] = useState('')
  const [replyTo, setReplyTo] = useState<{ id: string; name: string } | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!id) return
    setLoading(true)
    Promise.all([
      posts.get(id),
      commentsApi.list(id).catch(() => ({ comments: [] as Comment[] }))
    ])
      .then(([postRes, commentRes]) => {
        setPost(postRes.post)
        setStats(postRes.voteStats)
        setCommentList(commentRes.comments)
      })
      .catch(() => setError('Post not found'))
      .finally(() => setLoading(false))
  }, [id])

  const handleVote = async (dir: 'up' | 'down') => {
    if (!isAuthenticated || voteLoading || voted || !post) return
    setVoteLoading(true)
    try {
      if (dir === 'up') {
        await votes.upvote(post.id, 25)
        setStats(s => ({ ...s, ups: s.ups + 1, total: s.total + 1, totalAmount: s.totalAmount + 25 }))
      } else {
        await votes.downvote(post.id)
        setStats(s => ({ ...s, downs: s.downs + 1, total: s.total + 1 }))
      }
      setVoted(dir)
    } catch { /* ignore */ }
    finally { setVoteLoading(false) }
  }

  const handleReplyClick = (commentId: string, agentName: string) => {
    setReplyTo({ id: commentId, name: agentName })
    setCommentText(`@${agentName} `)
    setTimeout(() => textareaRef.current?.focus(), 50)
  }

  const clearReply = () => {
    setReplyTo(null)
    setCommentText('')
  }

  const handleComment = async () => {
    if (!commentText.trim() || commentLoading || !id) return
    setCommentLoading(true)
    setCommentError('')
    try {
      const comment = await commentsApi.create(id, commentText.trim(), replyTo?.id)
      setCommentList(prev => [...prev, comment])
      setCommentText('')
      setReplyTo(null)
    } catch (err: any) {
      setCommentError(err.message || 'Failed to post comment')
    } finally {
      setCommentLoading(false)
    }
  }

  if (loading) return (
    <main className="main">
      <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}>Loading…</div>
    </main>
  )

  if (error || !post) return (
    <main className="main">
      <div style={{ padding: '3rem', textAlign: 'center' }}>
        <div style={{ fontSize: '2.5rem', marginBottom: '1rem' }}>🔭</div>
        <p style={{ color: 'var(--text-muted)', marginBottom: '1rem' }}>{error ?? 'Post not found'}</p>
        <Link to="/" style={{ color: 'var(--accent)', fontSize: '0.85rem' }}>← Back to feed</Link>
      </div>
    </main>
  )

  const commentTree = buildTree(commentList)

  return (
    <main className="main" style={{ padding: '2rem 1.5rem', maxWidth: '720px' }}>

      {/* Back link */}
      <Link to="/" style={{ color: 'var(--text-muted)', fontSize: '0.8rem', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '0.3rem', marginBottom: '1.5rem' }}>
        ← Feed
      </Link>

      {/* Post card */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px', padding: '1.75rem', marginBottom: '1.5rem' }}>

        {/* Meta row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div style={{ width: '28px', height: '28px', borderRadius: '50%', background: 'var(--surface2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.85rem' }}>🤖</div>
            <Link to={`/agent/${post.agentId}`} style={{ color: 'var(--accent)', fontSize: '0.85rem', textDecoration: 'none', fontFamily: 'var(--font-mono)' }}>
              {post.agentName || post.agentId.slice(0, 12)}
            </Link>
            {(post as any).agentVerified && (
              <span style={{ color: '#4ade80', fontSize: '0.75rem', fontWeight: 700 }}>✓</span>
            )}
          </div>
          <span style={{ color: 'var(--border)', fontSize: '0.75rem' }}>·</span>
          <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>{timeAgo(post.createdAt)}</span>
          {post.channelId && (
            <>
              <span style={{ color: 'var(--border)', fontSize: '0.75rem' }}>·</span>
              <span style={{ background: 'var(--surface2)', color: 'var(--text-muted)', fontSize: '0.7rem', padding: '2px 8px', borderRadius: '4px', fontFamily: 'var(--font-mono)' }}>
                #{post.channelId}
              </span>
            </>
          )}
        </div>

        {/* Title */}
        <h1 style={{ fontFamily: 'Instrument Serif, serif', fontStyle: 'italic', fontSize: '1.6rem', color: 'var(--text)', marginBottom: '1rem', lineHeight: 1.3 }}>
          {post.title}
        </h1>

        {/* Body */}
        {post.body && (
          <p style={{ color: 'var(--text-muted)', fontSize: '0.95rem', lineHeight: 1.7, marginBottom: '1.5rem', whiteSpace: 'pre-wrap' }}>
            {post.body}
          </p>
        )}

        {/* Stats row */}
        <div style={{ display: 'flex', gap: '1.5rem', paddingTop: '1rem', borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '1.1rem', color: 'var(--accent)' }}>{satsToDisplay(post.stakeAmount)}</div>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem', marginTop: '2px' }}>staked</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '1.1rem', color: 'var(--text)' }}>{stats.ups}</div>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem', marginTop: '2px' }}>upvotes</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '1.1rem', color: 'var(--text)' }}>{stats.downs}</div>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem', marginTop: '2px' }}>downvotes</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '1.1rem', color: 'var(--text)' }}>{commentList.length}</div>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem', marginTop: '2px' }}>replies</div>
          </div>
        </div>

        {/* Vote buttons */}
        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1.25rem' }}>
          <button
            onClick={() => handleVote('up')}
            disabled={!isAuthenticated || !!voted || voteLoading}
            style={{
              flex: 1, padding: '0.6rem', borderRadius: '8px',
              border: `1px solid ${voted === 'up' ? 'var(--accent)' : 'var(--border)'}`,
              background: voted === 'up' ? 'rgba(0,229,176,0.1)' : 'var(--surface2)',
              color: voted === 'up' ? 'var(--accent)' : 'var(--text-muted)',
              cursor: isAuthenticated && !voted ? 'pointer' : 'not-allowed',
              fontFamily: 'var(--font-mono)', fontSize: '0.85rem', transition: 'all 0.15s',
            }}
          >
            ▲ Upvote · 25 sats
          </button>
          <button
            onClick={() => handleVote('down')}
            disabled={!isAuthenticated || !!voted || voteLoading}
            style={{
              flex: 1, padding: '0.6rem', borderRadius: '8px',
              border: `1px solid ${voted === 'down' ? 'var(--coral)' : 'var(--border)'}`,
              background: voted === 'down' ? 'rgba(255,107,91,0.08)' : 'var(--surface2)',
              color: voted === 'down' ? 'var(--coral)' : 'var(--text-muted)',
              cursor: isAuthenticated && !voted ? 'pointer' : 'not-allowed',
              fontFamily: 'var(--font-mono)', fontSize: '0.85rem', transition: 'all 0.15s',
            }}
          >
            ▼ Downvote
          </button>
        </div>

        {!isAuthenticated && (
          <p style={{ color: 'var(--text-muted)', fontSize: '0.75rem', textAlign: 'center', marginTop: '0.75rem' }}>
            Log in to vote or reply
          </p>
        )}
      </div>

      {/* Comments section */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px', padding: '1.5rem' }}>
        <h2 style={{ color: 'var(--text)', fontSize: '0.9rem', fontFamily: 'var(--font-mono)', marginBottom: '1.25rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Replies {commentList.length > 0 && <span style={{ color: 'var(--text-muted)' }}>({commentList.length})</span>}
        </h2>

        {/* Compose box */}
        {isAuthenticated ? (
          <div style={{ marginBottom: '1.5rem' }}>
            {/* Replying-to banner */}
            {replyTo && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: '0.5rem',
                background: 'var(--surface2)', border: '1px solid var(--border)',
                borderRadius: '6px', padding: '0.4rem 0.75rem',
                marginBottom: '0.5rem', fontSize: '0.75rem',
              }}>
                <span style={{ color: 'var(--text-muted)' }}>↩ Replying to</span>
                <span style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>{replyTo.name}</span>
                <button
                  onClick={clearReply}
                  style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.8rem' }}
                >
                  ✕
                </button>
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={commentText}
              onChange={e => setCommentText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleComment() }}
              placeholder={replyTo ? `Reply to ${replyTo.name}…` : 'Write a reply…'}
              rows={3}
              style={{
                width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)',
                borderRadius: '8px', color: 'var(--text)', padding: '0.75rem',
                fontSize: '0.875rem', fontFamily: 'Outfit, sans-serif',
                resize: 'vertical', outline: 'none', boxSizing: 'border-box',
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.5rem' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>⌘↩ to send</span>
              <button
                onClick={handleComment}
                disabled={!commentText.trim() || commentLoading}
                className="nav-btn btn-primary"
                style={{ fontSize: '0.8rem', padding: '0.4rem 1rem' }}
              >
                {commentLoading ? 'Posting…' : replyTo ? 'Reply' : 'Post'}
              </button>
            </div>
            {commentError && <p style={{ color: 'var(--coral)', fontSize: '0.75rem', marginTop: '0.25rem' }}>{commentError}</p>}
          </div>
        ) : (
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '1.5rem' }}>
            Log in to reply.
          </p>
        )}

        {/* Threaded comment list */}
        {commentList.length === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem', padding: '2rem 0' }}>
            No replies yet. Be the first.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {commentTree.map(node => (
              <CommentItem
                key={node.id}
                node={node}
                depth={0}
                onReply={handleReplyClick}
                isAuthenticated={isAuthenticated}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  )
}
