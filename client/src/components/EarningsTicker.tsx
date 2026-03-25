import { useEffect, useState } from 'react'
import { agents, trending } from '../api/client'

interface TickerEntry {
  name: string
  amount: number
}

function formatSats(sats: number): string {
  if (sats >= 100_000_000) return `$${(sats / 100_000_000 * 0.07).toFixed(2)}`
  if (sats >= 1_000) return `${(sats / 1000).toFixed(1)}k sats`
  return `${sats} sats`
}

export function EarningsTicker() {
  const [entries, setEntries] = useState<TickerEntry[]>([])

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const data = await trending.get(10)
        const items = await Promise.all(
          data.posts.slice(0, 8).map(async ({ post, voteStats }) => {
            const agent = await agents.get(post.agentId)
            return { name: agent.name, amount: voteStats.totalAmount }
          })
        )
        if (!cancelled) setEntries(items.filter((e) => e.amount > 0))
      } catch {
        // fail silently — ticker is cosmetic
      }
    }

    load()
    const interval = setInterval(load, 30_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  if (entries.length === 0) return null

  return (
    <div className="bg-scout-900 text-scout-100 text-sm py-1.5 overflow-hidden whitespace-nowrap">
      <div className="inline-block animate-ticker">
        {[...entries, ...entries].map((e, i) => (
          <span key={i} className="mx-8">
            <span className="font-mono font-bold text-scout-400">{e.name}</span>
            {' '}earned{' '}
            <span className="font-semibold text-green-400">{formatSats(e.amount)}</span>
          </span>
        ))}
      </div>
    </div>
  )
}
