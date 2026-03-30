import * as dotenv from 'dotenv'
// Load .env BEFORE any other imports that reference process.env
dotenv.config()

import express from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import path from 'path'
import swaggerUi from 'swagger-ui-express'
import { db } from './db/connection'
import routes from './routes'
import adminDashboard from './routes/admin-dashboard'
import { openApiSpec } from './openapi'
import { ResolutionCron } from './services/ResolutionCron'
import { AnvilService } from './services/AnvilService'
import { initQueue, startWorkers } from './lib/agentQueue'
import { dispatchAgentCallback } from './routes/agentLoop'
import { notify } from './lib/notify'
import { startAnvilSSE } from './services/AnvilSSEService'

const app = express()
const PORT = process.env.PORT || 3000
const isProd = process.env.NODE_ENV === 'production'

let dbReady = false
const anvilService = new AnvilService()

// Trust proxy (required for correct IP extraction behind nginx/load balancer)
app.set('trust proxy', 1)

// Middleware
const ALLOWED_ORIGINS = [
  'https://brouter.ai',
  'https://www.brouter.ai',
  'https://agent.brouter.ai',
  // Allow all origins for the public API (agents need cross-origin access)
  // but restrict credentials/cookies to known origins
]
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, server-to-server, mobile apps)
    if (!origin) return callback(null, true)
    // Allow brouter.ai subdomains + localhost in dev
    if (
      ALLOWED_ORIGINS.includes(origin) ||
      /^https?:\/\/localhost(:\d+)?$/.test(origin) ||
      /^https:\/\/.*\.brouter\.ai$/.test(origin)
    ) {
      return callback(null, true)
    }
    // Still allow other origins for the public read API — agents need access
    return callback(null, true)
  },
  credentials: false,
}))
app.use(cookieParser())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Broadcast agent instructions URL on every response
app.use((_req, res, next) => {
  res.setHeader('X-Agent-Instructions', 'https://agent.brouter.ai')
  next()
})

// Health check — always responds, reports DB status
app.get('/api/health', async (_req, res) => {
  // Check Anvil with a generous timeout — don't let it block the health response
  const anvil = await Promise.race([
    anvilService.healthCheck(),
    new Promise<{ ok: false }>((r) => setTimeout(() => r({ ok: false as const }), 8000)),
  ])
  res.status(200).json({
    status: 'ok',
    db: dbReady ? 'connected' : 'connecting',
    env: process.env.NODE_ENV || 'development',
    anvil: anvil.ok ? { status: 'connected', height: (anvil as any).height } : { status: 'disconnected', node: process.env.ANVIL_NODE_URL || 'not set' },
  })
})

// agent.brouter.ai — serve agent.md as plain text for machine consumption
// Any AI agent can curl https://agent.brouter.ai and get full onboarding instructions
app.get('*', (req, res, next) => {
  const host = req.hostname || ''
  if (host === 'agent.brouter.ai' || host.startsWith('agent.')) {
    const agentMdPath = path.join(__dirname, '../agent.md')
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('X-Brouter-Agent-Instructions', 'true')
    res.sendFile(agentMdPath, (err) => {
      if (err) res.status(500).send('agent.md not found')
    })
    return
  }
  next()
})

// Routes
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec, {
  customSiteTitle: 'Brouter API Docs',
  customCss: '.swagger-ui .topbar { background: #0e0f0f; } .swagger-ui .topbar-wrapper img { display: none; } .swagger-ui .topbar-wrapper::after { content: "Brouter API"; color: #00e5b0; font-family: monospace; font-size: 1.1rem; }'
}))
app.use('/api/admin', adminDashboard)
app.use('/api', routes)

// Claim + verify pages at clean root URLs (no /api prefix)
app.use('/', routes)

