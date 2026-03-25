import { useEffect, useState } from 'react'

export interface PricePoint {
  timestamp: number
  prob: number  // YES probability (0-1 scale)
  source: string
}

interface PriceChartProps {
  marketId: string
  title?: string
  height?: number
}

/**
 * Lightweight SVG price chart
 * Shows YES/NO probabilities over time
 */
export function PriceChart({ marketId, title, height = 200 }: PriceChartProps) {
  const [prices, setPrices] = useState<PricePoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)

    fetch(`/api/markets/${marketId}/price-history?hours=168`)
      .then(r => r.json())
      .then(res => {
        if (res.success === false) {
          setError(res.error)
          return
        }
        setPrices(res.data || [])
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [marketId])

  if (loading) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '0.75rem' }}>
        Loading price history...
      </div>
    )
  }

  if (error || prices.length === 0) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '0.75rem' }}>
        {error ? `Price data unavailable: ${error}` : 'No price history'}
      </div>
    )
  }

  // Chart dimensions
  const width = 600
  const padding = 40
  const chartWidth = width - padding * 2
  const chartHeight = height - padding * 2

  // Find min/max for scaling
  const minTime = Math.min(...prices.map(p => p.timestamp))
  const maxTime = Math.max(...prices.map(p => p.timestamp))
  const timeRange = maxTime - minTime || 1

  // Scale functions
  const xScale = (timestamp: number) => {
    return padding + ((timestamp - minTime) / timeRange) * chartWidth
  }

  const yScale = (prob: number) => {
    return height - padding - (prob * chartHeight)
  }

  // Build path strings for YES and NO lines
  const yesPath = prices.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xScale(p.timestamp)} ${yScale(p.prob)}`).join(' ')
  const noPath = prices.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xScale(p.timestamp)} ${yScale(1 - p.prob)}`).join(' ')

  // Format time labels (show first, last, and maybe middle)
  const timeLabels = [
    { time: minTime, label: new Date(minTime).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) },
    { time: maxTime, label: new Date(maxTime).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }
  ]

  return (
    <div style={{ marginBottom: '1.5rem' }}>
      {title && <div style={{ fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem', color: 'var(--text-primary)' }}>{title}</div>}

      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ border: '1px solid var(--border)', borderRadius: '0.375rem', backgroundColor: 'var(--bg-secondary)' }}
      >
        {/* Grid lines */}
        {[0.25, 0.5, 0.75].map((prob) => (
          <line
            key={`grid-${prob}`}
            x1={padding}
            y1={yScale(prob)}
            x2={width - padding}
            y2={yScale(prob)}
            stroke="var(--border)"
            strokeDasharray="2,2"
            opacity="0.5"
          />
        ))}

        {/* Y-axis */}
        <line x1={padding} y1={padding} x2={padding} y2={height - padding} stroke="var(--border)" />

        {/* X-axis */}
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="var(--border)" />

        {/* YES probability line */}
        <path d={yesPath} stroke="#00e5b0" fill="none" strokeWidth="2" opacity="0.8" />

        {/* NO probability line */}
        <path d={noPath} stroke="#ff6b5b" fill="none" strokeWidth="2" opacity="0.8" />

        {/* Y-axis labels */}
        {[0, 0.25, 0.5, 0.75, 1].map((prob) => (
          <g key={`label-y-${prob}`}>
            <text
              x={padding - 8}
              y={yScale(prob) + 4}
              textAnchor="end"
              fontSize="11"
              fill="var(--text-muted)"
              fontFamily="DM Mono, monospace"
            >
              {Math.round(prob * 100)}%
            </text>
          </g>
        ))}

        {/* X-axis labels */}
        {timeLabels.map(({ time, label }) => (
          <g key={`label-x-${time}`}>
            <text
              x={xScale(time)}
              y={height - 8}
              textAnchor="middle"
              fontSize="11"
              fill="var(--text-muted)"
              fontFamily="DM Mono, monospace"
            >
              {label}
            </text>
          </g>
        ))}
      </svg>

      {/* Legend */}
      <div style={{ display: 'flex', gap: '1rem', marginTop: '0.75rem', fontSize: '0.75rem', fontFamily: 'DM Mono, monospace' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <div style={{ width: '12px', height: '2px', backgroundColor: '#00e5b0' }}></div>
          <span>YES probability</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <div style={{ width: '12px', height: '2px', backgroundColor: '#ff6b5b' }}></div>
          <span>NO probability</span>
        </div>
        <div style={{ marginLeft: 'auto', color: 'var(--text-muted)' }}>Last 7 days</div>
      </div>
    </div>
  )
}
