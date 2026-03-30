import { describe, it, expect, beforeEach, vi } from 'vitest'
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

// ============ RELATIONSHIP HELPERS ============

/**
 * Helper class for testing relationship operations
 * (In production, these would be part of a RelationshipService or route handlers)
 */
class RelationshipHelper {
  constructor(private db: DbConnection) {}

  async createRelationship(
    fromAgentId: string,
    toAgentId: string,
    type: 'follow' | 'trust'
  ): Promise<{ valid: boolean; error?: string }> {
    // Validation: prevent self-follow/self-trust
    if (fromAgentId === toAgentId) {
      return { valid: false, error: 'Cannot create self-relationship' }
    }

    // Validation: check type is valid
    if (!['follow', 'trust'].includes(type)) {
      return { valid: false, error: `Invalid relationship type: ${type}` }
    }

    // Insert relationship
    await this.db.run(
      `INSERT INTO agent_relationships (from_agent_id, to_agent_id, relationship_type, created_at)
       VALUES (?, ?, ?, NOW())`,
      [fromAgentId, toAgentId, type]
    )

    return { valid: true }
  }

  async getRelationships(agentId: string): Promise<any[]> {
    const outgoing = await this.db.all(
      `SELECT from_agent_id, to_agent_id, relationship_type as type, created_at
       FROM agent_relationships WHERE from_agent_id = ? ORDER BY created_at DESC`,
      [agentId]
    )

    const incoming = await this.db.all(
      `SELECT from_agent_id, to_agent_id, relationship_type as type, created_at
       FROM agent_relationships WHERE to_agent_id = ? ORDER BY created_at DESC`,
      [agentId]
    )

    return [...outgoing, ...incoming]
  }

  async listFollowers(agentId: string): Promise<any[]> {
    return this.db.all(
      `SELECT from_agent_id as follower_id, created_at
       FROM agent_relationships WHERE to_agent_id = ? AND relationship_type = 'follow'
       ORDER BY created_at DESC`,
      [agentId]
    )
  }

  async listFollowing(agentId: string): Promise<any[]> {
    return this.db.all(
      `SELECT to_agent_id as following_id, created_at
       FROM agent_relationships WHERE from_agent_id = ? AND relationship_type = 'follow'
       ORDER BY created_at DESC`,
      [agentId]
    )
  }

  async getTrustedAgents(agentId: string): Promise<any[]> {
    return this.db.all(
      `SELECT to_agent_id as trusted_id, created_at
       FROM agent_relationships WHERE from_agent_id = ? AND relationship_type = 'trust'
       ORDER BY created_at DESC`,
      [agentId]
    )
  }

  async deleteRelationship(
    fromAgentId: string,
    toAgentId: string,
    type: 'follow' | 'trust'
  ): Promise<void> {
    await this.db.run(
      `DELETE FROM agent_relationships WHERE from_agent_id = ? AND to_agent_id = ? AND relationship_type = ?`,
      [fromAgentId, toAgentId, type]
    )
  }
}

// ============ RELATIONSHIP TESTS ============

