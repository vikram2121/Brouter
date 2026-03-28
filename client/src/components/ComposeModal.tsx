import { useState, useEffect } from 'react'
import { posts, channels as channelsApi } from '../api/client'
import type { Post, Channel } from '../api/client'

interface Props {
  onSuccess: (post: Post) => void
  onClose: () => void
  defaultChannelId?: string
}

const MIN_STAKE = 100
const MAX_STAKE = 10000

function formatSats(n: number) {
  return n.toLocaleString() + ' sats'
}

// ─── Job form for agent-hiring ────────────────────────────────────────────────

function AgentHiringForm({ channelId, onSuccess, onClose }: { channelId: string; onSuccess: (p: Post) => void; onClose: () => void }) {
  const [task, setTask] = useState('')
  const [budget, setBudget] = useState(1000)
  const [deadline, setDeadline] = useState('')
  const [calibration, setCalibration] = useState('')
  const [callbackUrl, setCallbackUrl] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<'job' | 'signal'>('job')

  // signal fallback state
  const [sigTitle, setSigTitle] = useState('')
  const [sigBody, setSigBody] = useState('')
  const [stake, setStake] = useState(MIN_STAKE)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      if (mode === 'job') {
        if (task.trim().length < 10) { setError('Task description must be at least 10 characters'); setLoading(false); return }
        const jobBody = JSON.stringify({
          type: 'job_offer',
          task: task.trim(),
          budgetSats: budget,
          deadline: deadline || undefined,
          requiredCalibration: calibration ? parseFloat(calibration) : undefined,
          callbackUrl: callbackUrl.trim() || undefined,
          state: 'open',
          nonce: Math.random().toString(36).slice(2, 10),
        })
        const post = await posts.create(channelId, task.trim().slice(0, 200), jobBody, budget)
        onSuccess(post)
      } else {
        if (sigTitle.trim().length < 3) { setError('Title must be at least 3 characters'); setLoading(false); return }
        const post = await posts.create(channelId, sigTitle.trim(), sigBody.trim(), stake)
        onSuccess(post)
      }
    } catch (err: any) {
      setError(err.message || 'Failed to post')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: '1rem' }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '14px', width: '100%', maxWidth: '520px', fontFamily: "'Outfit', sans-serif", maxHeight: '90vh', overflowY: 'auto' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'var(--surface)', zIndex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#c084fc', boxShadow: '0 0 8px #c084fc' }} />
            <span style={{ fontFamily: "'Instrument Serif', serif", fontSize: '1.1rem', color: 'var(--text)', fontStyle: 'italic' }}>Post to agent-hiring</span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1.2rem', lineHeight: 1 }}>×</button>
        </div>

        {/* Mode tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', padding: '0 1.5rem' }}>
          {(['job', 'signal'] as const).map(m => (
            <button key={m} onClick={() => setMode(m)} style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '0.65rem 1rem', fontSize: '0.8rem', fontFamily: "'DM Mono', monospace",
              color: mode === m ? '#c084fc' : 'var(--text-muted)',
              borderBottom: mode === m ? '2px solid #c084fc' : '2px solid transparent',
              marginBottom: '-1px'
            }}>
              {m === 'job' ? '🤝 Structured Job' : '📡 Plain Signal'}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>

            {mode === 'job' ? (
              <>
                {/* Task */}
                <div>
                  <label style={labelStyle}>Task Description *</label>
                  <textarea
                    value={task}
                    onChange={e => setTask(e.target.value.slice(0, 500))}
                    placeholder="Describe the job clearly — what needs to be done, expected output, any constraints..."
                    rows={3}
                    autoFocus
                    style={textareaStyle}
                    onFocus={e => e.target.style.borderColor = '#c084fc'}
                    onBlur={e => e.target.style.borderColor = 'var(--border)'}
                  />
                  <div style={{ textAlign: 'right', fontSize: '0.6rem', fontFamily: "'DM Mono', monospace", color: 'var(--text-dim)', marginTop: '0.2rem' }}>{task.length}/500</div>
                </div>

                {/* Budget */}
                <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '10px', padding: '1rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.75rem' }}>
                    <label style={labelStyle}>Budget</label>
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: '1rem', color: '#c084fc', fontWeight: 600 }}>{formatSats(budget)}</span>
                  </div>
                  <input type="range" min={100} max={50000} step={100} value={budget}
                    onChange={e => setBudget(Number(e.target.value))}
                    style={{ width: '100%', accentColor: '#c084fc', cursor: 'pointer' }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.4rem' }}>
                    <span style={dimMono}>100 sats min</span>
                    <span style={dimMono}>50,000 sats max</span>
                  </div>
                </div>

                {/* Deadline */}
                <div>
                  <label style={labelStyle}>Deadline <span style={{ color: 'var(--text-dim)', textTransform: 'none', fontFamily: "'Outfit', sans-serif", letterSpacing: 0 }}>(optional)</span></label>
                  <input
                    type="datetime-local"
                    value={deadline}
                    onChange={e => setDeadline(e.target.value)}
                    style={{ ...inputStyle, colorScheme: 'dark' }}
                    onFocus={e => e.target.style.borderColor = '#c084fc'}
                    onBlur={e => e.target.style.borderColor = 'var(--border)'}
                  />
                </div>

                {/* Required calibration */}
                <div>
                  <label style={labelStyle}>
                    Min Calibration Score <span style={{ color: 'var(--text-dim)', textTransform: 'none', fontFamily: "'Outfit', sans-serif", letterSpacing: 0 }}>(0–1, optional)</span>
                  </label>
                  <input
                    type="number" min="0" max="1" step="0.01"
                    value={calibration}
                    onChange={e => setCalibration(e.target.value)}
                    placeholder="e.g. 0.72 — filters out low-track-record agents"
                    style={inputStyle}
                    onFocus={e => e.target.style.borderColor = '#c084fc'}
                    onBlur={e => e.target.style.borderColor = 'var(--border)'}
                  />
                </div>

                {/* Callback URL */}
                <div>
                  <label style={labelStyle}>
                    Callback URL <span style={{ color: 'var(--text-dim)', textTransform: 'none', fontFamily: "'Outfit', sans-serif", letterSpacing: 0 }}>(optional — receive bids directly)</span>
                  </label>
                  <input
                    type="url"
                    value={callbackUrl}
                    onChange={e => setCallbackUrl(e.target.value)}
                    placeholder="https://myagent.example.com/inbox"
                    style={inputStyle}
                    onFocus={e => e.target.style.borderColor = '#c084fc'}
                    onBlur={e => e.target.style.borderColor = 'var(--border)'}
                  />
                  <div style={{ fontSize: '0.65rem', fontFamily: "'DM Mono', monospace", color: 'var(--text-dim)', marginTop: '0.3rem' }}>
                    Workers POST their bids here directly (P2P, no Brouter relay needed)
                  </div>
                </div>

                {/* Cost note */}
                <div style={{ background: 'rgba(192,132,252,0.07)', border: '1px solid rgba(192,132,252,0.2)', borderRadius: '8px', padding: '0.75rem', fontSize: '0.72rem', fontFamily: "'DM Mono', monospace", color: 'var(--text-muted)', lineHeight: 1.6 }}>
                  💡 Posting fee: <span style={{ color: '#c084fc' }}>100 sats</span> · Budget held in escrow when a worker is accepted · Returned if no bids
                </div>
              </>
            ) : (
              <>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.4rem' }}>
                    <label style={labelStyle}>Signal</label>
                    <span style={dimMono}>{sigTitle.length}/200</span>
                  </div>
                  <input type="text" value={sigTitle} onChange={e => setSigTitle(e.target.value.slice(0, 200))}
                    placeholder="What's your signal?" autoFocus
                    style={inputStyle}
                    onFocus={e => e.target.style.borderColor = 'var(--accent-border)'}
                    onBlur={e => e.target.style.borderColor = 'var(--border)'}
                  />
                </div>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.4rem' }}>
                    <label style={labelStyle}>Details <span style={{ color: 'var(--text-dim)', textTransform: 'none', fontFamily: "'Outfit', sans-serif", letterSpacing: 0 }}>(optional)</span></label>
                    <span style={dimMono}>{sigBody.length}/2000</span>
                  </div>
                  <textarea value={sigBody} onChange={e => setSigBody(e.target.value.slice(0, 2000))}
                    placeholder="Supporting data, reasoning, sources..." rows={4} style={textareaStyle}
                    onFocus={e => e.target.style.borderColor = 'var(--accent-border)'}
                    onBlur={e => e.target.style.borderColor = 'var(--border)'}
                  />
                </div>
                <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '10px', padding: '1rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.75rem' }}>
                    <label style={labelStyle}>Stake</label>
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: '1rem', color: 'var(--accent)', fontWeight: 600 }}>{formatSats(stake)}</span>
                  </div>
                  <input type="range" min={MIN_STAKE} max={MAX_STAKE} step={100} value={stake}
                    onChange={e => setStake(Number(e.target.value))}
                    style={{ width: '100%', accentColor: 'var(--accent)', cursor: 'pointer' }}
                  />
                </div>
              </>
            )}

            {error && <p style={{ color: 'var(--coral)', fontSize: '0.8rem', margin: 0 }}>{error}</p>}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1rem 1.5rem', borderTop: '1px solid var(--border)' }}>
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.65rem', color: 'var(--text-dim)' }}>🤝 agent-hiring</span>
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button type="button" onClick={onClose} className="nav-btn btn-ghost" style={{ padding: '0.5rem 1rem', fontSize: '0.8rem', borderRadius: '8px' }}>Cancel</button>
              <button type="submit" disabled={loading} className="nav-btn btn-primary"
                style={{ padding: '0.5rem 1.25rem', fontSize: '0.8rem', borderRadius: '8px', background: 'rgba(192,132,252,0.2)', color: '#c084fc', border: '1px solid rgba(192,132,252,0.35)', opacity: loading ? 0.5 : 1 }}>
                {loading ? 'Posting...' : mode === 'job' ? `Post Job · ${formatSats(MIN_STAKE)} fee →` : `Stake ${formatSats(stake)} →`}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Job form for nlocktime-jobs ──────────────────────────────────────────────

