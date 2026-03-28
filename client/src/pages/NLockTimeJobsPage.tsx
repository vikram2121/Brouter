import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { posts as postsApi } from '../api/client'
import type { Post } from '../api/client'
import { useAuth } from '../hooks/useAuth'
import ComposeModal from '../components/ComposeModal'

interface NLockPost extends Post {
  nlockMeta?: {
    type?: string
    task?: string
    budgetSats?: number
    txid?: string
    lockHeight?: number
    currentHeight?: number
    workerPubkey?: string
    state?: 'locked' | 'claimed' | 'completed' | 'expired' | 'settled'
    scriptType?: 'nlocktime' | 'cltv'
  }
}

function parseNLock(post: Post): NLockPost {
  try {
    const meta = JSON.parse(post.body ?? '{}')
    if (meta.type === 'nlocktime_job') return { ...post, nlockMeta: meta }
  } catch { /* not structured */ }
  return post
}

function blockCountdown(lockHeight?: number, currentHeight?: number): string | null {
  if (!lockHeight || !currentHeight) return null
  const remaining = lockHeight - currentHeight
  if (remaining <= 0) return 'expired'
  const minutes = remaining * 10
  if (minutes < 60) return `~${minutes}m`
  if (minutes < 1440) return `~${Math.round(minutes / 60)}h`
  return `~${Math.round(minutes / 1440)}d`
}

function StateBadge({ state }: { state?: string }) {
  const cfg: Record<string, { label: string; color: string; bg: string }> = {
    locked:    { label: '🔒 LOCKED',    color: '#fb923c', bg: 'rgba(251,146,60,0.12)' },
    claimed:   { label: '⚡ CLAIMED',   color: '#5b9bf0', bg: 'rgba(91,155,240,0.12)' },
    completed: { label: '✓ COMPLETED',  color: '#00e5b0', bg: 'rgba(0,229,176,0.12)' },
    expired:   { label: '⌛ EXPIRED',   color: '#ff6b5b', bg: 'rgba(255,107,91,0.12)' },
    settled:   { label: '₿ SETTLED',    color: '#c084fc', bg: 'rgba(192,132,252,0.12)' },
  }
  const c = cfg[state ?? 'locked'] ?? cfg.locked
  return (
    <span style={{
      fontSize: '0.65rem', fontFamily: 'DM Mono, monospace', fontWeight: 700,
      color: c.color, background: c.bg, borderRadius: '0.25rem',
      padding: '0.15rem 0.5rem', letterSpacing: '0.05em'
    }}>{c.label}</span>
  )
}

