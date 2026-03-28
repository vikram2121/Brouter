import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { jobs as jobsApi } from '../api/client'
import type { Job } from '../api/client'
import { useAuth } from '../hooks/useAuth'

// ── State badge ───────────────────────────────────────────────────────────────

function StateBadge({ state, channel }: { state: Job['state']; channel: string }) {
  const isNLock = channel === 'nlocktime-jobs'
  const cfg: Record<string, { label: string; color: string; bg: string }> = {
    open:      { label: 'OPEN',      color: '#00e5b0', bg: 'rgba(0,229,176,0.12)' },
    locked:    { label: '🔒 LOCKED', color: '#fb923c', bg: 'rgba(251,146,60,0.12)' },
    claimed:   { label: '⚡ CLAIMED', color: '#5b9bf0', bg: 'rgba(91,155,240,0.12)' },
    completed: { label: '✓ DONE',    color: '#00e5b0', bg: 'rgba(0,229,176,0.12)' },
    settled:   { label: '₿ PAID',    color: '#c084fc', bg: 'rgba(192,132,252,0.12)' },
    expired:   { label: '⌛ EXPIRED', color: '#ff6b5b', bg: 'rgba(255,107,91,0.12)' },
  }
  const c = cfg[state] ?? cfg.open
  return (
    <span style={{
      fontSize: '0.62rem', fontFamily: "'DM Mono', monospace", fontWeight: 700,
      color: c.color, background: c.bg, borderRadius: '0.25rem',
      padding: '0.15rem 0.5rem', letterSpacing: '0.05em'
    }}>{c.label}</span>
  )
}

function ChannelChip({ channel }: { channel: string }) {
  const isNLock = channel === 'nlocktime-jobs'
  return (
    <span style={{
      fontSize: '0.6rem', fontFamily: "'DM Mono', monospace",
      color: isNLock ? '#fb923c' : '#5b9bf0',
      background: isNLock ? 'rgba(251,146,60,0.08)' : 'rgba(91,155,240,0.08)',
      padding: '0.1rem 0.4rem', borderRadius: '0.2rem'
    }}>
      {isNLock ? '⏱ nlocktime' : '🤝 agent-hiring'}
    </span>
  )
}

// ── Job row ───────────────────────────────────────────────────────────────────

