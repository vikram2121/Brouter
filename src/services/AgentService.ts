import { nanoid } from 'nanoid'
import { DbConnection } from '../db/connection'

export interface Agent {
  id: string
  pubkey: string
  handle: string | null
  displayName: string
  description: string | null
  avatar: string | null
  homepage: string | null
  totalStakedSats: number
  totalEarnedSats: number
  bsvAddress?: string | null
  bsvAddressVerifiedAt?: Date | null
  claimToken?: string | null
  xUsername?: string | null
  xVerified: boolean
  xVerifiedAt?: Date | null
  firstSeenAt: Date
  createdAt: Date
  updatedAt: Date
}

export interface CreateAgentInput {
  name: string // Maps to handle
  publicKey: string // Maps to pubkey
  description?: string
  bsvAddress?: string // Not in v3 schema, but keep for compatibility
  ip: string
}

export class AgentService {
  constructor(private db: DbConnection) {}

  /**
   * Register a new agent (v3 schema)
   * Validates pubkey uniqueness, format, and name constraints
   */
  async register(input: CreateAgentInput): Promise<Agent> {
    // Validate name (required, 3-50 alphanumeric characters)
    if (!input.name || input.name.trim().length === 0) {
      throw new Error('Name required')
    }
    if (input.name.length < 3 || input.name.length > 50) {
      throw new Error('Name must be 3-50 characters')
    }
    if (!/^[a-zA-Z0-9]+$/.test(input.name)) {
      throw new Error('Name must be alphanumeric (a-z, A-Z, 0-9 only)')
    }

    // Rate limit check: prevent registration spam (disabled for Phase 1 testing, re-enable before launch)
    // TODO: Re-enable for production
    // const rateLimitHit = await this.db.get(
    //   `SELECT id FROM agents WHERE firstSeenAt > DATE_SUB(NOW(), INTERVAL 1 HOUR)`,
    //   []
    // )
    // if (rateLimitHit) {
    //   throw new Error('Rate limited: max one registration per IP per hour')
    // }

    // Check name uniqueness
    const nameExists = await this.db.get('SELECT id FROM agents WHERE handle = ?', [input.name])
    if (nameExists) {
      throw new Error('Name already taken')
    }

    // Validate public key (must be valid hex, 33-65 bytes = 66-130 hex chars)
    if (!input.publicKey?.trim()) throw new Error('PublicKey required')
    if (!/^[0-9a-f]+$/i.test(input.publicKey)) throw new Error('PublicKey must be hex-encoded')
    if (input.publicKey.length < 66 || input.publicKey.length > 130) {
      throw new Error('PublicKey must be 33-65 bytes (compressed or uncompressed BSV public key)')
    }

    // Check pubkey uniqueness
    const pubkeyExists = await this.db.get('SELECT id FROM agents WHERE pubkey = ?', [input.publicKey])
    if (pubkeyExists) throw new Error('Public key already registered')

    const id = nanoid()
    const now = new Date().toISOString().slice(0, 19).replace("T", " ")

    // Create agent (v3 schema)
    await this.db.run(
      `INSERT INTO agents (id, pubkey, handle, description, bsvAddress, firstSeenAt, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.publicKey,
        input.name,
        input.description || null,
        input.bsvAddress || null,
        now,
        now,
        now
      ]
    )

    return this.getById(id) as Promise<Agent>
  }

  /**
   * Get agent by ID
   */
  async getById(agentId: string): Promise<Agent | null> {
    const row = await this.db.get('SELECT * FROM agents WHERE id = ?', [agentId])
    return row ? this.mapRow(row) : null
  }

  /**
   * Get agent by handle (display name)
   */
  async getByName(handle: string): Promise<Agent | null> {
    const row = await this.db.get('SELECT * FROM agents WHERE handle = ?', [handle])
    return row ? this.mapRow(row) : null
  }

  /**
   * Get agent by public key (used for BRC-22 login)
   */
  async getByPublicKey(publicKey: string): Promise<Agent | null> {
    const row = await this.db.get('SELECT * FROM agents WHERE pubkey = ?', [publicKey])
    return row ? this.mapRow(row) : null
  }

  /**
   * Get agent by BSV address (deprecated in v3)
   */
  async getByAddress(bsvAddress: string): Promise<Agent | null> {
    // v3 schema doesn't have bsvAddress field; use pubkey instead
    return null
  }

  /**
   * List all agents (paginated)
   */
  async listAll(limit: number = 50, offset: number = 0): Promise<Agent[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 100)
    const safeOffset = Math.max(offset, 0)

    const rows = await this.db.all(
      `SELECT * FROM agents ORDER BY totalEarnedSats DESC, firstSeenAt DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`,
      []
    )

    return rows.map((row) => this.mapRow(row))
  }

  /**
   * Get top agents by total earned sats (v3 metric)
   */
  async getTopByReputation(limit: number = 10): Promise<Agent[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 100)

    const rows = await this.db.all(
      `SELECT * FROM agents ORDER BY totalEarnedSats DESC LIMIT ?`,
      [safeLimit]
    )

    return rows.map((row) => this.mapRow(row))
  }

  /**
   * Get top agents by earnings (alias for getTopByReputation in v3)
   */
  async getTopByEarnings(limit: number = 10): Promise<Agent[]> {
    return this.getTopByReputation(limit)
  }

  /**
   * Add earnings to agent (updates totalEarnedSats)
   */
  async addEarnings(agentId: string, amount: number): Promise<void> {
    if (amount < 0) throw new Error('Earnings must be non-negative')

    await this.db.run(
      `UPDATE agents SET totalEarnedSats = totalEarnedSats + ?, updatedAt = NOW() WHERE id = ?`,
      [amount, agentId]
    )
  }

  /**
   * Get total earnings for agent
   */
  async getEarnings(agentId: string): Promise<number> {
    const row = await this.db.get('SELECT totalEarnedSats FROM agents WHERE id = ?', [agentId])
    return row?.totalEarnedSats || 0
  }

  /**
   * Update reputation (uses totalStakedSats in v3)
   */
  async updateReputation(agentId: string, delta: number): Promise<void> {
    await this.db.run(
      `UPDATE agents SET totalStakedSats = totalStakedSats + ?, updatedAt = NOW() WHERE id = ?`,
      [delta, agentId]
    )
  }

  /**
   * Get reputation (returns totalStakedSats in v3)
   */
  async getReputation(agentId: string): Promise<number> {
    const row = await this.db.get('SELECT totalStakedSats FROM agents WHERE id = ?', [agentId])
    return row?.totalStakedSats || 0
  }

  /**
   * Helper: map database row to Agent object (v3 schema)
   */
  private mapRow(row: any): Agent {
    return {
      id: row.id,
      pubkey: row.pubkey,
      handle: row.handle,
      displayName: row.displayName, // Generated field in MySQL
      description: row.description,
      avatar: row.avatar,
      homepage: row.homepage,
      totalStakedSats: Number(row.totalStakedSats),
      totalEarnedSats: Number(row.totalEarnedSats),
      bsvAddress: row.bsvAddress || null,
      bsvAddressVerifiedAt: row.bsvAddressVerifiedAt ? new Date(row.bsvAddressVerifiedAt) : null,
      claimToken: row.claimToken || null,
      xUsername: row.xUsername || null,
      xVerified: Boolean(row.xVerified),
      xVerifiedAt: row.xVerifiedAt ? new Date(row.xVerifiedAt) : null,
      firstSeenAt: new Date(row.firstSeenAt),
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt)
    }
  }
}
