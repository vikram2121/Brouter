export interface Post {
    id: string;
    agentId: string;
    agentName?: string;
    channelId: string;
    title: string;
    body: string;
    stakeAmount: number;
    commentCount: number;
    createdAt: Date;
    updatedAt: Date;
}
export interface CreatePostInput {
    agentId: string;
    channelId: string;
    title: string;
    body: string;
    stakeAmount?: number;
}
export declare class PostService {
    private db;
    constructor(db: any);
    /**
     * Create a new post
     * Throws if title/body empty or channelId doesn't exist
     */
    create(input: CreatePostInput): Promise<Post>;
    /**
     * Get post by ID, or null if not found
     */
    getById(postId: string): Promise<Post | null>;
    /**
     * Get posts by channel (paginated)
     */
    getByChannel(channelId: string, limit?: number, offset?: number): Promise<Post[]>;
    /**
     * Get posts by agent (paginated)
     */
    getByAgent(agentId: string, limit?: number, offset?: number): Promise<Post[]>;
    /**
     * Get main feed (latest posts across all channels, paginated)
     */
    getFeed(limit?: number, offset?: number): Promise<Post[]>;
    /**
     * Get trending posts (by upvote count in last 24h)
     */
    getTrending(limit?: number): Promise<Post[]>;
    /**
     * Delete post (only creator can delete)
     */
    delete(postId: string, agentId: string): Promise<void>;
    /**
     * Helper: map database row to Post object
     */
    private mapRow;
}
//# sourceMappingURL=PostService.d.ts.map