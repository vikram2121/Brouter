import { DbConnection } from '../db/connection';
export interface Agent {
    id: string;
    pubkey: string;
    handle: string | null;
    displayName: string;
    description: string | null;
    avatar: string | null;
    homepage: string | null;
    totalStakedSats: number;
    totalEarnedSats: number;
    firstSeenAt: Date;
    createdAt: Date;
    updatedAt: Date;
}
export interface CreateAgentInput {
    name: string;
    publicKey: string;
    description?: string;
    bsvAddress?: string;
    ip: string;
}
export declare class AgentService {
    private db;
    constructor(db: DbConnection);
    /**
     * Register a new agent (v3 schema)
     * Validates pubkey uniqueness, format, and name constraints
     */
    register(input: CreateAgentInput): Promise<Agent>;
    /**
     * Get agent by ID
     */
    getById(agentId: string): Promise<Agent | null>;
    /**
     * Get agent by handle (display name)
     */
    getByName(handle: string): Promise<Agent | null>;
    /**
     * Get agent by public key (used for BRC-22 login)
     */
    getByPublicKey(publicKey: string): Promise<Agent | null>;
    /**
     * Get agent by BSV address (deprecated in v3)
     */
    getByAddress(bsvAddress: string): Promise<Agent | null>;
    /**
     * List all agents (paginated)
     */
    listAll(limit?: number, offset?: number): Promise<Agent[]>;
    /**
     * Get top agents by total earned sats (v3 metric)
     */
    getTopByReputation(limit?: number): Promise<Agent[]>;
    /**
     * Get top agents by earnings (alias for getTopByReputation in v3)
     */
    getTopByEarnings(limit?: number): Promise<Agent[]>;
    /**
     * Add earnings to agent (updates totalEarnedSats)
     */
    addEarnings(agentId: string, amount: number): Promise<void>;
    /**
     * Get total earnings for agent
     */
    getEarnings(agentId: string): Promise<number>;
    /**
     * Update reputation (uses totalStakedSats in v3)
     */
    updateReputation(agentId: string, delta: number): Promise<void>;
    /**
     * Get reputation (returns totalStakedSats in v3)
     */
    getReputation(agentId: string): Promise<number>;
    /**
     * Helper: map database row to Agent object (v3 schema)
     */
    private mapRow;
}
//# sourceMappingURL=AgentService.d.ts.map