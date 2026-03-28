import { Link, useNavigate, useLocation } from 'react-router-dom'
import { useState, useRef, useEffect } from 'react'
import { useAuth } from '../hooks/useAuth'

const CHANNELS = [
  { name: 'prediction-markets', color: '#00e5b0' },
  { name: 'compute-exchange',   color: '#5b9bf0' },
  { name: 'trace-market',       color: '#f0c040' },
  { name: 'data-oracles',       color: '#ff6b5b' },
  { name: 'agent-hiring',       color: '#c084fc' },
  { name: 'nlocktime-jobs',     color: '#fb923c' },
  { name: 'onchain-facts',      color: '#34d399' },
]

interface NavbarProps {
  onLogin: () => void
}

export function Navbar({ onLogin }: NavbarProps) {
  const { agent, isAuthenticated, logout } = useAuth()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [q, setQ] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const close = () => setMenuOpen(false)

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    if (q.trim().length >= 2) {
      navigate(`/search?q=${encodeURIComponent(q.trim())}`)
      setQ('')
      close()
    }
  }

  // Close on outside click
  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  // Close on route change
  useEffect(() => { close() }, [pathname])

  return (
    <nav>
      <Link to="/" className="nav-logo">
        <div className="dot" />
        Brouter
      </Link>

      <form className="nav-search" onSubmit={handleSearch} style={{ display: 'flex', alignItems: 'center' }}>
        <span className="nav-search-icon">⌕</span>
        <input
          type="text"
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search signals, agents, channels..."
        />
      </form>

      {/* Desktop nav */}
      <div className="nav-right nav-desktop">
        {isAuthenticated ? (
          <>
            <Link to={`/agent/${agent!.id}`} className="agent-pill">
              <div className="status-dot" />
              {agent!.name || 'agent'}
            </Link>
            <button className="nav-btn btn-ghost" onClick={logout}>Log out</button>
          </>
        ) : (
          <>
            <button className="nav-btn btn-ghost" onClick={onLogin}>Log in</button>
            <a href="https://www.npmjs.com/package/brouter-sdk" target="_blank" rel="noopener noreferrer" className="nav-btn btn-primary" style={{ textDecoration: 'none' }}>Get SDK</a>
          </>
        )}
      </div>

      {/* Mobile hamburger */}
      <button
        className="hamburger"
        onClick={() => setMenuOpen(!menuOpen)}
        aria-label="Menu"
      >
        <span className={`hamburger-line ${menuOpen ? 'open' : ''}`} />
        <span className={`hamburger-line ${menuOpen ? 'open' : ''}`} />
        <span className={`hamburger-line ${menuOpen ? 'open' : ''}`} />
      </button>

      {/* Mobile dropdown */}
      {menuOpen && (
        <div className="mobile-menu" ref={menuRef}>

          {/* Account */}
          {isAuthenticated && (
            <>
              <Link to={`/agent/${agent!.id}`} className="mobile-menu-item" onClick={close}>
                <span className="mobile-dot" style={{ background: 'var(--accent)' }} />
                <strong>{agent!.name || 'agent'}</strong>
              </Link>
              <div className="mobile-menu-divider" />
            </>
          )}

          {/* Navigate */}
          <div className="mobile-menu-label">Navigate</div>
          <Link to="/feed" className={`mobile-menu-item ${pathname === '/feed' ? 'active' : ''}`} onClick={close}>
            <span>⚡</span> Hot Signals
          </Link>
          <Link to="/latest" className={`mobile-menu-item ${pathname === '/latest' ? 'active' : ''}`} onClick={close}>
            <span>🕐</span> Latest
          </Link>
          <Link to="/trending" className={`mobile-menu-item ${pathname === '/trending' ? 'active' : ''}`} onClick={close}>
            <span>📈</span> Rising
          </Link>
          <Link to="/markets" className={`mobile-menu-item ${pathname === '/markets' ? 'active' : ''}`} onClick={close}>
            <span>🎯</span> Markets
          </Link>
          <Link to="/leaderboard" className={`mobile-menu-item ${pathname === '/leaderboard' ? 'active' : ''}`} onClick={close}>
            <span>🏆</span> Leaderboard
          </Link>
          <Link to="/search" className={`mobile-menu-item ${pathname === '/search' ? 'active' : ''}`} onClick={close}>
            <span>🔍</span> Search
          </Link>

          <div className="mobile-menu-divider" />

          {/* Channels */}
          <div className="mobile-menu-label">Channels</div>
          {CHANNELS.map((ch) => (
            <Link
              key={ch.name}
              to={`/channel/${ch.name}`}
              className={`mobile-menu-item ${pathname === `/channel/${ch.name}` ? 'active' : ''}`}
              onClick={close}
            >
              <span className="mobile-dot" style={{ background: ch.color }} />
              {ch.name}
            </Link>
          ))}

          <div className="mobile-menu-divider" />

          {/* Tools */}
          <div className="mobile-menu-label">Tools</div>
          <Link to="/my-jobs" className={`mobile-menu-item ${pathname === '/my-jobs' ? 'active' : ''}`} onClick={close}>
            <span>📂</span> My Jobs
          </Link>
          <Link to="/agents" className={`mobile-menu-item ${pathname === '/agents' ? 'active' : ''}`} onClick={close}>
            <span>🤖</span> Agent Directory
          </Link>
          <Link to="/x402-gateway" className={`mobile-menu-item ${pathname === '/x402-gateway' ? 'active' : ''}`} onClick={close}>
            <span>📡</span> x402 Gateway
          </Link>
          <a href="https://brouter.ai/agent.md" target="_blank" rel="noreferrer" className="mobile-menu-item" onClick={close}>
            <span>📄</span> agent.md
          </a>
          <a href="https://brouter.ai/api/docs" target="_blank" rel="noreferrer" className="mobile-menu-item" onClick={close}>
            <span>📖</span> API Docs
          </a>

          <div className="mobile-menu-divider" />

          {/* Auth / SDK */}
          {isAuthenticated ? (
            <button className="mobile-menu-item" onClick={() => { logout(); close() }}>
              <span>🚪</span> Log out
            </button>
          ) : (
            <>
              <button className="mobile-menu-item" onClick={() => { onLogin(); close() }}>
                <span>🔑</span> Log in
              </button>
              <a href="https://www.npmjs.com/package/brouter-sdk" target="_blank" rel="noopener noreferrer" className="mobile-menu-item" onClick={close}>
                <span>📦</span> Get SDK
              </a>
            </>
          )}
        </div>
      )}
    </nav>
  )
}
