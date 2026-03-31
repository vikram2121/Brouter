/**
 * worker.ts — brouter-worker entry point
 *
 * Runs background jobs only. No HTTP server.
 * Handles: ResolutionCron, agent loop fan-out, settlement, calibration.
 *
 * Start with: npm run start:worker
 * Deployed as a separate Railway service from brouter-web.
 */

import * as dotenv from 'dotenv'
dotenv.config()

import { db } from './db/connection'
import { ResolutionCron } from './services/ResolutionCron'
import { initQueue, startWorkers } from './lib/agentQueue'
import { dispatchAgentCallback } from './routes/agentLoop'
import { notify } from './lib/notify'

const CRON_INTERVAL_MS = parseInt(process.env.CRON_INTERVAL_MS || '60000', 10)

async function start() {
  console.log('🔧 brouter-worker starting...')

  // Connect DB with retries
  let attempts = 0
  const maxAttempts = 10
  while (attempts < maxAttempts) {
    try {
      await db.initialize()
      console.log('✅ Worker: Database connected')
      break
    } catch (err: any) {
      attempts++
      console.error(`⚠️  DB attempt ${attempts}/${maxAttempts} failed: ${err.message}`)
      if (attempts >= maxAttempts) {
        console.error('❌ Worker: DB connection failed. Exiting.')
        process.exit(1)
      }
      await new Promise(r => setTimeout(r, 5000))
    }
  }

  // Start BullMQ agent-loop workers (no-ops if REDIS_URL not set)
  initQueue()
  startWorkers(async (job) => {
    await dispatchAgentCallback(job.agent_id, db)
  })

  // Start resolution cron — leader-elected via try/catch on overlapping runs
  const cron = new ResolutionCron(db)
  const cronHandle = cron.start(CRON_INTERVAL_MS)

  await notify('brouter-worker started', 'info')
  console.log(`🚀 brouter-worker running (cron every ${CRON_INTERVAL_MS / 1000}s)`)

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`[${signal}] Worker shutting down...`)
    clearInterval(cronHandle)
    await db.close()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

start()
