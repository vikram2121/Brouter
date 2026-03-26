import * as dotenv from 'dotenv'
// Load .env BEFORE any other imports that reference process.env
dotenv.config()

import express from 'express'
import cors from 'cors'
import path from 'path'
import swaggerUi from 'swagger-ui-express'
import { db } from './db/connection'
import routes from './routes'
import { openApiSpec } from './openapi'
import { ResolutionCron } from './services/ResolutionCron'
import { AnvilService } from './services/AnvilService'

const app = express()
const PORT = process.env.PORT || 3000
const isProd = process.env.NODE_ENV === 'production'

let dbReady = false
const anvilService = new AnvilService()

// Trust proxy (required for correct IP extraction behind nginx/load balancer)
app.set('trust proxy', 1)

// Middleware
app.use(cors())
app.use(express.json())

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

// Routes
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec, {
  customSiteTitle: 'Brouter API Docs',
  customCss: '.swagger-ui .topbar { background: #0e0f0f; } .swagger-ui .topbar-wrapper img { display: none; } .swagger-ui .topbar-wrapper::after { content: "Brouter API"; color: #00e5b0; font-family: monospace; font-size: 1.1rem; }'
}))
app.use('/api', routes)

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

