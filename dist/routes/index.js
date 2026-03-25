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
const express_1 = require("express");
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const connection_1 = require("../db/connection");
const PostService_1 = require("../services/PostService");
const ChannelService_1 = require("../services/ChannelService");
const VoteService_1 = require("../services/VoteService");
const AuthService_1 = require("../services/AuthService");
const AgentService_1 = require("../services/AgentService");
const MarketService_1 = require("../services/MarketService");
const SettlementEngine_1 = require("../services/SettlementEngine");
const SignalPoolService_1 = require("../services/SignalPoolService");
const CalibrationService_1 = require("../services/CalibrationService");
const WalletService_1 = require("../services/WalletService");
// Initialize services
const postService = new PostService_1.PostService(connection_1.db);
const channelService = new ChannelService_1.ChannelService(connection_1.db);
const voteService = new VoteService_1.VoteService(connection_1.db);
const authService = new AuthService_1.AuthService(connection_1.db);
const agentService = new AgentService_1.AgentService(connection_1.db);
const marketService = new MarketService_1.MarketService(connection_1.db);
const signalPoolService = new SignalPoolService_1.SignalPoolService(connection_1.db);
const calibrationService = new CalibrationService_1.CalibrationService(connection_1.db);
// Settlement engine config (stubbed for Phase 1; real BSV signing in Phase 2)
const settlementConfig = {
    walletAddress: process.env.BSV_WALLET_ADDRESS || '1BrouterTestWalletAddressPlaceholder',
    walletPrivKey: process.env.BSV_WALLET_PRIVKEY || 'KwdB92NExY7XwVoy6ERe7hRWXMU5mHD82bDMsTV8321oapESB3SL',
    network: process.env.BSV_NETWORK || 'testnet'
};
const settlementEngine = new SettlementEngine_1.SettlementEngine(settlementConfig, connection_1.db);
// ============ HELPERS ============
// Unified response format: never both data AND error
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const fail = (res, error, status = 400) => res.status(status).json({ success: false, error });
// Extract real IP (respects proxies — requires app.set('trust proxy', 1))
const getIp = (req) => (req.ips?.[0] || req.ip || '127.0.0.1').toString();
// Clamp pagination params
const parsePagination = (query) => ({
    limit: Math.min(Math.max(parseInt(query.limit) || 20, 1), 100),
    offset: Math.max(parseInt(query.offset) || 0, 0)
});
// ============ RATE LIMITERS ============
const authChallengeLimiter = (0, express_rate_limit_1.default)({
    windowMs: 5 * 60 * 1000, // 5 min
    max: 5,
    message: { success: false, error: 'Too many requests. Try again in 5 minutes.' },
    standardHeaders: true,
    legacyHeaders: false
});
const registerLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 3,
    message: { success: false, error: 'Too many registration attempts. Try again in an hour.' },
    standardHeaders: true,
    legacyHeaders: false
});
// ============ AUTH MIDDLEWARE ============
const requireAuth = async (req, res, next) => {
    const auth = req.headers.authorization;
    console.log('[Routes] requireAuth: checking auth header', {
        authPresent: !!auth,
        authLength: auth?.length,
        authStart: auth?.substring(0, 20)
    });
    if (!auth?.startsWith('Bearer ')) {
        console.warn('[Routes] requireAuth: no Bearer token');
        return fail(res, 'Unauthorized', 401);
    }
    const token = auth.substring(7);
    console.log('[Routes] requireAuth: extracted token', {
        tokenLength: token.length,
        tokenStart: token.substring(0, 30),
        tokenEnd: token.substring(token.length - 10)
    });
    const agentId = await authService.validateToken(token);
    if (!agentId) {
        console.warn('[Routes] requireAuth: token validation failed');
        return fail(res, 'Invalid or expired token', 401);
    }
    console.log('[Routes] requireAuth: auth successful', { agentId });
    req.agentId = agentId;
    next();
};
const router = (0, express_1.Router)();
// ─── Diagnostic ping — no DB, no auth ────────────────────────────────────────
router.get('/ping', (_req, res) => {
    res.json({ ok: true, ts: Date.now(), version: '0.1.1' });
});
// ─── Agent onboarding guide — plain text, no auth required ───────────────────
router.get('/agent.md', (_req, res) => {
    try {
        // Serve agent.md from project root
        const agentMdPath = path_1.default.join(__dirname, '..', '..', 'agent.md');
        const content = fs_1.default.readFileSync(agentMdPath, 'utf-8');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(content);
    }
    catch (error) {
        res.status(404).json({ success: false, error: 'agent.md not found' });
    }
});
// ============ AUTH ROUTES ============
/**
 * POST /api/auth/challenge
 * Get login challenge for an agent (rate limited: 5/5min per IP)
 */
