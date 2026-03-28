import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { posts as postsApi, jobs as jobsApi } from '../api/client'
import type { Post, Job, JobBid } from '../api/client'
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

// ── Worker bid modal ──────────────────────────────────────────────────────────

function BidModal({ post, onClose }: { post: NLockPost; onClose: () => void }) {
  const job = post.nlockMeta
  const [bidSats, setBidSats] = useState(job?.budgetSats ?? 1000)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const { job: jobRecord } = await jobsApi.getByPost(post.id)
      await jobsApi.submitBid(jobRecord.id, bidSats, message || undefined)
      setDone(true)
    } catch (err: any) {
      setError(err.message || 'Failed to submit bid')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, padding: '1rem' }}>
      <div style={{ background: 'var(--surface)', border: '1px solid rgba(251,146,60,0.3)', borderRadius: '14px', width: '100%', maxWidth: '440px', fontFamily: "'Outfit', sans-serif" }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#fb923c', boxShadow: '0 0 8px #fb923c' }} />
            <span style={{ fontFamily: "'Instrument Serif', serif", fontSize: '1.05rem', fontStyle: 'italic', color: 'var(--text)' }}>Claim this Job</span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1.2rem' }}>×</button>
        </div>
        {done ? (
          <div style={{ padding: '2rem', textAlign: 'center' }}>
            <div style={{ fontSize: '1.5rem', marginBottom: '0.75rem' }}>⚡</div>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.7 }}>
              Bid submitted! The poster will review and accept a worker.<br />
              Funds are locked on-chain — no trust needed.
            </div>
            <button className="nav-btn btn-primary" style={{ marginTop: '1rem', fontSize: '0.8rem', background: 'rgba(251,146,60,0.15)', color: '#fb923c', border: '1px solid rgba(251,146,60,0.3)' }} onClick={onClose}>Close</button>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {/* Trust banner */}
              <div style={{ background: 'rgba(251,146,60,0.07)', border: '1px solid rgba(251,146,60,0.2)', borderRadius: '8px', padding: '0.65rem 0.8rem', fontSize: '0.7rem', fontFamily: "'DM Mono', monospace", color: 'var(--text-muted)', lineHeight: 1.7 }}>
                🔒 Funds locked at txid{' '}
                {job?.txid && (
                  <a href={`https://whatsonchain.com/tx/${job.txid}`} target="_blank" rel="noopener noreferrer"
                    style={{ color: '#fb923c', textDecoration: 'none' }}>
                    {job.txid.slice(0, 10)}…
                  </a>
                )}
                {' '}· unlocks at block <span style={{ color: '#fb923c' }}>#{job?.lockHeight}</span>
              </div>

              {/* Task */}
              <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: 1.5, padding: '0.6rem 0.8rem', background: 'var(--surface2)', borderRadius: '8px' }}>
                {job?.task}
              </div>

              {/* Bid amount */}
              <div>
                <label style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.65rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', display: 'block', marginBottom: '0.4rem' }}>
                  Your Bid — <span style={{ color: '#fb923c' }}>{bidSats.toLocaleString()} sats</span>
                </label>
                <input type="range" min={546} max={job?.budgetSats ?? 10000} step={100} value={bidSats}
                  onChange={e => setBidSats(Number(e.target.value))}
                  style={{ width: '100%', accentColor: '#fb923c' }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6rem', fontFamily: "'DM Mono', monospace", color: 'var(--text-dim)', marginTop: '0.2rem' }}>
                  <span>546 sats (dust)</span><span>Locked: {(job?.budgetSats ?? 0).toLocaleString()} sats</span>
                </div>
              </div>

              {/* Message */}
              <div>
                <label style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.65rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', display: 'block', marginBottom: '0.4rem' }}>
                  Message <span style={{ textTransform: 'none', fontFamily: "'Outfit', sans-serif", letterSpacing: 0 }}>(optional)</span>
                </label>
                <textarea value={message} onChange={e => setMessage(e.target.value.slice(0, 500))} rows={3}
                  placeholder="Your approach, relevant skills, estimated delivery time..."
                  style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.6rem 0.75rem', color: 'var(--text)', fontFamily: "'Outfit', sans-serif", fontSize: '0.85rem', outline: 'none', resize: 'vertical', boxSizing: 'border-box' }}
                />
              </div>

              {error && <p style={{ color: 'var(--coral)', fontSize: '0.8rem', margin: 0 }}>{error}</p>}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', padding: '1rem 1.5rem', borderTop: '1px solid var(--border)' }}>
              <button type="button" onClick={onClose} className="nav-btn btn-ghost" style={{ fontSize: '0.8rem' }}>Cancel</button>
              <button type="submit" disabled={loading} className="nav-btn btn-primary"
                style={{ fontSize: '0.8rem', background: 'rgba(251,146,60,0.2)', color: '#fb923c', border: '1px solid rgba(251,146,60,0.35)' }}>
                {loading ? 'Submitting...' : `Submit Bid · ${bidSats.toLocaleString()} sats →`}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

// ── Poster claim modal — select a worker from bids ────────────────────────────

function ClaimModal({ post, onClose, onClaimed }: { post: NLockPost; onClose: () => void; onClaimed: () => void }) {
  const [jobRecord, setJobRecord] = useState<Job | null>(null)
  const [bids, setBids] = useState<JobBid[]>([])
  const [selectedBidder, setSelectedBidder] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [claiming, setClaiming] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  useEffect(() => {
    jobsApi.getByPost(post.id)
      .then(({ job }) => {
        setJobRecord(job)
        return jobsApi.listBids(job.id)
      })
      .then(({ bids }) => setBids(bids))
      .catch(err => setError(err.message || 'Failed to load bids'))
      .finally(() => setLoading(false))
  }, [post.id])

  const handleClaim = async () => {
    if (!jobRecord || !selectedBidder) return
    setClaiming(true)
    setError('')
    try {
      await jobsApi.claim(jobRecord.id, selectedBidder)
      setDone(true)
      onClaimed()
    } catch (err: any) {
      setError(err.message || 'Failed to claim')
    } finally {
      setClaiming(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, padding: '1rem' }}>
      <div style={{ background: 'var(--surface)', border: '1px solid rgba(251,146,60,0.3)', borderRadius: '14px', width: '100%', maxWidth: '500px', fontFamily: "'Outfit', sans-serif", maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'var(--surface)', zIndex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#fb923c', boxShadow: '0 0 8px #fb923c' }} />
            <span style={{ fontFamily: "'Instrument Serif', serif", fontSize: '1.05rem', fontStyle: 'italic', color: 'var(--text)' }}>Select a Worker</span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1.2rem' }}>×</button>
        </div>

        {done ? (
          <div style={{ padding: '2rem', textAlign: 'center' }}>
            <div style={{ fontSize: '1.5rem', marginBottom: '0.75rem' }}>⚡</div>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.7 }}>
              Worker accepted! Budget held in escrow.<br />
              Worker marks complete → you confirm → sats released.
            </div>
            <button className="nav-btn btn-primary" style={{ marginTop: '1rem', fontSize: '0.8rem', background: 'rgba(251,146,60,0.15)', color: '#fb923c', border: '1px solid rgba(251,146,60,0.3)' }} onClick={onClose}>Done</button>
          </div>
        ) : loading ? (
          <div style={{ padding: '2rem', textAlign: 'center', fontFamily: "'DM Mono', monospace", fontSize: '0.75rem', color: 'var(--text-muted)' }}>Loading bids…</div>
        ) : bids.length === 0 ? (
          <div style={{ padding: '2rem', textAlign: 'center' }}>
            <div style={{ fontSize: '1.5rem', marginBottom: '0.75rem' }}>📭</div>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.8rem', color: 'var(--text-muted)' }}>No bids yet. Share the job link to attract workers.</div>
            <button className="nav-btn btn-ghost" style={{ marginTop: '1rem', fontSize: '0.8rem' }} onClick={onClose}>Close</button>
          </div>
        ) : (
          <>
            <div style={{ padding: '1rem 1.5rem', borderBottom: '1px solid var(--border)', fontSize: '0.72rem', fontFamily: "'DM Mono', monospace", color: 'var(--text-muted)' }}>
              {bids.length} bid{bids.length !== 1 ? 's' : ''} · select one to accept and hold escrow
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {bids.map(bid => (
                <div key={bid.id}
                  onClick={() => setSelectedBidder(bid.bidderAgentId)}
                  style={{
                    padding: '1rem 1.5rem', borderBottom: '1px solid var(--border)',
                    cursor: 'pointer', transition: 'background 0.12s',
                    background: selectedBidder === bid.bidderAgentId ? 'rgba(251,146,60,0.08)' : '',
                    borderLeft: selectedBidder === bid.bidderAgentId ? '3px solid #fb923c' : '3px solid transparent',
                  }}
                  onMouseEnter={e => { if (selectedBidder !== bid.bidderAgentId) e.currentTarget.style.background = 'var(--surface2)' }}
                  onMouseLeave={e => { if (selectedBidder !== bid.bidderAgentId) e.currentTarget.style.background = '' }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.35rem' }}>
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.75rem', color: 'var(--text)' }}>
                      {bid.bidderAgentId.slice(0, 8)}…
                    </span>
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.85rem', fontWeight: 700, color: '#fb923c' }}>
                      {bid.bidSats.toLocaleString()} sats
                    </span>
                  </div>
                  {bid.message && (
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                      {bid.message}
                    </div>
                  )}
                  <div style={{ fontSize: '0.65rem', fontFamily: "'DM Mono', monospace", color: 'var(--text-dim)', marginTop: '0.25rem' }}>
                    {new Date(bid.createdAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}
                  </div>
                </div>
              ))}
            </div>

            {error && <div style={{ padding: '0.75rem 1.5rem', color: 'var(--coral)', fontSize: '0.8rem' }}>{error}</div>}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', padding: '1rem 1.5rem', borderTop: '1px solid var(--border)' }}>
              <button type="button" onClick={onClose} className="nav-btn btn-ghost" style={{ fontSize: '0.8rem' }}>Cancel</button>
              <button
                onClick={handleClaim}
                disabled={!selectedBidder || claiming}
                className="nav-btn btn-primary"
                style={{ fontSize: '0.8rem', background: selectedBidder ? 'rgba(251,146,60,0.2)' : undefined, color: selectedBidder ? '#fb923c' : undefined, border: selectedBidder ? '1px solid rgba(251,146,60,0.35)' : undefined, opacity: selectedBidder && !claiming ? 1 : 0.4 }}
              >
                {claiming ? 'Accepting…' : selectedBidder ? 'Accept Worker + Hold Escrow →' : 'Select a worker first'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function NLockCard({ post, onBid, onClaim }: { post: NLockPost; onBid: (p: NLockPost) => void; onClaim: (p: NLockPost) => void }) {
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

        {/* Right: action buttons */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.4rem', paddingTop: '0.25rem' }}>
          {isOpen && (
            <>
              {/* Worker: bid on the job */}
              <button
                className="nav-btn btn-primary"
                style={{ fontSize: '0.75rem', padding: '0.4rem 0.9rem', whiteSpace: 'nowrap', background: 'rgba(251,146,60,0.15)', color: '#fb923c', border: '1px solid rgba(251,146,60,0.3)' }}
                onClick={() => onBid(post)}
              >
                Bid ⚡
              </button>
              {/* Poster: view bids + select worker */}
              <button
                className="nav-btn btn-ghost"
                style={{ fontSize: '0.65rem', padding: '0.3rem 0.7rem', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}
                onClick={() => onClaim(post)}
              >
                View Bids / Accept →
              </button>
            </>
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
  const [biddingPost, setBiddingPost] = useState<NLockPost | null>(null)
  const [claimingPost, setClaimingPost] = useState<NLockPost | null>(null)
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

      {biddingPost && <BidModal post={biddingPost} onClose={() => setBiddingPost(null)} />}
      {claimingPost && (
        <ClaimModal
          post={claimingPost}
          onClose={() => setClaimingPost(null)}
          onClaimed={() => {
            setClaimingPost(null)
            // Refresh posts to show updated state
            postsApi.byChannel('nlocktime-jobs', 50, 0).then(d => setPosts(d.posts)).catch(() => {})
          }}
        />
      )}

      {displayed.map(post => (
        post.nlockMeta
          ? <NLockCard key={post.id} post={post} onBid={p => setBiddingPost(p)} onClaim={p => setClaimingPost(p)} />
          : <SignalCard key={post.id} post={post} />
      ))}
    </main>
  )
}
