import { describe, it, expect, beforeEach, vi } from 'vitest'
import { JobService } from '../services/JobService'
import type { DbConnection } from '../db/connection'

// ============ MOCK DB ============

function createMockDb(): DbConnection & { _store: Map<string, any[]> } {
  const store = new Map<string, any[]>()

  return {
    _store: store,

    async run(_sql: string, _params?: any[]): Promise<void> {},

    async get(_sql: string, params?: any[]): Promise<any | null> {
      return null
    },

    async all(_sql: string, _params?: any[]): Promise<any[]> {
      return []
    },

    async allRaw(_sql: string, _params?: any[]): Promise<any[]> {
      return []
    },

    async close(): Promise<void> {}
  }
}

// ============ JOB SERVICE ============

describe('JobService', () => {
  let jobService: JobService
  let db: ReturnType<typeof createMockDb>

  beforeEach(() => {
    db = createMockDb()
    jobService = new JobService(db)
  })

  it('instantiates correctly', () => {
    expect(jobService).toBeDefined()
  })

  // ── createFromPost tests ──

  it('createFromPost() sets initial state to "open" for agent-hiring channel', async () => {
    const runSpy = vi.spyOn(db, 'run')
    const getSpy = vi.spyOn(db, 'get').mockResolvedValueOnce({
      id: 'job1',
      post_id: 'post1',
      channel: 'agent-hiring',
      poster_agent_id: 'agent1',
      task: 'test task',
      budget_sats: 1000,
      state: 'open',
      worker_agent_id: null,
      deadline: null,
      required_calibration: null,
      callback_url: null,
      txid: null,
      lock_height: null,
      script_type: 'cltv',
      escrow_held: false,
      payout_txid: null,
      createdAt: '2025-03-30 12:00:00',
      updatedAt: '2025-03-30 12:00:00'
    })

    const job = await jobService.createFromPost({
      postId: 'post1',
      channel: 'agent-hiring',
      posterAgentId: 'agent1',
      task: 'test task',
      budgetSats: 1000
    })

    expect(runSpy).toHaveBeenCalled()
    const callArgs = runSpy.mock.calls[0]
    // The state parameter should be 'open' for agent-hiring
    expect(callArgs[1][11]).toBe('open')
    expect(job.state).toBe('open')
  })

  it('createFromPost() sets initial state to "locked" for nlocktime-jobs channel', async () => {
    const runSpy = vi.spyOn(db, 'run')
    const getSpy = vi.spyOn(db, 'get').mockResolvedValueOnce({
      id: 'job2',
      post_id: 'post2',
      channel: 'nlocktime-jobs',
      poster_agent_id: 'agent1',
      task: 'locked task',
      budget_sats: 2000,
      state: 'locked',
      worker_agent_id: null,
      deadline: null,
      required_calibration: null,
      callback_url: null,
      txid: null,
      lock_height: 800000,
      script_type: 'cltv',
      escrow_held: false,
      payout_txid: null,
      createdAt: '2025-03-30 12:00:00',
      updatedAt: '2025-03-30 12:00:00'
    })

    const job = await jobService.createFromPost({
      postId: 'post2',
      channel: 'nlocktime-jobs',
      posterAgentId: 'agent1',
      task: 'locked task',
      budgetSats: 2000,
      lockHeight: 800000
    })

    expect(runSpy).toHaveBeenCalled()
    const callArgs = runSpy.mock.calls[0]
    // The state parameter should be 'locked' for nlocktime-jobs
    expect(callArgs[1][11]).toBe('locked')
    expect(job.state).toBe('locked')
  })

  it('createFromPost() stores task and budgetSats correctly', async () => {
    const runSpy = vi.spyOn(db, 'run')
    vi.spyOn(db, 'get').mockResolvedValueOnce({
      id: 'job3',
      post_id: 'post3',
      channel: 'agent-hiring',
      poster_agent_id: 'agent1',
      task: 'write code',
      budget_sats: 5000,
      state: 'open',
      worker_agent_id: null,
      deadline: null,
      required_calibration: null,
      callback_url: null,
      txid: null,
      lock_height: null,
      script_type: 'cltv',
      escrow_held: false,
      payout_txid: null,
      createdAt: '2025-03-30 12:00:00',
      updatedAt: '2025-03-30 12:00:00'
    })

    await jobService.createFromPost({
      postId: 'post3',
      channel: 'agent-hiring',
      posterAgentId: 'agent1',
      task: 'write code',
      budgetSats: 5000
    })

    expect(runSpy).toHaveBeenCalled()
    const callArgs = runSpy.mock.calls[0]
    // Position 2 is task, position 3 is budget_sats
    expect(callArgs[1][3]).toBe('write code')
    expect(callArgs[1][4]).toBe(5000)
  })

  // ── getById tests ──

  it('getById() returns null when db.get returns null', async () => {
    vi.spyOn(db, 'get').mockResolvedValueOnce(null)
    const job = await jobService.getById('nonexistent')
    expect(job).toBeNull()
  })

  it('getById() maps row correctly when db.get returns a row', async () => {
    const row = {
      id: 'job4',
      post_id: 'post4',
      channel: 'agent-hiring',
      poster_agent_id: 'agent1',
      worker_agent_id: 'agent2',
      task: 'test task',
      budget_sats: 1000,
      deadline: null,
      required_calibration: null,
      callback_url: null,
      txid: null,
      lock_height: null,
      script_type: 'cltv',
      state: 'claimed',
      escrow_held: 1,
      payout_txid: null,
      createdAt: '2025-03-30 12:00:00',
      updatedAt: '2025-03-30 12:01:00'
    }
    vi.spyOn(db, 'get').mockResolvedValueOnce(row)

    const job = await jobService.getById('job4')

    expect(job).not.toBeNull()
    expect(job!.id).toBe('job4')
    expect(job!.postId).toBe('post4')
    expect(job!.channel).toBe('agent-hiring')
    expect(job!.posterAgentId).toBe('agent1')
    expect(job!.workerAgentId).toBe('agent2')
    expect(job!.state).toBe('claimed')
    expect(job!.escrowHeld).toBe(true)
  })

  // ── State transition tests ──

  it('bid() throws if job state is not "open" (mock by calling with non-open state)', async () => {
    vi.spyOn(db, 'get').mockResolvedValueOnce({
      id: 'job5',
      post_id: 'post5',
      channel: 'agent-hiring',
      poster_agent_id: 'agent1',
      worker_agent_id: null,
      task: 'test',
      budget_sats: 1000,
      state: 'locked', // Not open or locked, or already claimed
      deadline: null,
      required_calibration: null,
      callback_url: null,
      txid: null,
      lock_height: null,
      script_type: 'cltv',
      escrow_held: false,
      payout_txid: null,
      createdAt: '2025-03-30 12:00:00',
      updatedAt: '2025-03-30 12:00:00'
    })

    // First call returns the job with 'locked' state, which should fail submitBid
    await expect(jobService.submitBid('job5', 'bidder1', 500)).rejects.toThrow()
  })

  it('claim() transitions state from "open" to "claimed" and sets workerAgentId', async () => {
    const runSpy = vi.spyOn(db, 'run')
    
    // First getById call (in claim method)
    vi.spyOn(db, 'get')
      .mockResolvedValueOnce({
        id: 'job6',
        post_id: 'post6',
        channel: 'agent-hiring',
        poster_agent_id: 'agent1',
        worker_agent_id: null,
        task: 'test',
        budget_sats: 1000,
        state: 'open',
        deadline: null,
        required_calibration: null,
        callback_url: null,
        txid: null,
        lock_height: null,
        script_type: 'cltv',
        escrow_held: false,
        payout_txid: null,
        createdAt: '2025-03-30 12:00:00',
        updatedAt: '2025-03-30 12:00:00'
      })
      // Second call: check poster agent balance
      .mockResolvedValueOnce({
        id: 'agent1',
        balance_sats: 5000
      })
      // Third call: final getById after state transition
      .mockResolvedValueOnce({
        id: 'job6',
        post_id: 'post6',
        channel: 'agent-hiring',
        poster_agent_id: 'agent1',
        worker_agent_id: 'agent2',
        task: 'test',
        budget_sats: 1000,
        state: 'claimed',
        deadline: null,
        required_calibration: null,
        callback_url: null,
        txid: null,
        lock_height: null,
        script_type: 'cltv',
        escrow_held: true,
        payout_txid: null,
        createdAt: '2025-03-30 12:00:00',
        updatedAt: '2025-03-30 12:01:00'
      })

    const job = await jobService.claim('job6', 'agent2', 'agent1')

    expect(job.state).toBe('claimed')
    expect(job.workerAgentId).toBe('agent2')
  })

  it('complete() can only be called by the worker agent', async () => {
    vi.spyOn(db, 'get').mockResolvedValueOnce({
      id: 'job7',
      post_id: 'post7',
      channel: 'agent-hiring',
      poster_agent_id: 'agent1',
      worker_agent_id: 'agent2',
      task: 'test',
      budget_sats: 1000,
      state: 'claimed',
      deadline: null,
      required_calibration: null,
      callback_url: null,
      txid: null,
      lock_height: null,
      script_type: 'cltv',
      escrow_held: true,
      payout_txid: null,
      createdAt: '2025-03-30 12:00:00',
      updatedAt: '2025-03-30 12:00:00'
    })

    // Wrong agent tries to mark complete
    await expect(jobService.markComplete('job7', 'agent3')).rejects.toThrow('Only the assigned worker can mark complete')
  })

  it('settle() can only be called by the poster agent', async () => {
    vi.spyOn(db, 'get').mockResolvedValueOnce({
      id: 'job8',
      post_id: 'post8',
      channel: 'agent-hiring',
      poster_agent_id: 'agent1',
      worker_agent_id: 'agent2',
      task: 'test',
      budget_sats: 1000,
      state: 'completed',
      deadline: null,
      required_calibration: null,
      callback_url: null,
      txid: null,
      lock_height: null,
      script_type: 'cltv',
      escrow_held: true,
      payout_txid: null,
      createdAt: '2025-03-30 12:00:00',
      updatedAt: '2025-03-30 12:00:00'
    })

    // Wrong agent tries to settle
    await expect(jobService.settle('job8', 'agent3')).rejects.toThrow('Only the poster can confirm settlement')
  })

  it('settle() rejects if job state is not "completed"', async () => {
    vi.spyOn(db, 'get').mockResolvedValueOnce({
      id: 'job9',
      post_id: 'post9',
      channel: 'agent-hiring',
      poster_agent_id: 'agent1',
      worker_agent_id: 'agent2',
      task: 'test',
      budget_sats: 1000,
      state: 'claimed', // Not completed yet
      deadline: null,
      required_calibration: null,
      callback_url: null,
      txid: null,
      lock_height: null,
      script_type: 'cltv',
      escrow_held: true,
      payout_txid: null,
      createdAt: '2025-03-30 12:00:00',
      updatedAt: '2025-03-30 12:00:00'
    })

    await expect(jobService.settle('job9', 'agent1')).rejects.toThrow('Cannot settle a claimed job')
  })
})
