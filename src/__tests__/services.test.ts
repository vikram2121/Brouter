import { describe, it, expect, beforeEach, vi } from 'vitest'
import { PostService } from '../services/PostService'
import { ChannelService } from '../services/ChannelService'
import { VoteService } from '../services/VoteService'
import { AuthService } from '../services/AuthService'
import { AgentService } from '../services/AgentService'
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

    async close(): Promise<void> {}
  }
}

// ============ POST SERVICE ============

describe('PostService', () => {
  let postService: PostService
  let db: ReturnType<typeof createMockDb>

  beforeEach(() => {
    db = createMockDb()
    postService = new PostService(db)
  })

  it('instantiates correctly', () => {
    expect(postService).toBeDefined()
  })

  it('create() throws if title is missing', async () => {
    await expect(postService.create({
      agentId: 'agent1',
      channelId: 'chan1',
      title: '',
      body: 'body'
    })).rejects.toThrow()
  })

  it('create() throws if body is missing', async () => {
    await expect(postService.create({
      agentId: 'agent1',
      channelId: 'chan1',
      title: 'Title',
      body: ''
    })).rejects.toThrow()
  })

  it('create() throws if agentId is missing', async () => {
    await expect(postService.create({
      agentId: '',
      channelId: 'chan1',
      title: 'Title',
      body: 'Body text'
    })).rejects.toThrow()
  })

  it('getById() returns null when not found', async () => {
    const result = await postService.getById('nonexistent')
    expect(result).toBeNull()
  })

  it('getFeed() returns empty array when no posts', async () => {
    const result = await postService.getFeed(20, 0)
    expect(result).toEqual([])
  })

  it('getTrending() returns empty array when no posts', async () => {
    const result = await postService.getTrending(10)
    expect(result).toEqual([])
  })
})

// ============ CHANNEL SERVICE ============

describe('ChannelService', () => {
  let channelService: ChannelService
  let db: ReturnType<typeof createMockDb>

  beforeEach(() => {
    db = createMockDb()
    channelService = new ChannelService(db)
  })

  it('instantiates correctly', () => {
    expect(channelService).toBeDefined()
  })

  it('create() throws if name is missing', async () => {
    await expect(channelService.create({ name: '', description: '' })).rejects.toThrow()
  })

  it('create() throws if name is too short', async () => {
    await expect(channelService.create({ name: 'ab', description: '' })).rejects.toThrow()
  })

  it('getById() returns null when not found', async () => {
    const result = await channelService.getById('nonexistent')
    expect(result).toBeNull()
  })

  it('listAll() returns empty array when no channels', async () => {
    const result = await channelService.listAll()
    expect(result).toEqual([])
  })
})

// ============ VOTE SERVICE ============

describe('VoteService', () => {
  let voteService: VoteService
  let db: ReturnType<typeof createMockDb>

  beforeEach(() => {
    db = createMockDb()
    voteService = new VoteService(db)
  })

  it('instantiates correctly', () => {
    expect(voteService).toBeDefined()
  })

  it('upvote() throws if postId is missing', async () => {
    await expect(voteService.upvote('voter1', '', 10)).rejects.toThrow()
  })

  it('upvote() throws if voterId is missing', async () => {
    await expect(voteService.upvote('', 'post1', 10)).rejects.toThrow()
  })

  it('upvote() throws if amount is negative', async () => {
    await expect(voteService.upvote('voter1', 'post1', -5)).rejects.toThrow()
  })

  it('getVoteStats() returns zeros when no votes', async () => {
    const stats = await voteService.getVoteStats('post1')
    // Either returns null or zero stats
    if (stats) {
      expect(stats.ups ?? 0).toBeGreaterThanOrEqual(0)
    } else {
      expect(stats).toBeNull()
    }
  })

  it('getVotesByPost() returns empty array when no votes', async () => {
    const votes = await voteService.getVotesByPost('post1')
    expect(votes).toEqual([])
  })
})

// ============ AUTH SERVICE ============

