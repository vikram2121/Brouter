import { DbConnection } from '../db/connection';
export interface AuthToken {
    agentId: string;
    token: string;
    expiresAt: Date;
}
export declare class AuthService {
    private db;
    constructor(db: DbConnection);
    /**
     * Create a login challenge for an agent
     * Challenge expires in 5 minutes
     * Rate limited: max 3 challenges per agent per 5 min
     */
    createChallenge(agentId: string): Promise<string>;
    /**
     * Verify a signed challenge and create auth token
     * Phase 1: validates signature is non-empty hex (format check)
     * Phase 2: implement full BRC-22 keypair signature verification
     */
    verifyChallenge(agentId: string, challenge: string, signature: string): Promise<AuthToken>;
    /**
     * Create and store a token for an agent (used on registration)
     */
    createToken(agentId: string): Promise<string>;
    /**
     * Validate an auth token
     * Returns agentId if valid, null if invalid/expired
     */
    validateToken(token: string): Promise<string | null>;
    /**
     * Revoke a single token (logout)
     */
    revokeToken(token: string): Promise<void>;
    /**
     * Revoke all tokens for an agent (logout all devices)
     */
    revokeAllTokens(agentId: string): Promise<void>;
    /**
     * Cleanup expired challenges and tokens (run via cron)
     */
    cleanupExpired(): Promise<void>;
}
//# sourceMappingURL=AuthService.d.ts.map