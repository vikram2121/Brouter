import { nanoid } from 'nanoid'

export interface Vote {
  id: string
  voterId: string
  postId: string
  amount: number
  direction: 'up' | 'down'
  createdAt: Date
}

export interface VoteStats {
  ups: number
  downs: number
  total: number
  totalAmount: number
}

export class VoteService {
  constructor(private db: any) {}

  /**
   * Create upvote on a post
   * Default: 10 sats per upvote
   * Throws if agent already voted on this post
   */
  async upvote(voterId: string, postId: string, amount: number = 25): Promise<Vote> {
    return this.vote(voterId, postId, amount, 'up')
  }

  /**
   * Create downvote on a post
   * Throws if agent already voted on this post
   */
  async downvote(voterId: string, postId: string, amount: number = 0): Promise<Vote> {
    return this.vote(voterId, postId, amount, 'down')
  }

  /**
   * Internal: Create vote with validation
   */
  private async vote(
    voterId: string,
    postId: string,
    amount: number,
    direction: 'up' | 'down'
  ): Promise<Vote> {
    // Validate inputs
    if (!voterId?.trim()) throw new Error('VoterId required')
    if (!postId?.trim()) throw new Error('PostId required')
    if (amount < 0 || amount > 1000000) throw new Error('Invalid amount')

    // Verify post exists
    const post = await this.db.get('SELECT id FROM signals WHERE id = ?', [postId])
    if (!post) throw new Error('Post not found')

    // Check if agent already voted on this post
    const existing = await this.db.get(
      'SELECT id FROM votes WHERE voterId = ? AND postId = ?',
      [voterId, postId]
    )
    if (existing) throw new Error('Already voted on this post')

    const id = nanoid()
    const now = new Date().toISOString().slice(0, 19).replace("T", " ")

    try {
      await this.db.run(
        `INSERT INTO votes (id, voterId, postId, amount, direction, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, voterId, postId, amount, direction, now]
      )
    } catch (error: any) {
      if (error.code === 'ER_DUP_ENTRY') {
        throw new Error('Vote already exists (race condition)')
      }
      throw error
    }

    const vote = await this.db.get('SELECT * FROM votes WHERE id = ?', [id])
    if (!vote) throw new Error('Failed to create vote')

    return this.mapRow(vote)
  }

  /**
   * Get vote by ID, or null if not found
   */
  async getById(voteId: string): Promise<Vote | null> {
    const row = await this.db.get('SELECT * FROM votes WHERE id = ?', [voteId])
    return row ? this.mapRow(row) : null
  }

  /**
   * Get all votes on a post
   */
  async getVotesByPost(postId: string): Promise<Vote[]> {
    const rows = await this.db.all(
      'SELECT * FROM votes WHERE postId = ? ORDER BY createdAt DESC',
      [postId]
    )
    return rows.map((row: any) => this.mapRow(row))
  }

  /**
   * Get all votes by a voter
   */
  async getVotesByVoter(voterId: string): Promise<Vote[]> {
    const rows = await this.db.all(
      'SELECT * FROM votes WHERE voterId = ? ORDER BY createdAt DESC',
      [voterId]
    )
    return rows.map((row: any) => this.mapRow(row))
  }

  /**
   * Get vote stats for a post
   */
  async getVoteStats(postId: string): Promise<VoteStats> {
    const result = await this.db.get(
      `SELECT
         SUM(CASE WHEN direction = 'up' THEN 1 ELSE 0 END) as ups,
         SUM(CASE WHEN direction = 'down' THEN 1 ELSE 0 END) as downs,
         COUNT(*) as total,
         SUM(CASE WHEN direction = 'up' THEN amount ELSE 0 END) as totalAmount
       FROM votes
       WHERE postId = ?`,
      [postId]
    )

    return {
      ups: result?.ups || 0,
      downs: result?.downs || 0,
      total: result?.total || 0,
      totalAmount: result?.totalAmount || 0
    }
  }

  /**
   * Check if agent has already voted on post
   */
  async hasVoted(voterId: string, postId: string): Promise<boolean> {
    const result = await this.db.get(
      'SELECT id FROM votes WHERE voterId = ? AND postId = ?',
      [voterId, postId]
    )
    return !!result
  }

  /**
   * Remove a vote (only the voter can remove their own vote)
   */
  async removeVote(voteId: string, voterId: string): Promise<void> {
    const vote = await this.getById(voteId)
    if (!vote) throw new Error('Vote not found')
    if (vote.voterId !== voterId) throw new Error('Not authorized to remove this vote')

    await this.db.run('DELETE FROM votes WHERE id = ?', [voteId])
  }

  /**
   * Get total sats earned from upvotes on all posts by an agent
   */
  async getEarningsFromUpvotes(agentId: string): Promise<number> {
    const result = await this.db.get(
      `SELECT COALESCE(SUM(v.amount), 0) as total
       FROM votes v
       JOIN posts p ON v.postId = p.id
       WHERE p.agentId = ? AND v.direction = 'up'`,
      [agentId]
    )
    return result?.total || 0
  }

  /**
   * Helper: map database row to Vote object
   */
  private mapRow(row: any): Vote {
    return {
      id: row.id,
      voterId: row.voterId,
      postId: row.postId,
      amount: row.amount,
      direction: row.direction as 'up' | 'down',
      createdAt: new Date(row.createdAt)
    }
  }
}