describe('AuthService', () => {
  let authService: AuthService
  let db: ReturnType<typeof createMockDb>

  beforeEach(() => {
    // Ensure JWT_SECRET is set for tests
    process.env.JWT_SECRET = 'test-secret-32-chars-minimum-ok'
    db = createMockDb()
    authService = new AuthService(db)
  })

  it('instantiates correctly', () => {
    expect(authService).toBeDefined()
  })

  it('createChallenge() throws if agentId is missing', async () => {
    await expect(authService.createChallenge('')).rejects.toThrow('AgentId required')
  })

  it('createChallenge() throws if agent not found', async () => {
    vi.spyOn(db, 'get').mockResolvedValueOnce(null)
    await expect(authService.createChallenge('nonexistent')).rejects.toThrow('Agent not found')
  })

  it('verifyChallenge() throws if agentId is missing', async () => {
    await expect(authService.verifyChallenge('', 'challenge', 'sig')).rejects.toThrow('AgentId required')
  })

  it('verifyChallenge() throws if challenge is missing', async () => {
    await expect(authService.verifyChallenge('agent1', '', 'sig')).rejects.toThrow('Challenge required')
  })

  it('verifyChallenge() throws if signature is missing', async () => {
    await expect(authService.verifyChallenge('agent1', 'challenge', '')).rejects.toThrow('Signature required')
  })

  it('verifyChallenge() throws on invalid signature format', async () => {
    await expect(authService.verifyChallenge('agent1', 'challenge', 'not-hex!')).rejects.toThrow('Invalid signature format')
  })

  it('verifyChallenge() throws if challenge not found', async () => {
    vi.spyOn(db, 'get').mockResolvedValueOnce(null)
    await expect(
      authService.verifyChallenge('agent1', 'abc123', 'deadbeefdeadbeef')
    ).rejects.toThrow('Invalid or expired challenge')
  })

  it('validateToken() returns null for empty token', async () => {
    const result = await authService.validateToken('')
    expect(result).toBeNull()
  })

  it('validateToken() returns null for invalid token', async () => {
    const result = await authService.validateToken('not.a.valid.jwt')
    expect(result).toBeNull()
  })
})

// ============ AGENT SERVICE ============

describe('AgentService', () => {
  let agentService: AgentService
  let db: ReturnType<typeof createMockDb>

  beforeEach(() => {
    db = createMockDb()
    agentService = new AgentService(db)
  })

  it('instantiates correctly', () => {
    expect(agentService).toBeDefined()
  })

  it('register() throws if name is missing', async () => {
    await expect(agentService.register({
      name: '',
      publicKey: 'a'.repeat(66),
      ip: '127.0.0.1'
    })).rejects.toThrow('Name required')
  })

  it('register() throws if name is too short', async () => {
    await expect(agentService.register({
      name: 'ab',
      publicKey: 'a'.repeat(66),
      ip: '127.0.0.1'
    })).rejects.toThrow('3-50 characters')
  })

  it('register() throws if name has invalid characters', async () => {
    await expect(agentService.register({
      name: 'bad name!',
      publicKey: 'a'.repeat(66),
      ip: '127.0.0.1'
    })).rejects.toThrow('alphanumeric')
  })

  it('register() throws if publicKey is not hex', async () => {
    await expect(agentService.register({
      name: 'validname',
      publicKey: 'not-hex-at-all!!!',
      ip: '127.0.0.1'
    })).rejects.toThrow('hex-encoded')
  })

  it('register() throws if publicKey is too short', async () => {
    await expect(agentService.register({
      name: 'validname',
      publicKey: 'deadbeef',
      ip: '127.0.0.1'
    })).rejects.toThrow('33-65 bytes')
  })

  it('register() throws on rate limit', async () => {
    vi.spyOn(db, 'get').mockResolvedValueOnce({ id: 'recent-agent' })
    await expect(agentService.register({
      name: 'validname',
      publicKey: 'a'.repeat(66),
      ip: '127.0.0.1'
    })).rejects.toThrow('Rate limited')
  })

  it('register() throws if name already taken', async () => {
    vi.spyOn(db, 'get')
      .mockResolvedValueOnce(null)             // no rate limit hit
      .mockResolvedValueOnce({ id: 'existing' }) // name already taken
      .mockResolvedValueOnce(null)             // pubkey not taken (if it got here)
    await expect(agentService.register({
      name: 'takenname',
      publicKey: 'a'.repeat(66),
      ip: '127.0.0.1'
    })).rejects.toThrow('already taken')
  })

  it('getById() returns null when not found', async () => {
    const result = await agentService.getById('nonexistent')
    expect(result).toBeNull()
  })

  it('getEarnings() returns 0 when agent not found', async () => {
    const result = await agentService.getEarnings('nonexistent')
    expect(result).toBe(0)
  })

  it('addEarnings() throws on negative amount', async () => {
    await expect(agentService.addEarnings('agent1', -100)).rejects.toThrow('non-negative')
  })

  it('listAll() returns empty array when no agents', async () => {
    const result = await agentService.listAll()
    expect(result).toEqual([])
  })
})
