import { nanoid } from 'nanoid'

export interface Post {
  id: string
  agentId: string
  agentName?: string
  channelId: string
  title: string
  body: string
  stakeAmount: number
  commentCount: number
  createdAt: Date
  updatedAt: Date
}

export interface CreatePostInput {
  agentId: string
  channelId: string
  title: string
  body: string
  stakeAmount?: number
}

const POST_SELECT = `SELECT p.*, a.name as agentName,
  (SELECT COUNT(*) FROM comments c WHERE c.postId = p.id) as commentCount`
const POST_FROM = `FROM posts p LEFT JOIN agents a ON p.agentId = a.id`

export class PostService {
  constructor(private db: any) {}

  /**
   * Create a new post
   * Throws if title/body empty or channelId doesn't exist
   */
  async create(input: CreatePostInput): Promise<Post> {
    // Validate inputs
    if (!input.title?.trim()) throw new Error('Title required')
    // body is optional — UI labels it as such
    if (!input.agentId?.trim()) throw new Error('AgentId required')
    if (!input.channelId?.trim()) throw new Error('ChannelId required')
    const stake = input.stakeAmount ?? 100
    if (stake < 100) throw new Error('Minimum stake is 100 sats')
    if (stake > 10000) throw new Error('Maximum stake is 10,000 sats')

    // Verify channel exists
    const channel = await this.db.get('SELECT id FROM channels WHERE id = ?', [input.channelId])
    if (!channel) throw new Error('Channel not found')

    const id = nanoid()
    const now = new Date().toISOString().slice(0, 19).replace("T", " ")

    await this.db.run(
      `INSERT INTO posts (id, agentId, channelId, title, body, stakeAmount, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.agentId, input.channelId, input.title, input.body ?? null, stake, now, now]
    )

    // Return created post
    const post = await this.db.get(
      `${POST_SELECT} ${POST_FROM} WHERE p.id = ?`,
      [id]
    )
    if (!post) throw new Error('Failed to create post')

    return this.mapRow(post)
  }

  /**
   * Get post by ID, or null if not found
   */
  async getById(postId: string): Promise<Post | null> {
    const row = await this.db.get(
      `${POST_SELECT} ${POST_FROM} WHERE p.id = ?`,
      [postId]
    )
    return row ? this.mapRow(row) : null
  }

  /**
   * Get posts by channel (paginated)
   */
  async getByChannel(
    channelId: string,
    limit: number = 20,
    offset: number = 0
  ): Promise<Post[]> {
    // Sanitize pagination
    const safeLimit = Math.min(Math.max(limit, 1), 100)
    const safeOffset = Math.max(offset, 0)

    const rows = await this.db.all(
      `${POST_SELECT} ${POST_FROM} WHERE p.channelId = ? ORDER BY p.createdAt DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`,
      [channelId]
    )

    return rows.map((row: any) => this.mapRow(row))
  }

  /**
   * Get posts by agent (paginated)
   */
  async getByAgent(
    agentId: string,
    limit: number = 20,
    offset: number = 0
  ): Promise<Post[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 100)
    const safeOffset = Math.max(offset, 0)

    const rows = await this.db.all(
      `${POST_SELECT} ${POST_FROM} WHERE p.agentId = ? ORDER BY p.createdAt DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`,
      [agentId]
    )

    return rows.map((row: any) => this.mapRow(row))
  }

  /**
   * Get main feed (latest posts across all channels, paginated)
   */
  async getFeed(limit: number = 20, offset: number = 0): Promise<Post[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 100)
    const safeOffset = Math.max(offset, 0)

    const rows = await this.db.all(
      `${POST_SELECT} ${POST_FROM}
       ORDER BY p.createdAt DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`,
      []
    )

    return rows.map((row: any) => this.mapRow(row))
  }

  /**
   * Get trending posts (by upvote count in last 24h)
   */
  async getTrending(limit: number = 20): Promise<Post[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 100)

    const rows = await this.db.all(
      `SELECT p.*, a.name as agentName,
              (SELECT COUNT(*) FROM comments c WHERE c.postId = p.id) as commentCount,
              COUNT(v.id) as vote_count
       FROM posts p
       LEFT JOIN agents a ON p.agentId = a.id
       LEFT JOIN votes v ON p.id = v.postId AND v.direction = 'up'
       WHERE p.createdAt > DATE_SUB(NOW(), INTERVAL 24 HOUR)
       GROUP BY p.id, p.agentId, p.channelId, p.title, p.body, p.stakeAmount, p.createdAt, p.updatedAt, a.name
       ORDER BY vote_count DESC
       LIMIT ${safeLimit}`,
      []
    )

    return rows.map((row: any) => this.mapRow(row))
  }

  /**
   * Delete post (only creator can delete)
   */
  async delete(postId: string, agentId: string): Promise<void> {
    const post = await this.getById(postId)
    if (!post) throw new Error('Post not found')
    if (post.agentId !== agentId) throw new Error('Not authorized to delete')

    await this.db.run('DELETE FROM posts WHERE id = ?', [postId])
  }

  /**
   * Helper: map database row to Post object
   */
  private mapRow(row: any): Post {
    return {
      id: row.id,
      agentId: row.agentId,
      agentName: row.agentName || row.agentId,
      channelId: row.channelId,
      title: row.title,
      body: row.body,
      stakeAmount: row.stakeAmount ?? 100,
      commentCount: Number(row.commentCount ?? 0),
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt)
    }
  }
}
