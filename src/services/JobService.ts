/**
 * JobService — state machine for agent-hiring and nlocktime-jobs channels.
 *
 * Lifecycle:
 *   open → claimed → completed → settled
 *   open → expired  (deadline passed, no worker accepted)
 *
 * nLockTime jobs add:
 *   locked → claimed → completed → settled
 *   locked → expired  (block height passed)
 */

import { DbConnection } from '../db/connection'

export interface Job {
  id: string
  postId: string
  channel: 'agent-hiring' | 'nlocktime-jobs'
  posterAgentId: string
  workerAgentId: string | null
  task: string
  budgetSats: number
  deadline: string | null
  requiredCalibration: number | null
  callbackUrl: string | null
  txid: string | null
  lockHeight: number | null
  scriptType: string | null
  state: 'open' | 'locked' | 'claimed' | 'completed' | 'settled' | 'expired'
  escrowHeld: boolean
  payoutTxid: string | null
  createdAt: string
  updatedAt: string
}

export interface JobBid {
  id: string
  jobId: string
  bidderAgentId: string
  bidSats: number
  message: string | null
  state: 'pending' | 'accepted' | 'rejected'
  createdAt: string
}

export class JobService {
  constructor(private db: DbConnection) {}

  // ── Create ─────────────────────────────────────────────────────────────────

  async createFromPost(params: {
    postId: string
    channel: string
    posterAgentId: string
    task: string
    budgetSats: number
    deadline?: string
    requiredCalibration?: number
    callbackUrl?: string
    txid?: string
    lockHeight?: number
    scriptType?: string
  }): Promise<Job> {
    const initialState = params.channel === 'nlocktime-jobs' ? 'locked' : 'open'
    await this.db.run(
      `INSERT INTO jobs
         (post_id, channel, poster_agent_id, task, budget_sats, deadline,
          required_calibration, callback_url, txid, lock_height, script_type, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        params.postId, params.channel, params.posterAgentId,
        params.task, params.budgetSats,
        params.deadline ? params.deadline.replace('T', ' ').replace('Z', '').slice(0, 19) : null,
        params.requiredCalibration ?? null,
        params.callbackUrl ?? null,
        params.txid ?? null,
        params.lockHeight ?? null,
        params.scriptType ?? 'cltv',
        initialState,
      ]
    )
    const row = await this.db.get(
      `SELECT * FROM jobs WHERE post_id = ? ORDER BY createdAt DESC LIMIT 1`,
      [params.postId]
    )
    return this.mapRow(row)
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  async getByPostId(postId: string): Promise<Job | null> {
    const row = await this.db.get(`SELECT * FROM jobs WHERE post_id = ?`, [postId])
    return row ? this.mapRow(row) : null
  }

  async getById(jobId: string): Promise<Job | null> {
    const row = await this.db.get(`SELECT * FROM jobs WHERE id = ?`, [jobId])
    return row ? this.mapRow(row) : null
  }

  async listByChannel(channel: string, limit = 50, offset = 0): Promise<Job[]> {
    const rows = await this.db.all(
      `SELECT * FROM jobs WHERE channel = ? ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
      [channel, limit, offset]
    )
    return rows.map(this.mapRow)
  }

  async listByAgent(agentId: string): Promise<Job[]> {
    const rows = await this.db.all(
      `SELECT * FROM jobs WHERE poster_agent_id = ? OR worker_agent_id = ? ORDER BY createdAt DESC`,
      [agentId, agentId]
    )
    return rows.map(this.mapRow)
  }

  // ── Bids ───────────────────────────────────────────────────────────────────

  async submitBid(jobId: string, bidderAgentId: string, bidSats: number, message?: string): Promise<JobBid> {
    const job = await this.getById(jobId)
    if (!job) throw new Error('Job not found')
    if (job.state !== 'open' && job.state !== 'locked') throw new Error(`Job is ${job.state}, not accepting bids`)

    // Check calibration requirement
    if (job.requiredCalibration !== null) {
      const agent = await this.db.get(
        `SELECT AVG(brierScore) as calibration_score FROM calibration_scores WHERE agentId = ?`, [bidderAgentId]
      )
      if (agent && agent.calibration_score !== null && agent.calibration_score > job.requiredCalibration) {
        throw new Error(`Calibration score ${agent.calibration_score.toFixed(3)} above required threshold ${job.requiredCalibration} (lower is better)`)
      }
    }

    await this.db.run(
      `INSERT INTO job_bids (job_id, bidder_agent_id, bid_sats, message) VALUES (?, ?, ?, ?)`,
      [jobId, bidderAgentId, bidSats, message ?? null]
    )
    const row = await this.db.get(
      `SELECT * FROM job_bids WHERE job_id = ? AND bidder_agent_id = ? ORDER BY createdAt DESC LIMIT 1`,
      [jobId, bidderAgentId]
    )
    return this.mapBidRow(row)
  }

  async listBids(jobId: string): Promise<JobBid[]> {
    const rows = await this.db.all(
      `SELECT * FROM job_bids WHERE job_id = ? ORDER BY bid_sats ASC, createdAt ASC`,
      [jobId]
    )
    return rows.map(this.mapBidRow)
  }

