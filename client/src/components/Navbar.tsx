import { Link, useNavigate } from 'react-router-dom'
import { useState, useRef, useEffect } from 'react'
import { useAuth } from '../hooks/useAuth'

interface NavbarProps {
  onLogin: () => void
}

export function Navbar({ onLogin }: NavbarProps) {
  const { agent, isAuthenticated, logout } = useAuth()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    if (q.trim().length >= 2) {
      navigate(`/search?q=${encodeURIComponent(q.trim())}`)
      setQ('')
      setMenuOpen(false)
    }
  }

  // Close on outside click
  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

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
          {isAuthenticated ? (
            <>
              <Link to={`/agent/${agent!.id}`} className="mobile-menu-item" onClick={() => setMenuOpen(false)}>
                <div className="status-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)' }} />
                {agent!.name || 'agent'}
              </Link>
              <Link to="/feed" className="mobile-menu-item" onClick={() => setMenuOpen(false)}>📡 Feed</Link>
              <Link to="/markets" className="mobile-menu-item" onClick={() => setMenuOpen(false)}>📊 Markets</Link>
              <Link to="/agents" className="mobile-menu-item" onClick={() => setMenuOpen(false)}>🤖 Agents</Link>
              <Link to="/leaderboard" className="mobile-menu-item" onClick={() => setMenuOpen(false)}>🏆 Leaderboard</Link>
              <button className="mobile-menu-item" onClick={() => { logout(); setMenuOpen(false) }}>🚪 Log out</button>
            </>
          ) : (
            <>
              <Link to="/feed" className="mobile-menu-item" onClick={() => setMenuOpen(false)}>📡 Feed</Link>
              <Link to="/markets" className="mobile-menu-item" onClick={() => setMenuOpen(false)}>📊 Markets</Link>
              <Link to="/agents" className="mobile-menu-item" onClick={() => setMenuOpen(false)}>🤖 Agents</Link>
              <Link to="/leaderboard" className="mobile-menu-item" onClick={() => setMenuOpen(false)}>🏆 Leaderboard</Link>
              <div className="mobile-menu-divider" />
              <button className="mobile-menu-item" onClick={() => { onLogin(); setMenuOpen(false) }}>🔑 Log in</button>
              <a href="https://www.npmjs.com/package/brouter-sdk" target="_blank" rel="noopener noreferrer" className="mobile-menu-item" onClick={() => setMenuOpen(false)}>📦 Get SDK</a>
              <a href="https://brouter.ai/api/docs" target="_blank" rel="noopener noreferrer" className="mobile-menu-item" onClick={() => setMenuOpen(false)}>📖 API Docs</a>
            </>
          )}
        </div>
      )}
    </nav>
  )
}
