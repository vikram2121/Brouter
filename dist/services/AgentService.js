"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentService = void 0;
const nanoid_1 = require("nanoid");
class AgentService {
    constructor(db) {
        this.db = db;
    }
    /**
     * Register a new agent (v3 schema)
     * Validates pubkey uniqueness, format, and name constraints
     */
    async register(input) {
        // Validate name (required, 3-50 alphanumeric characters)
        if (!input.name || input.name.trim().length === 0) {
            throw new Error('Name required');
        }
        if (input.name.length < 3 || input.name.length > 50) {
            throw new Error('Name must be 3-50 characters');
        }
        if (!/^[a-zA-Z0-9]+$/.test(input.name)) {
            throw new Error('Name must be alphanumeric (a-z, A-Z, 0-9 only)');
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
        const nameExists = await this.db.get('SELECT id FROM agents WHERE handle = ?', [input.name]);
        if (nameExists) {
            throw new Error('Name already taken');
        }
        // Validate public key (must be valid hex, 33-65 bytes = 66-130 hex chars)
        if (!input.publicKey?.trim())
            throw new Error('PublicKey required');
        if (!/^[0-9a-f]+$/i.test(input.publicKey))
            throw new Error('PublicKey must be hex-encoded');
        if (input.publicKey.length < 66 || input.publicKey.length > 130) {
            throw new Error('PublicKey must be 33-65 bytes (compressed or uncompressed BSV public key)');
        }
        // Check pubkey uniqueness
        const pubkeyExists = await this.db.get('SELECT id FROM agents WHERE pubkey = ?', [input.publicKey]);
        if (pubkeyExists)
            throw new Error('Public key already registered');
        const id = (0, nanoid_1.nanoid)();
        const now = new Date().toISOString().slice(0, 19).replace("T", " ");
        // Create agent (v3 schema)
        await this.db.run(`INSERT INTO agents (id, pubkey, handle, description, firstSeenAt, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`, [
            id,
            input.publicKey,
            input.name,
            input.description || null,
            now,
            now,
            now
        ]);
        return this.getById(id);
    }
    /**
     * Get agent by ID
     */
    async getById(agentId) {
        const row = await this.db.get('SELECT * FROM agents WHERE id = ?', [agentId]);
        return row ? this.mapRow(row) : null;
    }
    /**
     * Get agent by handle (display name)
     */
    async getByName(handle) {
        const row = await this.db.get('SELECT * FROM agents WHERE handle = ?', [handle]);
        return row ? this.mapRow(row) : null;
    }
    /**
     * Get agent by public key (used for BRC-22 login)
     */
    async getByPublicKey(publicKey) {
        const row = await this.db.get('SELECT * FROM agents WHERE pubkey = ?', [publicKey]);
        return row ? this.mapRow(row) : null;
    }
    /**
     * Get agent by BSV address (deprecated in v3)
     */
    async getByAddress(bsvAddress) {
        // v3 schema doesn't have bsvAddress field; use pubkey instead
        return null;
    }
    /**
     * List all agents (paginated)
     */
    async listAll(limit = 50, offset = 0) {
        const safeLimit = Math.min(Math.max(limit, 1), 100);
        const safeOffset = Math.max(offset, 0);
        const rows = await this.db.all(`SELECT * FROM agents ORDER BY totalEarnedSats DESC, firstSeenAt DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`, []);
        return rows.map((row) => this.mapRow(row));
    }
    /**
     * Get top agents by total earned sats (v3 metric)
     */
    async getTopByReputation(limit = 10) {
        const safeLimit = Math.min(Math.max(limit, 1), 100);
        const rows = await this.db.all(`SELECT * FROM agents ORDER BY totalEarnedSats DESC LIMIT ?`, [safeLimit]);
        return rows.map((row) => this.mapRow(row));
    }
    /**
     * Get top agents by earnings (alias for getTopByReputation in v3)
     */
    async getTopByEarnings(limit = 10) {
        return this.getTopByReputation(limit);
    }
    /**
     * Add earnings to agent (updates totalEarnedSats)
     */
    async addEarnings(agentId, amount) {
        if (amount < 0)
            throw new Error('Earnings must be non-negative');
        await this.db.run(`UPDATE agents SET totalEarnedSats = totalEarnedSats + ?, updatedAt = NOW() WHERE id = ?`, [amount, agentId]);
    }
    /**
     * Get total earnings for agent
     */
    async getEarnings(agentId) {
        const row = await this.db.get('SELECT totalEarnedSats FROM agents WHERE id = ?', [agentId]);
        return row?.totalEarnedSats || 0;
    }
    /**
     * Update reputation (uses totalStakedSats in v3)
     */
    async updateReputation(agentId, delta) {
        await this.db.run(`UPDATE agents SET totalStakedSats = totalStakedSats + ?, updatedAt = NOW() WHERE id = ?`, [delta, agentId]);
    }
    /**
     * Get reputation (returns totalStakedSats in v3)
     */
    async getReputation(agentId) {
        const row = await this.db.get('SELECT totalStakedSats FROM agents WHERE id = ?', [agentId]);
        return row?.totalStakedSats || 0;
    }
    /**
     * Helper: map database row to Agent object (v3 schema)
     */
    mapRow(row) {
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
            firstSeenAt: new Date(row.firstSeenAt),
            createdAt: new Date(row.createdAt),
            updatedAt: new Date(row.updatedAt)
        };
    }
}
exports.AgentService = AgentService;
//# sourceMappingURL=AgentService.js.map