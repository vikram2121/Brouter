import { useState } from 'react'
import { generateKeypair, encryptPrivateKey, saveWallet } from '../lib/wallet'
import { api } from '../api/client'

interface Props {
  onSuccess: (token: string, agentId: string, name: string) => void
  onClose: () => void
}

type Step = 'form' | 'showKey' | 'loading'

export default function RegisterModal({ onSuccess, onClose }: Props) {
  const [step, setStep] = useState<Step>('form')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [privateKeyHex, setPrivateKeyHex] = useState('')
  const [publicKeyHex, setPublicKeyHex] = useState('')
  const [address, setAddress] = useState('')
  const [keyCopied, setKeyCopied] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)

  const handleGenerateAndPreview = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!name.trim()) return setError('Name is required')
    if (name.length < 2 || name.length > 30) return setError('Name must be 2–30 characters')
    if (!/^[a-zA-Z0-9_]+$/.test(name)) return setError('Name must be alphanumeric + underscores only')
    if (password.length < 8) return setError('Password must be at least 8 characters')
    if (password !== confirmPassword) return setError('Passwords do not match')
    try {
      const kp = generateKeypair()
      setPrivateKeyHex(kp.privateKeyHex)
      setPublicKeyHex(kp.publicKeyHex)
      setAddress(kp.address)
      setStep('showKey')
    } catch {
      setError('Failed to generate keypair. Please try again.')
    }
  }

  const handleConfirmAndRegister = async () => {
    if (!acknowledged) return setError('Please acknowledge you have saved your key')
    setStep('loading')
    setError('')
    try {
      const encrypted = await encryptPrivateKey(privateKeyHex, password)
      saveWallet({ publicKey: publicKeyHex, bsvAddress: address, encryptedKey: encrypted.encryptedKey, iv: encrypted.iv, salt: encrypted.salt })
      const res = await api.post('/agents/register', { name: name.trim(), description: description.trim() || undefined, publicKey: publicKeyHex, bsvAddress: address })
      if (!res.success) throw new Error(res.error || 'Registration failed')
      onSuccess(res.data.token, res.data.agent.id, res.data.agent.name)
    } catch (err: any) {
      setError(err.message || 'Registration failed')
      setStep('showKey')
    }
  }

  const copyKey = () => {
    navigator.clipboard.writeText(privateKeyHex)
    setKeyCopied(true)
    setTimeout(() => setKeyCopied(false), 2000)
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: '1rem' }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '14px', width: '100%', maxWidth: '440px', fontFamily: "'Outfit', sans-serif" }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)', boxShadow: '0 0 8px var(--accent)' }} />
            <span style={{ fontFamily: "'Instrument Serif', serif", fontSize: '1.1rem', color: 'var(--text)' }}>
              {step === 'showKey' ? 'Save Your Key' : 'Launch Agent'}
            </span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1.2rem', lineHeight: 1 }}>×</button>
        </div>

        <div style={{ padding: '1.5rem' }}>

          {/* Step 1: Form */}
          {step === 'form' && (
            <form onSubmit={handleGenerateAndPreview} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label style={{ display: 'block', fontFamily: "'DM Mono', monospace", fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '0.4rem' }}>Agent name</label>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Brouter"
                  maxLength={30}
                  autoFocus
                  style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.55rem 0.75rem', color: 'var(--text)', fontFamily: "'Outfit', sans-serif", fontSize: '0.875rem', outline: 'none', boxSizing: 'border-box' }}
                  onFocus={e => e.target.style.borderColor = 'var(--accent-border)'}
                  onBlur={e => e.target.style.borderColor = 'var(--border)'}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontFamily: "'DM Mono', monospace", fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '0.4rem' }}>
                  Description <span style={{ color: 'var(--text-dim)', textTransform: 'none', fontFamily: "'Outfit', sans-serif", letterSpacing: 0 }}>(optional)</span>
                </label>
                <input
                  type="text"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="What does your agent do?"
                  maxLength={200}
                  style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.55rem 0.75rem', color: 'var(--text)', fontFamily: "'Outfit', sans-serif", fontSize: '0.875rem', outline: 'none', boxSizing: 'border-box' }}
                  onFocus={e => e.target.style.borderColor = 'var(--accent-border)'}
                  onBlur={e => e.target.style.borderColor = 'var(--border)'}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontFamily: "'DM Mono', monospace", fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '0.4rem' }}>Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Min. 8 characters"
                  style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.55rem 0.75rem', color: 'var(--text)', fontFamily: "'Outfit', sans-serif", fontSize: '0.875rem', outline: 'none', boxSizing: 'border-box' }}
                  onFocus={e => e.target.style.borderColor = 'var(--accent-border)'}
                  onBlur={e => e.target.style.borderColor = 'var(--border)'}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontFamily: "'DM Mono', monospace", fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '0.4rem' }}>Confirm password</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  placeholder="Repeat password"
                  style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.55rem 0.75rem', color: 'var(--text)', fontFamily: "'Outfit', sans-serif", fontSize: '0.875rem', outline: 'none', boxSizing: 'border-box' }}
                  onFocus={e => e.target.style.borderColor = 'var(--accent-border)'}
                  onBlur={e => e.target.style.borderColor = 'var(--border)'}
                />
              </div>

              {error && <p style={{ color: 'var(--coral)', fontSize: '0.8rem', margin: 0 }}>{error}</p>}

              <button type="submit" className="nav-btn btn-primary" style={{ width: '100%', padding: '0.6rem', fontSize: '0.875rem', borderRadius: '8px', marginTop: '0.25rem' }}>
                Generate Wallet & Continue →
              </button>
            </form>
          )}

          {/* Step 2: Show private key */}
          {step === 'showKey' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div style={{ background: 'rgba(240,192,64,0.08)', border: '1px solid rgba(240,192,64,0.2)', borderRadius: '8px', padding: '0.875rem' }}>
                <p style={{ color: 'var(--gold)', fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.35rem' }}>⚠ Save this now</p>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', lineHeight: 1.5 }}>This is the only time we'll show your private key. Save it somewhere safe — if you forget your password, this is your only way back in.</p>
              </div>

              <div>
                <label style={{ display: 'block', fontFamily: "'DM Mono', monospace", fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '0.4rem' }}>Private key</label>
                <div style={{ position: 'relative' }}>
                  <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.75rem', paddingRight: '4.5rem', fontFamily: "'DM Mono', monospace", fontSize: '0.7rem', color: 'var(--accent)', wordBreak: 'break-all', lineHeight: 1.6 }}>
                    {privateKeyHex}
                  </div>
                  <button
                    onClick={copyKey}
                    style={{ position: 'absolute', top: '0.5rem', right: '0.5rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '5px', color: 'var(--text-muted)', fontFamily: "'DM Mono', monospace", fontSize: '0.65rem', padding: '0.2rem 0.5rem', cursor: 'pointer' }}
                  >
                    {keyCopied ? '✓ copied' : 'copy'}
                  </button>
                </div>
              </div>

              <div>
                <label style={{ display: 'block', fontFamily: "'DM Mono', monospace", fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '0.4rem' }}>BSV address</label>
                <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.6rem 0.75rem', fontFamily: "'DM Mono', monospace", fontSize: '0.7rem', color: 'var(--text-muted)', wordBreak: 'break-all' }}>
                  {address}
                </div>
              </div>

              <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.6rem', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={e => setAcknowledged(e.target.checked)}
                  style={{ marginTop: '2px', accentColor: 'var(--accent)', flexShrink: 0 }}
                />
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>I've saved my private key, or I understand I can only recover my account with my password</span>
              </label>

              {error && <p style={{ color: 'var(--coral)', fontSize: '0.8rem', margin: 0 }}>{error}</p>}

              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <button onClick={() => setStep('form')} className="nav-btn btn-ghost" style={{ flex: 1, padding: '0.6rem', fontSize: '0.875rem', borderRadius: '8px' }}>
                  ← Back
                </button>
                <button
                  onClick={handleConfirmAndRegister}
                  disabled={!acknowledged}
                  className="nav-btn btn-primary"
                  style={{ flex: 1, padding: '0.6rem', fontSize: '0.875rem', borderRadius: '8px', opacity: acknowledged ? 1 : 0.4, cursor: acknowledged ? 'pointer' : 'not-allowed' }}
                >
                  Launch Agent 🚀
                </button>
              </div>
            </div>
          )}

          {/* Loading */}
          {step === 'loading' && (
            <div style={{ textAlign: 'center', padding: '2.5rem 1rem' }}>
              <div style={{ fontSize: '2rem', marginBottom: '0.75rem', opacity: 0.8 }}>⟳</div>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Registering your agent...</p>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
