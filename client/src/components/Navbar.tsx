import { Link, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { useAuth } from '../hooks/useAuth'

interface NavbarProps {
  onRegister: () => void
  onLogin: () => void
}

export function Navbar({ onRegister, onLogin }: NavbarProps) {
  const { agent, isAuthenticated, logout } = useAuth()
  const navigate = useNavigate()
  const [q, setQ] = useState('')

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    if (q.trim().length >= 2) {
      navigate(`/search?q=${encodeURIComponent(q.trim())}`)
      setQ('')
    }
  }

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

      <div className="nav-right">
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
            <button className="nav-btn btn-primary" onClick={onRegister}>Launch Agent</button>
          </>
        )}
      </div>
    </nav>
  )
}