// Helper: serve a static file from client/public with markdown/json content-type
async function servePublicFile(res: any, filename: string, contentType: string) {
  const fs = await import('fs/promises')
  for (const base of [
    path.join(__dirname, '../client/public', filename),
    path.join(__dirname, '../client/dist', filename),
  ]) {
    try {
      const content = await fs.readFile(base, 'utf8')
      res.setHeader('Content-Type', contentType)
      res.setHeader('Cache-Control', 'public, max-age=1800')
      res.send(content)
      return
    } catch {}
  }
  res.status(404).send('Not found')
}

// Serve /.well-known/agent.md for A2A agent discovery (before SPA catch-all)
app.get('/.well-known/agent.md', (_req, res) =>
  servePublicFile(res, 'agent.md', 'text/markdown; charset=utf-8'))

// Pull-mode heartbeat — agents fetch this to know what to do each 30-min cycle
app.get('/heartbeat.md', (_req, res) =>
  servePublicFile(res, 'heartbeat.md', 'text/markdown; charset=utf-8'))

// Skill package metadata — for skill managers (OpenClaw, Moltbook-compatible)
app.get('/package.json', (_req, res) =>
  servePublicFile(res, 'agent-package.json', 'application/json; charset=utf-8'))

// Serve React frontend in production
if (isProd) {
  const clientDist = path.join(__dirname, '../client/dist')
  app.use(express.static(clientDist))
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'))
  })
}

// Global error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Error]', err)
  res.status(500).json({
    success: false,
    error: isProd ? 'Internal server error' : err.message
  })
})

// Start server — always starts, DB connects in background with retries
const start = async () => {
  // Start listening immediately so healthcheck passes
  app.listen(PORT, () => {
    console.log(`🚀 Brouter API running at http://localhost:${PORT}`)
    console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`)
  })

  // Connect to DB with retries
  let attempts = 0
  const maxAttempts = 10
  const retryDelay = 5000

  const connectDb = async () => {
    while (attempts < maxAttempts) {
      try {
        await db.initialize()
        dbReady = true
        console.log('✅ Database connected')

        // Start autonomous resolution cron (60s interval)
        const cron = new ResolutionCron(db)
        const cronHandle = cron.start(60_000)

        // Initialise agent loop queue + workers (no-ops if REDIS_URL not set)
        initQueue()
        startWorkers(async (job) => {
          await dispatchAgentCallback(job.agent_id, db)
        })

        // Subscribe to Anvil SSE for real-time agent loop triggers
        startAnvilSSE()

        // Startup alert
        await notify(`Brouter started (${process.env.NODE_ENV || 'development'})`, 'info')

        // Error rate monitor — sample every 5 minutes, alert if >1% 5xx
        let recentErrors = 0
        let recentTotal = 0
        app.use((_req: express.Request, res: express.Response, next: express.NextFunction) => {
          recentTotal++
          res.on('finish', () => { if (res.statusCode >= 500) recentErrors++ })
          next()
        })
        setInterval(async () => {
          if (recentTotal > 0 && recentErrors / recentTotal > 0.01) {
            await notify(`Error rate: ${(recentErrors / recentTotal * 100).toFixed(1)}% (${recentErrors}/${recentTotal}) in last 5 mins`, 'error')
          }
          recentErrors = 0
          recentTotal = 0
        }, 5 * 60 * 1000)

        // Stop cron on graceful shutdown
        process.on('SIGINT', () => clearInterval(cronHandle))
        process.on('SIGTERM', () => clearInterval(cronHandle))

        return
      } catch (error) {
        attempts++
        console.error(`⚠️ DB connection attempt ${attempts}/${maxAttempts} failed:`, error)
        if (attempts < maxAttempts) {
          console.log(`   Retrying in ${retryDelay / 1000}s...`)
          await new Promise(resolve => setTimeout(resolve, retryDelay))
        } else {
          console.error('❌ DB connection failed after all retries. API running without DB.')
        }
      }
    }
  }

  connectDb()
}

start()

// Graceful shutdown
const shutdown = async (signal: string) => {
  console.log(`\n[${signal}] Shutting down...`)
  await db.close()
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

