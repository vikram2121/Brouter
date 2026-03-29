/**
 * Agent loop job queue — Bull + Redis.
 *
 * When REDIS_URL is set:   uses real Bull queue, 20 concurrent workers
 * When REDIS_URL is unset: falls back to in-process sequential (dev mode)
 *
 * Usage:
 *   import { enqueueAgents, startWorkers } from './agentQueue'
 *   await enqueueAgents(agents)   // call from cron/loop endpoint
 *   startWorkers(processAgent)    // call once at startup
 */

import Bull from 'bull'
import { notify } from './notify'

export interface AgentJob {
  agent_id: string
  handle: string
}

export type AgentProcessor = (job: AgentJob) => Promise<void>

let queue: Bull.Queue<AgentJob> | null = null

export function getQueue(): Bull.Queue<AgentJob> | null {
  return queue
}

export function initQueue(): void {
  const redisUrl = process.env.REDIS_URL
  if (!redisUrl) {
    console.warn('[agentQueue] REDIS_URL not set — queue disabled, falling back to sequential loop')
    return
  }

  queue = new Bull<AgentJob>('agent-loop', redisUrl, {
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'fixed', delay: 5000 },
      timeout: 8000,
      removeOnComplete: 100,
      removeOnFail: 50,
    },
  })

  queue.on('error', (err) => {
    console.error('[agentQueue] Queue error:', err.message)
  })

  queue.on('failed', (job, err) => {
    console.warn(`[agentQueue] Job failed for agent ${job.data.handle}:`, err.message)
  })

  // Alert if queue depth grows unexpectedly large
  queue.on('waiting', async () => {
    try {
      const count = await queue!.getWaitingCount()
      if (count > 500) {
        await notify(`Agent loop queue depth: ${count} jobs waiting — workers may be stalled`, 'warning')
      }
    } catch (_) {}
  })

  console.log('[agentQueue] Bull queue initialised')
}

export function startWorkers(processor: AgentProcessor, concurrency = 20): void {
  if (!queue) {
    console.warn('[agentQueue] No queue — workers not started')
    return
  }

  queue.process(concurrency, async (job) => {
    await processor(job.data)
  })

  console.log(`[agentQueue] ${concurrency} workers started`)
}

export async function enqueueAgents(agents: AgentJob[]): Promise<'queued' | 'sequential'> {
  if (!queue) return 'sequential'

  for (const agent of agents) {
    await queue.add({ agent_id: agent.agent_id, handle: agent.handle })
  }

  console.log(`[agentQueue] Enqueued ${agents.length} agent jobs`)
  return 'queued'
}
