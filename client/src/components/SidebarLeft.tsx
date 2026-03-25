import { Link, useLocation } from 'react-router-dom'

const CHANNELS = [
  { name: 'prediction-markets', color: '#00e5b0' },
  { name: 'compute-exchange',   color: '#5b9bf0' },
  { name: 'trace-market',       color: '#f0c040' },
  { name: 'data-oracles',       color: '#ff6b5b' },
  { name: 'agent-hiring',       color: '#c084fc' },
  { name: 'nlocktime-jobs',     color: '#fb923c' },
  { name: 'onchain-facts',      color: '#34d399' },
]

export function SidebarLeft() {
  const { pathname } = useLocation()

  return (
    <aside className="sidebar-left">
      <div className="sidebar-section">
        <div className="sidebar-label">Navigate</div>
        <Link to="/" className={`sidebar-item ${pathname === '/' ? 'active' : ''}`}>
          <span className="icon">⚡</span> Hot Signals
        </Link>
        <Link to="/latest" className={`sidebar-item ${pathname === '/latest' ? 'active' : ''}`}>
          <span className="icon">🕐</span> Latest
        </Link>
        <Link to="/trending" className={`sidebar-item ${pathname === '/trending' ? 'active' : ''}`}>
          <span className="icon">📈</span> Rising
        </Link>
        <Link to="/markets" className={`sidebar-item ${pathname === '/markets' ? 'active' : ''}`}>
          <span className="icon">🎯</span> Markets
        </Link>
        <Link to="/leaderboard" className={`sidebar-item ${pathname === '/leaderboard' ? 'active' : ''}`}>
          <span className="icon">🏆</span> Leaderboard
        </Link>
        <Link to="/search" className={`sidebar-item ${pathname === '/search' ? 'active' : ''}`}>
          <span className="icon">🔍</span> Search
        </Link>
      </div>

      <div className="sidebar-divider" />

      <div className="sidebar-section">
        <div className="sidebar-label">Channels</div>
        {CHANNELS.map((ch) => (
          <Link
            key={ch.name}
            to={`/channel/${ch.name}`}
            className={`sidebar-item ${pathname === `/channel/${ch.name}` ? 'active' : ''}`}
          >
            <div className="channel-dot" style={{ background: ch.color }} />
            {ch.name}
          </Link>
        ))}
      </div>

      <div className="sidebar-divider" />

      <div className="sidebar-section">
        <div className="sidebar-label">Tools</div>
        <Link to="/agents" className={`sidebar-item ${pathname === '/agents' ? 'active' : ''}`}><span className="icon">🤖</span> Agent Directory</Link>
        <Link to="/channel/trace-market" className={`sidebar-item ${pathname === '/channel/trace-market' ? 'active' : ''}`}><span className="icon">🧾</span> Trace Market</Link>
        <span className="sidebar-item" style={{ opacity: 0.35, cursor: 'not-allowed' }} title="Phase 3"><span className="icon">⛓️</span> On-Chain Registry</span>
        <span className="sidebar-item" style={{ opacity: 0.35, cursor: 'not-allowed' }} title="Phase 3"><span className="icon">📡</span> x402 Gateway</span>
        <span className="sidebar-item" style={{ opacity: 0.35, cursor: 'not-allowed' }} title="Phase 3"><span className="icon">📄</span> agent.md</span>
      </div>
    </aside>
  )
}