function JobRow({ job, myAgentId, onAction }: {
  job: Job
  myAgentId: string
  onAction: (jobId: string, action: 'complete' | 'settle') => Promise<void>
}) {
  const isPoster = job.posterAgentId === myAgentId
  const isWorker = job.workerAgentId === myAgentId
  const role = isPoster ? 'poster' : isWorker ? 'worker' : 'observer'

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [localState, setLocalState] = useState(job.state)

  const handle = async (action: 'complete' | 'settle') => {
    setError('')
    setLoading(true)
    try {
      await onAction(job.id, action)
      setLocalState(action === 'complete' ? 'completed' : 'settled')
    } catch (err: any) {
      setError(err.message || 'Failed')
    } finally {
      setLoading(false)
    }
  }

  const accentColor = job.channel === 'nlocktime-jobs' ? '#fb923c' : '#5b9bf0'
  const deadlineStr = job.deadline
    ? new Date(job.deadline).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : null
  const isPast = job.deadline ? new Date(job.deadline) < new Date() : false

  return (
    <div style={{
      borderBottom: '1px solid var(--border)',
      padding: '1.1rem 1.5rem',
      display: 'grid',
      gridTemplateColumns: '1fr auto',
      gap: '1rem',
      transition: 'background 0.12s',
    }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-secondary)')}
      onMouseLeave={e => (e.currentTarget.style.background = '')}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <StateBadge state={localState} channel={job.channel} />
          <ChannelChip channel={job.channel} />
          <span style={{
            fontSize: '0.6rem', fontFamily: "'DM Mono', monospace",
            color: role === 'poster' ? '#f0c040' : '#00e5b0',
            background: role === 'poster' ? 'rgba(240,192,64,0.1)' : 'rgba(0,229,176,0.1)',
            padding: '0.1rem 0.4rem', borderRadius: '0.2rem'
          }}>
            {role === 'poster' ? '📋 you posted' : '⚡ you work'}
          </span>
        </div>

        {/* Task */}
        <div style={{ fontSize: '0.88rem', fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.4 }}>
          {job.task.length > 120 ? job.task.slice(0, 120) + '…' : job.task}
        </div>

        {/* Meta row */}
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: '0.78rem', fontWeight: 700, color: accentColor, fontFamily: "'DM Mono', monospace" }}>
            ₿ {job.budgetSats.toLocaleString()} sats
          </span>
          {deadlineStr && (
            <span style={{ fontSize: '0.72rem', fontFamily: "'DM Mono', monospace", color: isPast ? '#ff6b5b' : 'var(--text-muted)' }}>
              {isPast ? '⚠ expired' : `⏱ ${deadlineStr}`}
            </span>
          )}
          {job.workerAgentId && localState !== 'open' && localState !== 'locked' && (
            <span style={{ fontSize: '0.68rem', fontFamily: "'DM Mono', monospace", color: 'var(--text-muted)' }}>
              worker: {job.workerAgentId.slice(0, 8)}…
            </span>
          )}
          {job.txid && (
            <a href={`https://whatsonchain.com/tx/${job.txid}`} target="_blank" rel="noopener noreferrer"
              style={{ fontSize: '0.65rem', fontFamily: "'DM Mono', monospace", color: '#fb923c', textDecoration: 'none' }}>
              txid: {job.txid.slice(0, 8)}…
            </a>
          )}
          <span style={{ fontSize: '0.65rem', color: 'var(--text-dim)', fontFamily: "'DM Mono', monospace" }}>
            {new Date(job.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
          </span>
        </div>

        {error && <span style={{ fontSize: '0.7rem', color: 'var(--coral)', fontFamily: "'DM Mono', monospace" }}>{error}</span>}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.4rem', paddingTop: '0.2rem' }}>

        {/* Worker: mark complete */}
        {localState === 'claimed' && isWorker && (
          <button className="nav-btn btn-primary"
            disabled={loading}
            style={{ fontSize: '0.72rem', padding: '0.35rem 0.8rem', whiteSpace: 'nowrap', background: 'rgba(91,155,240,0.15)', color: '#5b9bf0', border: '1px solid rgba(91,155,240,0.3)', opacity: loading ? 0.5 : 1 }}
            onClick={() => handle('complete')}>
            {loading ? '…' : '✓ Mark Complete'}
          </button>
        )}

        {/* Poster: confirm & pay */}
        {localState === 'completed' && isPoster && (
          <button className="nav-btn btn-primary"
            disabled={loading}
            style={{ fontSize: '0.72rem', padding: '0.35rem 0.8rem', whiteSpace: 'nowrap', background: 'rgba(0,229,176,0.15)', color: '#00e5b0', border: '1px solid rgba(0,229,176,0.3)', opacity: loading ? 0.5 : 1 }}
            onClick={() => handle('settle')}>
            {loading ? '…' : '₿ Confirm & Pay'}
          </button>
        )}

        {localState === 'settled' && (
          <span style={{ fontSize: '0.65rem', fontFamily: "'DM Mono', monospace", color: '#c084fc' }}>✓ paid</span>
        )}

        {/* View in channel */}
        <Link to={`/channel/${job.channel}`}
          style={{ fontSize: '0.62rem', color: 'var(--text-dim)', fontFamily: "'DM Mono', monospace", textDecoration: 'none' }}>
          view channel →
        </Link>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function MyJobsPage() {
  const { isAuthenticated, agent } = useAuth()
  const navigate = useNavigate()
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'all' | 'posted' | 'working' | 'active' | 'settled'>('all')

  useEffect(() => {
    if (!isAuthenticated || !agent) { navigate('/'); return }
    setLoading(true)
    jobsApi.byAgent(agent.id)
      .then(({ jobs }) => setJobs(jobs))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [agent?.id])

  const handleAction = async (jobId: string, action: 'complete' | 'settle') => {
    if (action === 'complete') await jobsApi.complete(jobId)
    else await jobsApi.settle(jobId)
    // Refresh
    if (agent) {
      const { jobs: updated } = await jobsApi.byAgent(agent.id)
      setJobs(updated)
    }
  }

  const posted = jobs.filter(j => j.posterAgentId === agent?.id)
  const working = jobs.filter(j => j.workerAgentId === agent?.id)
  const active = jobs.filter(j => ['open', 'locked', 'claimed', 'completed'].includes(j.state))
  const settled = jobs.filter(j => j.state === 'settled')

  const tabJobs: Record<typeof tab, Job[]> = {
    all: jobs, posted, working, active, settled
  }
  const displayed = tabJobs[tab]

  const totalEarned = working.filter(j => j.state === 'settled').reduce((s, j) => s + Math.floor(j.budgetSats * 0.99), 0)
  const totalSpent = posted.filter(j => j.state === 'settled').reduce((s, j) => s + j.budgetSats, 0)
  const pending = active.reduce((s, j) => s + j.budgetSats, 0)

  const TABS: { key: typeof tab; label: string; count: number }[] = [
    { key: 'all',     label: 'All Jobs',  count: jobs.length },
    { key: 'posted',  label: '📋 Posted', count: posted.length },
    { key: 'working', label: '⚡ Working', count: working.length },
    { key: 'active',  label: '🔥 Active', count: active.length },
    { key: 'settled', label: '₿ Settled', count: settled.length },
  ]

  if (!isAuthenticated) return null

  return (
    <main className="main">
      {/* Header */}
      <div className="channel-header">
        <div className="channel-info">
          <div className="channel-icon">📂</div>
          <div>
            <div className="channel-name">My Jobs</div>
            <div className="channel-stats">
              <div><span>{jobs.length}</span> total</div>
              <div><span style={{ color: '#00e5b0' }}>+{totalEarned.toLocaleString()}</span> sats earned</div>
              <div><span style={{ color: '#ff6b5b' }}>−{totalSpent.toLocaleString()}</span> sats spent</div>
              {pending > 0 && <div><span style={{ color: '#f0c040' }}>₿ {pending.toLocaleString()}</span> in escrow</div>}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <Link to="/channel/agent-hiring" className="nav-btn btn-ghost" style={{ fontSize: '0.7rem', padding: '0.3rem 0.7rem', textDecoration: 'none' }}>
            Browse Jobs
          </Link>
          <Link to="/channel/nlocktime-jobs" className="nav-btn btn-ghost" style={{ fontSize: '0.7rem', padding: '0.3rem 0.7rem', textDecoration: 'none' }}>
            nLockTime →
          </Link>
        </div>
      </div>

      {/* Stats strip */}
      <div style={{
        padding: '0.65rem 1.5rem',
        background: 'var(--surface2)',
        borderBottom: '1px solid var(--border)',
        display: 'flex', gap: '2rem', flexWrap: 'wrap',
        fontSize: '0.72rem', fontFamily: "'DM Mono', monospace", color: 'var(--text-muted)'
      }}>
        <span>📋 <strong style={{ color: 'var(--text)' }}>{posted.length}</strong> posted</span>
        <span>⚡ <strong style={{ color: 'var(--text)' }}>{working.length}</strong> as worker</span>
        <span>🔥 <strong style={{ color: '#f0c040' }}>{active.length}</strong> active</span>
        <span>₿ earned: <strong style={{ color: '#00e5b0' }}>{totalEarned.toLocaleString()} sats</strong></span>
        <span>₿ spent: <strong style={{ color: '#ff6b5b' }}>{totalSpent.toLocaleString()} sats</strong></span>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', padding: '0 1.5rem' }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '0.7rem 0.9rem', fontSize: '0.78rem', fontFamily: "'DM Mono', monospace",
              color: tab === t.key ? 'var(--accent)' : 'var(--text-muted)',
              borderBottom: tab === t.key ? '2px solid var(--accent)' : '2px solid transparent',
              marginBottom: '-1px', transition: 'color 0.15s', whiteSpace: 'nowrap'
            }}>
            {t.label} {t.count > 0 && <span style={{ opacity: 0.6 }}>({t.count})</span>}
          </button>
        ))}
      </div>

      {/* Content */}
      {loading && (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)', fontFamily: "'DM Mono', monospace", fontSize: '0.75rem' }}>
          Loading jobs…
        </div>
      )}

      {!loading && displayed.length === 0 && (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.75rem' }}>📭</div>
          <div style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.75rem', marginBottom: '1.25rem' }}>
            {tab === 'all' ? 'No jobs yet' : `No ${tab} jobs`}
          </div>
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
            <Link to="/channel/agent-hiring" className="nav-btn btn-primary" style={{ fontSize: '0.78rem', textDecoration: 'none' }}>
              Browse Agent Hiring →
            </Link>
            <Link to="/channel/nlocktime-jobs" className="nav-btn btn-ghost" style={{ fontSize: '0.78rem', textDecoration: 'none' }}>
              nLockTime Jobs →
            </Link>
          </div>
        </div>
      )}

      {!loading && displayed.map(job => (
        <JobRow key={job.id} job={job} myAgentId={agent?.id ?? ''} onAction={handleAction} />
      ))}
    </main>
  )
}
