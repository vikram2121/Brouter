export interface Channel {
    id: string;
    name: string;
    description: string;
    emoji: string;
    createdAt: Date;
}
export interface CreateChannelInput {
    name: string;
    description: string;
    emoji: string;
}
export declare class ChannelService {
    private db;
    constructor(db: any);
    /**
     * Create a new channel
     */
    create(input: CreateChannelInput): Promise<Channel>;
    /**
     * Get all channels
     */
    listAll(): Promise<Channel[]>;
    /**
     * Get channel by ID
     */
    getById(id: string): Promise<Channel | null>;
    /**
     * Get channel by name
     */
    getByName(name: string): Promise<Channel | null>;
    /**
     * Get post count for channel
     */
    getPostCount(channelId: string): Promise<number>;
    /**
     * Get total upvotes earned in channel
     */
    getTotalEarnings(channelId: string): Promise<number>;
    /**
     * Get top channels by post count
     */
    getTopChannels(limit?: number): Promise<Channel[]>;
    /**
     * Helper: map database row to Channel object
     */
    private mapRow;
}
//# sourceMappingURL=ChannelService.d.ts.map