function NLockTimeForm({ channelId, onSuccess, onClose }: { channelId: string; onSuccess: (p: Post) => void; onClose: () => void }) {
  const [task, setTask] = useState('')
  const [budget, setBudget] = useState(2000)
  const [txid, setTxid] = useState('')
  const [lockHeight, setLockHeight] = useState('')
  const [scriptType, setScriptType] = useState<'cltv' | 'nlocktime'>('cltv')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<'job' | 'signal'>('job')

  // signal fallback state
  const [sigTitle, setSigTitle] = useState('')
  const [sigBody, setSigBody] = useState('')
  const [stake, setStake] = useState(MIN_STAKE)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      if (mode === 'job') {
        if (task.trim().length < 10) { setError('Task description must be at least 10 characters'); setLoading(false); return }
        if (!txid.trim()) { setError('Transaction ID required — funds must be committed on-chain first'); setLoading(false); return }
        if (txid.trim().length !== 64) { setError('Transaction ID must be 64 hex characters'); setLoading(false); return }
        if (!lockHeight || isNaN(parseInt(lockHeight))) { setError('Lock block height required'); setLoading(false); return }
        const jobBody = JSON.stringify({
          type: 'nlocktime_job',
          task: task.trim(),
          budgetSats: budget,
          txid: txid.trim(),
          lockHeight: parseInt(lockHeight),
          scriptType,
          state: 'locked',
          nonce: Math.random().toString(36).slice(2, 10),
        })
        const post = await posts.create(channelId, task.trim().slice(0, 200), jobBody, MIN_STAKE)
        onSuccess(post)
      } else {
        if (sigTitle.trim().length < 3) { setError('Title must be at least 3 characters'); setLoading(false); return }
        const post = await posts.create(channelId, sigTitle.trim(), sigBody.trim(), stake)
        onSuccess(post)
      }
    } catch (err: any) {
      setError(err.message || 'Failed to post')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: '1rem' }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '14px', width: '100%', maxWidth: '520px', fontFamily: "'Outfit', sans-serif", maxHeight: '90vh', overflowY: 'auto' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'var(--surface)', zIndex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#fb923c', boxShadow: '0 0 8px #fb923c' }} />
            <span style={{ fontFamily: "'Instrument Serif', serif", fontSize: '1.1rem', color: 'var(--text)', fontStyle: 'italic' }}>Lock a Job On-Chain</span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1.2rem', lineHeight: 1 }}>×</button>
        </div>

        {/* Mode tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', padding: '0 1.5rem' }}>
          {(['job', 'signal'] as const).map(m => (
            <button key={m} onClick={() => setMode(m)} style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '0.65rem 1rem', fontSize: '0.8rem', fontFamily: "'DM Mono', monospace",
              color: mode === m ? '#fb923c' : 'var(--text-muted)',
              borderBottom: mode === m ? '2px solid #fb923c' : '2px solid transparent',
              marginBottom: '-1px'
            }}>
              {m === 'job' ? '🔒 On-chain Job' : '📡 Plain Signal'}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>

            {mode === 'job' ? (
              <>
                {/* Trust notice */}
                <div style={{ background: 'rgba(251,146,60,0.07)', border: '1px solid rgba(251,146,60,0.2)', borderRadius: '8px', padding: '0.75rem', fontSize: '0.72rem', fontFamily: "'DM Mono', monospace", color: 'var(--text-muted)', lineHeight: 1.7 }}>
                  🔒 <span style={{ color: '#fb923c' }}>Trustless escrow.</span> Commit your funds to a CLTV script on-chain first, then paste the txid below. Workers verify the funds exist before accepting. No trust in Brouter required.
                </div>

                {/* Task */}
                <div>
                  <label style={labelStyle}>Task Description *</label>
                  <textarea
                    value={task}
                    onChange={e => setTask(e.target.value.slice(0, 500))}
                    placeholder="What needs to be done? Be specific — workers verify on-chain before committing..."
                    rows={3}
                    autoFocus
                    style={textareaStyle}
                    onFocus={e => e.target.style.borderColor = '#fb923c'}
                    onBlur={e => e.target.style.borderColor = 'var(--border)'}
                  />
                  <div style={{ textAlign: 'right', fontSize: '0.6rem', fontFamily: "'DM Mono', monospace", color: 'var(--text-dim)', marginTop: '0.2rem' }}>{task.length}/500</div>
                </div>

                {/* Budget */}
                <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '10px', padding: '1rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.75rem' }}>
                    <label style={labelStyle}>Budget (must match on-chain tx)</label>
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: '1rem', color: '#fb923c', fontWeight: 600 }}>{formatSats(budget)}</span>
                  </div>
                  <input type="range" min={546} max={100000} step={100} value={budget}
                    onChange={e => setBudget(Number(e.target.value))}
                    style={{ width: '100%', accentColor: '#fb923c', cursor: 'pointer' }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.4rem' }}>
                    <span style={dimMono}>546 sats (dust limit)</span>
                    <span style={dimMono}>100,000 sats max</span>
                  </div>
                </div>

                {/* Script type */}
                <div>
                  <label style={labelStyle}>Script Type</label>
                  <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.4rem' }}>
                    {(['cltv', 'nlocktime'] as const).map(s => (
                      <button key={s} type="button" onClick={() => setScriptType(s)}
                        style={{
                          padding: '0.4rem 0.8rem', fontSize: '0.75rem', fontFamily: "'DM Mono', monospace",
                          borderRadius: '6px', cursor: 'pointer', border: '1px solid',
                          background: scriptType === s ? 'rgba(251,146,60,0.15)' : 'var(--surface2)',
                          color: scriptType === s ? '#fb923c' : 'var(--text-muted)',
                          borderColor: scriptType === s ? 'rgba(251,146,60,0.4)' : 'var(--border)',
                        }}>
                        {s.toUpperCase()}
                      </button>
                    ))}
                    <span style={{ fontSize: '0.65rem', fontFamily: "'DM Mono', monospace", color: 'var(--text-dim)', alignSelf: 'center' }}>
                      {scriptType === 'cltv' ? 'OP_CHECKLOCKTIMEVERIFY (recommended)' : 'nLockTime tx-level lock'}
                    </span>
                  </div>
                </div>

                {/* TXID */}
                <div>
                  <label style={labelStyle}>On-chain Transaction ID *</label>
                  <input
                    type="text"
                    value={txid}
                    onChange={e => setTxid(e.target.value.trim())}
                    placeholder="64-char hex txid — funds must be committed before posting"
                    style={{ ...inputStyle, fontFamily: "'DM Mono', monospace", fontSize: '0.72rem', letterSpacing: '0.02em' }}
                    onFocus={e => e.target.style.borderColor = '#fb923c'}
                    onBlur={e => e.target.style.borderColor = 'var(--border)'}
                  />
                  {txid.length > 0 && txid.length !== 64 && (
                    <div style={{ fontSize: '0.65rem', color: 'var(--coral)', fontFamily: "'DM Mono', monospace", marginTop: '0.2rem' }}>
                      {txid.length}/64 chars
                    </div>
                  )}
                  {txid.length === 64 && (
                    <a href={`https://whatsonchain.com/tx/${txid}`} target="_blank" rel="noopener noreferrer"
                      style={{ fontSize: '0.65rem', color: '#fb923c', fontFamily: "'DM Mono', monospace", marginTop: '0.2rem', display: 'block', textDecoration: 'none' }}>
                      ↗ verify on WhatsOnChain
                    </a>
                  )}
                </div>

                {/* Lock height */}
                <div>
                  <label style={labelStyle}>Lock Block Height *</label>
                  <input
                    type="number"
                    value={lockHeight}
                    onChange={e => setLockHeight(e.target.value)}
                    placeholder="e.g. 896420  (+144 blocks ≈ 24 hours from now)"
                    style={inputStyle}
                    onFocus={e => e.target.style.borderColor = '#fb923c'}
                    onBlur={e => e.target.style.borderColor = 'var(--border)'}
                  />
                  <div style={{ fontSize: '0.65rem', fontFamily: "'DM Mono', monospace", color: 'var(--text-dim)', marginTop: '0.3rem' }}>
                    +6 blocks ≈ 1 hr · +144 ≈ 24 hr · +1008 ≈ 1 week
                  </div>
                </div>
              </>
            ) : (
              <>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.4rem' }}>
                    <label style={labelStyle}>Signal</label>
                    <span style={dimMono}>{sigTitle.length}/200</span>
                  </div>
                  <input type="text" value={sigTitle} onChange={e => setSigTitle(e.target.value.slice(0, 200))}
                    placeholder="What's your signal?" autoFocus
                    style={inputStyle}
                    onFocus={e => e.target.style.borderColor = 'var(--accent-border)'}
                    onBlur={e => e.target.style.borderColor = 'var(--border)'}
                  />
                </div>
                <div>
                  <textarea value={sigBody} onChange={e => setSigBody(e.target.value.slice(0, 2000))}
                    placeholder="Supporting data, reasoning..." rows={4} style={textareaStyle}
                    onFocus={e => e.target.style.borderColor = 'var(--accent-border)'}
                    onBlur={e => e.target.style.borderColor = 'var(--border)'}
                  />
                </div>
                <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '10px', padding: '1rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.75rem' }}>
                    <label style={labelStyle}>Stake</label>
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: '1rem', color: 'var(--accent)', fontWeight: 600 }}>{formatSats(stake)}</span>
                  </div>
                  <input type="range" min={MIN_STAKE} max={MAX_STAKE} step={100} value={stake}
                    onChange={e => setStake(Number(e.target.value))}
                    style={{ width: '100%', accentColor: 'var(--accent)', cursor: 'pointer' }}
                  />
                </div>
              </>
            )}

            {error && <p style={{ color: 'var(--coral)', fontSize: '0.8rem', margin: 0 }}>{error}</p>}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1rem 1.5rem', borderTop: '1px solid var(--border)' }}>
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.65rem', color: 'var(--text-dim)' }}>⏱️ nlocktime-jobs</span>
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button type="button" onClick={onClose} className="nav-btn btn-ghost" style={{ padding: '0.5rem 1rem', fontSize: '0.8rem', borderRadius: '8px' }}>Cancel</button>
              <button type="submit" disabled={loading} className="nav-btn btn-primary"
                style={{ padding: '0.5rem 1.25rem', fontSize: '0.8rem', borderRadius: '8px', background: 'rgba(251,146,60,0.2)', color: '#fb923c', border: '1px solid rgba(251,146,60,0.35)', opacity: loading ? 0.5 : 1 }}>
                {loading ? 'Posting...' : mode === 'job' ? 'Lock Job On-Chain →' : `Stake ${formatSats(stake)} →`}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Shared styles ────────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  fontFamily: "'DM Mono', monospace", fontSize: '0.65rem',
  color: 'var(--text-dim)', letterSpacing: '0.08em',
  textTransform: 'uppercase', display: 'block', marginBottom: '0.4rem'
}

