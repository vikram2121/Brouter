import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { dispatchAgentCallback } from '../routes/agentLoop'
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

// ============ AGENT LOOP TESTS ============

describe('dispatchAgentCallback', () => {
  let db: ReturnType<typeof createMockDb>
  let fetchSpy: any

  beforeEach(() => {
    db = createMockDb()
    fetchSpy = vi.spyOn(global, 'fetch')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns early (no fetch) if agent has no callback_url', async () => {
    vi.spyOn(db, 'get').mockResolvedValueOnce({
      id: 'agent1',
      handle: 'test-agent',
      persona: 'analyst',
      persona_id: null,
      balance_sats: 1000,
      callback_url: null, // No callback
      callback_secret: 'secret123',
      loop_seen_at: null
    })

    await dispatchAgentCallback('agent1', db)

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns early if feed is empty (no recent posts)', async () => {
    vi.spyOn(db, 'get').mockResolvedValueOnce({
      id: 'agent1',
      handle: 'test-agent',
      persona: 'analyst',
      persona_id: null,
      balance_sats: 1000,
      callback_url: 'https://example.com/callback',
      callback_secret: 'secret123',
      loop_seen_at: null
    })

    // Empty feed
    vi.spyOn(db, 'all').mockResolvedValueOnce([])

    await dispatchAgentCallback('agent1', db)

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('sends POST to callback_url with correct headers', async () => {
    vi.spyOn(db, 'get').mockResolvedValueOnce({
      id: 'agent1',
      handle: 'test-agent',
      persona: 'analyst',
      persona_id: null,
      balance_sats: 1000,
      callback_url: 'https://example.com/callback',
      callback_secret: 'secret123',
      loop_seen_at: null
    })

    // Mock feed with one post
    const mockPost = {
      id: 'post1',
      title: 'Test Post',
      body: 'Test content',
      agentId: 'agent2',
      agentName: 'other-agent',
      authorCalibration: 0.2,
      marketId: null,
      claimedProb: null,
      createdAt: '2025-03-30T12:00:00'
    }

    vi.spyOn(db, 'all')
      .mockResolvedValueOnce([mockPost]) // Recent posts
      .mockResolvedValueOnce([]) // Comments check for post1
      .mockResolvedValueOnce([]) // Recent own comments
      .mockResolvedValueOnce([]) // Mentions
      .mockResolvedValueOnce([]) // Open positions
      .mockResolvedValueOnce([]) // Calibration scores

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200
    })

    await dispatchAgentCallback('agent1', db)

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://example.com/callback',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Brouter-Signature': expect.stringContaining('sha256='),
          'X-Brouter-Event': 'loop.feed.v1',
        })
      })
    )
  })

  it('HMAC signature is sha256=<hex> format', async () => {
    vi.spyOn(db, 'get').mockResolvedValueOnce({
      id: 'agent1',
      handle: 'test-agent',
      persona: 'analyst',
      persona_id: null,
      balance_sats: 1000,
      callback_url: 'https://example.com/callback',
      callback_secret: 'secret123',
      loop_seen_at: null
    })

    const mockPost = {
      id: 'post1',
      title: 'Test',
      body: 'Content',
      agentId: 'agent2',
      agentName: 'other',
      authorCalibration: null,
      marketId: null,
      claimedProb: null,
      createdAt: '2025-03-30T12:00:00'
    }

    vi.spyOn(db, 'all')
      .mockResolvedValueOnce([mockPost])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200
    })

    await dispatchAgentCallback('agent1', db)

    const call = fetchSpy.mock.calls[0]
    const sig = call[1].headers['X-Brouter-Signature']

    expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/)
  })

  it('payload includes event, agent, feed, context keys', async () => {
    vi.spyOn(db, 'get').mockResolvedValueOnce({
      id: 'agent1',
      handle: 'test-agent',
      persona: 'analyst',
      persona_id: null,
      balance_sats: 1000,
      callback_url: 'https://example.com/callback',
      callback_secret: 'secret123',
      loop_seen_at: null
    })

    const mockPost = {
      id: 'post1',
      title: 'Test',
      body: 'Content',
      agentId: 'agent2',
      agentName: 'other',
      authorCalibration: null,
      marketId: null,
      claimedProb: null,
      createdAt: '2025-03-30T12:00:00'
    }

    vi.spyOn(db, 'all')
      .mockResolvedValueOnce([mockPost])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200
    })

    await dispatchAgentCallback('agent1', db)

    const call = fetchSpy.mock.calls[0]
    const body = JSON.parse(call[1].body)

    expect(body).toHaveProperty('event', 'loop.feed.v1')
    expect(body).toHaveProperty('agent')
    expect(body).toHaveProperty('feed')
    expect(body).toHaveProperty('context')
  })

  it('does not include posts authored by the agent itself in the feed', async () => {
    const getSpy = vi.spyOn(db, 'get')
    
    // First call: get agent
    getSpy.mockResolvedValueOnce({
      id: 'agent1',
      handle: 'test-agent',
      persona: 'analyst',
      persona_id: null,
      balance_sats: 1000,
      callback_url: 'https://example.com/callback',
      callback_secret: 'secret123',
      loop_seen_at: null
    })

    // Two posts: one by agent1 (should be filtered), one by agent2 (should be included)
    const mockPosts = [
      {
        id: 'post1',
        title: 'Own post',
        body: 'My content',
        agentId: 'agent1', // Own post — filtered out in .filter()
        agentName: 'test-agent',
        authorCalibration: null,
        marketId: null,
        claimedProb: null,
        createdAt: '2025-03-30T12:00:00'
      },
      {
        id: 'post2',
        title: 'Other post',
        body: 'Other content',
        agentId: 'agent2', // Other's post
        agentName: 'other-agent',
        authorCalibration: 0.3,
        marketId: null,
        claimedProb: null,
        createdAt: '2025-03-30T11:00:00'
      }
    ]

    vi.spyOn(db, 'all')
      .mockResolvedValueOnce(mockPosts) // Recent posts
      .mockResolvedValueOnce([]) // Recent own comments
      .mockResolvedValueOnce([]) // Mentions
      .mockResolvedValueOnce([]) // Open positions
      .mockResolvedValueOnce([]) // Calibration scores

    // Check comments on post2 (post1 is filtered by agentId check)
    getSpy.mockResolvedValueOnce(null) // No comments on post2

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200
    })

    await dispatchAgentCallback('agent1', db)

    const call = fetchSpy.mock.calls[0]
    const body = JSON.parse(call[1].body)

    // Feed should only contain post2, not post1
    expect(body.feed).toHaveLength(1)
    expect(body.feed[0].id).toBe('post2')
  })

  it('handles callback timeout (AbortError) without throwing', async () => {
    vi.spyOn(db, 'get').mockResolvedValueOnce({
      id: 'agent1',
      handle: 'test-agent',
      persona: 'analyst',
      persona_id: null,
      balance_sats: 1000,
      callback_url: 'https://example.com/callback',
      callback_secret: 'secret123',
      loop_seen_at: null
    })

    const mockPost = {
      id: 'post1',
      title: 'Test',
      body: 'Content',
      agentId: 'agent2',
      agentName: 'other',
      authorCalibration: null,
      marketId: null,
      claimedProb: null,
      createdAt: '2025-03-30T12:00:00'
    }

    vi.spyOn(db, 'all')
      .mockResolvedValueOnce([mockPost])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])

    const abortError = new Error('Aborted')
    abortError.name = 'AbortError'
    fetchSpy.mockRejectedValueOnce(abortError)

    // Should not throw
    await expect(dispatchAgentCallback('agent1', db)).resolves.toBeUndefined()
  })

  it('handles non-2xx callback response without throwing', async () => {
    vi.spyOn(db, 'get').mockResolvedValueOnce({
      id: 'agent1',
      handle: 'test-agent',
      persona: 'analyst',
      persona_id: null,
      balance_sats: 1000,
      callback_url: 'https://example.com/callback',
      callback_secret: 'secret123',
      loop_seen_at: null
    })

    const mockPost = {
      id: 'post1',
      title: 'Test',
      body: 'Content',
      agentId: 'agent2',
      agentName: 'other',
      authorCalibration: null,
      marketId: null,
      claimedProb: null,
      createdAt: '2025-03-30T12:00:00'
    }

    vi.spyOn(db, 'all')
      .mockResolvedValueOnce([mockPost])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])

    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500
    })

    // Should not throw
    await expect(dispatchAgentCallback('agent1', db)).resolves.toBeUndefined()
  })

  it('updates loop_seen_at after successful dispatch', async () => {
    const runSpy = vi.spyOn(db, 'run')

    vi.spyOn(db, 'get').mockResolvedValueOnce({
      id: 'agent1',
      handle: 'test-agent',
      persona: 'analyst',
      persona_id: null,
      balance_sats: 1000,
      callback_url: 'https://example.com/callback',
      callback_secret: 'secret123',
      loop_seen_at: null
    })

    const mockPost = {
      id: 'post1',
      title: 'Test',
      body: 'Content',
      agentId: 'agent2',
      agentName: 'other',
      authorCalibration: null,
      marketId: null,
      claimedProb: null,
      createdAt: '2025-03-30T12:00:00'
    }

    vi.spyOn(db, 'all')
      .mockResolvedValueOnce([mockPost])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200
    })

    await dispatchAgentCallback('agent1', db)

    // Check that db.run was called to update loop_seen_at
    expect(runSpy).toHaveBeenCalledWith(
      'UPDATE agents SET loop_seen_at = NOW() WHERE id = ?',
      ['agent1']
    )
  })

  it('skips posts the agent already commented on', async () => {
    const getSpy = vi.spyOn(db, 'get')
    
    // First call: get agent
    getSpy.mockResolvedValueOnce({
      id: 'agent1',
      handle: 'test-agent',
      persona: 'analyst',
      persona_id: null,
      balance_sats: 1000,
      callback_url: 'https://example.com/callback',
      callback_secret: 'secret123',
      loop_seen_at: null
    })

    // Two posts
    const mockPosts = [
      {
        id: 'post1',
        title: 'Post 1',
        body: 'Content 1',
        agentId: 'agent2',
        agentName: 'other-agent',
        authorCalibration: null,
        marketId: null,
        claimedProb: null,
        createdAt: '2025-03-30T12:00:00'
      },
      {
        id: 'post2',
        title: 'Post 2',
        body: 'Content 2',
        agentId: 'agent3',
        agentName: 'another-agent',
        authorCalibration: null,
        marketId: null,
        claimedProb: null,
        createdAt: '2025-03-30T11:00:00'
      }
    ]

    vi.spyOn(db, 'all')
      .mockResolvedValueOnce(mockPosts) // Recent posts
      .mockResolvedValueOnce([]) // Recent own comments
      .mockResolvedValueOnce([]) // Mentions
      .mockResolvedValueOnce([]) // Open positions
      .mockResolvedValueOnce([]) // Calibration scores

    // Second call: check comments on post1 → has comment from agent1
    getSpy.mockResolvedValueOnce({ id: 'comment1' })
    // Third call: check comments on post2 → no comment from agent1
    getSpy.mockResolvedValueOnce(null)

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200
    })

    await dispatchAgentCallback('agent1', db)

    const call = fetchSpy.mock.calls[0]
    const body = JSON.parse(call[1].body)

    // Only post2 should be in feed (post1 was already commented on)
    expect(body.feed).toHaveLength(1)
    expect(body.feed[0].id).toBe('post2')
  })
})
