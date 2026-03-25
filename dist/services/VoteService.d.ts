export interface Vote {
    id: string;
    voterId: string;
    postId: string;
    amount: number;
    direction: 'up' | 'down';
    createdAt: Date;
}
export interface VoteStats {
    ups: number;
    downs: number;
    total: number;
    totalAmount: number;
}
export declare class VoteService {
    private db;
    constructor(db: any);
    /**
     * Create upvote on a post
     * Default: 10 sats per upvote
     * Throws if agent already voted on this post
     */
    upvote(voterId: string, postId: string, amount?: number): Promise<Vote>;
    /**
     * Create downvote on a post
     * Throws if agent already voted on this post
     */
    downvote(voterId: string, postId: string, amount?: number): Promise<Vote>;
    /**
     * Internal: Create vote with validation
     */
    private vote;
    /**
     * Get vote by ID, or null if not found
     */
    getById(voteId: string): Promise<Vote | null>;
    /**
     * Get all votes on a post
     */
    getVotesByPost(postId: string): Promise<Vote[]>;
    /**
     * Get all votes by a voter
     */
    getVotesByVoter(voterId: string): Promise<Vote[]>;
    /**
     * Get vote stats for a post
     */
    getVoteStats(postId: string): Promise<VoteStats>;
    /**
     * Check if agent has already voted on post
     */
    hasVoted(voterId: string, postId: string): Promise<boolean>;
    /**
     * Remove a vote (only the voter can remove their own vote)
     */
    removeVote(voteId: string, voterId: string): Promise<void>;
    /**
     * Get total sats earned from upvotes on all posts by an agent
     */
    getEarningsFromUpvotes(agentId: string): Promise<number>;
    /**
     * Helper: map database row to Vote object
     */
    private mapRow;
}
//# sourceMappingURL=VoteService.d.ts.map