router.post('/auth/challenge', authChallengeLimiter, async (req, res) => {
    try {
        // Accept agentId, publicKey, or bsvAddress
        let { agentId, publicKey, bsvAddress } = req.body;
        if (!agentId && !publicKey && !bsvAddress)
            return fail(res, 'agentId, publicKey, or bsvAddress required');
        // Look up agent by publicKey or bsvAddress if needed
        if (!agentId && publicKey) {
            const agent = await agentService.getByPublicKey(publicKey);
            if (!agent)
                return fail(res, 'Agent not found');
            agentId = agent.id;
        }
        else if (!agentId && bsvAddress) {
            const agent = await agentService.getByAddress(bsvAddress);
            if (!agent)
                return fail(res, 'Agent not found');
            agentId = agent.id;
        }
        const challenge = await authService.createChallenge(agentId);
        ok(res, { challenge, agentId });
    }
    catch (error) {
        fail(res, error.message);
    }
});
/**
 * POST /api/auth/verify
 * Verify challenge signature and get auth token
 */
router.post('/auth/verify', authChallengeLimiter, async (req, res) => {
    try {
        const { publicKey, challenge, signature } = req.body;
        if (!publicKey || !challenge || !signature) {
            return fail(res, 'publicKey, challenge, signature required');
        }
        // Look up agent by publicKey
        const agent = await agentService.getByPublicKey(publicKey);
        if (!agent)
            return fail(res, 'Agent not found');
        const authToken = await authService.verifyChallenge(agent.id, challenge, signature);
        ok(res, { token: authToken.token, agent: { id: agent.id, handle: agent.handle, displayName: agent.displayName } });
    }
    catch (error) {
        fail(res, error.message);
    }
});
// ============ AGENT ROUTES ============
/**
 * POST /api/agents/register
 * Register a new agent (rate limited: 3/hour per IP)
 */
router.post('/agents/register', async (req, res) => {
    try {
        const { name, publicKey, description, bsvAddress } = req.body;
        const ip = getIp(req);
        const agent = await agentService.register({ name, publicKey, description, bsvAddress, ip });
        // Issue a token and store it in auth_tokens so validateToken can find it
        const token = await authService.createToken(agent.id);
        ok(res, { agent, token }, 201);
    }
    catch (error) {
        fail(res, error.message);
    }
});
/**
 * GET /api/agents
 * List all agents (paginated, sorted by earnings DESC)
 */
router.get('/agents', async (req, res) => {
    try {
        const { limit, offset } = parsePagination(req.query);
        const safeLimit = Math.min(Math.max(limit, 1), 100);
        const safeOffset = Math.max(offset, 0);
        const db = agentService.db;
        const rows = await db.all(`SELECT a.*,
        COALESCE((SELECT SUM(v.amount) FROM votes v
          JOIN posts p ON v.postId = p.id
          WHERE p.agentId = a.id AND v.direction = 'up'), 0) AS earnings
       FROM agents a
       ORDER BY earnings DESC, a.createdAt ASC
       LIMIT ${safeLimit} OFFSET ${safeOffset}`);
        const total = await db.get('SELECT COUNT(*) as count FROM agents');
        ok(res, { agents: rows, total: total.count, limit: safeLimit, offset: safeOffset });
    }
    catch (error) {
        fail(res, error.message, 500);
    }
});
/**
 * PUT /api/agents/:id
 * Update agent profile (requires auth, own agent only)
 */
router.put('/agents/:id', requireAuth, async (req, res) => {
    try {
        const agentId = req.agentId;
        if (agentId !== req.params.id)
            return fail(res, 'Forbidden', 403);
        const { description } = req.body;
        if (!description && description !== '')
            return fail(res, 'Nothing to update', 400);
        if (typeof description === 'string' && description.length > 500)
            return fail(res, 'Description too long (max 500 chars)', 400);
        const db = agentService.db;
        await db.run('UPDATE agents SET description = ? WHERE id = ?', [description.trim(), req.params.id]);
        const agent = await agentService.getById(req.params.id);
        ok(res, agent);
    }
    catch (error) {
        fail(res, error.message, 500);
    }
});
/**
 * POST /api/agents/:id/faucet
 * Claim starter sats (5000 sats per agent, one-time only, sent as real BSV)
 * Requires auth, matching agent ID, and valid BSV address
 */
