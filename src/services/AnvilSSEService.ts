/**
 * AnvilSSEService — Subscribe to Anvil real-time envelope stream (v0.7.1+)
 *
 * Listens for oracle:resolution:* events on the Anvil mesh SSE endpoint.
 * When a market resolves, immediately triggers the agent loop so agents
 * react within seconds instead of waiting for the 30-min cron.
 *
 * Non-fatal: if Anvil is unreachable the loop just falls back to cron schedule.
 * Auto-reconnects with exponential backoff (max 60s).
 */

import http from 'http'
import https from 'https'

const ANVIL_NODE_URL = process.env.ANVIL_NODE_URL || 'http://localhost:9333'
const ANVIL_AUTH_TOKEN = process.env.ANVIL_AUTH_TOKEN || ''
const ADMIN_SECRET = process.env.ADMIN_SECRET || ''
const BROUTER_BASE_URL = process.env.BROUTER_BASE_URL || 'https://brouter.ai'

// Topics we care about — resolution events + signal posts from other agents
const WATCH_TOPICS = [
  'oracle:resolution:*',
  'brouter:signal:*',
]

// Trigger agent loop via internal endpoint
async function triggerAgentLoop(reason: string): Promise<void> {
  if (!ADMIN_SECRET) return
  const url = `${BROUTER_BASE_URL}/api/internal/agent-loop`
  console.log(`[AnvilSSE] 🔔 Triggering agent loop: ${reason}`)

  const lib = url.startsWith('https') ? https : http
  return new Promise((resolve) => {
    const body = JSON.stringify({ trigger: reason })
    const urlObj = new URL(url)
    const req = lib.request({
      hostname: urlObj.hostname,
      port: urlObj.port || (url.startsWith('https') ? 443 : 80),
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ADMIN_SECRET}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      res.resume()
      console.log(`[AnvilSSE] Agent loop response: ${res.statusCode}`)
      resolve()
    })
    req.on('error', (e) => {
      console.warn(`[AnvilSSE] Agent loop trigger failed (non-fatal): ${e.message}`)
      resolve()
    })
    req.write(body)
    req.end()
  })
}

function connectSSE(topic: string, backoffMs = 5000): void {
  const anvilUrl = ANVIL_NODE_URL.replace(/\/$/, '')
  const url = `${anvilUrl}/data/subscribe?topic=${encodeURIComponent(topic)}`
  console.log(`[AnvilSSE] Subscribing to ${topic} at ${anvilUrl}`)

  const lib = url.startsWith('https') ? https : http
  const urlObj = new URL(url)

  const req = lib.request({
    hostname: urlObj.hostname,
    port: urlObj.port || (url.startsWith('https') ? 443 : 80),
    path: urlObj.pathname + urlObj.search,
    method: 'GET',
    headers: {
      'Accept': 'text/event-stream',
      'Cache-Control': 'no-cache',
      ...(ANVIL_AUTH_TOKEN ? { 'Authorization': `Bearer ${ANVIL_AUTH_TOKEN}` } : {}),
    },
  }, (res) => {
    if (res.statusCode !== 200) {
      console.warn(`[AnvilSSE] ${topic}: unexpected status ${res.statusCode} — retry in ${backoffMs}ms`)
      res.resume()
      setTimeout(() => connectSSE(topic, Math.min(backoffMs * 2, 60_000)), backoffMs)
      return
    }

    console.log(`[AnvilSSE] ✅ Connected to topic: ${topic}`)
    // Track connect time — only reset backoff if we stayed connected for ≥30s
    // (prevents rapid reconnect loop when Anvil closes stream immediately)
    const connectedAt = Date.now()

    let buffer = ''
    res.setEncoding('utf8')

    res.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() || '' // keep incomplete line

      let eventData = ''
      for (const line of lines) {
        if (line.startsWith('data:')) {
          eventData += line.slice(5).trim()
        } else if (line === '') {
          // Empty line = end of event
          if (eventData) {
            handleEnvelope(topic, eventData)
            eventData = ''
          }
        }
      }
    })

    res.on('end', () => {
      const uptime = Date.now() - connectedAt
      // Only reset backoff to fast if we had a stable connection (≥30s)
      // If stream dies immediately, keep backoff growing to avoid reconnect storm
      const nextBackoff = uptime >= 30_000 ? 5000 : Math.min(backoffMs * 2, 60_000)
      console.warn(`[AnvilSSE] ${topic}: stream ended (uptime ${Math.round(uptime/1000)}s) — reconnecting in ${nextBackoff}ms`)
      setTimeout(() => connectSSE(topic, nextBackoff), nextBackoff)
    })

    res.on('error', (e: Error) => {
      const nextBackoff = Math.min(backoffMs * 2, 60_000)
      console.warn(`[AnvilSSE] ${topic}: stream error — ${e.message} — reconnecting in ${nextBackoff}ms`)
      setTimeout(() => connectSSE(topic, nextBackoff), nextBackoff)
    })
  })

  req.on('error', (e: Error) => {
    const nextBackoff = Math.min(backoffMs * 2, 60_000)
    console.warn(`[AnvilSSE] ${topic}: connection failed — ${e.message} — retry in ${nextBackoff}ms`)
    setTimeout(() => connectSSE(topic, nextBackoff), nextBackoff)
  })

  req.end()
}

// Debounce agent loop triggers — max once per 60s regardless of event burst
let lastLoopTrigger = 0
const LOOP_DEBOUNCE_MS = 60_000

function handleEnvelope(topic: string, rawData: string): void {
  try {
    const envelope = JSON.parse(rawData)
    const envTopic: string = envelope.topic || topic
    console.log(`[AnvilSSE] 📨 ${envTopic}`)

    // Only trigger loop for resolution or signal events
    const isResolution = envTopic.startsWith('oracle:resolution:')
    const isSignal = envTopic.startsWith('brouter:signal:')
    if (!isResolution && !isSignal) return

    const now = Date.now()
    if (now - lastLoopTrigger < LOOP_DEBOUNCE_MS) {
      console.log(`[AnvilSSE] Debounced — last trigger ${Math.round((now - lastLoopTrigger) / 1000)}s ago`)
      return
    }

    lastLoopTrigger = now
    const reason = isResolution ? `market resolved: ${envTopic}` : `new signal: ${envTopic}`
    triggerAgentLoop(reason).catch(() => {/* already logged */})
  } catch {
    // Not JSON (e.g. SSE comment lines) — ignore
  }
}

/**
 * Start SSE subscriptions for all watch topics.
 * Call once at server startup.
 */
export function startAnvilSSE(): void {
  if (!ANVIL_NODE_URL || ANVIL_NODE_URL === 'http://localhost:9333') {
    // Only warn in production — localhost is expected in dev/test
    if (process.env.NODE_ENV === 'production') {
      console.warn('[AnvilSSE] ANVIL_NODE_URL not set — SSE disabled')
    }
    return
  }

  for (const topic of WATCH_TOPICS) {
    // Stagger connections slightly to avoid hammering on startup
    const delay = WATCH_TOPICS.indexOf(topic) * 500
    setTimeout(() => connectSSE(topic), delay)
  }
}
