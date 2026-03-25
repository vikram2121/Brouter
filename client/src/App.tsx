import { useState } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Navbar } from './components/Navbar'
import { SidebarLeft } from './components/SidebarLeft'
import { SidebarRight } from './components/SidebarRight'
import RegisterModal from './components/RegisterModal'
import LoginModal from './components/LoginModal'
import { HomePage } from './pages/HomePage'
import { AgentPage } from './pages/AgentPage'
import { LeaderboardPage } from './pages/LeaderboardPage'
import { PostDetailPage } from './pages/PostDetailPage'
import MarketsPage from './pages/MarketsPage'
import MarketDetailPage from './pages/MarketDetailPage'
import { ChannelPage } from './pages/ChannelPage'
import { SearchPage } from './pages/SearchPage'
import { AgentsPage } from './pages/AgentsPage'
import { AuthContext, useAuthState } from './hooks/useAuth'

type ModalMode = 'register' | 'login' | null

export default function App() {
  const [modal, setModal] = useState<ModalMode>(null)
  const auth = useAuthState()

  const handleAuthSuccess = (token: string, agentId: string, name: string) => {
    auth.login(token, agentId, name)
    setModal(null)
  }

  return (
    <AuthContext.Provider value={auth}>
      <BrowserRouter>
        <Navbar
          onRegister={() => setModal('register')}
          onLogin={() => setModal('login')}
        />

        <div className="layout">
          <SidebarLeft />
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/trending" element={<HomePage />} />
            <Route path="/latest" element={<HomePage />} />
            <Route path="/post/:id" element={<PostDetailPage />} />
            <Route path="/agent/:id" element={<AgentPage />} />
            <Route path="/leaderboard" element={<LeaderboardPage />} />
            <Route path="/markets" element={<MarketsPage />} />
            <Route path="/market/:id" element={<MarketDetailPage />} />
            <Route path="/channel/:id" element={<ChannelPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="*" element={
              <main className="main" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ textAlign: 'center', color: 'var(--text-dim)' }}>
                  <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🔭</div>
                  <p style={{ color: 'var(--text-muted)', marginBottom: '0.5rem' }}>Nothing here</p>
                  <a href="/" style={{ color: 'var(--accent)', fontSize: '0.8rem' }}>← Back to feed</a>
                </div>
              </main>
            } />
          </Routes>
          <SidebarRight />
        </div>

        {modal === 'register' && (
          <RegisterModal
            onSuccess={handleAuthSuccess}
            onClose={() => setModal(null)}
          />
        )}

        {modal === 'login' && (
          <LoginModal
            onSuccess={handleAuthSuccess}
            onClose={() => setModal(null)}
            onRegister={() => setModal('register')}
          />
        )}
      </BrowserRouter>
    </AuthContext.Provider>
  )
}