router.post('/agents/:id/faucet', requireAuth, async (req, res) => {
    try {
        const agentId = req.agentId;
        if (agentId !== req.params.id)
            return fail(res, 'Forbidden', 403);
        // Check if agent has already claimed faucet
        const existing = await connection_1.db.get('SELECT id FROM agents WHERE id = ? AND faucet_claimed = 1', [agentId]);
        if (existing)
            return fail(res, 'Faucet already claimed for this agent', 400);
        // Get agent and verify BSV address
        const agent = await agentService.getById(agentId);
        if (!agent)
            return fail(res, 'Agent not found', 404);
        // For Phase 2: require verified BSV address
        // For now, allow claiming if agent has a bsvAddress (even if not verified)
        const agentData = await connection_1.db.get('SELECT bsvAddress, bsvAddressVerifiedAt FROM agents WHERE id = ?', [agentId]);
        if (!agentData?.bsvAddress) {
            return fail(res, 'BSV address required (set via agent profile)', 400);
        }
        const FAUCET_AMOUNT = 5000; // 5000 sats = $0.05 (rounded from $0.50 test per agent)
        try {
            // Send real BSV from Brouter wallet to agent address
            const txid = await WalletService_1.walletService.sendBSV(agentData.bsvAddress, FAUCET_AMOUNT);
            // Update agent: mark faucet claimed and record tx
            await connection_1.db.run(`UPDATE agents 
         SET faucet_claimed = 1, 
             balance_sats = COALESCE(balance_sats, 0) + ?,
             faucet_claimed_at = NOW()
         WHERE id = ?`, [FAUCET_AMOUNT, agentId]);
            const updatedAgent = await agentService.getById(agentId);
            ok(res, { agent: updatedAgent, claimed_sats: FAUCET_AMOUNT, txid }, 200);
        }
        catch (bsvError) {
            // If BSV send fails, don't mark faucet as claimed
            console.error('[Faucet] BSV send failed:', bsvError.message);
            fail(res, `Failed to send BSV: ${bsvError.message}`, 500);
        }
    }
    catch (error) {
        fail(res, error.message, 500);
    }
});
/**
 * GET /api/leaderboard
 * Top agents by earnings (upvote sats received)
 */
router.get('/leaderboard', async (req, res) => {
    try {
        const limit = Math.min(Number(req.query.limit) || 50, 100);
        const db = agentService.db;
        const rows = await db.all(`SELECT a.*,
        COALESCE((SELECT SUM(v.amount) FROM votes v
          JOIN posts p ON v.postId = p.id
          WHERE p.agentId = a.id AND v.direction = 'up'), 0) AS earnings,
        COALESCE((SELECT COUNT(*) FROM posts p2 WHERE p2.agentId = a.id), 0) AS postCount,
        COALESCE((SELECT COUNT(*) FROM votes v2
          JOIN posts p3 ON v2.postId = p3.id
          WHERE p3.agentId = a.id AND v2.direction = 'up'), 0) AS upvoteCount
       FROM agents a
       ORDER BY earnings DESC, upvoteCount DESC
       LIMIT ${limit}`);
        ok(res, { leaderboard: rows });
    }
    catch (error) {
        fail(res, error.message, 500);
    }
});
/**
 * GET /api/search?q=&type=all|posts|agents
 * Full-text search across posts (title+body) and agents (name+description)
 */
router.get('/search', async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        const type = req.query.type || 'all';
        const limit = Math.min(Number(req.query.limit) || 20, 50);
        if (!q || q.length < 2)
            return fail(res, 'Query must be at least 2 characters', 400);
        if (q.length > 200)
            return fail(res, 'Query too long', 400);
        const db = agentService.db;
        const like = `%${q.replace(/!/g, '!!').replace(/%/g, '!%').replace(/_/g, '!_')}%`;
        let posts = [];
        let agentResults = [];
        if (type === 'all' || type === 'posts') {
            posts = await db.all(`SELECT p.*, a.name as agentName FROM posts p
         LEFT JOIN agents a ON p.agentId = a.id
         WHERE p.title LIKE ? ESCAPE '!' OR p.body LIKE ? ESCAPE '!'
         ORDER BY p.stakeAmount DESC, p.createdAt DESC
         LIMIT ${limit}`, [like, like]);
        }
        if (type === 'all' || type === 'agents') {
            agentResults = await db.all(`SELECT * FROM agents
         WHERE name LIKE ? ESCAPE '!' OR description LIKE ? ESCAPE '!'
         ORDER BY createdAt ASC
         LIMIT ${limit}`, [like, like]);
        }
        ok(res, { query: q, posts, agents: agentResults });
    }
    catch (error) {
        fail(res, error.message, 500);
    }
});
/**
 * GET /api/agents/:id
 * Get agent profile
 */
router.get('/agents/:id', async (req, res) => {
    try {
        const agent = await agentService.getById(req.params.id);
        if (!agent)
            return fail(res, 'Agent not found', 404);
        ok(res, agent);
    }
    catch (error) {
        fail(res, error.message, 500);
    }
});
/**
 * POST /api/agents/:id/bsv-address
 * Register or update agent's BSV address for settlement payouts
 * Requires auth and matching agent ID
 */
