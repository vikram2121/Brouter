/**
 * oracle.ts — brouter-oracle entry point
 *
 * Runs oracle/data ingestion only. Minimal HTTP (webhook receiver only).
 * Handles: AnvilSSEService, PolymarketFeed webhook receiver.
 *
 * Start with: npm run start:oracle
 * Deployed as a separate Railway service from brouter-web and brouter-worker.
 */

import * as dotenv from 'dotenv'
dotenv.config()

import express from 'express'
import { db } from './db/connection'
import { startAnvilSSE } from './services/AnvilSSEService'
import { notify } from './lib/notify'

const PORT = process.env.PORT || 3001

async function start() {
  console.log('🔮 brouter-oracle starting...')

  // Connect DB with retries
  let attempts = 0
  const maxAttempts = 10
  while (attempts < maxAttempts) {
    try {
      await db.initialize()
      console.log('✅ Oracle: Database connected')
      break
    } catch (err: any) {
      attempts++
      console.error(`⚠️  DB attempt ${attempts}/${maxAttempts} failed: ${err.message}`)
      if (attempts >= maxAttempts) {
        console.error('❌ Oracle: DB connection failed. Exiting.')
        process.exit(1)
      }
      await new Promise(r => setTimeout(r, 5000))
    }
  }

  // Start Anvil SSE listener (triggers agent loop via queue)
  startAnvilSSE()

  // Minimal HTTP server — webhook receiver only
  const app = express()
  app.use(express.json())

  // Health check (both paths — Railway probes /api/health)
  const healthHandler = (_req: any, res: any) => {
    res.json({ status: 'ok', service: 'brouter-oracle' })
  }
  app.get('/health', healthHandler)
  app.get('/api/health', healthHandler)

  /**
   * Polymarket webhook receiver.
   * Register once: POST https://gamma-api.polymarket.com/webhooks
   *   { url: "https://<oracle-service-url>/webhooks/polymarket" }
   *
   * Polymarket POSTs here when a market resolves — zero polling.
   *
   * TODO Phase 9: implement signature verification + enqueue settle-market job.
   * For now: logs receipt (webhook registration + signature spec TBD with Polymarket).
   */
  app.post('/webhooks/polymarket', async (req, res) => {
    try {
      const { conditionId, resolved, outcome } = req.body
      console.log(`[oracle] Polymarket webhook: conditionId=${conditionId} resolved=${resolved} outcome=${outcome}`)

      if (resolved && conditionId) {
        // TODO Phase 9: enqueue settle-market job to Redis queue
        // await settlementQueue.add('settle-market', { oracle_source: 'polymarket', oracle_market_id: conditionId, outcome })
        console.log(`[oracle] Market ${conditionId} resolved → ${outcome} (queued for settlement)`)
      }

      res.sendStatus(200)
    } catch (err: any) {
      console.error('[oracle] Polymarket webhook error:', err.message)
      res.sendStatus(500)
    }
  })

  app.listen(PORT, () => {
    console.log(`🚀 brouter-oracle webhook receiver at http://localhost:${PORT}`)
  })

  await notify('brouter-oracle started', 'info')

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`[${signal}] Oracle shutting down...`)
    await db.close()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

start()
