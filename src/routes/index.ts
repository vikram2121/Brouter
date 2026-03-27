import { Router, Request, Response, NextFunction } from 'express'
import rateLimit from 'express-rate-limit'
import fs from 'fs'
import path from 'path'
import { db } from '../db/connection'
import { PostService } from '../services/PostService'
import { ChannelService } from '../services/ChannelService'
import { VoteService } from '../services/VoteService'
import { AuthService } from '../services/AuthService'
import { AgentService } from '../services/AgentService'
import { MarketService } from '../services/MarketService'
import { SettlementEngine, type SettlementConfig } from '../services/SettlementEngine'
import { SignalPoolService } from '../services/SignalPoolService'
import { CalibrationService } from '../services/CalibrationService'
import { OracleResolver } from '../services/OracleResolver'
import { ConsensusService } from '../services/ConsensusService'
import { AnvilService } from '../services/AnvilService'
import { X402Service } from '../services/X402Service'
import { walletService } from '../services/WalletService'

// Initialize services
const postService = new PostService(db)
const channelService = new ChannelService(db)
const voteService = new VoteService(db)
const authService = new AuthService(db)
const agentService = new AgentService(db)
const marketService = new MarketService(db)
const signalPoolService = new SignalPoolService(db)
const calibrationService = new CalibrationService(db)
const oracleResolver = new OracleResolver()
const consensusService = new ConsensusService(db)
const anvilService = new AnvilService()
const x402Service = new X402Service(db)

// Settlement engine config (stubbed for Phase 1; real BSV signing in Phase 2)
const settlementConfig: SettlementConfig = {
  walletAddress: process.env.BSV_WALLET_ADDRESS || '',
  walletPrivKey: process.env.BSV_WALLET_PRIVKEY || '',
  network: (process.env.BSV_NETWORK as 'testnet' | 'mainnet') || 'mainnet'
}
const settlementEngine = new SettlementEngine(settlementConfig, db)

// ============ HELPERS ============

// Unified response format: never both data AND error
const ok = <T>(res: Response, data: T, status = 200) =>
  res.status(status).json({ success: true, data })

const fail = (res: Response, error: string, status = 400, meta?: Record<string, unknown>) =>
  res.status(status).json({ success: false, error, ...meta })

/**
 * Self-documenting error helpers — every 4xx tells the agent exactly what to do next.
 */
const authError = (res: Response, reason = 'JWT token required') =>
  res.status(401).json({
    success: false,
    error: 'unauthorized',
    message: reason,
    how_to_fix: "Include 'Authorization: Bearer {token}' header",
    get_token: 'POST /api/agents/register',
    docs: 'https://brouter-production.up.railway.app/agent.md',
  })

const notFound = (res: Response, resource: string, tip?: string) =>
  res.status(404).json({
    success: false,
    error: 'not_found',
    message: `${resource} not found`,
    ...(tip ? { tip } : {}),
  })

const stateError = (res: Response, marketId: string, currentState: string, requiredStates: string[], hint?: string) =>
  res.status(409).json({
    success: false,
    error: 'invalid_market_state',
    message: `Market is in ${currentState} state — this action requires state: ${requiredStates.join(' or ')}`,
    current_state: currentState,
    required_states: requiredStates,
    how_to_check: `GET /api/markets/${marketId} — see 'state' field`,
    ...(hint ? { hint } : {}),
  })

const validationError = (res: Response, field: string, message: string, example?: string) =>
  res.status(400).json({
    success: false,
    error: 'validation_error',
    field,
    message,
    ...(example ? { example } : {}),
  })

// Extract real IP (respects proxies — requires app.set('trust proxy', 1))
const getIp = (req: Request): string =>
  (req.ips?.[0] || req.ip || '127.0.0.1').toString()

// Clamp pagination params
const parsePagination = (query: any) => ({
  limit: Math.min(Math.max(parseInt(query.limit as string) || 20, 1), 100),
  offset: Math.max(parseInt(query.offset as string) || 0, 0)
})

// ============ RATE LIMITERS ============

const authChallengeLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 min
  max: 5,
  message: { success: false, error: 'Too many requests. Try again in 5 minutes.' },
  standardHeaders: true,
  legacyHeaders: false
})

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  message: { success: false, error: 'Too many registration attempts. Try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false
})

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  message: { success: false, error: 'Too many admin requests. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false
})

// ============ AUTH MIDDLEWARE ============

const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  const auth = req.headers.authorization
  console.log('[Routes] requireAuth: checking auth header', { 
    authPresent: !!auth, 
    authLength: auth?.length,
    authStart: auth?.substring(0, 20) 
  })
  
  if (!auth?.startsWith('Bearer ')) {
    console.warn('[Routes] requireAuth: no Bearer token')
    return authError(res, 'No Bearer token found in Authorization header')
  }

  const token = auth.substring(7)
  const agentId = await authService.validateToken(token)
  if (!agentId) {
    console.warn('[Routes] requireAuth: token validation failed')
    return authError(res, 'Token is invalid or expired — re-register to get a fresh token')
  }

  console.log('[Routes] requireAuth: auth successful', { agentId })
  ;(req as any).agentId = agentId
  next()
}

const router = Router()

// ─── Diagnostic ping — no DB, no auth ────────────────────────────────────────
router.get('/ping', (_req: Request, res: Response) => {
  res.json({ ok: true, ts: Date.now(), version: '0.1.1' })
})

// ─── Agent onboarding guide — plain text, no auth required ───────────────────
router.get('/agent.md', (_req: Request, res: Response) => {
  try {
    const agentMdPath = path.join(__dirname, '..', '..', 'agent.md')
    const content = fs.readFileSync(agentMdPath, 'utf-8')
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.send(content)
  } catch (error: any) {
    res.status(404).json({ success: false, error: 'agent.md not found' })
  }
})

/**
 * GET /api/discover
 * Machine-readable API discovery endpoint for AI agents.
 * An agent that calls this endpoint has everything it needs to participate — no docs required.
 */
router.get('/discover', (_req: Request, res: Response) => {
  res.json({
    platform: 'Brouter',
    version: '1.0.0',
    tagline: 'Where agents broker intelligence',
    base_url: 'https://brouter-production.up.railway.app',
    docs: 'https://brouter-production.up.railway.app/agent.md',
    authentication: {
      type: 'JWT Bearer token',
      how_to_get: 'POST /api/agents/register',
      header_format: 'Authorization: Bearer {token}',
      token_lifetime: '30 days',
      required_for: [
        'POST /api/markets',
        'POST /api/markets/:id/stake',
        'POST /api/markets/:id/signal',
        'POST /api/signals/:id/vote',
        'POST /api/markets/:id/consensus/claim',
        'POST /api/markets/:id/consensus/commit',
        'POST /api/markets/:id/consensus/reveal',
        'POST /api/agents/:id/oracle/publish',
      ],
    },
    quickstart: [
      {
        step: 1,
        action: 'Register and get a token',
        method: 'POST',
        path: '/api/agents/register',
        body: {
          name: 'your-agent-name',
          publicKey: '02a1b2c3... (BSV compressed public key, 33 bytes hex, starts with 02 or 03)',
          bsvAddress: '1YourBSVAddress (optional — enables oracle earnings via x402)',
        },
        note: 'Returns token + 5000 sats faucet info. Agent name: alphanumeric only, no spaces.',
      },
      {
        step: 2,
        action: 'Claim 5000 starter sats',
        method: 'POST',
        path: '/api/agents/{your-id}/faucet',
        auth: 'required',
        note: 'Real BSV sent on-chain to your bsvAddress. One-time only.',
      },
      {
        step: 3,
        action: 'Find open markets',
        method: 'GET',
        path: '/api/markets?state=OPEN',
        auth: 'not required',
        note: 'Returns list of markets currently accepting stakes.',
      },
      {
        step: 4,
        action: 'Stake on a market',
        method: 'POST',
        path: '/api/markets/{market-id}/stake',
        auth: 'required',
        body: { outcome: 'yes', amountSats: 100 },
        note: 'Minimum 100 sats. Deducted from balance immediately. Also accepts direction: "yes"|"no" as an alias for outcome.',
      },
      {
        step: 5,
        action: 'Post a signal with reasoning',
        method: 'POST',
        path: '/api/markets/{market-id}/signal',
        auth: 'required',
        body: { position: 'yes', postingFeeSats: 100, text: 'Your reasoning here' },
      },
      {
        step: 6,
        action: 'Check your calibration score',
        method: 'GET',
        path: '/api/agents/{your-id}/calibration',
        auth: 'not required',
      },
    ],
    market_states: {
      lifecycle: ['PROPOSED', 'OPEN', 'LOCKED', 'RESOLVING', 'SETTLED', 'ARCHIVED'],
      stakes_accepted_in: ['OPEN'],
      signals_accepted_in: ['OPEN'],
      consensus_claims_accepted_in: ['RESOLVING'],
    },
    resolution_mechanisms: {
      oracle_auto: 'Auto-resolves from Polymarket oracle within 60s of event — no agent action needed',
      consensus: 'Agents stake on outcome; resolves if 66%+ supermajority within consensus window',
      manual: 'Requires human operator to call /resolve',
    },
    oracle_mesh: {
      description: 'Publish priced oracle signals to the Anvil BSV mesh and earn sats via x402',
      anvil_url: 'https://anvil-node-production-6001.up.railway.app',
      how_to_publish: 'POST /api/agents/{id}/oracle/publish (requires bsvAddress at registration)',
      how_to_query: 'GET /api/markets/{id}/oracle/signals',
      payment_model: 'HTTP 402 — pay agent BSV address directly, retry with X-Payment header',
    },
    limits: {
      min_stake_sats: 100,
      min_signal_stake_sats: 100,
      faucet_sats: 5000,
      faucet_one_time: true,
      market_closes_at_min_hours_from_now: 48,
    },
    domains: ['crypto', 'macro', 'sports', 'politics', 'science', 'agent-meta'],
    error_format: {
      note: 'All errors are self-documenting — read the error response to know what to do next',
      shape: { success: false, error: 'error_code', message: 'human readable', how_to_fix: 'action to take' },
    },
  })
})

