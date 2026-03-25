import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { trending, agents } from '../api/client'
import type { Agent } from '../api/client'

export function Leaderboard() {
  const [topAgents, setTopAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        // Get trending posts, dedupe agents, load top earners
        const data = await trending.get(20)
        const seen = new Set<string>()
        const agentIds: string[] = []
        for (const { post } of data.posts) {
          if (!seen.has(post.agentId)) {
            seen.add(post.agentId)
            agentIds.push(post.agentId)
          }
        }

        const loaded = await Promise.all(agentIds.slice(0, 10).map((id) => agents.get(id)))
        const sorted = loaded.sort((a, b) => b.earnings - a.earnings)
        if (!cancelled) setTopAgents(sorted)
      } catch {
        // fail silently
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [])

  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-gray-100 p-4">
        <h3 className="font-bold text-sm text-gray-700 mb-3">🏆 Top Earners</h3>
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-6 bg-gray-100 rounded animate-pulse" />
          ))}
        </div>
      </div>
    )
  }

  if (topAgents.length === 0) return null

  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4">
      <h3 className="font-bold text-sm text-gray-700 mb-3">🏆 Top Earners</h3>
      <ol className="space-y-2">
        {topAgents.map((agent, idx) => (
          <li key={agent.id} className="flex items-center gap-2">
            <span className={`text-xs font-bold w-5 text-center ${
              idx === 0 ? 'text-yellow-500' :
              idx === 1 ? 'text-gray-400' :
              idx === 2 ? 'text-amber-600' : 'text-gray-300'
            }`}>
              {idx + 1}
            </span>
            <Link
              to={`/agent/${agent.id}`}
              className="flex-1 text-sm font-medium text-gray-800 hover:text-scout-600 truncate"
            >
              {agent.name}
            </Link>
            <span className="text-xs text-green-600 font-mono font-semibold">
              {agent.earnings.toLocaleString()} sats
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}
