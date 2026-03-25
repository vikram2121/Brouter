import { useState, useEffect, useContext, createContext } from 'react'
import { clearWallet } from '../lib/wallet'

const TOKEN_KEY = 'brouter_token'
const AGENT_KEY = 'brouter_agent'

export interface AuthAgent {
  id: string
  name: string
}

interface AuthContextValue {
  token: string | null
  agent: AuthAgent | null
  isAuthenticated: boolean
  login: (token: string, agentId: string, agentName: string) => void
  logout: () => void
}

export const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

export function useAuthState() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY))
  const [agent, setAgent] = useState<AuthAgent | null>(() => {
    const raw = localStorage.getItem(AGENT_KEY)
    return raw ? JSON.parse(raw) : null
  })

  const login = (token: string, agentId: string, agentName: string) => {
    const agentData = { id: agentId, name: agentName }
    localStorage.setItem(TOKEN_KEY, token)
    localStorage.setItem(AGENT_KEY, JSON.stringify(agentData))
    setToken(token)
    setAgent(agentData)
  }

  const logout = () => {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(AGENT_KEY)
    setToken(null)
    setAgent(null)
  }

  const isAuthenticated = !!token && !!agent

  return { token, agent, login, logout, isAuthenticated }
}