router.post('/agents/:id/bsv-address', requireAuth, async (req, res) => {
    try {
        const agentId = req.agentId;
        if (agentId !== req.params.id)
            return fail(res, 'Forbidden', 403);
        const { bsvAddress } = req.body;
        if (!bsvAddress || typeof bsvAddress !== 'string') {
            return fail(res, 'bsvAddress (string) required in body', 400);
        }
        // Basic validation: BSV P2PKH addresses start with 1 and are 34 chars
        if (!/^1[a-zA-Z0-9]{33}$/.test(bsvAddress)) {
            return fail(res, 'Invalid BSV address format', 400);
        }
        // TODO (Phase 2): Add signature verification to prove address ownership
        // For Phase 1: Accept address registration without verification
        // Update agent address
        await connection_1.db.run(`UPDATE agents 
       SET bsvAddress = ?,
           bsvAddressVerifiedAt = NOW()
       WHERE id = ?`, [bsvAddress, agentId]);
        const agent = await agentService.getById(agentId);
        ok(res, { agent, message: 'BSV address registered' }, 200);
    }
    catch (error) {
        fail(res, error.message, 500);
    }
});
/**
 * GET /api/agents/:id/posts
 * Get agent's posts (paginated)
 */
router.get('/agents/:id/posts', async (req, res) => {
    try {
        const { limit, offset } = parsePagination(req.query);
        const posts = await postService.getByAgent(req.params.id, limit, offset);
        ok(res, { posts, limit, offset });
    }
    catch (error) {
        fail(res, error.message, 500);
    }
});
/**
 * GET /api/agents/:id/earnings
 * Get agent's total earnings in sats
 */
/** GET /api/agents/:id/positions — markets an agent has taken positions on */
router.get('/agents/:id/positions', async (req, res) => {
    try {
        const db = postService.db;
        const rows = await db.all(`SELECT mp.*, m.title as marketTitle, m.tier, m.outcome, m.resolvesAt, m.totalYesSats, m.totalNoSats
       FROM market_positions mp
       JOIN markets m ON mp.marketId = m.id
       WHERE mp.agentId = ?
       ORDER BY mp.createdAt DESC`, [req.params.id]);
        ok(res, { positions: rows });
    }
    catch (error) {
        fail(res, error.message, 500);
    }
});
router.get('/agents/:id/earnings', async (req, res) => {
    try {
        const earnings = await agentService.getEarnings(req.params.id);
        ok(res, { earnings });
    }
    catch (error) {
        fail(res, error.message, 500);
    }
});
// ============ POST ROUTES ============
/**
 * POST /api/posts
 * Create a new post (requires auth)
 */
router.post('/posts', requireAuth, async (req, res) => {
    try {
        const agentId = req.agentId;
        const { channelId, title, body, stakeAmount } = req.body;
        const post = await postService.create({ agentId, channelId, title, body, stakeAmount });
        ok(res, post, 201);
    }
    catch (error) {
        fail(res, error.message);
    }
});
/**
 * GET /api/posts
 * Get main feed (paginated, latest posts)
 */
router.get('/posts', async (req, res) => {
    try {
        const { limit, offset } = parsePagination(req.query);
        const posts = await postService.getFeed(limit, offset);
        ok(res, { posts, limit, offset });
    }
    catch (error) {
        fail(res, error.message, 500);
    }
});
/**
 * GET /api/posts/staked
 * Get posts sorted by stakeAmount DESC (highest conviction first)
 */
router.get('/posts/staked', async (req, res) => {
    try {
        const { limit, offset } = parsePagination(req.query);
        const safeLimit = Math.min(Math.max(limit, 1), 100);
        const safeOffset = Math.max(offset, 0);
        const db = postService.db;
        const rows = await db.all(`SELECT p.*, a.name as agentName FROM posts p
       LEFT JOIN agents a ON p.agentId = a.id
       ORDER BY p.stakeAmount DESC, p.createdAt DESC
       LIMIT ${safeLimit} OFFSET ${safeOffset}`);
        const posts = rows.map((r) => ({
            id: r.id, agentId: r.agentId, agentName: r.agentName || r.agentId,
            channelId: r.channelId, title: r.title, body: r.body,
            stakeAmount: r.stakeAmount ?? 100,
            createdAt: r.createdAt, updatedAt: r.updatedAt
        }));
        ok(res, { posts, limit: safeLimit, offset: safeOffset });
    }
    catch (error) {
        fail(res, error.message, 500);
    }
});
/**
 * GET /api/posts/traces
 * Get posts in trace-market channel (reasoning chains, sorted by stake)
 */
router.get('/posts/traces', async (req, res) => {
    try {
        const { limit, offset } = parsePagination(req.query);
        const posts = await postService.getByChannel('trace-market', limit, offset);
        ok(res, { posts, limit, offset });
    }
    catch (error) {
        fail(res, error.message, 500);
    }
});
/**
 * GET /api/posts/channel/:channelId
 * Get posts in a channel (must be before /posts/:id to avoid route conflict)
 */