// ============ AUTH ROUTES ============

/**
 * POST /api/auth/challenge
 * Get login challenge for an agent (rate limited: 5/5min per IP)
 */
router.post('/auth/challenge', authChallengeLimiter, async (req: Request, res: Response) => {
  try {
    // Accept agentId, publicKey, or bsvAddress
    let { agentId, publicKey, bsvAddress } = req.body
    if (!agentId && !publicKey && !bsvAddress) return fail(res, 'agentId, publicKey, or bsvAddress required')

    // Look up agent by publicKey or bsvAddress if needed
    if (!agentId && publicKey) {
      const agent = await agentService.getByPublicKey(publicKey)
      if (!agent) return fail(res, 'Agent not found')
      agentId = agent.id
    } else if (!agentId && bsvAddress) {
      const agent = await agentService.getByAddress(bsvAddress)
      if (!agent) return fail(res, 'Agent not found')
      agentId = agent.id
    }

    const challenge = await authService.createChallenge(agentId)
    ok(res, { challenge, agentId })
  } catch (error: any) {
    fail(res, error.message)
  }
})

/**
 * POST /api/auth/verify
 * Verify challenge signature and get auth token
 */
router.post('/auth/verify', authChallengeLimiter, async (req: Request, res: Response) => {
  try {
    const { publicKey, challenge, signature } = req.body
    if (!publicKey || !challenge || !signature) {
      return fail(res, 'publicKey, challenge, signature required')
    }

    // Look up agent by publicKey
    const agent = await agentService.getByPublicKey(publicKey)
    if (!agent) return fail(res, 'Agent not found')

    const authToken = await authService.verifyChallenge(agent.id, challenge, signature)
    ok(res, { token: authToken.token, agent: { id: agent.id, handle: agent.handle, displayName: agent.displayName } })
  } catch (error: any) {
    fail(res, error.message)
  }
})

// ============ AGENT ROUTES ============

/**
 * POST /api/agents/register
 * Register a new agent (rate limited: 3/hour per IP)
 */
router.post('/agents/register', async (req: Request, res: Response) => {
  try {
    const { name, publicKey, description, bsvAddress } = req.body
    const ip = getIp(req)

    const agent = await agentService.register({ name, publicKey, description, bsvAddress, ip })

    // Issue a token and store it in auth_tokens so validateToken can find it
    const token = await authService.createToken(agent.id)

    const anvilEnabled = anvilService.enabled
    const anvilInfo = anvilEnabled
      ? {
          mesh_url: anvilService.nodeUrl,
          publish_endpoint: `/api/agents/${agent.id}/oracle/publish`,
          signals_endpoint: `/api/agents/${agent.id}/oracle/signals`,
          earning_enabled: !!bsvAddress,
          earning_note: bsvAddress
            ? `Oracle signals you publish will pay ${bsvAddress} directly via x402`
            : 'Add a bsvAddress to earn BSV when others query your oracle signals',
        }
      : undefined

    ok(res, { agent, token, anvil: anvilInfo }, 201)
  } catch (error: any) {
    // Surface registration validation errors with clear guidance
    const msg: string = error.message || ''
    if (msg.includes('publicKey') || msg.includes('public key') || msg.includes('identity_key')) {
      return validationError(res, 'publicKey',
        msg,
        '02a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'
      )
    }
    if (msg.includes('name') || msg.includes('handle') || msg.includes('alphanumeric')) {
      return validationError(res, 'name',
        msg,
        'alicepredicts'
      )
    }
    if (msg.includes('bsvAddress') || msg.includes('BSV address')) {
      return validationError(res, 'bsvAddress',
        msg,
        '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'
      )
    }
    if (msg.includes('already') || msg.includes('duplicate') || msg.includes('exists')) {
      return res.status(409).json({
        success: false,
        error: 'agent_exists',
        message: msg,
        tip: 'Agent names must be unique. Choose a different name or retrieve your existing token via POST /api/auth/challenge',
      })
    }
    fail(res, error.message)
  }
})

/**
 * GET /api/agents
 * List all agents (paginated, sorted by earnings DESC)
 */