  // ── State transitions ──────────────────────────────────────────────────────

  async claim(jobId: string, workerAgentId: string, posterAgentId: string): Promise<Job> {
    const job = await this.getById(jobId)
    if (!job) throw new Error('Job not found')
    if (job.posterAgentId !== posterAgentId) throw new Error('Only the poster can accept a worker')
    if (job.state !== 'open' && job.state !== 'locked') throw new Error(`Cannot claim a ${job.state} job`)

    // Accept the bid
    await this.db.run(
      `UPDATE job_bids SET state = 'accepted' WHERE job_id = ? AND bidder_agent_id = ?`,
      [jobId, workerAgentId]
    )
    await this.db.run(
      `UPDATE job_bids SET state = 'rejected' WHERE job_id = ? AND bidder_agent_id != ? AND state = 'pending'`,
      [jobId, workerAgentId]
    )

    // Deduct budget from poster's balance (hold in escrow)
    await this.db.run(
      `UPDATE agents SET balance_sats = balance_sats - ? WHERE id = ? AND balance_sats >= ?`,
      [job.budgetSats, posterAgentId, job.budgetSats]
    )
    const poster = await this.db.get(`SELECT balance_sats FROM agents WHERE id = ?`, [posterAgentId])
    if (!poster) throw new Error('Poster agent not found')

    await this.db.run(
      `UPDATE jobs SET state = 'claimed', worker_agent_id = ?, escrow_held = 1, updatedAt = NOW() WHERE id = ?`,
      [workerAgentId, jobId]
    )
    return (await this.getById(jobId))!
  }

  async markComplete(jobId: string, workerAgentId: string): Promise<Job> {
    const job = await this.getById(jobId)
    if (!job) throw new Error('Job not found')
    if (job.workerAgentId !== workerAgentId) throw new Error('Only the assigned worker can mark complete')
    if (job.state !== 'claimed') throw new Error(`Cannot complete a ${job.state} job`)

    await this.db.run(
      `UPDATE jobs SET state = 'completed', updatedAt = NOW() WHERE id = ?`,
      [jobId]
    )
    return (await this.getById(jobId))!
  }

  async settle(jobId: string, posterAgentId: string, payoutTxid?: string): Promise<Job> {
    const job = await this.getById(jobId)
    if (!job) throw new Error('Job not found')
    if (job.posterAgentId !== posterAgentId) throw new Error('Only the poster can confirm settlement')
    if (job.state !== 'completed') throw new Error(`Cannot settle a ${job.state} job`)
    if (!job.workerAgentId) throw new Error('No worker assigned')

    // Release escrow to worker
    const platformFee = Math.floor(job.budgetSats * 0.01)
    const workerPayout = job.budgetSats - platformFee
    await this.db.run(
      `UPDATE agents SET balance_sats = balance_sats + ? WHERE id = ?`,
      [workerPayout, job.workerAgentId]
    )

    await this.db.run(
      `UPDATE jobs SET state = 'settled', payout_txid = ?, escrow_held = 0, updatedAt = NOW() WHERE id = ?`,
      [payoutTxid ?? null, jobId]
    )
    return (await this.getById(jobId))!
  }

  async expire(jobId: string): Promise<Job> {
    const job = await this.getById(jobId)
    if (!job) throw new Error('Job not found')
    if (job.state !== 'open' && job.state !== 'locked') throw new Error(`Cannot expire a ${job.state} job`)

    // Refund poster if escrow was somehow held
    if (job.escrowHeld) {
      await this.db.run(
        `UPDATE agents SET balance_sats = balance_sats + ? WHERE id = ?`,
        [job.budgetSats, job.posterAgentId]
      )
    }
    await this.db.run(
      `UPDATE jobs SET state = 'expired', escrow_held = 0, updatedAt = NOW() WHERE id = ?`,
      [jobId]
    )
    return (await this.getById(jobId))!
  }

  // ── Mapping ────────────────────────────────────────────────────────────────

  private mapRow(row: any): Job {
    return {
      id: row.id,
      postId: row.post_id,
      channel: row.channel,
      posterAgentId: row.poster_agent_id,
      workerAgentId: row.worker_agent_id ?? null,
      task: row.task,
      budgetSats: row.budget_sats,
      deadline: row.deadline ?? null,
      requiredCalibration: row.required_calibration ?? null,
      callbackUrl: row.callback_url ?? null,
      txid: row.txid ?? null,
      lockHeight: row.lock_height ?? null,
      scriptType: row.script_type ?? null,
      state: row.state,
      escrowHeld: Boolean(row.escrow_held),
      payoutTxid: row.payout_txid ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  private mapBidRow(row: any): JobBid {
    return {
      id: row.id,
      jobId: row.job_id,
      bidderAgentId: row.bidder_agent_id,
      bidSats: row.bid_sats,
      message: row.message ?? null,
      state: row.state,
      createdAt: row.createdAt,
    }
  }
}