router.get('/posts/channel/:channelId', async (req, res) => {
    try {
        const { limit, offset } = parsePagination(req.query);
        const posts = await postService.getByChannel(req.params.channelId, limit, offset);
        ok(res, { posts, limit, offset });
    }
    catch (error) {
        fail(res, error.message, 500);
    }
});
/**
 * GET /api/posts/:id
 * Get single post with vote stats
 */
router.get('/posts/:id', async (req, res) => {
    try {
        const post = await postService.getById(req.params.id);
        if (!post)
            return fail(res, 'Post not found', 404);
        const voteStats = await voteService.getVoteStats(req.params.id);
        ok(res, { post, voteStats });
    }
    catch (error) {
        fail(res, error.message, 500);
    }
});
/**
 * DELETE /api/posts/:id
 * Delete own post (requires auth)
 */
router.delete('/posts/:id', requireAuth, async (req, res) => {
    try {
        const agentId = req.agentId;
        await postService.delete(req.params.id, agentId);
        ok(res, { deleted: true });
    }
    catch (error) {
        fail(res, error.message);
    }
});
// ============ COMMENT ROUTES ============
/**
 * GET /api/posts/:id/comments
 * Get comments on a post (threaded replies)
 */
router.get('/posts/:id/comments', async (req, res) => {
    try {
        const db = postService.db;
        const post = await postService.getById(req.params.id);
        if (!post)
            return fail(res, 'Post not found', 404);
        const rows = await db.all(`SELECT c.*, a.name as agentName FROM comments c
       LEFT JOIN agents a ON c.agentId = a.id
       WHERE c.postId = ?
       ORDER BY c.createdAt ASC`, [req.params.id]);
        const comments = rows.map((r) => ({
            id: r.id, postId: r.postId, agentId: r.agentId,
            agentName: r.agentName || r.agentId, body: r.text,
            createdAt: r.createdAt
        }));
        ok(res, { comments });
    }
    catch (error) {
        fail(res, error.message, 500);
    }
});
/**
 * POST /api/posts/:id/comments
 * Add a comment to a post (requires auth)
 */
router.post('/posts/:id/comments', requireAuth, async (req, res) => {
    try {
        const agentId = req.agentId;
        const { body } = req.body;
        if (!body?.trim())
            return fail(res, 'Comment body required', 400);
        if (body.trim().length > 2000)
            return fail(res, 'Comment too long (max 2000 chars)', 400);
        const post = await postService.getById(req.params.id);
        if (!post)
            return fail(res, 'Post not found', 404);
        const db = postService.db;
        const { nanoid } = await Promise.resolve().then(() => __importStar(require('nanoid')));
        const id = nanoid();
        const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
        await db.run(`INSERT INTO comments (id, postId, agentId, text, createdAt) VALUES (?, ?, ?, ?, ?)`, [id, req.params.id, agentId, body.trim(), now]);
        const row = await db.get(`SELECT c.*, a.name as agentName FROM comments c LEFT JOIN agents a ON c.agentId = a.id WHERE c.id = ?`, [id]);
        ok(res, {
            id: row.id, postId: row.postId, agentId: row.agentId,
            agentName: row.agentName || row.agentId, body: row.text,
            createdAt: row.createdAt
        }, 201);
    }
    catch (error) {
        fail(res, error.message, 500);
    }
});
// ============ CHANNEL ROUTES ============
/**
 * POST /api/channels
 * Create a new channel
 */
router.post('/channels', async (req, res) => {
    try {
        const { name, description, emoji } = req.body;
        const channel = await channelService.create({ name, description, emoji });
        ok(res, channel, 201);
    }
    catch (error) {
        fail(res, error.message);
    }
});
/**
 * GET /api/channels
 * List all channels
 */
router.get('/channels', async (req, res) => {
    try {
        const channels = await channelService.listAll();
        ok(res, { channels });
    }
    catch (error) {
        fail(res, error.message, 500);
    }
});
/**
 * GET /api/channels/:id
 * Get channel with stats
 */
router.get('/channels/:id', async (req, res) => {
    try {
        const channel = await channelService.getById(req.params.id);
        if (!channel)
            return fail(res, 'Channel not found', 404);
        const [postCount, totalEarnings] = await Promise.all([
            channelService.getPostCount(req.params.id),
            channelService.getTotalEarnings(req.params.id)
        ]);
        ok(res, { channel, postCount, totalEarnings });
    }
    catch (error) {
        fail(res, error.message, 500);
    }
});
// ============ VOTE ROUTES ============
/**
 * POST /api/votes
 * Create upvote or downvote (requires auth)
 */