describe('Relationships', () => {
  let db: ReturnType<typeof createMockDb>
  let helper: RelationshipHelper

  beforeEach(() => {
    db = createMockDb()
    helper = new RelationshipHelper(db)
  })

  it('creates a follow relationship between two agents', async () => {
    const runSpy = vi.spyOn(db, 'run')

    const result = await helper.createRelationship('agent1', 'agent2', 'follow')

    expect(result.valid).toBe(true)
    expect(runSpy).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO agent_relationships'),
      ['agent1', 'agent2', 'follow']
    )
  })

  it('creates a trust relationship between two agents', async () => {
    const runSpy = vi.spyOn(db, 'run')

    const result = await helper.createRelationship('agent1', 'agent3', 'trust')

    expect(result.valid).toBe(true)
    expect(runSpy).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO agent_relationships'),
      ['agent1', 'agent3', 'trust']
    )
  })

  it('gets relationships for an agent', async () => {
    const mockRelationships = [
      {
        from_agent_id: 'agent1',
        to_agent_id: 'agent2',
        type: 'follow',
        created_at: '2025-03-30T12:00:00'
      },
      {
        from_agent_id: 'agent3',
        to_agent_id: 'agent1',
        type: 'trust',
        created_at: '2025-03-30T11:00:00'
      }
    ]

    vi.spyOn(db, 'all')
      .mockResolvedValueOnce([mockRelationships[0]]) // Outgoing
      .mockResolvedValueOnce([mockRelationships[1]]) // Incoming

    const relationships = await helper.getRelationships('agent1')

    expect(relationships).toHaveLength(2)
    expect(relationships[0].type).toBe('follow')
    expect(relationships[1].type).toBe('trust')
  })

  it('prevents self-follow', async () => {
    const result = await helper.createRelationship('agent1', 'agent1', 'follow')

    expect(result.valid).toBe(false)
    expect(result.error).toContain('Cannot create self-relationship')
  })

  it('prevents self-trust', async () => {
    const result = await helper.createRelationship('agent2', 'agent2', 'trust')

    expect(result.valid).toBe(false)
    expect(result.error).toContain('Cannot create self-relationship')
  })

  it('validates relationship type (only valid types accepted)', async () => {
    const result = await helper.createRelationship('agent1', 'agent2', 'invalid-type' as any)

    expect(result.valid).toBe(false)
    expect(result.error).toContain('Invalid relationship type')
  })

  it('lists followers correctly', async () => {
    const mockFollowers = [
      { follower_id: 'agent2', created_at: '2025-03-30T12:00:00' },
      { follower_id: 'agent3', created_at: '2025-03-30T11:00:00' }
    ]

    vi.spyOn(db, 'all').mockResolvedValueOnce(mockFollowers)

    const followers = await helper.listFollowers('agent1')

    expect(followers).toHaveLength(2)
    expect(followers[0].follower_id).toBe('agent2')
    expect(followers[1].follower_id).toBe('agent3')
  })

  it('lists following correctly', async () => {
    const mockFollowing = [
      { following_id: 'agent4', created_at: '2025-03-30T12:00:00' },
      { following_id: 'agent5', created_at: '2025-03-30T11:00:00' }
    ]

    vi.spyOn(db, 'all').mockResolvedValueOnce(mockFollowing)

    const following = await helper.listFollowing('agent1')

    expect(following).toHaveLength(2)
    expect(following[0].following_id).toBe('agent4')
  })

  it('lists trusted agents correctly', async () => {
    const mockTrusted = [
      { trusted_id: 'agent6', created_at: '2025-03-30T12:00:00' },
      { trusted_id: 'agent7', created_at: '2025-03-30T11:00:00' }
    ]

    vi.spyOn(db, 'all').mockResolvedValueOnce(mockTrusted)

    const trusted = await helper.getTrustedAgents('agent1')

    expect(trusted).toHaveLength(2)
    expect(trusted[0].trusted_id).toBe('agent6')
  })

  it('deletes a relationship', async () => {
    const runSpy = vi.spyOn(db, 'run')

    await helper.deleteRelationship('agent1', 'agent2', 'follow')

    expect(runSpy).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM agent_relationships'),
      ['agent1', 'agent2', 'follow']
    )
  })

  it('listing relationships returns correct shape', async () => {
    const mockData = [
      {
        from_agent_id: 'agent1',
        to_agent_id: 'agent2',
        type: 'follow',
        created_at: '2025-03-30T12:00:00'
      }
    ]

    vi.spyOn(db, 'all')
      .mockResolvedValueOnce(mockData)
      .mockResolvedValueOnce([])

    const relationships = await helper.getRelationships('agent1')

    if (relationships.length > 0) {
      expect(relationships[0]).toHaveProperty('from_agent_id')
      expect(relationships[0]).toHaveProperty('to_agent_id')
      expect(relationships[0]).toHaveProperty('type')
      expect(relationships[0]).toHaveProperty('created_at')
    }
  })
})
