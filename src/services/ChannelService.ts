import { nanoid } from 'nanoid'

export interface Channel {
  id: string
  name: string
  description: string
  emoji: string
  createdAt: Date
}

export interface CreateChannelInput {
  name: string
  description: string
  emoji: string
}

export class ChannelService {
  constructor(private db: any) {}

  /**
   * Create a new channel
   */
  async create(input: CreateChannelInput): Promise<Channel> {
    // Validate inputs
    if (!input.name?.trim() || input.name.length > 100) {
      throw new Error('Name required (max 100 chars)')
    }
    if (!input.description?.trim() || input.description.length > 1000) {
      throw new Error('Description required (max 1000 chars)')
    }
    if (!input.emoji?.trim() || input.emoji.length > 2) {
      throw new Error('Emoji required (1-2 chars)')
    }

    const id = nanoid()
    const now = new Date().toISOString().slice(0, 19).replace("T", " ")

    await this.db.run(
      `INSERT INTO channels (id, name, description, emoji, createdAt)
       VALUES (?, ?, ?, ?, ?)`,
      [id, input.name, input.description, input.emoji, now]
    )

    const channel = await this.db.get('SELECT * FROM channels WHERE id = ?', [id])
    if (!channel) throw new Error('Failed to create channel')

    return this.mapRow(channel)
  }

  /**
   * Get all channels
   */
  async listAll(): Promise<Channel[]> {
    const rows = await this.db.all('SELECT * FROM channels ORDER BY name ASC', [])
    return rows.map((row: any) => this.mapRow(row))
  }

  /**
   * Get channel by ID
   */
  async getById(id: string): Promise<Channel | null> {
    const row = await this.db.get('SELECT * FROM channels WHERE id = ?', [id])
    return row ? this.mapRow(row) : null
  }

  /**
   * Get channel by name
   */
  async getByName(name: string): Promise<Channel | null> {
    const row = await this.db.get('SELECT * FROM channels WHERE name = ?', [name])
    return row ? this.mapRow(row) : null
  }

  /**
   * Get post count for channel
   */
  async getPostCount(channelId: string): Promise<number> {
    const result = await this.db.get(
      'SELECT COUNT(*) as count FROM signals WHERE channelId = ?',
      [channelId]
    )
    return result?.count || 0
  }

  /**
   * Get total upvotes earned in channel
   */
  async getTotalEarnings(channelId: string): Promise<number> {
    const result = await this.db.get(
      `SELECT COALESCE(SUM(v.amount), 0) as total
       FROM votes v
       JOIN posts p ON v.postId = p.id
       WHERE p.channelId = ? AND v.direction = 'up'`,
      [channelId]
    )
    return result?.total || 0
  }

  /**
   * Get top channels by post count
   */
  async getTopChannels(limit: number = 10): Promise<Channel[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 100)

    const rows = await this.db.all(
      `SELECT c.*, COUNT(p.id) as post_count
       FROM channels c
       LEFT JOIN posts p ON c.id = p.channelId
       GROUP BY c.id
       ORDER BY post_count DESC
       LIMIT ?`,
      [safeLimit]
    )

    return rows.map((row: any) => this.mapRow(row))
  }

  /**
   * Helper: map database row to Channel object
   */
  private mapRow(row: any): Channel {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      emoji: row.emoji,
      createdAt: new Date(row.createdAt)
    }
  }
}