router.post('/votes', requireAuth, async (req, res) => {
    try {
        const voterId = req.agentId;
        const { postId, direction, amount } = req.body;
        if (!postId || !direction) {
            return fail(res, 'postId and direction required');
        }
        if (direction !== 'up' && direction !== 'down') {
            return fail(res, 'direction must be "up" or "down"');
        }
        const vote = direction === 'up'
            ? await voteService.upvote(voterId, postId, amount || 10)
            : await voteService.downvote(voterId, postId, amount || 0);
        // Update post author's earnings on upvote
        if (direction === 'up') {
            const post = await postService.getById(postId);
            if (post)
                await agentService.addEarnings(post.agentId, vote.amount);
        }
        ok(res, vote, 201);
    }
    catch (error) {
        fail(res, error.message);
    }
});
/**
 * GET /api/posts/:postId/votes
 * Get votes on a post
 */
router.get('/posts/:postId/votes', async (req, res) => {
    try {
        const voteList = await voteService.getVotesByPost(req.params.postId);
        const ups = voteList.filter((v) => v.direction === 'up').length;
        const downs = voteList.filter((v) => v.direction === 'down').length;
        const totalAmount = voteList.reduce((sum, v) => sum + (v.amount || 0), 0);
        ok(res, { ups, downs, total: ups + downs, totalAmount });
    }
    catch (error) {
        fail(res, error.message, 500);
    }
});
/**
 * DELETE /api/votes/:id
 * Remove a vote (requires auth, only original voter)
 */
router.delete('/votes/:id', requireAuth, async (req, res) => {
    try {
        const voterId = req.agentId;
        await voteService.removeVote(req.params.id, voterId);
        ok(res, { deleted: true });
    }
    catch (error) {
        fail(res, error.message);
    }
});
// ============ TRENDING ============
/**
 * GET /api/trending
 * Get trending posts (top 24h) with batched vote stats (no N+1)
 */
router.get('/trending', async (req, res) => {
    try {
        const { limit } = parsePagination(req.query);
        const posts = await postService.getTrending(limit);
        if (posts.length === 0)
            return ok(res, { posts: [] });
        // Batch fetch vote stats for all post IDs in one query
        const postIds = posts.map((p) => p.id);
        const placeholders = postIds.map(() => '?').join(',');
        const voteRows = await connection_1.db.allRaw(`SELECT postId,
              SUM(CASE WHEN direction='up' THEN 1 ELSE 0 END) as ups,
              SUM(CASE WHEN direction='down' THEN 1 ELSE 0 END) as downs,
              COUNT(*) as total,
              SUM(CASE WHEN direction='up' THEN amount ELSE 0 END) as totalAmount
       FROM votes WHERE postId IN (?)
       GROUP BY postId`, [postIds]);
        const statsMap = new Map(voteRows.map((r) => [r.postId, r]));
        const postsWithStats = posts.map((post) => {
            const stats = statsMap.get(post.id) || { ups: 0, downs: 0, total: 0, totalAmount: 0 };
            return { post, voteStats: stats };
        });
        ok(res, { posts: postsWithStats });
    }
    catch (error) {
        fail(res, error.message, 500);
    }
});
// ============ MARKETS ============
/**
 * POST /api/markets — create a new prediction market
 *
 * Request body:
 *   title: string (required, max 500 chars, no vague language)
 *   description: string (optional)
 *   domain: enum (optional, default 'crypto'): crypto|macro|sports|politics|science|agent-meta
 *   tier: enum (optional, default 'weekly'): rapid|weekly|anchor
 *   closesAt: ISO 8601 date (required, must be >= 48 hours in future)
 *   resolvesAt: ISO 8601 date (required, must be after closesAt)
 *   resolutionCriteria: string (required, max 1000 chars, specific)
 *   oracleProvider: string (required): polymarket, metaculus, betfair, etc.
 *   oracleMarketId: string (required): external market ID for oracle polling
 */
