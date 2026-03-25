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

export default function ComposeModal({ onSuccess, onClose, defaultChannelId }: Props) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [stake, setStake] = useState(MIN_STAKE)
  const [channelId, setChannelId] = useState(defaultChannelId ?? 'prediction-markets')
  const [channelList, setChannelList] = useState<Channel[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    channelsApi.list().then(r => {
      setChannelList(r.channels)
    }).catch(() => {})
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

  // Stake conviction label
  const convictionLabel = stake >= 8000 ? 'High conviction' : stake >= 3000 ? 'Strong signal' : stake >= 1000 ? 'Solid stake' : 'Entry stake'
  const convictionColor = stake >= 8000 ? 'var(--gold)' : stake >= 3000 ? 'var(--accent)' : stake >= 1000 ? 'var(--blue)' : 'var(--text-muted)'

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: '1rem' }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '14px', width: '100%', maxWidth: '520px', fontFamily: "'Outfit', sans-serif" }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)', boxShadow: '0 0 8px var(--accent)' }} />
            <span style={{ fontFamily: "'Instrument Serif', serif", fontSize: '1.1rem', color: 'var(--text)', fontStyle: 'italic' }}>Post a Signal</span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1.2rem', lineHeight: 1 }}>×</button>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

            {/* Title */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.4rem' }}>
                <label style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Signal</label>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.6rem', color: title.length > titleMax * 0.9 ? 'var(--coral)' : 'var(--text-dim)' }}>
                  {title.length}/{titleMax}
                </span>
              </div>
              <input
                type="text"
                value={title}
                onChange={e => setTitle(e.target.value.slice(0, titleMax))}
                placeholder="What's your signal?"
                autoFocus
                style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.6rem 0.75rem', color: 'var(--text)', fontFamily: "'Outfit', sans-serif", fontSize: '0.875rem', outline: 'none', boxSizing: 'border-box' }}
                onFocus={e => e.target.style.borderColor = 'var(--accent-border)'}
                onBlur={e => e.target.style.borderColor = 'var(--border)'}
              />
            </div>

            {/* Body */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.4rem' }}>
                <label style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  Details <span style={{ color: 'var(--text-dim)', textTransform: 'none', fontFamily: "'Outfit', sans-serif", letterSpacing: 0 }}>(optional)</span>
                </label>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.6rem', color: body.length > bodyMax * 0.9 ? 'var(--coral)' : 'var(--text-dim)' }}>
                  {body.length}/{bodyMax}
                </span>
              </div>
              <textarea
                value={body}
                onChange={e => setBody(e.target.value.slice(0, bodyMax))}
                placeholder="Supporting data, reasoning, sources..."
                rows={4}
                style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.6rem 0.75rem', color: 'var(--text)', fontFamily: "'Outfit', sans-serif", fontSize: '0.875rem', outline: 'none', resize: 'vertical', boxSizing: 'border-box', lineHeight: 1.6 }}
                onFocus={e => e.target.style.borderColor = 'var(--accent-border)'}
                onBlur={e => e.target.style.borderColor = 'var(--border)'}
              />
            </div>

            {/* Channel */}
            <div>
              <label style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.08em', textTransform: 'uppercase', display: 'block', marginBottom: '0.4rem' }}>Channel</label>
              <select
                value={channelId}
                onChange={e => setChannelId(e.target.value)}
                style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.6rem 0.75rem', color: 'var(--text)', fontFamily: "'DM Mono', monospace", fontSize: '0.8rem', outline: 'none', cursor: 'pointer', boxSizing: 'border-box' }}
              >
                {channelList.length > 0
                  ? channelList.map(c => (
                      <option key={c.id} value={c.id}>{c.emoji ? `${c.emoji} ` : ''}{c.name}</option>
                    ))
                  : <option value="prediction-markets">prediction-markets</option>
                }
              </select>
            </div>

            {/* Stake */}
            <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '10px', padding: '1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.75rem' }}>
                <label style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Stake</label>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.7rem', color: convictionColor }}>{convictionLabel}</span>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: '1rem', color: 'var(--accent)', fontWeight: 600 }}>{formatSats(stake)}</span>
                </div>
              </div>
              <input
                type="range"
                min={MIN_STAKE}
                max={MAX_STAKE}
                step={100}
                value={stake}
                onChange={e => setStake(Number(e.target.value))}
                style={{ width: '100%', accentColor: 'var(--accent)', cursor: 'pointer' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.4rem' }}>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.6rem', color: 'var(--text-dim)' }}>100 sats min</span>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.6rem', color: 'var(--text-dim)' }}>10,000 sats max</span>
              </div>
            </div>

            {error && <p style={{ color: 'var(--coral)', fontSize: '0.8rem', margin: 0 }}>{error}</p>}

          </div>

          {/* Footer */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1rem 1.5rem', borderTop: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', boxShadow: '0 0 6px var(--accent)' }} />
              <span style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.65rem', color: 'var(--text-dim)' }}>{channelId}</span>
            </div>
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button type="button" onClick={onClose} className="nav-btn btn-ghost" style={{ padding: '0.5rem 1rem', fontSize: '0.8rem', borderRadius: '8px' }}>
                Cancel
              </button>
              <button
                type="submit"
                disabled={!canSubmit}
                className="nav-btn btn-primary"
                style={{ padding: '0.5rem 1.25rem', fontSize: '0.8rem', borderRadius: '8px', opacity: canSubmit ? 1 : 0.4, cursor: canSubmit ? 'pointer' : 'not-allowed' }}
              >
                {loading ? 'Posting...' : `Stake ${formatSats(stake)} →`}
              </button>
            </div>
          </div>
        </form>

      </div>
    </div>
  )
}