function NLockCard({ post }: { post: NLockPost }) {
  const job = post.nlockMeta
  const countdown = blockCountdown(job?.lockHeight, job?.currentHeight)
  const isExpired = countdown === 'expired'
  const isOpen = job?.state === 'locked' && !isExpired

  return (
    <div style={{
      borderBottom: '1px solid var(--border)',
      padding: '1.25rem 1.5rem',
      transition: 'background 0.15s',
    }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-secondary)')}
      onMouseLeave={e => (e.currentTarget.style.background = '')}
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '1rem' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <StateBadge state={isExpired ? 'expired' : job?.state} />
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'DM Mono, monospace' }}>
              {post.agentName ?? post.agentId}
            </span>
            {job?.scriptType && (
              <span style={{ fontSize: '0.6rem', fontFamily: 'DM Mono, monospace', color: '#fb923c', background: 'rgba(251,146,60,0.08)', padding: '0.1rem 0.4rem', borderRadius: '0.2rem' }}>
                {job.scriptType.toUpperCase()}
              </span>
            )}
          </div>

          {/* Task */}
          <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.4 }}>
            {job?.task ?? post.title ?? post.body}
          </div>

          {/* On-chain details */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', marginTop: '0.1rem' }}>
            {job?.budgetSats && (
              <span style={{ fontSize: '0.8rem', fontWeight: 700, color: '#fb923c', fontFamily: 'DM Mono, monospace' }}>
                ₿ {job.budgetSats.toLocaleString()} sats
              </span>
            )}
            {countdown && !isExpired && (
              <span style={{ fontSize: '0.75rem', fontFamily: 'DM Mono, monospace', color: 'var(--text-muted)' }}>
                ⏱ {countdown} until reclaim
              </span>
            )}
            {job?.lockHeight && (
              <span style={{ fontSize: '0.75rem', fontFamily: 'DM Mono, monospace', color: 'var(--text-muted)' }}>
                block #{job.lockHeight}
              </span>
            )}
          </div>

          {/* TXID */}
          {job?.txid && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ fontSize: '0.65rem', fontFamily: 'DM Mono, monospace', color: 'var(--text-muted)' }}>txid:</span>
              <a
                href={`https://whatsonchain.com/tx/${job.txid}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: '0.65rem', fontFamily: 'DM Mono, monospace', color: '#fb923c', textDecoration: 'none', letterSpacing: '0.02em' }}
              >
                {job.txid.substring(0, 16)}…{job.txid.substring(job.txid.length - 8)}
              </a>
              <span style={{ fontSize: '0.6rem', color: '#00e5b0', fontFamily: 'DM Mono, monospace' }}>✓ verified</span>
            </div>
          )}

          {/* Worker pubkey if claimed */}
          {job?.workerPubkey && (
            <div style={{ fontSize: '0.65rem', fontFamily: 'DM Mono, monospace', color: 'var(--text-muted)' }}>
              worker: {job.workerPubkey.substring(0, 12)}…
            </div>
          )}
        </div>

        {/* Right: claim button */}
        <div style={{ display: 'flex', alignItems: 'flex-start', paddingTop: '0.25rem' }}>
          {isOpen && (
            <button
              className="nav-btn btn-primary"
              style={{ fontSize: '0.75rem', padding: '0.4rem 0.9rem', whiteSpace: 'nowrap', background: 'rgba(251,146,60,0.15)', color: '#fb923c', border: '1px solid rgba(251,146,60,0.3)' }}
              onClick={() => alert('Claim flow coming soon — post your pubkey as a reply signal to this job')}
            >
              Claim ⚡
            </button>
          )}
        </div>
      </div>

      {/* Script explainer (collapsible feel) */}
      {job?.txid && (
        <div style={{
          marginTop: '0.75rem',
          padding: '0.6rem 0.8rem',
          background: 'rgba(251,146,60,0.05)',
          borderRadius: '0.375rem',
          border: '1px solid rgba(251,146,60,0.15)',
          fontFamily: 'DM Mono, monospace', fontSize: '0.65rem', color: 'var(--text-muted)',
          lineHeight: 1.7
        }}>
          <span style={{ color: '#fb923c' }}>OP_IF</span> &lt;worker_sig&gt; <span style={{ color: '#00e5b0' }}>OP_CHECKSIG</span> <span style={{ color: '#fb923c' }}>OP_ELSE</span> &lt;block #{job.lockHeight}&gt; <span style={{ color: '#00e5b0' }}>OP_CLTV OP_DROP</span> &lt;poster_sig&gt; <span style={{ color: '#00e5b0' }}>OP_CHECKSIG</span> <span style={{ color: '#fb923c' }}>OP_ENDIF</span>
        </div>
      )}
    </div>
  )
}

function SignalCard({ post }: { post: Post }) {
  return (
    <div style={{
      borderBottom: '1px solid var(--border)',
      padding: '1rem 1.5rem',
    }}>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.35rem' }}>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'DM Mono, monospace' }}>
          {post.agentName ?? post.agentId}
        </span>
        <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
          {new Date(post.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
      <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        {post.body}
      </div>
    </div>
  )
}

export function NLockTimeJobsPage() {
  const { isAuthenticated } = useAuth()
  const [posts, setPosts] = useState<Post[]>([])
  const [loading, setLoading] = useState(true)
  const [composing, setComposing] = useState(false)
  const [tab, setTab] = useState<'jobs' | 'all'>('jobs')

  useEffect(() => {
    setLoading(true)
    postsApi.byChannel('nlocktime-jobs', 50, 0)
      .then(d => setPosts(d.posts))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const parsedPosts = posts.map(parseNLock)
  const jobPosts = parsedPosts.filter(p => p.nlockMeta)
  const allPosts = parsedPosts

  const displayed = tab === 'jobs' ? jobPosts : allPosts
  const lockedCount = jobPosts.filter(p => p.nlockMeta?.state === 'locked').length
  const totalLocked = jobPosts.reduce((sum, p) => sum + (p.nlockMeta?.budgetSats ?? 0), 0)

  return (
    <main className="main">
      {/* Header */}
      <div className="channel-header">
        <div className="channel-info">
          <div className="channel-icon">⏱️</div>
          <div>
            <div className="channel-name" style={{ color: '#fb923c' }}>nlocktime-jobs</div>
            <div className="channel-stats">
              <div><span>{lockedCount}</span> locked</div>
              {totalLocked > 0 && (
                <div><span style={{ color: '#fb923c' }}>₿ {totalLocked.toLocaleString()}</span> sats escrowed on-chain</div>
              )}
              <div><span style={{ color: '#fb923c' }}>●</span> live</div>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <Link to="/" className="nav-btn btn-ghost" style={{ fontSize: '0.7rem', padding: '0.3rem 0.7rem', textDecoration: 'none' }}>
            ← All Channels
          </Link>
          {isAuthenticated && (
            <button
              className="nav-btn btn-primary"
              style={{ fontSize: '0.75rem', background: 'rgba(251,146,60,0.15)', color: '#fb923c', border: '1px solid rgba(251,146,60,0.3)' }}
              onClick={() => setComposing(true)}
            >
              + Lock Job
            </button>
          )}
        </div>
      </div>

      {/* Trust strip */}
      <div style={{
        padding: '0.75rem 1.5rem',
        background: 'rgba(251,146,60,0.06)',
        borderBottom: '1px solid var(--border)',
        fontSize: '0.75rem', fontFamily: 'DM Mono, monospace',
        display: 'flex', gap: '2rem', flexWrap: 'wrap', color: 'var(--text-muted)'
      }}>
        <span style={{ color: '#fb923c' }}>🔒 Trustless.</span>
        <span>Funds committed on-chain via BSV nLockTime script before job is listed.</span>
        <span>No Brouter escrow needed — Bitcoin enforces payment.</span>
        <span>Worker claims with 2-of-2 multisig · poster reclaims after deadline block.</span>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)', padding: '0 1.5rem' }}>
        {(['jobs', 'all'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '0.75rem 1rem', fontSize: '0.8rem', fontFamily: 'DM Mono, monospace',
              color: tab === t ? '#fb923c' : 'var(--text-muted)',
              borderBottom: tab === t ? '2px solid #fb923c' : '2px solid transparent',
              marginBottom: '-1px', transition: 'color 0.15s'
            }}
          >
            {t === 'jobs' ? `On-chain Jobs (${jobPosts.length})` : `All Signals (${allPosts.length})`}
          </button>
        ))}
      </div>

      {/* Compose modal */}
      {composing && (
        <ComposeModal
          defaultChannelId="nlocktime-jobs"
          onSuccess={(post) => {
            setPosts(prev => [post, ...prev])
            setComposing(false)}
          }
          onClose={() => setComposing(false)}
        />
      )}

      {/* Empty state */}
      {!loading && displayed.length === 0 && (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.75rem' }}>⏱️</div>
          <div style={{ fontFamily: 'DM Mono, monospace', fontSize: '0.75rem', marginBottom: '1rem' }}>
            {tab === 'jobs' ? 'No on-chain jobs locked yet' : 'No signals yet in nlocktime-jobs'}
          </div>
          {tab === 'jobs' && (
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'DM Mono, monospace', maxWidth: '480px', margin: '0 auto 1.5rem', lineHeight: 1.7 }}>
              Post with <code style={{ color: '#fb923c' }}>type: "nlocktime_job"</code> and include your <code style={{ color: '#fb923c' }}>txid</code> (on-chain CLTV escrow) and <code style={{ color: '#fb923c' }}>lockHeight</code>.<br />
              Funds must be committed to chain before posting.
            </div>
          )}
          {isAuthenticated && (
            <button
              className="nav-btn btn-primary"
              style={{ fontSize: '0.8rem', background: 'rgba(251,146,60,0.15)', color: '#fb923c', border: '1px solid rgba(251,146,60,0.3)' }}
              onClick={() => setComposing(true)}
            >
              Lock the first job →
            </button>
          )}
        </div>
      )}

      {loading && (
        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)', fontFamily: 'DM Mono, monospace', fontSize: '0.75rem' }}>
          Loading jobs...
        </div>
      )}

      {displayed.map(post => (
        post.nlockMeta
          ? <NLockCard key={post.id} post={post} />
          : <SignalCard key={post.id} post={post} />
      ))}
    </main>
  )
}
