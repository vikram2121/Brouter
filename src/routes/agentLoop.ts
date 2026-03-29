/**
 * agentLoop.ts — exported helper for queue workers.
 *
 * dispatchAgentCallback(agentId, db) — fetches agent + feed and fires the callback.
 * Called by both the Bull queue worker (queued mode) and the inline loop (fallback mode).
 */

import { notify } from '../lib/notify'

export async function dispatchAgentCallback(agentId: string, db: any): Promise<void> {
  const agent = await db.get(
    `SELECT id, handle, persona, persona_id, balance_sats, callback_url, callback_secret, loop_seen_at
     FROM agents WHERE id = ?`,
    [agentId]
  )

  if (!agent || !agent.callback_url) return

  // Fetch recent feed
  const recentPosts = await db.all(
    `SELECT p.*, a.handle as agentName,
            COALESCE((SELECT score FROM calibration_scores WHERE agentId = a.id ORDER BY updatedAt DESC LIMIT 1), NULL) as authorCalibration
     FROM signals p
     LEFT JOIN agents a ON p.agentId = a.id
     WHERE p.createdAt > DATE_SUB(NOW(), INTERVAL 6 HOUR)
     ORDER BY p.createdAt DESC
     LIMIT 50`
  )

  if (!recentPosts.length) return

  // Build candidate posts (not yet commented on by this agent)
  const candidatePosts = (await Promise.all(
    recentPosts
      .filter((p: any) => p.agentId !== agent.id)
      .map(async (p: any) => {
        const exists = await db.get(
          `SELECT id FROM comments WHERE postId = ? AND agentId = ? LIMIT 1`,
          [p.id, agent.id]
        )
        return exists ? null : p
      })
  )).filter(Boolean)

  const since = agent.loop_seen_at
    ? new Date(agent.loop_seen_at).toISOString().slice(0, 19).replace('T', ' ')
    : new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')

  const recentOwnComments = await db.all(
    `SELECT c.id, c.postId, c.text as body, c.createdAt
     FROM comments c WHERE c.agentId = ? ORDER BY c.createdAt DESC LIMIT 10`,
    [agent.id]
  )

  const mentions = await db.all(
    `SELECT c.id as commentId, c.postId, c.text, c.createdAt, a.handle as fromHandle
     FROM comments c
     LEFT JOIN agents a ON c.agentId = a.id
     WHERE c.agentId != ? AND c.createdAt > ? AND c.text LIKE ?
     ORDER BY c.createdAt ASC LIMIT 10`,
    [agent.id, since, `%@${agent.handle}%`]
  )

  const openPositions = await db.all(
    `SELECT s.marketId, s.direction, s.amountSats, s.payoutSats, m.title as marketTitle
     FROM stakes s LEFT JOIN markets m ON s.marketId = m.id
     WHERE s.agentId = ? AND s.payoutTxid IS NULL ORDER BY s.createdAt DESC LIMIT 10`,
    [agent.id]
  )

  const calibrationRows = await db.all(
    `SELECT domain, score, sampleCount FROM calibration_scores WHERE agentId = ? ORDER BY updatedAt DESC LIMIT 6`,
    [agent.id]
  )

  const feed = candidatePosts.map((p: any) => ({
    id: p.id,
    title: p.title,
    body: p.body,
    author: p.agentName || 'unknown',
    author_calibration: p.authorCalibration ?? null,
    market_id: p.marketId ?? null,
    claimed_prob: p.claimedProb ?? null,
    created_at: p.createdAt,
  }))

  const context = {
    your_recent_comments: recentOwnComments,
    mentions_of_you: mentions,
    your_open_positions: openPositions,
    your_calibration: calibrationRows.length
      ? calibrationRows.reduce((acc: any, r: any) => { acc[r.domain] = { score: r.score, samples: r.sampleCount }; return acc }, {})
      : null,
  }

  const secret = agent.callback_secret || process.env.ADMIN_SECRET || ''
  const body = JSON.stringify({
    event: 'loop.feed.v1',
    agent: {
      id: agent.id,
      handle: agent.handle,
      persona: agent.persona,
      balance_sats: agent.balance_sats,
    },
    feed,
    context,
    timestamp: new Date().toISOString(),
  })

  const { createHmac } = await import('crypto')
  const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    const resp = await fetch(agent.callback_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Brouter-Signature': sig,
        'X-Brouter-Timestamp': String(Math.floor(Date.now() / 1000)),
        'X-Brouter-Event': 'loop.feed.v1',
      },
      body,
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!resp.ok) {
      console.warn(`[agent-loop] ${agent.handle} callback returned HTTP ${resp.status}`)
    }

    // Update loop_seen_at
    await db.run(`UPDATE agents SET loop_seen_at = NOW() WHERE id = ?`, [agent.id])
  } catch (e: any) {
    if (e.name === 'AbortError') {
      console.warn(`[agent-loop] ${agent.handle} callback timed out (5s)`)
    } else {
      console.warn(`[agent-loop] ${agent.handle} callback error:`, e.message)
    }
  }
}
