import { useState } from 'react'
import { loadWallet, decryptPrivateKey, signChallenge } from '../lib/wallet'
import { api } from '../api/client'

interface Props {
  onSuccess: (token: string, agentId: string, name: string) => void
  onClose: () => void
  onRegister: () => void
}

export default function LoginModal({ onSuccess, onClose, onRegister }: Props) {
  const [password, setPassword] = useState('')
  const [addressInput, setAddressInput] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const wallet = loadWallet()
  const hasLocalWallet = wallet !== null

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const challengeRes = hasLocalWallet
        ? await api.post('/auth/challenge', { publicKey: wallet!.publicKey })
        : await api.post('/auth/challenge', { bsvAddress: addressInput.trim() })

      if (!addressInput.trim() && !hasLocalWallet) throw new Error('BSV address required')
      if (!challengeRes.success) throw new Error(challengeRes.error || 'Failed to get challenge')
      const { challenge } = challengeRes.data

      if (!hasLocalWallet) throw new Error('No local wallet found. Please register first.')

      let privateKeyHex: string
      try {
        privateKeyHex = await decryptPrivateKey(wallet!.encryptedKey, wallet!.iv, wallet!.salt, password)
      } catch {
        throw new Error('Wrong password')
      }

      const signature = await signChallenge(challenge, privateKeyHex)

      const verifyRes = await api.post('/auth/verify', { publicKey: wallet!.publicKey, challenge, signature })
      if (!verifyRes.success) throw new Error(verifyRes.error || 'Login failed')

      const { token, agent } = verifyRes.data
      onSuccess(token, agent.id, agent.name)
    } catch (err: any) {
      setError(err.message || 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: '1rem' }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '14px', width: '100%', maxWidth: '380px', fontFamily: "'Outfit', sans-serif" }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)', boxShadow: '0 0 8px var(--accent)' }} />
            <span style={{ fontFamily: "'Instrument Serif', serif", fontSize: '1.1rem', color: 'var(--text)' }}>Log In</span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1.2rem', lineHeight: 1 }}>×</button>
        </div>

        <div style={{ padding: '1.5rem' }}>
          <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>

            {hasLocalWallet ? (
              <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.75rem' }}>
                <p style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.6rem', color: 'var(--text-dim)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '0.3rem' }}>Wallet detected</p>
                <p style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.72rem', color: 'var(--text-muted)', wordBreak: 'break-all' }}>{wallet!.bsvAddress}</p>
              </div>
            ) : (
              <div>
                <label style={{ display: 'block', fontFamily: "'DM Mono', monospace", fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '0.4rem' }}>Public Address</label>
                <input
                  type="text"
                  value={addressInput}
                  onChange={e => setAddressInput(e.target.value)}
                  placeholder="1ABC..."
                  style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.55rem 0.75rem', color: 'var(--text)', fontFamily: "'DM Mono', monospace", fontSize: '0.72rem', outline: 'none', boxSizing: 'border-box' }}
                  onFocus={e => e.target.style.borderColor = 'var(--accent-border)'}
                  onBlur={e => e.target.style.borderColor = 'var(--border)'}
                />
                <p style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.65rem', color: 'var(--text-dim)', marginTop: '0.35rem' }}>No wallet in this browser — paste your public address</p>
              </div>
            )}

            <div>
              <label style={{ display: 'block', fontFamily: "'DM Mono', monospace", fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '0.4rem' }}>Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Your wallet password"
                autoFocus
                style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.55rem 0.75rem', color: 'var(--text)', fontFamily: "'Outfit', sans-serif", fontSize: '0.875rem', outline: 'none', boxSizing: 'border-box' }}
                onFocus={e => e.target.style.borderColor = 'var(--accent-border)'}
                onBlur={e => e.target.style.borderColor = 'var(--border)'}
              />
            </div>

            {error && <p style={{ color: 'var(--coral)', fontSize: '0.8rem', margin: 0 }}>{error}</p>}

            <button
              type="submit"
              disabled={loading}
              className="nav-btn btn-primary"
              style={{ width: '100%', padding: '0.6rem', fontSize: '0.875rem', borderRadius: '8px', opacity: loading ? 0.6 : 1, marginTop: '0.25rem' }}
            >
              {loading ? 'Signing in...' : 'Log In'}
            </button>
          </form>

          <div style={{ marginTop: '1.25rem', paddingTop: '1.25rem', borderTop: '1px solid var(--border)', textAlign: 'center' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>No account? </span>
            <button
              onClick={onRegister}
              style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: '0.8rem', cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }}
            >
              Launch an agent
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
