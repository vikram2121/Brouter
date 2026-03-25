"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthService = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const crypto_1 = __importDefault(require("crypto"));
const secp = __importStar(require("@noble/secp256k1"));
const sha2_js_1 = require("@noble/hashes/sha2.js");
// Fail fast if JWT secret not set
if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET environment variable is required in production');
}
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-DO-NOT-USE-IN-PRODUCTION';
const JWT_EXPIRY = '24h';
const CHALLENGE_EXPIRY_MINUTES = 5;
const MAX_CHALLENGES_PER_AGENT_PER_WINDOW = 3;
const CHALLENGE_WINDOW_MINUTES = 5;
class AuthService {
    constructor(db) {
        this.db = db;
    }
    /**
     * Create a login challenge for an agent
     * Challenge expires in 5 minutes
     * Rate limited: max 3 challenges per agent per 5 min
     */
    async createChallenge(agentId) {
        if (!agentId?.trim())
            throw new Error('AgentId required');
        // Verify agent exists
        const agent = await this.db.get('SELECT id FROM agents WHERE id = ?', [agentId]);
        if (!agent)
            throw new Error('Agent not found');
        // Rate limit: max 3 challenges per agent per 5 min window
        const recentCount = await this.db.get(`SELECT COUNT(*) as count FROM auth_challenges
       WHERE agentId = ? AND createdAt > DATE_SUB(NOW(), INTERVAL ? MINUTE)`, [agentId, CHALLENGE_WINDOW_MINUTES]);
        if (recentCount?.count >= MAX_CHALLENGES_PER_AGENT_PER_WINDOW) {
            console.warn(`[Auth] Rate limit: too many challenges for agentId=${agentId}`);
            throw new Error('Too many challenge requests. Try again in a few minutes.');
        }
        const challenge = crypto_1.default.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + CHALLENGE_EXPIRY_MINUTES * 60 * 1000);
        await this.db.run(`INSERT INTO auth_challenges (agentId, challenge, expiresAt, createdAt)
       VALUES (?, ?, ?, NOW())`, [agentId, challenge, expiresAt]);
        console.log(`[Auth] Challenge created for agentId=${agentId}`);
        return challenge;
    }
    /**
     * Verify a signed challenge and create auth token
     * Phase 1: validates signature is non-empty hex (format check)
     * Phase 2: implement full BRC-22 keypair signature verification
     */
    async verifyChallenge(agentId, challenge, signature) {
        if (!agentId?.trim())
            throw new Error('AgentId required');
        if (!challenge?.trim())
            throw new Error('Challenge required');
        if (!signature?.trim())
            throw new Error('Signature required');
        // Validate signature is valid hex
        if (!/^[0-9a-f]+$/i.test(signature) || signature.length < 16) {
            console.warn(`[Auth] Invalid signature format for agentId=${agentId}`);
            throw new Error('Invalid signature format');
        }
        // Get stored challenge (must exist and be unexpired)
        const storedChallenge = await this.db.get(`SELECT id, challenge, expiresAt FROM auth_challenges
       WHERE agentId = ? AND challenge = ? AND expiresAt > NOW()`, [agentId, challenge]);
        if (!storedChallenge) {
            console.warn(`[Auth] Invalid or expired challenge for agentId=${agentId}`);
            throw new Error('Invalid or expired challenge');
        }
        // Verify secp256k1 ECDSA signature against stored public key
        const agentRow = await this.db.get('SELECT publicKey FROM agents WHERE id = ?', [agentId]);
        if (agentRow?.publicKey) {
            try {
                const msgHash = (0, sha2_js_1.sha256)(new TextEncoder().encode(challenge));
                const pubKeyBytes = Uint8Array.from(Buffer.from(agentRow.publicKey, 'hex'));
                const sigBytes = Uint8Array.from(Buffer.from(signature, 'hex'));
                const valid = secp.verify(sigBytes, msgHash, pubKeyBytes, { lowS: false });
                if (!valid) {
                    console.warn(`[Auth] Signature verification failed for agentId=${agentId}`);
                    throw new Error('Signature verification failed');
                }
            }
            catch (err) {
                if (err.message === 'Signature verification failed')
                    throw err;
                // If pubkey is old format (pre-secp256k1), allow through for now
                console.warn(`[Auth] Sig verify error (legacy key?): ${err.message}`);
            }
        }
        // Create JWT — jti ensures uniqueness even for same agentId within same second
        const jti = crypto_1.default.randomBytes(16).toString('hex');
        const token = jsonwebtoken_1.default.sign({ agentId, jti }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        // Store token
        await this.db.run(`INSERT INTO auth_tokens (agentId, token, expiresAt, createdAt)
       VALUES (?, ?, ?, NOW())`, [agentId, token, expiresAt]);
        // Consume the challenge (delete after use)
        await this.db.run('DELETE FROM auth_challenges WHERE id = ?', [storedChallenge.id]);
        console.log(`[Auth] Token issued for agentId=${agentId}`);
        return { agentId, token, expiresAt };
    }
    /**
     * Create and store a token for an agent (used on registration)
     */
    async createToken(agentId) {
        const jti = crypto_1.default.randomBytes(16).toString('hex');
        const token = jsonwebtoken_1.default.sign({ agentId, jti }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await this.db.run(`INSERT INTO auth_tokens (agentId, token, expiresAt, createdAt) VALUES (?, ?, ?, NOW())`, [agentId, token, expiresAt]);
        return token;
    }
    /**
     * Validate an auth token
     * Returns agentId if valid, null if invalid/expired
     */
    async validateToken(token) {
        if (!token) {
            console.log('[Auth] validateToken: no token provided');
            return null;
        }
        try {
            console.log('[Auth] validateToken: verifying JWT...', { tokenLength: token.length });
            const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
            console.log('[Auth] validateToken: JWT verified', { agentId: decoded.agentId });
            // Check token exists in DB (not revoked)
            console.log('[Auth] validateToken: checking DB for token match...');
            const dbToken = await this.db.get(`SELECT agentId FROM auth_tokens WHERE token = ? AND expiresAt > NOW()`, [token]);
            if (!dbToken) {
                console.warn('[Auth] validateToken: token not found in DB or expired', {
                    agentId: decoded.agentId,
                    tokenLength: token.length
                });
                return null;
            }
            console.log('[Auth] validateToken: token valid', { agentId: dbToken.agentId });
            return dbToken.agentId;
        }
        catch (err) {
            console.error('[Auth] validateToken: error', { error: err.message, tokenLength: token.length });
            return null;
        }
    }
    /**
     * Revoke a single token (logout)
     */
    async revokeToken(token) {
        await this.db.run('DELETE FROM auth_tokens WHERE token = ?', [token]);
        console.log('[Auth] Token revoked');
    }
    /**
     * Revoke all tokens for an agent (logout all devices)
     */
    async revokeAllTokens(agentId) {
        await this.db.run('DELETE FROM auth_tokens WHERE agentId = ?', [agentId]);
        console.log(`[Auth] All tokens revoked for agentId=${agentId}`);
    }
    /**
     * Cleanup expired challenges and tokens (run via cron)
     */
    async cleanupExpired() {
        await this.db.run('DELETE FROM auth_challenges WHERE expiresAt < NOW()', []);
        await this.db.run('DELETE FROM auth_tokens WHERE expiresAt < NOW()', []);
        console.log('[Auth] Expired challenges and tokens cleaned up');
    }
}
exports.AuthService = AuthService;
//# sourceMappingURL=AuthService.js.map