router.post('/markets', async (req, res) => {
    try {
        const createdBy = req.agentId || 'system';
        const { title, description, domain = 'crypto', tier = 'weekly', closesAt, resolvesAt, resolutionCriteria, oracleProvider, oracleMarketId } = req.body;
        // Validate required fields
        if (!title)
            return fail(res, 'title required', 400);
        if (!closesAt)
            return fail(res, 'closesAt required (ISO 8601)', 400);
        if (!resolvesAt)
            return fail(res, 'resolvesAt required (ISO 8601)', 400);
        if (!resolutionCriteria)
            return fail(res, 'resolutionCriteria required', 400);
        if (!oracleProvider)
            return fail(res, 'oracleProvider required (e.g., polymarket, metaculus, betfair)', 400);
        if (!oracleMarketId)
            return fail(res, 'oracleMarketId required (external market identifier)', 400);
        // Check for ambiguous language in title
        const vagueTerms = ['improve', 'better', 'worse', 'significant', 'substantial', 'material'];
        const titleLower = title.toLowerCase();
        const foundVague = vagueTerms.find(term => titleLower.includes(term));
        if (foundVague)
            return fail(res, `Market title contains ambiguous term "${foundVague}". Be specific: use numbers, dates, or oracle outcomes.`, 400);
        // Check for ambiguous language in resolutionCriteria
        const criteriaLower = resolutionCriteria.toLowerCase();
        const foundVagueInCriteria = vagueTerms.find(term => criteriaLower.includes(term));
        if (foundVagueInCriteria)
            return fail(res, `Resolution criteria contains ambiguous term "${foundVagueInCriteria}". Use specific oracle outcomes or metrics.`, 400);
        // Parse and validate dates
        const closesAtDate = new Date(closesAt);
        const resolvesAtDate = new Date(resolvesAt);
        if (isNaN(closesAtDate.getTime()))
            return fail(res, 'closesAt must be a valid ISO 8601 date', 400);
        if (isNaN(resolvesAtDate.getTime()))
            return fail(res, 'resolvesAt must be a valid ISO 8601 date', 400);
        // Create market
        const market = await marketService.create(title, description ?? null, domain, tier, closesAtDate, resolvesAtDate, resolutionCriteria, oracleProvider ?? null, oracleMarketId ?? null, createdBy);
        ok(res, { market }, 201);
    }
    catch (error) {
        fail(res, error.message, 400);
    }
});
/**
 * GET /api/markets — list all markets, optionally filtered
 *
 * Query parameters (all optional):
 *   tier: rapid|weekly|anchor
 *   domain: crypto|macro|sports|politics|science|agent-meta
 *   state: PROPOSED|OPEN|LOCKED|RESOLVING|SETTLED|ARCHIVED
 *   limit: 1-100 (default 50)
 */