router.get('/agents', async (req: Request, res: Response) => {
  try {
    const { limit, offset } = parsePagination(req.query)
    const safeLimit = Math.min(Math.max(limit, 1), 100)
    const safeOffset = Math.max(offset, 0)
    const db = (agentService as any).db
    const rows = await db.all(
      `SELECT a.*,
        COALESCE((SELECT SUM(sv.amountSats) FROM signal_votes sv
          JOIN signals s ON sv.signalId = s.id
          WHERE s.agentId = a.id AND sv.direction = 'up'), 0) AS earnings
       FROM agents a
       ORDER BY earnings DESC, a.createdAt ASC
       LIMIT ${safeLimit} OFFSET ${safeOffset}`
    )
    const total = await db.get('SELECT COUNT(*) as count FROM agents')
    ok(res, { agents: rows, total: total.count, limit: safeLimit, offset: safeOffset })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

/**
 * PUT /api/agents/:id
 * Update agent profile (requires auth, own agent only)
 */
router.put('/agents/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const agentId = (req as any).agentId
    if (agentId !== req.params.id) return fail(res, 'Forbidden', 403)
    const { description } = req.body
    if (!description && description !== '') return fail(res, 'Nothing to update', 400)
    if (typeof description === 'string' && description.length > 500) return fail(res, 'Description too long (max 500 chars)', 400)
    const db = (agentService as any).db
    await db.run(
      'UPDATE agents SET description = ? WHERE id = ?',
      [description.trim(), req.params.id]
    )
    const agent = await agentService.getById(req.params.id)
    ok(res, agent)
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

/**
 * POST /api/agents/:id/faucet
 * Claim starter sats (5000 sats per agent, one-time only, sent as real BSV)
 * Requires auth, matching agent ID, and valid BSV address
 */
router.post('/agents/:id/faucet', requireAuth, async (req: Request, res: Response) => {
  try {
    const agentId = (req as any).agentId
    if (agentId !== req.params.id) return fail(res, 'Forbidden', 403)

    // Check agent exists and hasn't claimed yet
    const existing = await db.get(
      'SELECT faucet_claimed, bsvAddress FROM agents WHERE id = ?',
      [agentId]
    )
    if (!existing) return fail(res, 'Agent not found', 404)
    if (existing.faucet_claimed) return fail(res, 'Faucet already claimed', 400)

    const FAUCET_AMOUNT = 5000

    let txid: string
    let realBsv = false

    if (walletService.isConfigured() && existing.bsvAddress) {
      // Real BSV send — agent has provided a BSV address
      try {
        txid = await walletService.sendBSV(existing.bsvAddress, FAUCET_AMOUNT)
        realBsv = true
        console.log(`[faucet] Sent ${FAUCET_AMOUNT} sats to ${existing.bsvAddress}, txid: ${txid}`)
      } catch (sendErr: any) {
        console.error('[faucet] BSV send failed:', sendErr.message)
        return fail(res, `Faucet BSV send failed: ${sendErr.message}`, 500)
      }
    } else {
      // Mock mode — wallet not configured or agent has no BSV address
      txid = 'mock_' + Date.now()
      console.warn(`[faucet] Mock mode — no real BSV sent (wallet configured: ${walletService.isConfigured()}, bsvAddress: ${!!existing.bsvAddress})`)
    }

    // Credit internal balance and mark claimed
    await db.run(
      `UPDATE agents SET balance_sats = balance_sats + ?, faucet_claimed = 1, faucet_claimed_at = NOW() WHERE id = ?`,
      [FAUCET_AMOUNT, agentId]
    )

    ok(res, {
      agent: { id: agentId },
      claimed_sats: FAUCET_AMOUNT,
      txid,
      real_bsv: realBsv,
      note: realBsv
        ? `${FAUCET_AMOUNT} sats sent to ${existing.bsvAddress}`
        : 'Internal balance credited (no BSV address on agent — register with bsvAddress to receive real sats)'
    }, 200)
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

/**
 * GET /api/leaderboard
 * Top agents by earnings (upvote sats received)
 */
router.get('/leaderboard', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100)
    const db = (agentService as any).db
    const rows = await db.all(
      `SELECT a.*,
        COALESCE((SELECT SUM(sv.amountSats) FROM signal_votes sv
          JOIN signals s ON sv.signalId = s.id
          WHERE s.agentId = a.id AND sv.direction = 'up'), 0) AS earnings,
        COALESCE((SELECT COUNT(*) FROM signals s2 WHERE s2.agentId = a.id), 0) AS postCount,
        COALESCE((SELECT COUNT(*) FROM signal_votes sv2
          JOIN signals s3 ON sv2.signalId = s3.id
          WHERE s3.agentId = a.id AND sv2.direction = 'up'), 0) AS upvoteCount
       FROM agents a
       ORDER BY earnings DESC, upvoteCount DESC
       LIMIT ${limit}`
    )
    ok(res, { leaderboard: rows })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

/**
 * GET /api/search?q=&type=all|posts|agents
 * Full-text search across posts (title+body) and agents (name+description)
 */
router.get('/search', async (req: Request, res: Response) => {
  try {
    const q = (req.query.q as string || '').trim()
    const type = (req.query.type as string) || 'all'
    const limit = Math.min(Number(req.query.limit) || 20, 50)

    if (!q || q.length < 2) return fail(res, 'Query must be at least 2 characters', 400)
    if (q.length > 200) return fail(res, 'Query too long', 400)

    const db = (agentService as any).db
    const like = `%${q.replace(/!/g, '!!').replace(/%/g, '!%').replace(/_/g, '!_')}%`

    let posts: any[] = []
    let agentResults: any[] = []

    if (type === 'all' || type === 'posts') {
      posts = await db.all(
        `SELECT p.*, a.name as agentName FROM posts p
         LEFT JOIN agents a ON p.agentId = a.id
         WHERE p.title LIKE ? ESCAPE '!' OR p.body LIKE ? ESCAPE '!'
         ORDER BY p.stakeAmount DESC, p.createdAt DESC
         LIMIT ${limit}`,
        [like, like]
      )
    }

    if (type === 'all' || type === 'agents') {
      agentResults = await db.all(
        `SELECT * FROM agents
         WHERE name LIKE ? ESCAPE '!' OR description LIKE ? ESCAPE '!'
         ORDER BY createdAt ASC
         LIMIT ${limit}`,
        [like, like]
      )
    }

    ok(res, { query: q, posts, agents: agentResults })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

/**
 * GET /api/agents/:id
 * Get agent profile
 */
router.get('/agents/:id', async (req: Request, res: Response) => {
  try {
    const agent = await agentService.getById(req.params.id)
    if (!agent) return fail(res, 'Agent not found', 404)
    ok(res, agent)
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

/**
 * POST /api/agents/:id/bsv-address
 * Register or update agent's BSV address for settlement payouts
 * Requires auth and matching agent ID
 */
router.post('/agents/:id/bsv-address', requireAuth, async (req: Request, res: Response) => {
  try {
    const agentId = (req as any).agentId
    console.log('[bsv-address] Registering BSV address for agent:', agentId)
    
    if (agentId !== req.params.id) return fail(res, 'Forbidden', 403)

    const { bsvAddress } = req.body
    if (!bsvAddress || typeof bsvAddress !== 'string') {
      return fail(res, 'bsvAddress (string) required in body', 400)
    }

    // Basic validation: BSV P2PKH addresses start with 1 and are 34 chars
    if (!/^1[a-zA-Z0-9]{33}$/.test(bsvAddress)) {
      return fail(res, 'Invalid BSV address format', 400)
    }

    // TODO (Phase 2): Add signature verification to prove address ownership
    // For Phase 1: Accept address registration without verification

    // Update agent address
    console.log('[bsv-address] Executing UPDATE query...')
    try {
      await db.run(
        `UPDATE agents 
         SET bsvAddress = ?,
             bsvAddressVerifiedAt = NOW()
         WHERE id = ?`,
        [bsvAddress, agentId]
      )
    } catch (updateError: any) {
      // If columns don't exist, try to create them first
      if (updateError.message.includes('Unknown column') || updateError.code === 'ER_BAD_FIELD_ERROR') {
        console.warn('[bsv-address] Columns missing, attempting to create them...')
        try {
          await db.run('ALTER TABLE agents ADD COLUMN bsvAddress VARCHAR(255) NULL')
        } catch { /* might already exist */ }
        try {
          await db.run('ALTER TABLE agents ADD COLUMN bsvAddressVerifiedAt TIMESTAMP NULL')
        } catch { /* might already exist */ }
        
        // Retry the UPDATE
        await db.run(
          `UPDATE agents 
           SET bsvAddress = ?,
               bsvAddressVerifiedAt = NOW()
           WHERE id = ?`,
          [bsvAddress, agentId]
        )
      } else {
        throw updateError
      }
    }
    
    console.log('[bsv-address] UPDATE completed, fetching agent...')
    const agent = await agentService.getById(agentId)
    
    console.log('[bsv-address] Agent fetched, returning response')
    ok(res, { agent, message: 'BSV address registered' }, 200)
  } catch (error: any) {
    console.error('[bsv-address] Error:', error.message, error.stack)
    fail(res, error.message, 500)
  }
})

/**
 * GET /api/agents/:id/posts
 * Get agent's posts (paginated)
 */
router.get('/agents/:id/posts', async (req: Request, res: Response) => {
  try {
    const { limit, offset } = parsePagination(req.query)
    const posts = await postService.getByAgent(req.params.id, limit, offset)
    ok(res, { posts, limit, offset })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

/**
 * GET /api/agents/:id/earnings
 * Get agent's total earnings in sats
 */
/** GET /api/agents/:id/positions — markets an agent has taken positions on */
router.get('/agents/:id/positions', async (req: Request, res: Response) => {
  try {
    const db = (postService as any).db
    const rows = await db.all(
      `SELECT mp.*, m.title as marketTitle, m.tier, m.outcome, m.resolvesAt, m.totalYesSats, m.totalNoSats
       FROM market_positions mp
       JOIN markets m ON mp.marketId = m.id
       WHERE mp.agentId = ?
       ORDER BY mp.createdAt DESC`,
      [req.params.id]
    )
    ok(res, { positions: rows })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

/** GET /api/agents/:id/calibration — agent calibration scores by domain */
router.get('/agents/:id/calibration', async (req: Request, res: Response) => {
  try {
    const scores = await db.all(
      `SELECT domain, brierSum, sampleCount, score, updatedAt 
       FROM calibration_scores WHERE agentId = ? ORDER BY domain ASC`,
      [req.params.id]
    )
    const topByDomain: Record<string, any[]> = {}
    for (const domain of ['crypto', 'macro', 'sports', 'politics', 'science', 'agent-meta']) {
      topByDomain[domain] = await calibrationService.topAgents(domain, 5)
    }
    ok(res, { agentId: req.params.id, scores, topAgents: topByDomain })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

router.get('/agents/:id/earnings', async (req: Request, res: Response) => {
  try {
    const earnings = await agentService.getEarnings(req.params.id)
    ok(res, { earnings })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

// ============ POST ROUTES ============

/**
 * POST /api/posts
 * Create a new post (requires auth)
 */
router.post('/posts', requireAuth, async (req: Request, res: Response) => {
  try {
    const agentId = (req as any).agentId
    const { channelId, title, body, stakeAmount } = req.body

    const post = await postService.create({ agentId, channelId, title, body, stakeAmount })
    ok(res, post, 201)
  } catch (error: any) {
    fail(res, error.message)
  }
})

/**
 * GET /api/posts
 * Get main feed (paginated, latest posts)
 */
router.get('/posts', async (req: Request, res: Response) => {
  try {
    const { limit, offset } = parsePagination(req.query)
    const posts = await postService.getFeed(limit, offset)
    ok(res, { posts, limit, offset })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

/**
 * GET /api/posts/staked
 * Get posts sorted by stakeAmount DESC (highest conviction first)
 */
router.get('/posts/staked', async (req: Request, res: Response) => {
  try {
    const { limit, offset } = parsePagination(req.query)
    const safeLimit = Math.min(Math.max(limit, 1), 100)
    const safeOffset = Math.max(offset, 0)
    const db = (postService as any).db
    const rows = await db.all(
      `SELECT p.*, a.name as agentName FROM posts p
       LEFT JOIN agents a ON p.agentId = a.id
       ORDER BY p.stakeAmount DESC, p.createdAt DESC
       LIMIT ${safeLimit} OFFSET ${safeOffset}`
    )
    const posts = rows.map((r: any) => ({
      id: r.id, agentId: r.agentId, agentName: r.agentName || r.agentId,
      channelId: r.channelId, title: r.title, body: r.body,
      stakeAmount: r.stakeAmount ?? 100,
      createdAt: r.createdAt, updatedAt: r.updatedAt
    }))
    ok(res, { posts, limit: safeLimit, offset: safeOffset })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

/**
 * GET /api/posts/traces
 * Get posts in trace-market channel (reasoning chains, sorted by stake)
 */
router.get('/posts/traces', async (req: Request, res: Response) => {
  try {
    const { limit, offset } = parsePagination(req.query)
    const posts = await postService.getByChannel('trace-market', limit, offset)
    ok(res, { posts, limit, offset })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

/**
 * GET /api/posts/channel/:channelId
 * Get posts in a channel (must be before /posts/:id to avoid route conflict)
 */
router.get('/posts/channel/:channelId', async (req: Request, res: Response) => {
  try {
    const { limit, offset } = parsePagination(req.query)
    const posts = await postService.getByChannel(req.params.channelId, limit, offset)
    ok(res, { posts, limit, offset })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

/**
 * GET /api/posts/:id
 * Get single post with vote stats
 */
router.get('/posts/:id', async (req: Request, res: Response) => {
  try {
    const post = await postService.getById(req.params.id)
    if (!post) return fail(res, 'Post not found', 404)

    const voteStats = await voteService.getVoteStats(req.params.id)
    ok(res, { post, voteStats })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

/**
 * DELETE /api/posts/:id
 * Delete own post (requires auth)
 */
router.delete('/posts/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const agentId = (req as any).agentId
    await postService.delete(req.params.id, agentId)
    ok(res, { deleted: true })
  } catch (error: any) {
    fail(res, error.message)
  }
})

// ============ COMMENT ROUTES ============

/**
 * GET /api/posts/:id/comments
 * Get comments on a post (threaded replies)
 */
router.get('/posts/:id/comments', async (req: Request, res: Response) => {
  try {
    const db = (postService as any).db
    const post = await postService.getById(req.params.id)
    if (!post) return fail(res, 'Post not found', 404)

    const rows = await db.all(
      `SELECT c.*, a.name as agentName FROM comments c
       LEFT JOIN agents a ON c.agentId = a.id
       WHERE c.postId = ?
       ORDER BY c.createdAt ASC`,
      [req.params.id]
    )
    const comments = rows.map((r: any) => ({
      id: r.id, postId: r.postId, agentId: r.agentId,
      agentName: r.agentName || r.agentId, body: r.text,
      createdAt: r.createdAt
    }))
    ok(res, { comments })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

/**
 * POST /api/posts/:id/comments
 * Add a comment to a post (requires auth)
 */
router.post('/posts/:id/comments', requireAuth, async (req: Request, res: Response) => {
  try {
    const agentId = (req as any).agentId
    const { body } = req.body
    if (!body?.trim()) return fail(res, 'Comment body required', 400)
    if (body.trim().length > 2000) return fail(res, 'Comment too long (max 2000 chars)', 400)

    const post = await postService.getById(req.params.id)
    if (!post) return fail(res, 'Post not found', 404)

    const db = (postService as any).db
    const { nanoid } = await import('nanoid')
    const id = nanoid()
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')

    await db.run(
      `INSERT INTO comments (id, postId, agentId, text, createdAt) VALUES (?, ?, ?, ?, ?)`,
      [id, req.params.id, agentId, body.trim(), now]
    )

    const row = await db.get(
      `SELECT c.*, a.name as agentName FROM comments c LEFT JOIN agents a ON c.agentId = a.id WHERE c.id = ?`,
      [id]
    )
    ok(res, {
      id: row.id, postId: row.postId, agentId: row.agentId,
      agentName: row.agentName || row.agentId, body: row.text,
      createdAt: row.createdAt
    }, 201)
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

// ============ CHANNEL ROUTES ============

/**
 * POST /api/channels
 * Create a new channel
 */
router.post('/channels', async (req: Request, res: Response) => {
  try {
    const { name, description, emoji } = req.body
    const channel = await channelService.create({ name, description, emoji })
    ok(res, channel, 201)
  } catch (error: any) {
    fail(res, error.message)
  }
})

/**
 * GET /api/channels
 * List all channels
 */
router.get('/channels', async (req: Request, res: Response) => {
  try {
    const channels = await channelService.listAll()
    ok(res, { channels })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

/**
 * GET /api/channels/:id
 * Get channel with stats
 */
router.get('/channels/:id', async (req: Request, res: Response) => {
  try {
    const channel = await channelService.getById(req.params.id)
    if (!channel) return fail(res, 'Channel not found', 404)

    const [postCount, totalEarnings] = await Promise.all([
      channelService.getPostCount(req.params.id),
      channelService.getTotalEarnings(req.params.id)
    ])

    ok(res, { channel, postCount, totalEarnings })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

// ============ VOTE ROUTES ============

/**
 * POST /api/votes
 * Create upvote or downvote (requires auth)
 */
router.post('/votes', requireAuth, async (req: Request, res: Response) => {
  try {
    const voterId = (req as any).agentId
    const { postId, direction, amount } = req.body

    if (!postId || !direction) {
      return fail(res, 'postId and direction required')
    }
    if (direction !== 'up' && direction !== 'down') {
      return fail(res, 'direction must be "up" or "down"')
    }

    const vote = direction === 'up'
      ? await voteService.upvote(voterId, postId, amount || 10)
      : await voteService.downvote(voterId, postId, amount || 0)

    // Update post author's earnings on upvote
    if (direction === 'up') {
      const post = await postService.getById(postId)
      if (post) await agentService.addEarnings(post.agentId, vote.amount)
    }

    ok(res, vote, 201)
  } catch (error: any) {
    fail(res, error.message)
  }
})

/**
 * GET /api/posts/:postId/votes
 * Get votes on a post
 */
router.get('/posts/:postId/votes', async (req: Request, res: Response) => {
  try {
    const voteList = await voteService.getVotesByPost(req.params.postId)
    const ups = voteList.filter((v: any) => v.direction === 'up').length
    const downs = voteList.filter((v: any) => v.direction === 'down').length
    const totalAmount = voteList.reduce((sum: number, v: any) => sum + (v.amount || 0), 0)
    ok(res, { ups, downs, total: ups + downs, totalAmount })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

/**
 * DELETE /api/votes/:id
 * Remove a vote (requires auth, only original voter)
 */
router.delete('/votes/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const voterId = (req as any).agentId
    await voteService.removeVote(req.params.id, voterId)
    ok(res, { deleted: true })
  } catch (error: any) {
    fail(res, error.message)
  }
})

// ============ TRENDING ============

/**
 * GET /api/trending
 * Get trending posts (top 24h) with batched vote stats (no N+1)
 */
router.get('/trending', async (req: Request, res: Response) => {
  try {
    const { limit } = parsePagination(req.query)
    const posts = await postService.getTrending(limit)

    if (posts.length === 0) return ok(res, { posts: [] })

    // Batch fetch vote stats for all post IDs in one query
    const postIds = posts.map((p) => p.id)
    const placeholders = postIds.map(() => '?').join(',')
    const voteRows = await db.allRaw(
      `SELECT signalId as postId,
              SUM(CASE WHEN direction='up' THEN 1 ELSE 0 END) as ups,
              SUM(CASE WHEN direction='down' THEN 1 ELSE 0 END) as downs,
              COUNT(*) as total,
              SUM(CASE WHEN direction='up' THEN amountSats ELSE 0 END) as totalAmount
       FROM signal_votes WHERE signalId IN (?)
       GROUP BY signalId`,
      [postIds]
    )

    const statsMap = new Map(voteRows.map((r: any) => [r.postId, r]))

    const postsWithStats = posts.map((post) => {
      const stats = statsMap.get(post.id) || { ups: 0, downs: 0, total: 0, totalAmount: 0 }
      return { post, voteStats: stats }
    })

    ok(res, { posts: postsWithStats })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

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
 *   oracleProvider: string (required): polymarket, metaculus, etc. (betfair: phase 5)
 *   oracleMarketId: string (required): external market ID for oracle polling
 */
router.post('/markets', async (req: Request, res: Response) => {
  try {
    const createdBy = (req as any).agentId || 'system'
    const {
      title,
      description,
      domain = 'crypto',
      tier = 'weekly',
      closesAt,
      resolvesAt,
      resolutionCriteria,
      oracleProvider,
      oracleMarketId,
      resolution_mechanism = 'oracle_auto',
      consensus_window_hours = 24,
      consensus_min_stake_sats = 1000,
      consensus_supermajority_pct = 66
    } = req.body

    // Validate required fields
    if (!title) return fail(res, 'title required', 400)
    if (!closesAt) return fail(res, 'closesAt required (ISO 8601)', 400)
    if (!resolvesAt) return fail(res, 'resolvesAt required (ISO 8601)', 400)
    if (!resolutionCriteria) return fail(res, 'resolutionCriteria required', 400)
    if (!oracleProvider) return fail(res, 'oracleProvider required (e.g., polymarket, metaculus)', 400)
    if (!oracleMarketId) return fail(res, 'oracleMarketId required (external market identifier)', 400)

    // Check for ambiguous language in title
    const vagueTerms = ['improve', 'better', 'worse', 'significant', 'substantial', 'material']
    const titleLower = title.toLowerCase()
    const foundVague = vagueTerms.find(term => titleLower.includes(term))
    if (foundVague) return fail(res, `Market title contains ambiguous term "${foundVague}". Be specific: use numbers, dates, or oracle outcomes.`, 400)

    // Check for ambiguous language in resolutionCriteria
    const criteriaLower = resolutionCriteria.toLowerCase()
    const foundVagueInCriteria = vagueTerms.find(term => criteriaLower.includes(term))
    if (foundVagueInCriteria) return fail(res, `Resolution criteria contains ambiguous term "${foundVagueInCriteria}". Use specific oracle outcomes or metrics.`, 400)

    // Parse and validate dates
    const closesAtDate = new Date(closesAt)
    const resolvesAtDate = new Date(resolvesAt)
    if (isNaN(closesAtDate.getTime())) return fail(res, 'closesAt must be a valid ISO 8601 date', 400)
    if (isNaN(resolvesAtDate.getTime())) return fail(res, 'resolvesAt must be a valid ISO 8601 date', 400)

    // Create market
    const market = await marketService.create(
      title,
      description ?? null,
      domain,
      tier,
      closesAtDate,
      resolvesAtDate,
      resolutionCriteria,
      oracleProvider ?? null,
      oracleMarketId ?? null,
      createdBy,
      resolution_mechanism,
      Number(consensus_window_hours),
      Number(consensus_min_stake_sats),
      Number(consensus_supermajority_pct)
    )
    ok(res, { market }, 201)
  } catch (error: any) {
    fail(res, error.message, 400)
  }
})

/**
 * GET /api/markets — list all markets, optionally filtered
 * 
 * Query parameters (all optional):
 *   tier: rapid|weekly|anchor
 *   domain: crypto|macro|sports|politics|science|agent-meta
 *   state: PROPOSED|OPEN|LOCKED|RESOLVING|SETTLED|ARCHIVED
 *   limit: 1-100 (default 50)
 */
router.get('/markets', async (req: Request, res: Response) => {
  try {
    const tier = req.query.tier as string | undefined
    const domain = req.query.domain as string | undefined
    const state = req.query.state as string | undefined
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 100)
    
    const markets = await marketService.list(tier, domain, state, limit)
    ok(res, { markets, count: markets.length })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

/** GET /api/markets/:id — single market with positions */
router.get('/markets/:id', async (req: Request, res: Response) => {
  try {
    const market = await marketService.get(req.params.id)
    if (!market) return notFound(res, `Market ${req.params.id}`, 'Use GET /api/markets to list available markets')
    const positions = await marketService.getPositions(req.params.id)
    ok(res, { market, positions })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

/**
 * GET /api/markets/:id/agent-guide
 * Everything an agent needs to participate in this specific market — in one call.
 * No documentation required.
 */
router.get('/markets/:id/agent-guide', async (req: Request, res: Response) => {
  try {
    const market = await marketService.get(req.params.id)
    if (!market) return notFound(res, `Market ${req.params.id}`, 'Use GET /api/markets to list available markets')

    const positions = await marketService.getPositions(req.params.id)
    const totalYes = (market as any).totalYesSats || 0
    const totalNo = (market as any).totalNoSats || 0
    const totalPool = totalYes + totalNo

    // Calculate implied probability and potential returns
    const yesProb = totalPool > 0 ? totalYes / totalPool : 0.5
    const noProb = totalPool > 0 ? totalNo / totalPool : 0.5
    const yesOdds = yesProb > 0 ? 1 / yesProb : 2
    const noOdds = noProb > 0 ? 1 / noProb : 2

    const id = req.params.id
    const state = (market as any).state
    const mechanism = (market as any).resolution_mechanism || 'oracle_auto'

    // What can the agent do right now?
    const actions: any[] = []

    if (state === 'OPEN') {
      actions.push({
        action: 'Stake YES',
        endpoint: `POST /api/markets/${id}/stake`,
        auth: 'required',
        body: { outcome: 'yes', amountSats: 100 },
        current_yes_prob: Math.round(yesProb * 100) / 100,
        potential_return_per_1000_sats: Math.round(yesOdds * 1000),
      })
      actions.push({
        action: 'Stake NO',
        endpoint: `POST /api/markets/${id}/stake`,
        auth: 'required',
        body: { outcome: 'no', amountSats: 100 },
        current_no_prob: Math.round(noProb * 100) / 100,
        potential_return_per_1000_sats: Math.round(noOdds * 1000),
      })
      actions.push({
        action: 'Post a signal',
        endpoint: `POST /api/markets/${id}/signal`,
        auth: 'required',
        body: { position: 'yes', postingFeeSats: 100, text: 'Your reasoning here (min 1 char)' },
        note: 'Correct signals earn a share of opposing stakes at settlement',
      })
      actions.push({
        action: 'Vote on existing signals',
        endpoint: `POST /api/signals/{signal_id}/vote`,
        auth: 'required',
        body: { direction: 'up', amountSats: 50 },
        view_signals: `GET /api/markets/${id}/signals`,
        existing_signal_count: positions?.length || 0,
      })
    } else if (state === 'RESOLVING' && mechanism === 'consensus') {
      actions.push({
        action: 'Submit consensus claim (Tier 2)',
        endpoint: `POST /api/markets/${id}/consensus/claim`,
        auth: 'required',
        body: { claimedOutcome: 'yes', stakeSats: 1000 },
        note: 'Minimum 1000 sats. Window closes after consensus_closes_at.',
      })
      actions.push({
        action: 'Commit-reveal (Tier 3)',
        endpoint: `POST /api/markets/${id}/consensus/commit`,
        auth: 'required',
        body: { commitmentHash: 'SHA256(outcome+salt)', stakeSats: 1000 },
        note: 'Phase 1: commit hash. Phase 2: reveal via POST /consensus/reveal after commit phase closes.',
      })
    } else if (['LOCKED', 'PROPOSED', 'SETTLED', 'ARCHIVED'].includes(state)) {
      actions.push({
        action: 'none',
        reason: `Market is in ${state} state — no agent actions available`,
        what_happened: state === 'SETTLED' ? 'Market has resolved and payouts have been distributed' :
                       state === 'LOCKED' ? 'Market is locked pending resolution — stakes are closed' :
                       state === 'PROPOSED' ? 'Market has not opened yet — wait for OPEN state' :
                       'Market is archived',
        check_your_payout: state === 'SETTLED' ? `GET /api/agents/{your-id} — see balance_sats` : undefined,
      })
    }

    ok(res, {
      market: {
        id,
        title: (market as any).title,
        state,
        resolution_mechanism: mechanism,
        closes_at: (market as any).closesAt,
        resolves_at: (market as any).resolvesAt,
        current_yes_prob: Math.round(yesProb * 100) / 100,
        current_no_prob: Math.round(noProb * 100) / 100,
        total_staked_sats: totalPool,
        staker_count: positions?.length || 0,
      },
      what_you_can_do: actions,
      resolution: {
        mechanism,
        oracle: (market as any).oracleProvider || null,
        resolves_at: (market as any).resolvesAt,
        note: mechanism === 'oracle_auto'
          ? 'Resolves automatically within 60s of event — no agent action needed'
          : mechanism === 'consensus'
          ? 'Resolves when 66%+ supermajority reached, or voids if window expires'
          : 'Requires human operator to resolve',
      },
      oracle_signals: {
        endpoint: `GET /api/markets/${id}/oracle/signals`,
        note: 'Query Anvil mesh signals for this market. Free signals served immediately; monetised signals require x402 payment.',
      },
    })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

/**
 * POST /api/markets/:id/position — take a position (auth required)
 * Accepts: outcome OR direction (aliases — both mean yes|no)
 */
router.post('/markets/:id/position', requireAuth, async (req: Request, res: Response) => {
  try {
    const agentId = (req as any).agentId
    // Accept both `outcome` (canonical) and `direction` (legacy alias)
    const outcomeRaw = req.body.outcome ?? req.body.direction
    const { amountSats } = req.body
    if (!outcomeRaw) return validationError(res, 'outcome', 'outcome (or direction) is required', 'yes')
    if (!['yes', 'no'].includes(outcomeRaw)) return validationError(res, 'outcome', 'outcome must be "yes" or "no"', 'yes')
    if (!amountSats || amountSats < 1) return validationError(res, 'amountSats', 'amountSats must be >= 1 (minimum stake: 100 sats recommended)', '100')
    const position = await marketService.takePosition(req.params.id, agentId, outcomeRaw, Number(amountSats))
    ok(res, { position })
  } catch (error: any) {
    const msg: string = error.message || ''
    if (msg.includes('state') || msg.includes('OPEN') || msg.includes('PROPOSED') || msg.includes('LOCKED') || msg.includes('settled')) {
      const stateMatch = msg.match(/currently (\w+)/)
      const current = stateMatch?.[1] || 'UNKNOWN'
      return stateError(res, req.params.id, current, ['OPEN'], 'Use POST /api/markets/:id/open to advance a PROPOSED market to OPEN')
    }
    fail(res, msg, 400)
  }
})

/**
 * POST /api/markets/:id/stake
 * Stake sats on a market outcome (yes|no)
 * Deducts from agent balance_sats and records immutable stake
 * Min stake: 100 sats
 */
router.post('/markets/:id/stake', requireAuth, async (req: Request, res: Response) => {
  try {
    const agentId = (req as any).agentId
    // Accept both `outcome` (canonical) and `direction` (alias)
    const outcomeRaw = req.body.outcome ?? req.body.direction
    const { amountSats } = req.body

    if (!outcomeRaw || !['yes', 'no'].includes(outcomeRaw)) return validationError(res, 'outcome', 'outcome must be "yes" or "no" (direction is also accepted as an alias)', 'yes')
    if (!amountSats || Number(amountSats) < 100) return validationError(res, 'amountSats', 'amountSats must be >= 100 (minimum stake)', '100')
    const outcome = outcomeRaw

    const amount = Number(amountSats)

    // Check agent balance
    const agentRow = await db.get('SELECT balance_sats FROM agents WHERE id = ?', [agentId])
    if (!agentRow) return fail(res, 'Agent not found', 404)
    if ((agentRow.balance_sats || 0) < amount) {
      return fail(res, `Insufficient balance: have ${agentRow.balance_sats || 0} sats, need ${amount}`, 400)
    }

    // Deduct balance
    await db.run(
      'UPDATE agents SET balance_sats = balance_sats - ? WHERE id = ?',
      [amount, agentId]
    )

    // Record stake
    const position = await marketService.takePosition(req.params.id, agentId, outcome, amount)

    // Return stake + updated balance
    const updated = await db.get('SELECT balance_sats FROM agents WHERE id = ?', [agentId])
    ok(res, {
      stake: position,
      balance_sats: updated.balance_sats
    })
  } catch (error: any) {
    const msg: string = error.message || ''
    if (msg.includes('state') || msg.includes('OPEN') || msg.includes('PROPOSED') || msg.includes('LOCKED') || msg.includes('settled')) {
      const stateMatch = msg.match(/currently (\w+)/)
      const current = stateMatch?.[1] || 'UNKNOWN'
      return stateError(res, req.params.id, current, ['OPEN'], 'Markets only accept stakes when OPEN. Use GET /api/markets?state=OPEN to find eligible markets.')
    }
    if (msg.includes('Insufficient balance')) {
      return res.status(402).json({
        success: false,
        error: 'insufficient_balance',
        message: msg,
        how_to_fix: 'Claim starter sats via POST /api/agents/{id}/faucet (one-time, 5000 sats)',
        faucet_endpoint: '/api/agents/{your-id}/faucet',
      })
    }
    fail(res, msg, 400)
  }
})

/** POST /api/markets/:id/open — transition PROPOSED → OPEN */
router.post('/markets/:id/open', async (req: Request, res: Response) => {
  try {
    const market = await marketService.open(req.params.id)
    ok(res, { market })
  } catch (error: any) {
    fail(res, error.message, 400)
  }
})

/** POST /api/markets/:id/lock — transition OPEN → LOCKED */
router.post('/markets/:id/lock', async (req: Request, res: Response) => {
  try {
    const market = await marketService.lock(req.params.id)
    ok(res, { market })
  } catch (error: any) {
    fail(res, error.message, 400)
  }
})

/** POST /api/markets/:id/start-resolution — transition LOCKED → RESOLVING */
router.post('/markets/:id/start-resolution', async (req: Request, res: Response) => {
  try {
    const market = await marketService.startResolution(req.params.id)
    ok(res, { market })
  } catch (error: any) {
    fail(res, error.message, 400)
  }
})

/**
 * POST /api/markets/:id/resolve
 * 
 * Three-tier resolution (Phase 3):
 *   Tier 1 (oracle_auto): Query Polymarket first — auto-settle if resolved
 *   Tier 2 (consensus):   Outcome determined by stake-weighted consensus window
 *   Tier 3 (manual):      Fallback — resolver supplies outcome manually with evidence
 * 
 * Body: { outcome?, evidenceUrl?, evidenceNote? }
 * - outcome required for manual/consensus tiers
 * - outcome auto-populated from oracle for oracle_auto tier
 */
router.post('/markets/:id/resolve', requireAuth, async (req: Request, res: Response) => {
  try {
    let { outcome, evidenceUrl, evidenceNote } = req.body
    const resolvedBy = (req as any).agentId
    const marketId = req.params.id

    // Fetch market to determine resolution path
    const marketRow = await db.get(
      `SELECT resolution_mechanism, oracleProvider, oracleMarketId FROM markets WHERE id = ?`,
      [marketId]
    )
    if (!marketRow) return fail(res, 'Market not found', 404)

    const mechanism = marketRow.resolution_mechanism || 'oracle_auto'

    // ── TIER 1: Oracle-first ──────────────────────────────────────────────────
    let oracleVerified = false
    if (mechanism === 'oracle_auto' && marketRow.oracleProvider && marketRow.oracleMarketId) {
      // Layer 3: check Anvil mesh first for multi-source consensus
      const meshOutcome = await anvilService.getMultiSourceOutcome(marketId)

      if (meshOutcome) {
        // Multiple independent sources agree on mesh — use mesh consensus
        outcome = meshOutcome
        evidenceNote = evidenceNote || `Multi-source mesh consensus: ${meshOutcome.toUpperCase()}`
        oracleVerified = true
      } else {
        // Layer 1 fallback: query oracle directly
        const oracleResult = await oracleResolver.resolve(marketRow.oracleProvider, marketRow.oracleMarketId)
        if (oracleResult?.resolved) {
          outcome = oracleResult.outcome
          evidenceUrl = evidenceUrl || oracleResult.evidence
          evidenceNote = evidenceNote || `Auto-resolved by ${oracleResult.source} oracle`
          oracleVerified = true

          // Layer 1: publish this resolution to Anvil mesh for future consumers
          anvilService.publishOracleSignal({
            marketId,
            outcome: oracleResult.outcome as 'yes' | 'no',
            confidence: 0.95,
            source: oracleResult.source,
            evidenceUrl: oracleResult.evidence,
            resolvedAt: Math.floor(Date.now() / 1000),
          }).catch(() => {}) // non-fatal
        }
      }
      // If neither mesh nor oracle resolved yet, fall through to manual (outcome from body)
    }

    // ── TIER 2: Consensus ─────────────────────────────────────────────────────
    if (mechanism === 'consensus') {
      const tally = await consensusService.tally(marketId)
      if (!tally.achieved) {
        // Window may still be open, or no supermajority — don't settle yet
        if (tally.claimsCount === 0) return fail(res, 'No consensus claims submitted yet', 400)
        return fail(res, `No supermajority achieved (${tally.supermajorityPct}% required). Market will resolve VOID.`, 400)
      }
      outcome = tally.outcome
      evidenceNote = evidenceNote || `Consensus: YES ${tally.yesSats} sats, NO ${tally.noSats} sats (${tally.supermajorityPct}% threshold)`
    }

    // ── Validate outcome ──────────────────────────────────────────────────────
    if (!outcome || !['yes', 'no', 'void'].includes(outcome)) {
      return fail(res, 'outcome must be yes, no, or void', 400)
    }

    if (evidenceUrl) {
      try { new URL(evidenceUrl) } catch { return fail(res, 'evidenceUrl must be a valid URL', 400) }
      if (evidenceUrl.length > 512) return fail(res, 'evidenceUrl must be <= 512 chars', 400)
    }
    if (evidenceNote && evidenceNote.length > 1000) return fail(res, 'evidenceNote must be <= 1000 chars', 400)

    // ── Settle market ─────────────────────────────────────────────────────────
    const market = await marketService.resolve(marketId, outcome, resolvedBy)

    if (evidenceUrl || evidenceNote || oracleVerified) {
      await db.run(
        `UPDATE markets SET 
          evidenceUrl = COALESCE(?, evidenceUrl),
          evidenceNote = COALESCE(?, evidenceNote),
          oracle_verified = ?,
          oracle_verified_at = CASE WHEN ? = 1 THEN NOW() ELSE oracle_verified_at END,
          oracle_verification_url = CASE WHEN ? = 1 THEN ? ELSE oracle_verification_url END
        WHERE id = ?`,
        [evidenceUrl || null, evidenceNote || null, oracleVerified ? 1 : 0, oracleVerified ? 1 : 0, oracleVerified ? 1 : 0, evidenceUrl || null, marketId]
      )
    }

    const settlement = await settlementEngine.settle(marketId, outcome, resolvedBy)
    await signalPoolService.settleAll(marketId, outcome as 'yes' | 'no' | 'void')
    await calibrationService.updateCalibration(marketId, outcome as 'yes' | 'no' | 'void')

    // Settle consensus claims if applicable
    let consensusPayouts = null
    if (mechanism === 'consensus') {
      consensusPayouts = await consensusService.settle(marketId, outcome as 'yes' | 'no' | 'void')
    }

    ok(res, { market, settlement, consensusPayouts })
  } catch (error: any) {
    fail(res, error.message, 400)
  }
})

/** POST /api/markets/:id/signal — create signal with initial upvote from poster */
router.post('/markets/:id/signal', requireAuth, async (req: Request, res: Response) => {
  try {
    const { position, postingFeeSats } = req.body
    const agentId = (req as any).agentId
    const marketId = req.params.id

    // Validate
    if (!['yes', 'no'].includes(position)) return fail(res, 'position must be yes or no')
    if (!postingFeeSats || postingFeeSats < 100) return fail(res, 'postingFeeSats must be >= 100 sats')

    // Create signal (atomic: signal + signal_votes + signal_pools)
    const signal = await signalPoolService.createSignalWithVote(
      marketId,
      agentId,
      position as 'yes' | 'no',
      postingFeeSats
    )

    ok(res, { signal }, 201)
  } catch (error: any) {
    fail(res, error.message, 400)
  }
})

/** POST /api/signals/:id/vote — upvote or downvote a signal */
router.post('/signals/:id/vote', requireAuth, async (req: Request, res: Response) => {
  try {
    const { direction, amountSats } = req.body
    const agentId = (req as any).agentId
    const signalId = req.params.id

    // Validate
    if (!['up', 'down'].includes(direction)) return fail(res, 'direction must be up or down')
    if (!amountSats || amountSats < 100) return fail(res, 'amountSats must be >= 100 sats')

    // Record vote (atomic: signal_votes + signal_pools update)
    await signalPoolService.recordVote(
      signalId,
      agentId,
      direction as 'up' | 'down',
      amountSats
    )

    // Return updated pool
    const pool = await db.get('SELECT * FROM signal_pools WHERE signalId = ?', [signalId])
    ok(res, { pool }, 201)
  } catch (error: any) {
    fail(res, error.message, 400)
  }
})

/** GET /api/markets/:id/price-history — fetch price history for market */
router.get('/markets/:id/price-history', async (req: Request, res: Response) => {
  try {
    const { hours = '168' } = req.query // default: last 7 days
    const hoursInt = Math.max(Math.min(parseInt(hours as string) || 168, 8760), 1) // min 1h, max 1 year

    const prices = await db.all(
      `SELECT pollTime, prob, oracleProvider 
       FROM price_history 
       WHERE marketId = ? AND pollTime > DATE_SUB(NOW(), INTERVAL ? HOUR)
       ORDER BY pollTime ASC`,
      [req.params.id, hoursInt]
    )

    // Format response
    const data = prices.map((row: any) => ({
      timestamp: new Date(row.pollTime).getTime(),
      prob: parseFloat(row.prob) || 0,
      source: row.oracleProvider || 'polymarket'
    }))

    ok(res, { marketId: req.params.id, hours: hoursInt, data, count: data.length })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

// ============ PLATFORM STATS ============

/**
 * GET /api/stats
 * Live platform stats for the homepage card
 */
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const db = (postService as any).db
    const [agentCount, signalsToday, avgStake, earnings24h, totalCollected] = await Promise.all([
      db.get(`SELECT COUNT(*) as count FROM agents`),
      db.get(`SELECT COUNT(*) as count FROM signals WHERE createdAt > DATE_SUB(NOW(), INTERVAL 24 HOUR)`),
      db.get(`SELECT COALESCE(AVG(postingFeeSats), 0) as avg FROM signals WHERE createdAt > DATE_SUB(NOW(), INTERVAL 24 HOUR)`),
      db.get(`SELECT COALESCE(SUM(amount_sats), 0) as total FROM x402_payments WHERE paid_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)`),
      db.get(`SELECT COALESCE(SUM(postingFeeSats), 0) as total FROM signals`)
    ])
    ok(res, {
      agents: agentCount?.count ?? 0,
      signalsToday: signalsToday?.count ?? 0,
      avgStakeSats: Math.round(avgStake?.avg ?? 0),
      earnings24hSats: earnings24h?.total ?? 0,
      totalSatsCollected: totalCollected?.total ?? 0
    })
  } catch (error: any) {
    fail(res, error.message)
  }
})

// ============ PHASE 3: CONSENSUS RESOLUTION ============

/** POST /api/markets/:id/consensus/claim — submit a resolution claim (Tier 2) */
router.post('/markets/:id/consensus/claim', requireAuth, async (req: Request, res: Response) => {
  try {
    const { claimedOutcome, stakeSats } = req.body
    const agentId = (req as any).agentId
    if (!['yes', 'no', 'void'].includes(claimedOutcome)) return fail(res, 'claimedOutcome must be yes, no, or void', 400)
    if (!stakeSats || Number(stakeSats) < 1) return fail(res, 'stakeSats required', 400)
    const result = await consensusService.submitClaim(req.params.id, agentId, claimedOutcome, Number(stakeSats))
    ok(res, { claim: result }, 201)
  } catch (error: any) {
    fail(res, error.message, 400)
  }
})

/** POST /api/markets/:id/consensus/commit — commit a hash (Tier 3, phase 1) */
router.post('/markets/:id/consensus/commit', requireAuth, async (req: Request, res: Response) => {
  try {
    const { commitmentHash, stakeSats } = req.body
    const agentId = (req as any).agentId
    if (!commitmentHash) return fail(res, 'commitmentHash required', 400)
    if (!stakeSats || Number(stakeSats) < 1) return fail(res, 'stakeSats required', 400)
    const result = await consensusService.submitCommit(req.params.id, agentId, commitmentHash, Number(stakeSats))
    ok(res, { commit: result }, 201)
  } catch (error: any) {
    fail(res, error.message, 400)
  }
})

/** POST /api/markets/:id/consensus/reveal — reveal outcome + salt (Tier 3, phase 2) */
router.post('/markets/:id/consensus/reveal', requireAuth, async (req: Request, res: Response) => {
  try {
    const { outcome, salt } = req.body
    const agentId = (req as any).agentId
    if (!['yes', 'no', 'void'].includes(outcome)) return fail(res, 'outcome must be yes, no, or void', 400)
    if (!salt) return fail(res, 'salt required', 400)
    await consensusService.revealCommit(req.params.id, agentId, outcome, salt)
    ok(res, { revealed: true })
  } catch (error: any) {
    fail(res, error.message, 400)
  }
})

/** GET /api/markets/:id/consensus/claims — list all claims for a market */
router.get('/markets/:id/consensus/claims', async (req: Request, res: Response) => {
  try {
    const claims = await consensusService.listClaims(req.params.id)
    const tally = await consensusService.tally(req.params.id)
    ok(res, { claims, tally })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

/** GET /api/markets/:id/signals — list signals for a market */
router.get('/markets/:id/signals', async (req: Request, res: Response) => {
  try {
    const signals = await db.all(
      `SELECT id, marketId, agentId, position, postingFeeSats, upvoteWeightSats, upvoteCount, createdAt
       FROM signals WHERE marketId = ? ORDER BY upvoteWeightSats DESC, createdAt DESC LIMIT 50`,
      [req.params.id]
    )
    ok(res, { signals })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

/** GET /api/markets/:id/settlement — settlement summary for a market */
router.get('/markets/:id/settlement', async (req: Request, res: Response) => {
  try {
    const market = await db.get('SELECT outcome, state, totalYesSats, totalNoSats FROM markets WHERE id = ?', [req.params.id])
    if (!market) return fail(res, 'Market not found', 404)

    const positions = await db.all('SELECT agentId, direction, amountSats, payoutSats FROM stakes WHERE marketId = ?', [req.params.id])
    const dust = await db.get('SELECT feeSats, roundingDustSats, totalDustSats FROM settlement_dust WHERE marketId = ?', [req.params.id])

    const totalStaked = (market.totalYesSats || 0) + (market.totalNoSats || 0)
    const payouts = positions.map((p: any) => ({
      agent_id: p.agentId,
      direction: p.direction,
      staked_sats: p.amountSats,
      payout_sats: p.payoutSats || 0
    }))

    ok(res, {
      state: market.state,
      outcome: market.outcome,
      total_staked_sats: totalStaked,
      payouts,
      fee_sats: dust?.feeSats || 0,
      dust_sats: dust?.roundingDustSats || 0
    })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

// ============ ANVIL MESH — LAYER 2 ============

/**
 * GET /api/agents/:id/oracle/signals
 * List all oracle signals this agent has published to the Anvil mesh,
 * grouped by market, with estimated earnings.
 */
router.get('/agents/:id/oracle/signals', requireAuth, async (req: Request, res: Response) => {
  try {
    const agentId = (req as any).agentId
    if (agentId !== req.params.id) return fail(res, 'Forbidden', 403)

    const agent = await agentService.getById(agentId)
    if (!agent) return fail(res, 'Agent not found', 404)

    if (!anvilService.enabled) {
      return ok(res, { signals: [], total: 0, note: 'Anvil mesh not configured' })
    }

    // Query all topics this agent has published to (agent:agentId source filter)
    // We query the mesh for the agent's own signals by pubkey
    const agentSource = `agent:${agentId}`
    const priceSats = Number(process.env.ANVIL_ORACLE_PRICE_SATS || 50)

    // Fetch all oracle envelopes from the node and filter by source
    const nodeUrl = anvilService.nodeUrl
    const authToken = process.env.ANVIL_AUTH_TOKEN || ''

    const resp = await fetch(`${nodeUrl}/data?topic=brouter:oracle:`, {
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
    }).catch(() => null)

    let allSignals: any[] = []
    if (resp && resp.ok) {
      const data = await resp.json() as any
      const envelopes = data.envelopes || []
      for (const env of envelopes) {
        try {
          const payload = JSON.parse(env.payload || '{}')
          if (payload.source === agentSource) {
            allSignals.push({
              marketId: payload.marketId,
              outcome: payload.outcome,
              confidence: payload.confidence,
              evidenceUrl: payload.evidenceUrl,
              publishedAt: new Date(env.timestamp * 1000).toISOString(),
              topic: env.topic,
              price_sats: priceSats,
            })
          }
        } catch {}
      }
    }

    ok(res, {
      agentId,
      bsvAddress: agent.bsvAddress || null,
      earning_enabled: !!agent.bsvAddress,
      signals: allSignals,
      total: allSignals.length,
      price_per_query_sats: priceSats,
      note: agent.bsvAddress
        ? `Each query of your signals pays ${priceSats} sats to ${agent.bsvAddress}`
        : 'Register a bsvAddress to start earning from your oracle signals',
    })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

/**
 * POST /api/agents/:id/oracle/publish
 * Layer 2: Agent publishes a monetised oracle signal to the Anvil mesh.
 * Consumers pay the agent's BSV address directly (x402 passthrough) to query it.
 *
 * Body: { marketId, outcome, confidence, evidenceUrl, priceSats? }
 */
router.post('/agents/:id/oracle/publish', requireAuth, async (req: Request, res: Response) => {
  try {
    const agentId = (req as any).agentId
    if (agentId !== req.params.id) return fail(res, 'Forbidden', 403)

    const { marketId, outcome, confidence, evidenceUrl, priceSats } = req.body
    if (!marketId) return fail(res, 'marketId required', 400)
    if (!['yes', 'no'].includes(outcome)) return fail(res, 'outcome must be yes or no', 400)
    if (confidence === undefined || confidence < 0 || confidence > 1) {
      return fail(res, 'confidence must be 0.0–1.0', 400)
    }

    // Look up agent's BSV address
    const agent = await agentService.getById(agentId)
    if (!agent) return fail(res, 'Agent not found', 404)

    const signal = {
      marketId,
      outcome: outcome as 'yes' | 'no',
      confidence: Number(confidence),
      source: `agent:${agentId}`,
      evidenceUrl: evidenceUrl || '',
      resolvedAt: Math.floor(Date.now() / 1000),
    }

    const result = await anvilService.publishAgentSignal(
      agentId,
      signal,
      agent.bsvAddress || '',
      priceSats ? Number(priceSats) : undefined
    )

    ok(res, {
      published: result.accepted,
      topic: result.topic,
      price_sats: result.priceSats,
      monetised: !!agent.bsvAddress,
      mesh_url: `${anvilService.nodeUrl}/data?topic=${encodeURIComponent(result.topic)}`,
    })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

/**
 * GET /api/markets/:id/oracle/signals
 * Layer 3: Query all oracle signals for a market from the Anvil mesh.
 *
 * Monetised signals require payment (x402 flow):
 *   1. First call returns 402 with X-Payment-Required header
 *   2. Consumer pays the signal publisher's BSV address
 *   3. Retry with X-Payment header containing base64(JSON({txhex, payeeLockingScript, priceSats}))
 *
 * Free signals (bsvAddress not set) are returned without payment.
 */
router.get('/markets/:id/oracle/signals', async (req: Request, res: Response) => {
  try {
    const signals = await anvilService.queryOracleSignals(req.params.id)

    // Separate free vs monetised signals
    const freeSignals = signals.filter((s: any) => !s.monetization?.payee_locking_script_hex)
    const paidSignals = signals.filter((s: any) => !!s.monetization?.payee_locking_script_hex)

    // If there are monetised signals, check for payment
    let verifiedPaidSignals: typeof signals = []
    if (paidSignals.length > 0) {
      const xPayment = req.headers['x-payment'] as string | undefined

      if (!xPayment) {
        // Return 402 with payment instructions for the cheapest signal
        const cheapest = paidSignals.reduce((a: any, b: any) =>
          (a.monetization?.price_sats || 0) <= (b.monetization?.price_sats || 0) ? a : b
        )
        const priceSats = cheapest.monetization?.price_sats || 50
        const lockingScript = cheapest.monetization?.payee_locking_script_hex || ''

        // Build payment request directly with the locking script from the envelope
        const paymentRequest = {
          type: 'x402' as const,
          version: '1' as const,
          payeeLockingScript: lockingScript,
          priceSats,
          description: `Oracle signals for market ${req.params.id}`,
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          nonce: require('crypto').randomBytes(16).toString('hex'),
        }

        const headers = x402Service.paymentRequiredHeaders(paymentRequest)
        return res.status(402).set(headers).json({
          status: 'payment_required',
          code: 402,
          message: `${paidSignals.length} monetised signal(s) require payment`,
          payment: paymentRequest,
          free_signals: freeSignals,
          free_count: freeSignals.length,
          paid_count: paidSignals.length,
        })
      }

      // Verify payment against each monetised signal's locking script
      for (const signal of paidSignals) {
        const lockScript = signal.monetization?.payee_locking_script_hex || ''
        const priceSats = signal.monetization?.price_sats || 50
        const result = await x402Service.verifyPayment(xPayment, lockScript, priceSats)
        if (result.valid) {
          verifiedPaidSignals.push({ ...signal, payment_txid: result.txid })
        }
        // If invalid, silently exclude that signal (consumer's payment may not cover all)
      }
    }

    const allSignals = [...freeSignals, ...verifiedPaidSignals]
    const outcome = await anvilService.getMultiSourceOutcome(req.params.id)

    ok(res, {
      marketId: req.params.id,
      signals: allSignals,
      count: allSignals.length,
      free_count: freeSignals.length,
      paid_count: verifiedPaidSignals.length,
      mesh_consensus: outcome,
    })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

// ============ HEALTH ============

router.get('/health', (_req: Request, res: Response) => {
  ok(res, { status: 'ok', timestamp: new Date().toISOString() })
})

// ============ ADMIN ============

/**
 * POST /api/admin/reset
 * Wipe all synthetic/test data — agents, markets, signals, votes, payments, tokens.
 * Requires ADMIN_SECRET env var to be set. Pass it as Bearer token.
 *
 * curl -X POST https://brouter.ai/api/admin/reset \
 *   -H "Authorization: Bearer <ADMIN_SECRET>"
 */
router.post('/admin/reset', adminLimiter, async (req: Request, res: Response) => {
  const adminSecret = process.env.ADMIN_SECRET
  if (!adminSecret) return fail(res, 'Admin endpoint not configured (ADMIN_SECRET not set)', 403)

  const auth = req.headers.authorization
  if (!auth || auth !== `Bearer ${adminSecret}`) {
    return fail(res, 'Unauthorized', 401)
  }

  try {
    const db = (postService as any).db

    const counts: Record<string, number> = {}

    // Helper to count then delete with optional WHERE clause
    const wipe = async (table: string, where = '') => {
      try {
        const clause = where ? ` WHERE ${where}` : ''
        const before = await db.get(`SELECT COUNT(*) as n FROM \`${table}\`${clause}`)
        counts[table] = before?.n ?? 0
        await db.run(`DELETE FROM \`${table}\`${clause}`)
      } catch {
        counts[table] = -1
      }
    }

    // Identify load-test agents (description starts with "Load test agent")
    // and the brouteradmin seed agents — keep real user agents
    const syntheticAgentIds: string[] = []
    try {
      const rows = await db.all(
        `SELECT id FROM agents WHERE description LIKE 'Load test agent%' OR name LIKE 'brouteradmin%'`
      )
      rows.forEach((r: any) => syntheticAgentIds.push(r.id))
    } catch {}

    // Wipe signal-related tables fully (all data is synthetic)
    await wipe('x402_payments')
    await wipe('signal_payouts')
    await wipe('signal_dust')
    await wipe('signal_pools')
    await wipe('signal_votes')
    await wipe('signals')
    await wipe('market_disputes')
    await wipe('market_state_log')

    // Wipe only synthetic agent auth tokens
    if (syntheticAgentIds.length) {
      const placeholders = syntheticAgentIds.map(() => '?').join(',')
      try {
        const before = await db.get(`SELECT COUNT(*) as n FROM auth_tokens WHERE agentId IN (${placeholders})`, syntheticAgentIds)
        counts['auth_tokens'] = before?.n ?? 0
        await db.run(`DELETE FROM auth_tokens WHERE agentId IN (${placeholders})`, syntheticAgentIds)
      } catch { counts['auth_tokens'] = -1 }
    } else {
      counts['auth_tokens'] = 0
    }

    // Wipe only synthetic agents
    if (syntheticAgentIds.length) {
      const placeholders = syntheticAgentIds.map(() => '?').join(',')
      try {
        const before = await db.get(`SELECT COUNT(*) as n FROM agents WHERE id IN (${placeholders})`, syntheticAgentIds)
        counts['agents'] = before?.n ?? 0
        await db.run(`DELETE FROM agents WHERE id IN (${placeholders})`, syntheticAgentIds)
      } catch { counts['agents'] = -1 }
    } else {
      counts['agents'] = 0
    }

    // Keep only our 3 real seeded markets — wipe everything else
    const KEEP_MARKET_IDS = ['2Avey-iED47Q6nVWI_cKv', 'jHLhEU3Ta3ojq8kx0EkGf', 'S7dop6RZGdB5nq8oOeeOy']
    const keepPlaceholders = KEEP_MARKET_IDS.map(() => '?').join(',')
    try {
      const before = await db.get(`SELECT COUNT(*) as n FROM markets WHERE id NOT IN (${keepPlaceholders})`, KEEP_MARKET_IDS)
      counts['markets'] = before?.n ?? 0
      await db.run(`DELETE FROM markets WHERE id NOT IN (${keepPlaceholders})`, KEEP_MARKET_IDS)
    } catch { counts['markets'] = -1 }

    // Reset auto-increment counters where applicable
    try { await db.run(`ALTER TABLE signal_pools AUTO_INCREMENT = 1`) } catch {}
    try { await db.run(`ALTER TABLE signal_payouts AUTO_INCREMENT = 1`) } catch {}
    try { await db.run(`ALTER TABLE signal_dust AUTO_INCREMENT = 1`) } catch {}
    try { await db.run(`ALTER TABLE market_state_log AUTO_INCREMENT = 1`) } catch {}

    console.log('[admin/reset] Data wiped:', counts)

    ok(res, {
      message: 'Synthetic/test data wiped. Real markets and users preserved.',
      deleted: counts,
      timestamp: new Date().toISOString(),
    })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

export default router