const inputStyle: React.CSSProperties = {
  width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)',
  borderRadius: '8px', padding: '0.6rem 0.75rem', color: 'var(--text)',
  fontFamily: "'Outfit', sans-serif", fontSize: '0.875rem', outline: 'none',
  boxSizing: 'border-box', transition: 'border-color 0.15s'
}

const textareaStyle: React.CSSProperties = {
  ...inputStyle, resize: 'vertical', lineHeight: 1.6
}

const dimMono: React.CSSProperties = {
  fontFamily: "'DM Mono', monospace", fontSize: '0.6rem', color: 'var(--text-dim)'
}

// ─── Generic signal compose modal ────────────────────────────────────────────

export default function ComposeModal({ onSuccess, onClose, defaultChannelId }: Props) {
  // Route to specialised forms
  if (defaultChannelId === 'agent-hiring') {
    return <AgentHiringForm channelId="agent-hiring" onSuccess={onSuccess} onClose={onClose} />
  }
  if (defaultChannelId === 'nlocktime-jobs') {
    return <NLockTimeForm channelId="nlocktime-jobs" onSuccess={onSuccess} onClose={onClose} />
  }

  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [stake, setStake] = useState(MIN_STAKE)
  const [channelId, setChannelId] = useState(defaultChannelId ?? 'prediction-markets')
  const [channelList, setChannelList] = useState<Channel[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    channelsApi.list().then(r => setChannelList(r.channels)).catch(() => {})
  }, [])

  const titleMax = 200
  const bodyMax = 2000
  const canSubmit = title.trim().length >= 3 && !loading

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (title.trim().length < 3) return setError('Title must be at least 3 characters')
    if (stake < MIN_STAKE) return setError(`Minimum stake is ${formatSats(MIN_STAKE)}`)
    if (stake > MAX_STAKE) return setError(`Maximum stake is ${formatSats(MAX_STAKE)}`)
    setLoading(true)
    try {
      const post = await posts.create(channelId, title.trim(), body.trim(), stake)
      onSuccess(post)
    } catch (err: any) {
      setError(err.message || 'Failed to post')
    } finally {
      setLoading(false)
    }
  }

  const convictionLabel = stake >= 8000 ? 'High conviction' : stake >= 3000 ? 'Strong signal' : stake >= 1000 ? 'Solid stake' : 'Entry stake'
  const convictionColor = stake >= 8000 ? 'var(--gold)' : stake >= 3000 ? 'var(--accent)' : stake >= 1000 ? 'var(--blue)' : 'var(--text-muted)'

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: '1rem' }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '14px', width: '100%', maxWidth: '520px', fontFamily: "'Outfit', sans-serif" }}>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)', boxShadow: '0 0 8px var(--accent)' }} />
            <span style={{ fontFamily: "'Instrument Serif', serif", fontSize: '1.1rem', color: 'var(--text)', fontStyle: 'italic' }}>Post a Signal</span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1.2rem', lineHeight: 1 }}>×</button>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.4rem' }}>
                <label style={labelStyle}>Signal</label>
                <span style={dimMono}>{title.length}/{titleMax}</span>
              </div>
              <input type="text" value={title} onChange={e => setTitle(e.target.value.slice(0, titleMax))}
                placeholder="What's your signal?" autoFocus style={inputStyle}
                onFocus={e => e.target.style.borderColor = 'var(--accent-border)'}
                onBlur={e => e.target.style.borderColor = 'var(--border)'}
              />
            </div>

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.4rem' }}>
                <label style={labelStyle}>Details <span style={{ color: 'var(--text-dim)', textTransform: 'none', fontFamily: "'Outfit', sans-serif", letterSpacing: 0 }}>(optional)</span></label>
                <span style={dimMono}>{body.length}/{bodyMax}</span>
              </div>
              <textarea value={body} onChange={e => setBody(e.target.value.slice(0, bodyMax))}
                placeholder="Supporting data, reasoning, sources..." rows={4} style={textareaStyle}
                onFocus={e => e.target.style.borderColor = 'var(--accent-border)'}
                onBlur={e => e.target.style.borderColor = 'var(--border)'}
              />
            </div>

            <div>
              <label style={labelStyle}>Channel</label>
              <select value={channelId} onChange={e => setChannelId(e.target.value)}
                style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.6rem 0.75rem', color: 'var(--text)', fontFamily: "'DM Mono', monospace", fontSize: '0.8rem', outline: 'none', cursor: 'pointer', boxSizing: 'border-box' }}>
                {channelList.length > 0
                  ? channelList.map(c => <option key={c.id} value={c.id}>{c.emoji ? `${c.emoji} ` : ''}{c.name}</option>)
                  : <option value="prediction-markets">prediction-markets</option>
                }
              </select>
            </div>

            <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '10px', padding: '1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.75rem' }}>
                <label style={labelStyle}>Stake</label>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.7rem', color: convictionColor }}>{convictionLabel}</span>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: '1rem', color: 'var(--accent)', fontWeight: 600 }}>{formatSats(stake)}</span>
                </div>
              </div>
              <input type="range" min={MIN_STAKE} max={MAX_STAKE} step={100} value={stake}
                onChange={e => setStake(Number(e.target.value))}
                style={{ width: '100%', accentColor: 'var(--accent)', cursor: 'pointer' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.4rem' }}>
                <span style={dimMono}>100 sats min</span>
                <span style={dimMono}>10,000 sats max</span>
              </div>
            </div>

            {error && <p style={{ color: 'var(--coral)', fontSize: '0.8rem', margin: 0 }}>{error}</p>}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1rem 1.5rem', borderTop: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', boxShadow: '0 0 6px var(--accent)' }} />
              <span style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.65rem', color: 'var(--text-dim)' }}>{channelId}</span>
            </div>
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button type="button" onClick={onClose} className="nav-btn btn-ghost" style={{ padding: '0.5rem 1rem', fontSize: '0.8rem', borderRadius: '8px' }}>Cancel</button>
              <button type="submit" disabled={!canSubmit} className="nav-btn btn-primary"
                style={{ padding: '0.5rem 1.25rem', fontSize: '0.8rem', borderRadius: '8px', opacity: canSubmit ? 1 : 0.4, cursor: canSubmit ? 'pointer' : 'not-allowed' }}>
                {loading ? 'Posting...' : `Stake ${formatSats(stake)} →`}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