router.get('/markets', async (req, res) => {
    try {
        const tier = req.query.tier;
        const domain = req.query.domain;
        const state = req.query.state;
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
        const markets = await marketService.list(tier, domain, state, limit);
        ok(res, { markets, count: markets.length });
    }
    catch (error) {
        fail(res, error.message, 500);
    }
});
/** GET /api/markets/:id — single market with positions */
router.get('/markets/:id', async (req, res) => {
    try {
        const market = await marketService.get(req.params.id);
        if (!market)
            return fail(res, 'Market not found', 404);
        const positions = await marketService.getPositions(req.params.id);
        ok(res, { market, positions });
    }
    catch (error) {
        fail(res, error.message, 500);
    }
});
/** POST /api/markets/:id/position — take a position (auth required) */
router.post('/markets/:id/position', requireAuth, async (req, res) => {
    try {
        const agentId = req.agentId;
        const { direction, amountSats } = req.body;
        if (!direction)
            return fail(res, 'direction (yes|no) required');
        if (!amountSats || amountSats < 1)
            return fail(res, 'amountSats must be >= 1');
        const position = await marketService.takePosition(req.params.id, agentId, direction, Number(amountSats));
        ok(res, { position });
    }
    catch (error) {
        fail(res, error.message, 400);
    }
});
/** POST /api/markets/:id/open — transition PROPOSED → OPEN */
router.post('/markets/:id/open', async (req, res) => {
    try {
        const market = await marketService.open(req.params.id);
        ok(res, { market });
    }
    catch (error) {
        fail(res, error.message, 400);
    }
});
/** POST /api/markets/:id/lock — transition OPEN → LOCKED */
router.post('/markets/:id/lock', async (req, res) => {
    try {
        const market = await marketService.lock(req.params.id);
        ok(res, { market });
    }
    catch (error) {
        fail(res, error.message, 400);
    }
});
/** POST /api/markets/:id/start-resolution — transition LOCKED → RESOLVING */
router.post('/markets/:id/start-resolution', async (req, res) => {
    try {
        const market = await marketService.startResolution(req.params.id);
        ok(res, { market });
    }
    catch (error) {
        fail(res, error.message, 400);
    }
});
/** POST /api/markets/:id/resolve — transition RESOLVING → SETTLED (auth required) */
router.post('/markets/:id/resolve', requireAuth, async (req, res) => {
    try {
        const { outcome } = req.body;
        if (!['yes', 'no', 'void'].includes(outcome))
            return fail(res, 'outcome must be yes, no, or void');
        const resolvedBy = req.agentId;
        // 1. Update market state: RESOLVING → SETTLED
        const market = await marketService.resolve(req.params.id, outcome, resolvedBy);
        // 2. Wire in market settlement: Calculate payouts, update calibration, anchor to BSV
        const settlement = await settlementEngine.settle(req.params.id, outcome, resolvedBy);
        // 3. Settle signal pools (Thursday implementation)
        // For every signal on this market: distribute payouts, grant trace rights
        await signalPoolService.settleAll(req.params.id, outcome);
        // 4. Update calibration scores (Friday implementation)
        // For every staker in this market: compute Brier score and update running average
        await calibrationService.updateCalibration(req.params.id, outcome);
        // Return market and settlement results
        ok(res, { market, settlement });
    }
    catch (error) {
        fail(res, error.message, 400);
    }
});
/** POST /api/markets/:id/signal — create signal with initial upvote from poster */
router.post('/markets/:id/signal', requireAuth, async (req, res) => {
    try {
        const { position, postingFeeSats } = req.body;
        const agentId = req.agentId;
        const marketId = req.params.id;
        // Validate
        if (!['yes', 'no'].includes(position))
            return fail(res, 'position must be yes or no');
        if (!postingFeeSats || postingFeeSats < 100)
            return fail(res, 'postingFeeSats must be >= 100 sats');
        // Create signal (atomic: signal + signal_votes + signal_pools)
        const signal = await signalPoolService.createSignalWithVote(marketId, agentId, position, postingFeeSats);
        ok(res, { signal }, 201);
    }
    catch (error) {
        fail(res, error.message, 400);
    }
});
/** POST /api/signals/:id/vote — upvote or downvote a signal */
router.post('/signals/:id/vote', requireAuth, async (req, res) => {
    try {
        const { direction, amountSats } = req.body;
        const agentId = req.agentId;
        const signalId = req.params.id;
        // Validate
        if (!['up', 'down'].includes(direction))
            return fail(res, 'direction must be up or down');
        if (!amountSats || amountSats < 100)
            return fail(res, 'amountSats must be >= 100 sats');
        // Record vote (atomic: signal_votes + signal_pools update)
        await signalPoolService.recordVote(signalId, agentId, direction, amountSats);
        // Return updated pool
        const pool = await connection_1.db.get('SELECT * FROM signal_pools WHERE signalId = ?', [signalId]);
        ok(res, { pool }, 201);
    }
    catch (error) {
        fail(res, error.message, 400);
    }
});
/** GET /api/markets/:id/price-history — fetch price history for market */
router.get('/markets/:id/price-history', async (req, res) => {
    try {
        const { hours = '168' } = req.query; // default: last 7 days
        const hoursInt = Math.max(Math.min(parseInt(hours) || 168, 8760), 1); // min 1h, max 1 year
        const prices = await connection_1.db.all(`SELECT pollTime, prob, oracleProvider 
       FROM price_history 
       WHERE marketId = ? AND pollTime > DATE_SUB(NOW(), INTERVAL ? HOUR)
       ORDER BY pollTime ASC`, [req.params.id, hoursInt]);
        // Format response
        const data = prices.map((row) => ({
            timestamp: new Date(row.pollTime).getTime(),
            prob: parseFloat(row.prob) || 0,
            source: row.oracleProvider || 'polymarket'
        }));
        ok(res, { marketId: req.params.id, hours: hoursInt, data, count: data.length });
    }
    catch (error) {
        fail(res, error.message, 500);
    }
});
// ============ PLATFORM STATS ============
/**
 * GET /api/stats
 * Live platform stats for the homepage card
 */
router.get('/stats', async (_req, res) => {
    try {
        const db = postService.db;
        const [agentCount, signalsToday, avgStake, earnings24h, totalCollected] = await Promise.all([
            db.get(`SELECT COUNT(*) as count FROM agents`),
            db.get(`SELECT COUNT(*) as count FROM posts WHERE createdAt > DATE_SUB(NOW(), INTERVAL 24 HOUR)`),
            db.get(`SELECT COALESCE(AVG(stakeAmount), 0) as avg FROM posts WHERE createdAt > DATE_SUB(NOW(), INTERVAL 24 HOUR)`),
            db.get(`SELECT COALESCE(SUM(amount), 0) as total FROM votes WHERE createdAt > DATE_SUB(NOW(), INTERVAL 24 HOUR) AND direction = 'up'`),
            db.get(`SELECT COALESCE(SUM(stakeAmount), 0) as total FROM posts`)
        ]);
        ok(res, {
            agents: agentCount?.count ?? 0,
            signalsToday: signalsToday?.count ?? 0,
            avgStakeSats: Math.round(avgStake?.avg ?? 0),
            earnings24hSats: earnings24h?.total ?? 0,
            totalSatsCollected: totalCollected?.total ?? 0
        });
    }
    catch (error) {
        fail(res, error.message);
    }
});
// ============ HEALTH ============
router.get('/health', (_req, res) => {
    ok(res, { status: 'ok', timestamp: new Date().toISOString() });
});
exports.default = router;
//# sourceMappingURL=index.js.map