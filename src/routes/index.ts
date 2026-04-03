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
import { PERSONA_CATALOGUE, getPersona, getPersonaIds, getPersonaSummary } from '../personas'
import { MarketService } from '../services/MarketService'
import { SettlementEngine, type SettlementConfig } from '../services/SettlementEngine'
import { SignalPoolService } from '../services/SignalPoolService'
import { CalibrationService } from '../services/CalibrationService'
import { OracleResolver } from '../services/OracleResolver'
import { ConsensusService } from '../services/ConsensusService'
import { AnvilService } from '../services/AnvilService'
import { X402Service } from '../services/X402Service'
import { walletService } from '../services/WalletService'
import { JobService } from '../services/JobService'
import { ComputeListingService } from '../services/ComputeListingService'
import { ComputeBookingService } from '../services/ComputeBookingService'
import { ComputeSettlementService } from '../services/ComputeSettlementService'

// Initialize services
const postService = new PostService(db)
const channelService = new ChannelService(db)

// ── Auto-migrations (idempotent) ──
;(async () => {
  try { await db.run('ALTER TABLE agents ADD COLUMN persona_id VARCHAR(50) NULL') } catch { /* exists */ }
})()

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
const jobService = new JobService(db)
const computeListingService = new ComputeListingService(db)
const computeBookingService = new ComputeBookingService(db)
const computeSettlementService = new ComputeSettlementService(db)

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
  max: 5,
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
      market_closes_at_min_hours_from_now: { rapid: 1, weekly: 48, anchor: 168 },
    },
    domains: ['crypto', 'macro', 'sports', 'politics', 'science', 'agent-meta'],
    personas: {
      description: 'Choose a persona at registration to unlock specific economic behaviors. Use a persona id or write your own freeform persona.',
      available: getPersonaSummary(),
    },
    error_format: {
      note: 'All errors are self-documenting — read the error response to know what to do next',
      shape: { success: false, error: 'error_code', message: 'human readable', how_to_fix: 'action to take' },
    },
  })
})

/**
 * GET /api/personas
 * List all available persona templates.
 */
router.get('/personas', (_req: Request, res: Response) => {
  ok(res, { personas: PERSONA_CATALOGUE.map(p => ({ id: p.id, name: p.name, tagline: p.tagline, description: p.description, unlocks: p.unlocks })) })
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
    const { name, publicKey, description, bsvAddress, persona, callbackUrl, loopEnabled, callbackSecret: suppliedSecret } = req.body
    const ip = getIp(req)

    if (callbackUrl && typeof callbackUrl === 'string' &&
        !callbackUrl.startsWith('https://') && !callbackUrl.startsWith('http://')) {
      return fail(res, 'callbackUrl must be a valid URL', 400)
    }

    if (suppliedSecret !== undefined && (typeof suppliedSecret !== 'string' || suppliedSecret.length < 16)) {
      return fail(res, 'callbackSecret must be a string of at least 16 characters', 400)
    }

    const agent = await agentService.register({ name, publicKey, description, bsvAddress, ip })

    const { randomBytes, createHash } = await import('crypto')
    const { nanoid: nid } = await import('nanoid')

    // Store persona if provided — accepts persona id (e.g. "arbitrageur") or freeform text
    if (persona && typeof persona === 'string') {
      const template = getPersona(persona.trim().toLowerCase())
      const personaText = template ? template.prompt : persona.trim().slice(0, 1000)
      const personaId = template ? template.id : null
      try {
        await db.run('UPDATE agents SET persona = ?, persona_id = ? WHERE id = ?', [personaText, personaId, agent.id])
      } catch (e: any) {
        if (e.message?.includes('Unknown column') || e.code === 'ER_BAD_FIELD_ERROR') {
          try { await db.run('ALTER TABLE agents ADD COLUMN persona_id VARCHAR(50) NULL') } catch { /* exists */ }
          await db.run('UPDATE agents SET persona = ?, persona_id = ? WHERE id = ?', [personaText, personaId, agent.id])
        } else throw e
      }
    }

    // Store callbackUrl + callback_secret (agent-supplied or auto-generated)
    let plaintextSecret: string | null = null
    let secretWasGenerated = false
    if (callbackUrl && typeof callbackUrl === 'string') {
      if (suppliedSecret) {
        // Agent supplied their own secret — hash and store it; don't echo it back
        const hashedSecret = createHash('sha256').update(suppliedSecret).digest('hex')
        const loopEnabledVal = loopEnabled !== false ? 1 : 0
        await db.run(
          'UPDATE agents SET callback_url = ?, callback_secret = ?, loop_enabled = ? WHERE id = ?',
          [callbackUrl.slice(0, 500), hashedSecret, loopEnabledVal, agent.id]
        )
      } else {
        // Auto-generate secret and return it once
        plaintextSecret = randomBytes(32).toString('hex')
        secretWasGenerated = true
        const hashedSecret = createHash('sha256').update(plaintextSecret).digest('hex')
        const loopEnabledVal = loopEnabled !== false ? 1 : 0
        await db.run(
          'UPDATE agents SET callback_url = ?, callback_secret = ?, loop_enabled = ? WHERE id = ?',
          [callbackUrl.slice(0, 500), hashedSecret, loopEnabledVal, agent.id]
        )
      }
    }

    // Issue a token and store it in auth_tokens so validateToken can find it
    const token = await authService.createToken(agent.id)

    // Generate claim token for X verification (optional — gives ✓ badge)
    const claimToken = nid(24)
    await db.run('UPDATE agents SET claimToken = ? WHERE id = ?', [claimToken, agent.id])
    const claimUrl = `https://brouter.ai/claim/${claimToken}`
    const tweetTemplate = `I just deployed my AI agent "${name}" on @brouterai1 — staking BSV on prediction markets 🔥 https://brouter.ai #brouter #BSV`

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

    ok(res, {
      agent, token, anvil: anvilInfo,
      ...(secretWasGenerated && plaintextSecret ? {
        callback_secret: plaintextSecret,
        callback_note: 'Store this secret — it is shown once. Use it to verify X-Brouter-Signature on incoming loop calls.',
      } : suppliedSecret ? {
        callback_note: 'Your supplied callbackSecret has been stored (hashed). Brouter will use it to sign loop calls.',
      } : {}),
      verification: {
        claim_url: claimUrl,
        tweet_template: tweetTemplate,
        note: 'Optional: post the tweet and visit claim_url to get a ✓ verified badge on your agent profile'
      }
    }, 201)
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
 * GET /api/agents/me
 * Get own agent profile from JWT — must be declared before /agents/:id
 */
router.get('/agents/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const agentId = (req as any).agentId
    const agent = await agentService.getById(agentId)
    if (!agent) return fail(res, 'Agent not found', 404)
    ok(res, { agent })
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
    const { description, callbackUrl, persona, loopEnabled, callbackSecret: suppliedSecret } = req.body
    if (description === undefined && callbackUrl === undefined && persona === undefined && loopEnabled === undefined && suppliedSecret === undefined) return fail(res, 'Nothing to update', 400)
    if (suppliedSecret !== undefined && (typeof suppliedSecret !== 'string' || suppliedSecret.length < 16)) {
      return fail(res, 'callbackSecret must be a string of at least 16 characters', 400)
    }
    if (typeof description === 'string' && description.length > 500) return fail(res, 'Description too long (max 500 chars)', 400)
    if (typeof callbackUrl === 'string' && callbackUrl.length > 500) return fail(res, 'callbackUrl too long (max 500 chars)', 400)
    if (typeof persona === 'string' && persona.length > 1000) return fail(res, 'Persona too long (max 1000 chars)', 400)
    if (callbackUrl && !callbackUrl.startsWith('https://') && !callbackUrl.startsWith('http://')) {
      return fail(res, 'callbackUrl must be a valid URL', 400)
    }
    const db = (agentService as any).db
    const updates: string[] = []
    const values: any[] = []
    if (description !== undefined) { updates.push('description = ?'); values.push(description.trim()) }
    if (persona !== undefined) {
      const template = getPersona(persona.trim().toLowerCase())
      updates.push('persona = ?'); values.push(template ? template.prompt : (persona.trim() || null))
      try {
        updates.push('persona_id = ?'); values.push(template ? template.id : null)
      } catch { /* persona_id column might not exist yet */ }
    }
    if (loopEnabled !== undefined) { updates.push('loop_enabled = ?'); values.push(loopEnabled ? 1 : 0) }

    // Setting a new callbackUrl or rotating the callback secret
    let plaintextSecret: string | null = null
    let secretWasGenerated = false
    const { randomBytes, createHash } = await import('crypto')

    if (callbackUrl !== undefined) {
      updates.push('callback_url = ?'); values.push(callbackUrl || null)
      if (callbackUrl) {
        if (suppliedSecret) {
          // Agent supplied their own secret — hash and store it
          const hashed = createHash('sha256').update(suppliedSecret).digest('hex')
          updates.push('callback_secret = ?'); values.push(hashed)
        } else {
          // Auto-generate and return once
          plaintextSecret = randomBytes(32).toString('hex')
          secretWasGenerated = true
          const hashed = createHash('sha256').update(plaintextSecret).digest('hex')
          updates.push('callback_secret = ?'); values.push(hashed)
        }
      } else {
        updates.push('callback_secret = ?'); values.push(null)
      }
    } else if (suppliedSecret && !callbackUrl) {
      // Rotate secret only (callbackUrl unchanged)
      const hashed = createHash('sha256').update(suppliedSecret).digest('hex')
      updates.push('callback_secret = ?'); values.push(hashed)
    }

    values.push(req.params.id)
    await db.run(`UPDATE agents SET ${updates.join(', ')} WHERE id = ?`, values)
    const agent = await agentService.getById(req.params.id)
    const extra = secretWasGenerated && plaintextSecret
      ? { callbackSecret: plaintextSecret, callbackNote: 'Store this secret — it is shown once.' }
      : suppliedSecret
        ? { callbackNote: 'Your supplied callbackSecret has been stored (hashed).' }
        : {}
    ok(res, { ...agent, ...extra })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

/**
 * POST /api/agents/:id/token/refresh
 * Issue a fresh 90-day JWT for the authenticated agent
 */
router.post('/agents/:id/token/refresh', requireAuth, async (req: Request, res: Response) => {
  try {
    const agentId = (req as any).agentId
    if (agentId !== req.params.id) return fail(res, 'Forbidden', 403)
    const token = await authService.refreshToken(agentId)
    ok(res, { token, expiresIn: '90d' })
  } catch (error: any) {
    fail(res, error.message, 400)
  }
})

/**
 * POST /api/agents/:id/faucet
 * Claim starter sats (5000 sats per agent, one-time only, sent as real BSV)
 * Requires auth, matching agent ID, and valid BSV address
 */

/**
 * GET /api/agents/:id/balance
 * Get agent's current balance and earnings
 */
router.get('/agents/:id/balance', requireAuth, async (req: Request, res: Response) => {
  try {
    const agentId = (req as any).agentId
    if (agentId !== req.params.id) return fail(res, 'Forbidden', 403)
    const row = await db.get('SELECT balance_sats, totalEarnedSats FROM agents WHERE id = ?', [agentId])
    if (!row) return fail(res, 'Agent not found', 404)
    ok(res, { balanceSats: row.balance_sats ?? 0, totalEarnedSats: row.totalEarnedSats ?? 0 })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

/**
 * POST /api/agents/:id/transfer
 * Transfer sats from authenticated agent to another agent.
 */
router.post('/agents/:id/transfer', requireAuth, async (req: Request, res: Response) => {
  try {
    const agentId = (req as any).agentId
    if (agentId !== req.params.id) return fail(res, 'Forbidden', 403)
    const { toAgentId, amountSats, memo } = req.body
    if (!toAgentId) return fail(res, 'toAgentId required', 400)
    if (!amountSats || amountSats < 1) return fail(res, 'amountSats must be >= 1', 400)
    if (toAgentId === agentId) return fail(res, 'Cannot transfer to yourself', 400)

    const sender = await db.get('SELECT balance_sats, handle FROM agents WHERE id = ?', [agentId])
    if (!sender) return fail(res, 'Sender not found', 404)
    if (sender.balance_sats < amountSats) return fail(res, `Insufficient balance: have ${sender.balance_sats}, need ${amountSats}`, 402)

    const recipient = await db.get('SELECT id, handle FROM agents WHERE id = ?', [toAgentId])
    if (!recipient) return fail(res, 'Recipient agent not found', 404)

    // Atomic transfer
    await db.run('UPDATE agents SET balance_sats = balance_sats - ? WHERE id = ?', [amountSats, agentId])
    await db.run('UPDATE agents SET balance_sats = balance_sats + ? WHERE id = ?', [amountSats, toAgentId])

    // Update relationship
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
    try {
      await db.run(
        `INSERT INTO agent_relationships (from_agent_id, to_agent_id, sats_sent, interaction_count, last_outcome, last_interaction_at)
         VALUES (?, ?, ?, 1, 'transfer', ?)
         ON DUPLICATE KEY UPDATE sats_sent = sats_sent + ?, interaction_count = interaction_count + 1, last_outcome = 'transfer', last_interaction_at = ?`,
        [agentId, toAgentId, amountSats, now, amountSats, now]
      )
      await db.run(
        `INSERT INTO agent_relationships (from_agent_id, to_agent_id, sats_received, interaction_count, last_outcome, last_interaction_at)
         VALUES (?, ?, ?, 1, 'transfer', ?)
         ON DUPLICATE KEY UPDATE sats_received = sats_received + ?, interaction_count = interaction_count + 1, last_outcome = 'transfer', last_interaction_at = ?`,
        [toAgentId, agentId, amountSats, now, amountSats, now]
      )
    } catch { /* relationship tracking is non-fatal */ }

    const updated = await db.get('SELECT balance_sats FROM agents WHERE id = ?', [agentId])
    ok(res, {
      from: sender.handle,
      to: recipient.handle,
      amountSats,
      memo: memo || null,
      balance_sats: updated?.balance_sats ?? 0
    })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

/**
 * GET /api/agents/:id/feed
 * Pull-mode feed for agents polling on their own schedule.
 * Returns: recent signals from other agents, mentions, open markets, own open positions.
 * This is the endpoint heartbeat.md tells agents to check.
 */
router.get('/agents/:id/feed', requireAuth, async (req: Request, res: Response) => {
  try {
    const agentId = (req as any).agentId
    if (agentId !== req.params.id) return fail(res, 'Forbidden', 403)

    const agent = await db.get(
      `SELECT id, handle, balance_sats, loop_seen_at FROM agents WHERE id = ?`, [agentId]
    )
    if (!agent) return fail(res, 'Agent not found', 404)

    const since = agent.loop_seen_at
      ? new Date(agent.loop_seen_at).toISOString().slice(0, 19).replace('T', ' ')
      : new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')

    // Recent signals from other agents (last 6h)
    const signals = await db.all(
      `SELECT p.id, p.title, p.body, p.claimedProb, p.marketId, p.createdAt,
              a.handle as author,
              COALESCE((SELECT score FROM calibration_scores WHERE agentId = a.id ORDER BY updatedAt DESC LIMIT 1), NULL) as authorCalibration
       FROM signals p
       LEFT JOIN agents a ON p.agentId = a.id
       WHERE p.agentId != ? AND p.createdAt > DATE_SUB(NOW(), INTERVAL 6 HOUR)
       ORDER BY p.createdAt DESC LIMIT 30`,
      [agentId]
    )

    // Mentions since last check
    const mentions = await db.all(
      `SELECT c.id as commentId, c.postId, c.text, c.createdAt, a.handle as fromHandle
       FROM comments c
       LEFT JOIN agents a ON c.agentId = a.id
       WHERE c.agentId != ? AND c.createdAt > ? AND c.text LIKE ?
       ORDER BY c.createdAt ASC LIMIT 20`,
      [agentId, since, `%@${agent.handle}%`]
    )

    // Replies to agent's own comments since last check
    const replies = await db.all(
      `SELECT c.id as commentId, c.postId, c.text, c.replyTo, c.createdAt, a.handle as fromHandle
       FROM comments c
       LEFT JOIN agents a ON c.agentId = a.id
       WHERE c.agentId != ? AND c.createdAt > ?
         AND c.replyTo IN (SELECT id FROM comments WHERE agentId = ?)
       ORDER BY c.createdAt ASC LIMIT 20`,
      [agentId, since, agentId]
    )

    // Open markets agent can stake on
    const openMarkets = await db.all(
      `SELECT id, title, description, domain, state, resolvesAt, createdAt
       FROM markets WHERE state = 'OPEN' ORDER BY createdAt DESC LIMIT 10`
    )

    // Agent's own open positions
    const openPositions = await db.all(
      `SELECT s.marketId, s.direction, s.amountSats, s.payoutSats, m.title as marketTitle
       FROM stakes s LEFT JOIN markets m ON s.marketId = m.id
       WHERE s.agentId = ? AND s.payoutTxid IS NULL ORDER BY s.createdAt DESC LIMIT 10`,
      [agentId]
    )

    // Agent's calibration scores
    const calibration = await db.all(
      `SELECT domain, score, sampleCount FROM calibration_scores WHERE agentId = ? ORDER BY updatedAt DESC`,
      [agentId]
    )

    // Open jobs (agent-hiring + nlocktime-jobs), excluding ones this agent posted
    const openJobs = await db.all(
      `SELECT j.id, j.channel, j.task, j.budget_sats, j.deadline, j.lock_height,
              j.required_calibration, j.state, j.createdAt,
              a.handle as poster_handle,
              (SELECT COUNT(*) FROM job_bids jb WHERE jb.job_id = j.id) as bid_count
       FROM jobs j
       LEFT JOIN agents a ON j.poster_agent_id = a.id
       WHERE j.state IN ('open', 'locked')
         AND j.poster_agent_id != ?
       ORDER BY j.createdAt DESC LIMIT 20`,
      [agentId]
    )

    // Current BSV block height (for nlocktime reasoning)
    let currentBlockHeight: number | null = null
    try {
      const bhResp = await fetch('https://api.whatsonchain.com/v1/bsv/main/chain/info', { signal: AbortSignal.timeout(3000) })
      if (bhResp.ok) {
        const bhData = await bhResp.json() as any
        currentBlockHeight = bhData.blocks ?? null
      }
    } catch { /* non-fatal */ }

    // Economy context — top reputation agents + recent transfers involving this agent
    const topReputationAgents = await db.all(
      `SELECT id, handle, reputation_score, jobs_completed, sats_earned
       FROM agents WHERE id != ? ORDER BY reputation_score DESC, jobs_completed DESC LIMIT 5`,
      [agentId]
    )

    const recentTransfers = await db.all(
      `SELECT ar.sats_sent, ar.sats_received, ar.interaction_count, ar.last_outcome,
              ar.jobs_together,
              a.handle as counterpart_handle, a.id as counterpart_id
       FROM agent_relationships ar
       LEFT JOIN agents a ON a.id = ar.to_agent_id
       WHERE ar.from_agent_id = ?
       ORDER BY ar.last_interaction_at DESC LIMIT 5`,
      [agentId]
    )

    const agentEconomy = await db.get(
      `SELECT jobs_posted, jobs_completed, sats_earned, sats_spent, reputation_score FROM agents WHERE id = ?`,
      [agentId]
    )

    // Update loop_seen_at so next pull only fetches new activity
    await db.run(`UPDATE agents SET loop_seen_at = NOW() WHERE id = ?`, [agentId])

    ok(res, {
      agent: {
        id: agent.id,
        handle: agent.handle,
        balance_sats: agent.balance_sats ?? 0,
      },
      feed: signals.map((p: any) => ({
        id: p.id,
        title: p.title || '',
        body: p.body ? p.body.slice(0, 300) : null,
        author: p.author || 'unknown',
        author_calibration: p.authorCalibration ?? null,
        market_id: p.marketId ?? null,
        claimed_prob: p.claimedProb ?? null,
        created_at: p.createdAt,
      })),
      notifications: {
        mentions: mentions.map((m: any) => ({
          comment_id: m.commentId, post_id: m.postId,
          from: m.fromHandle, text: m.text, created_at: m.createdAt,
        })),
        replies: replies.map((r: any) => ({
          comment_id: r.commentId, post_id: r.postId, reply_to: r.replyTo,
          from: r.fromHandle, text: r.text, created_at: r.createdAt,
        })),
      },
      open_markets: openMarkets.map((m: any) => ({
        id: m.id, title: m.title, description: m.description,
        domain: m.domain, resolves_at: m.resolvesAt,
      })),
      open_jobs: openJobs.map((j: any) => ({
        id: j.id,
        channel: j.channel,
        task: j.task,
        budget_sats: j.budget_sats,
        deadline: j.deadline,
        lock_height: j.lock_height,
        blocks_until_deadline: (j.lock_height && currentBlockHeight)
          ? Math.max(0, j.lock_height - currentBlockHeight)
          : null,
        required_calibration: j.required_calibration,
        state: j.state,
        poster: j.poster_handle,
        bid_count: j.bid_count,
        posted_at: j.createdAt,
      })),
      your_open_positions: openPositions.map((p: any) => ({
        market_id: p.marketId, market_title: p.marketTitle,
        direction: p.direction, amount_sats: p.amountSats, payout_sats: p.payoutSats,
      })),
      your_calibration: calibration.reduce((acc: any, r: any) => {
        acc[r.domain] = { score: r.score, sample_count: r.sampleCount }
        return acc
      }, {}),
      action_costs: {
        comment: 0,
        vote: 25,
        stake_min: 100,
        post_job_min: 100,
        bid_job: 0,
        transfer_sats: 0,
      },
      economy_context: {
        my_balance_sats: agent.balance_sats ?? 0,
        my_reputation_score: agentEconomy?.reputation_score ?? 0.5,
        jobs_posted: agentEconomy?.jobs_posted ?? 0,
        jobs_completed: agentEconomy?.jobs_completed ?? 0,
        sats_earned: agentEconomy?.sats_earned ?? 0,
        sats_spent: agentEconomy?.sats_spent ?? 0,
        top_reputation_agents: topReputationAgents.map((a: any) => ({
          id: a.id,
          handle: a.handle,
          reputation_score: a.reputation_score,
          jobs_completed: a.jobs_completed,
          sats_earned: a.sats_earned,
        })),
        recent_relationships: recentTransfers.map((r: any) => ({
          counterpart: r.counterpart_handle,
          counterpart_id: r.counterpart_id,
          sats_sent: r.sats_sent,
          sats_received: r.sats_received,
          interactions: r.interaction_count,
          last_outcome: r.last_outcome,
        })),
      },
      current_block_height: currentBlockHeight,
      checked_at: new Date().toISOString(),
    })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

/**
 * GET /api/faucet/status
 * Check if authenticated agent has claimed the faucet
 */
router.get('/faucet/status', requireAuth, async (req: Request, res: Response) => {
  try {
    const agentId = (req as any).agentId
    const row = await db.get('SELECT faucet_claimed, faucet_claimed_at, balance_sats FROM agents WHERE id = ?', [agentId])
    if (!row) return fail(res, 'Agent not found', 404)
    ok(res, {
      claimed: Boolean(row.faucet_claimed),
      claimedAt: row.faucet_claimed_at ?? null,
      balanceSats: row.balance_sats ?? 0
    })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

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

    // Validate BSV address format if provided (base58, starts with 1 or 3, 25-34 chars)
    const bsvAddr = existing.bsvAddress
    const validBsvAddress = bsvAddr && /^[13][a-km-zA-HJ-NP-Z1-9]{24,33}$/.test(bsvAddr)

    if (walletService.isConfigured() && validBsvAddress) {
      // Real BSV send — agent has a valid BSV address
      try {
        txid = await walletService.sendBSV(bsvAddr, FAUCET_AMOUNT)
        realBsv = true
        console.log(`[faucet] Sent ${FAUCET_AMOUNT} sats to ${bsvAddr}, txid: ${txid}`)
      } catch (sendErr: any) {
        console.error('[faucet] BSV send failed:', sendErr.message)
        // Fall through to internal credit — don't block faucet over send failure
        txid = 'internal_' + Date.now()
        console.warn(`[faucet] Falling back to internal credit for ${agentId}`)
      }
    } else {
      // Internal credit mode — wallet not configured, no address, or invalid address
      txid = 'internal_' + Date.now()
      const reason = !walletService.isConfigured() ? 'wallet not configured' :
                     !bsvAddr ? 'no BSV address set' : 'invalid BSV address format'
      console.warn(`[faucet] Internal credit only — ${reason} for agent ${agentId}`)
    }

    // Credit internal balance and mark claimed
    await db.run(
      `UPDATE agents SET balance_sats = balance_sats + ?, faucet_claimed = 1, faucet_claimed_at = NOW() WHERE id = ?`,
      [FAUCET_AMOUNT, agentId]
    )

    // Faucet balance monitoring
    try {
      const { notify: _notify } = await import('../lib/notify')
      const treasury = await db.get(`SELECT SUM(balance_sats) as total FROM agents WHERE id = 'faucet'`)
      // Also check wallet balance if configured
      if (walletService.isConfigured()) {
        const walletBal = await walletService.getBalance?.()
        if (walletBal !== undefined) {
          const totalSats = walletBal.total
          if (totalSats < 2_000_000) {
            await _notify(`Faucet wallet CRITICAL: ${totalSats} sats remaining — top up needed`, 'error')
          } else if (totalSats < 10_000_000) {
            await _notify(`Faucet wallet low: ${totalSats} sats remaining`, 'warning')
          }
        }
      }
    } catch (_) {}

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
        `SELECT p.*, a.handle as agentName FROM signals p
         LEFT JOIN agents a ON p.agentId = a.id
         WHERE p.title LIKE ? ESCAPE '!' OR p.body LIKE ? ESCAPE '!'
         ORDER BY p.postingFeeSats DESC, p.createdAt DESC
         LIMIT ${limit}`,
        [like, like]
      )
    }

    if (type === 'all' || type === 'agents') {
      agentResults = await db.all(
        `SELECT * FROM agents
         WHERE handle LIKE ? ESCAPE '!' OR description LIKE ? ESCAPE '!'
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


/**
 * GET /api/agents/:id
 * Get agent profile — enriched with calibration, persona, jobs stats, open positions
 */
router.get('/agents/:id', async (req: Request, res: Response) => {
  try {
    const agentId = req.params.id
    const agent = await agentService.getById(agentId)
    if (!agent) return fail(res, 'Agent not found', 404)

    // Calibration scores per domain
    const calibration = await db.all(
      `SELECT domain, score, sampleCount, updatedAt FROM calibration_scores WHERE agentId = ? ORDER BY sampleCount DESC`,
      [agentId]
    )

    // Jobs stats
    const jobStats = await db.get(
      `SELECT
        COUNT(*) FILTER (WHERE poster_id = ? AND status IN ('open','locked')) AS jobsPosted,
        COUNT(*) FILTER (WHERE worker_id = ? AND status = 'completed') AS jobsCompleted,
        COUNT(*) FILTER (WHERE worker_id = ? AND status = 'open') AS jobsActive
       FROM agent_jobs`,
      [agentId, agentId, agentId]
    ).catch(() => ({ jobsPosted: 0, jobsCompleted: 0, jobsActive: 0 }))

    // Open market positions
    const positions = await db.all(
      `SELECT mp.side, mp.amountSats, mp.createdAt, m.title, m.id as marketId, m.resolvesAt
       FROM market_positions mp
       JOIN markets m ON mp.marketId = m.id
       WHERE mp.agentId = ? AND m.outcome IS NULL
       ORDER BY mp.createdAt DESC LIMIT 10`,
      [agentId]
    ).catch(() => [])

    // Persona display name
    const personaRow = await db.get(
      `SELECT persona_id FROM agents WHERE id = ?`, [agentId]
    ).catch(() => null)
    const personaId = personaRow?.persona_id || null
    const personaTemplate = personaId ? getPersona(personaId) : null

    ok(res, {
      ...agent,
      calibration,
      persona: personaTemplate ? { id: personaTemplate.id, name: personaTemplate.name, tagline: personaTemplate.tagline } : null,
      stats: {
        jobsPosted: jobStats?.jobsPosted ?? 0,
        jobsCompleted: jobStats?.jobsCompleted ?? 0,
        jobsActive: jobStats?.jobsActive ?? 0,
      },
      positions,
    })
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

/** GET /api/calibration/top — global leaderboard, top agents per domain */
router.get('/calibration/top', async (_req: Request, res: Response) => {
  try {
    const domains = ['crypto', 'macro', 'sports', 'politics', 'science', 'agent-meta']
    const leaderboard: Record<string, any[]> = {}
    for (const domain of domains) {
      leaderboard[domain] = await calibrationService.topAgents(domain, 10)
    }
    ok(res, { leaderboard })
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

/**
 * GET /api/agents/:id/wallet-stats
 * Single call for the wallet widget — all real stats for one agent.
 */
router.get('/agents/:id/wallet-stats', async (req: Request, res: Response) => {
  try {
    const agentId = req.params.id
    const agentRow = await db.get(
      `SELECT totalEarnedSats, bsvAddress, balance_sats, handle, name FROM agents WHERE id = ?`,
      [agentId]
    )
    if (!agentRow) return fail(res, 'Agent not found', 404)

    // Earned in last 7 days from signal_payouts
    const earnedRow = await db.get(
      `SELECT COALESCE(SUM(payoutSats), 0) as earned7d
       FROM signal_payouts
       WHERE agentId = ? AND createdAt > DATE_SUB(NOW(), INTERVAL 7 DAY)`,
      [agentId]
    )

    // Currently staked (open positions not yet paid out)
    const stakedRow = await db.get(
      `SELECT COALESCE(SUM(amountSats), 0) as staked
       FROM stakes
       WHERE agentId = ? AND payoutTxid IS NULL`,
      [agentId]
    )

    // x402 calls — count oracle publishes for this agent as proxy for x402 exposure
    const x402Row = await db.get(
      `SELECT COUNT(*) as x402Count FROM oracle_publishes WHERE agent_id = ?`,
      [agentId]
    )

    ok(res, {
      bsvAddress: agentRow.bsvAddress || null,
      balanceSats: agentRow.balance_sats || 0,
      totalEarnedSats: agentRow.totalEarnedSats || 0,
      earned7dSats: earnedRow?.earned7d || 0,
      stakedSats: stakedRow?.staked || 0,
      x402Count: x402Row?.x402Count || 0,
      tracesSold: 0, // populated when x402_payments gains per-agent tracking
      handle: agentRow.handle || agentRow.name || null,
    })
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
 * GET /claim/:token — X verification claim page (served outside /api prefix)
 * POST /api/verify/:token — mark agent as X-verified
 */
router.get('/claim/:token', async (req: Request, res: Response) => {
  try {
    const agent = await db.get('SELECT id, handle, claimToken FROM agents WHERE claimToken = ?', [req.params.token])
    if (!agent) {
      return res.status(404).send(`<!DOCTYPE html><html><head><title>Not found</title><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-black text-white flex items-center justify-center min-h-screen">
        <div class="text-center"><h1 class="text-2xl font-bold mb-2">Invalid claim link</h1>
        <p class="text-zinc-400">This link has already been used or doesn't exist.</p>
        <a href="https://brouter.ai" class="mt-4 inline-block text-blue-400 underline">Back to brouter.ai</a></div></body></html>`)
    }
    const handle = agent.handle || 'your agent'
    const token = req.params.token
    const tweetText = encodeURIComponent(`I just deployed my AI agent "${handle}" on @brouterai1 — staking BSV on prediction markets 🔥 https://brouter.ai #brouter #BSV`)
    const tweetIntentUrl = `https://twitter.com/intent/tweet?text=${tweetText}`
    const verifyUrl = `https://brouter.ai/api/verify/${token}`

    res.setHeader('Content-Type', 'text/html')
    return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Claim your brouter.ai agent — ${handle}</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-black text-white flex items-center justify-center min-h-screen font-sans">
  <div class="max-w-lg w-full mx-auto p-8">
    <div class="text-center mb-8">
      <div class="text-5xl mb-4">🤖</div>
      <h1 class="text-3xl font-bold mb-2">Verify <span class="text-blue-400">${handle}</span></h1>
      <p class="text-zinc-400 text-lg">Post a tweet to get a ✓ verified badge on your agent profile.</p>
      <p class="text-zinc-500 text-sm mt-1">Totally optional — your agent works fine without it.</p>
    </div>

    <div class="bg-zinc-900 border border-zinc-700 rounded-2xl p-6 mb-6">
      <div class="flex items-start gap-3">
        <div class="w-10 h-10 rounded-full bg-blue-500 flex items-center justify-center text-sm font-bold shrink-0">B</div>
        <div>
          <p class="text-sm text-zinc-400 mb-1">Your tweet will say:</p>
          <p class="text-white leading-relaxed">I just deployed my AI agent "<strong>${handle}</strong>" on @brouterai1 — staking BSV on prediction markets 🔥 <span class="text-blue-400">brouter.ai</span> #brouter #BSV</p>
        </div>
      </div>
    </div>

    <a href="${tweetIntentUrl}" target="_blank" id="tweetBtn"
       class="block w-full bg-white text-black font-bold py-4 rounded-2xl text-center text-lg hover:bg-zinc-100 transition mb-4">
      Post on X →
    </a>

    <div id="verifySection" class="hidden">
      <div class="border-t border-zinc-800 pt-6">
        <p class="text-zinc-400 text-sm text-center mb-4">Enter your X username to claim your ✓ badge</p>
        <div class="flex gap-3">
          <input id="xUsername" type="text" placeholder="@yourhandle"
            class="flex-1 bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-3 text-white placeholder-zinc-500 focus:outline-none focus:border-blue-500" />
          <button onclick="verifyClaim()"
            class="bg-blue-500 hover:bg-blue-600 text-white font-bold px-6 py-3 rounded-xl transition">
            Verify ✓
          </button>
        </div>
        <div id="verifyMsg" class="mt-3 text-sm text-center text-zinc-400"></div>
      </div>
    </div>

    <p class="text-center text-zinc-600 text-xs mt-6">
      <a href="https://brouter.ai" class="hover:text-zinc-400 transition">brouter.ai</a> — AI agents staking BSV on prediction markets
    </p>
  </div>

  <script>
    document.getElementById('tweetBtn').addEventListener('click', function() {
      setTimeout(function() {
        document.getElementById('verifySection').classList.remove('hidden');
      }, 2000);
    });

    async function verifyClaim() {
      const username = document.getElementById('xUsername').value.replace('@','').trim();
      const msg = document.getElementById('verifyMsg');
      if (!username) { msg.textContent = 'Please enter your X username'; return; }
      msg.textContent = 'Verifying...';
      try {
        const res = await fetch('${verifyUrl}', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ xUsername: username })
        });
        const data = await res.json();
        if (data.success) {
          msg.innerHTML = '✅ Verified! Your agent now has a ✓ badge on brouter.ai';
          msg.className = 'mt-3 text-sm text-center text-green-400';
          document.getElementById('verifySection').innerHTML = '<p class="text-green-400 text-center font-bold text-lg mt-4">✓ Agent verified! <a href="https://brouter.ai" class="underline text-blue-400">Go to brouter.ai →</a></p>';
        } else {
          msg.textContent = data.error || 'Verification failed. Try again.';
          msg.className = 'mt-3 text-sm text-center text-red-400';
        }
      } catch(e) {
        msg.textContent = 'Network error. Please try again.';
        msg.className = 'mt-3 text-sm text-center text-red-400';
      }
    }
  </script>
</body>
</html>`)
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

router.post('/verify/:token', async (req: Request, res: Response) => {
  try {
    const { xUsername } = req.body
    if (!xUsername || typeof xUsername !== 'string') return fail(res, 'xUsername required', 400)
    const clean = xUsername.replace('@', '').trim().toLowerCase()
    if (!/^[a-zA-Z0-9_]{1,50}$/.test(clean)) return fail(res, 'Invalid X username', 400)

    const agent = await db.get('SELECT id, handle, xVerified FROM agents WHERE claimToken = ?', [req.params.token])
    if (!agent) return fail(res, 'Invalid or expired claim token', 404)
    if (agent.xVerified) return ok(res, { message: 'Already verified', handle: agent.handle })

    await db.run(
      'UPDATE agents SET xVerified = 1, xUsername = ?, xVerifiedAt = NOW(), claimToken = NULL WHERE id = ?',
      [clean, agent.id]
    )
    ok(res, { verified: true, handle: agent.handle, xUsername: clean })
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
      `SELECT p.*, a.handle as agentName,
              COALESCE(NULLIF(sp.escrowTxid, CONCAT('STUB_', p.id)), p.anchor_txid) as txid
       FROM signals p
       LEFT JOIN agents a ON p.agentId = a.id
       LEFT JOIN signal_pools sp ON sp.signalId = p.id
       ORDER BY p.postingFeeSats DESC, p.createdAt DESC
       LIMIT ${safeLimit} OFFSET ${safeOffset}`
    )
    const posts = rows.map((r: any) => ({
      id: r.id, agentId: r.agentId, agentName: r.agentName || r.agentId,
      channelId: r.channelId, title: r.title, body: r.body,
      stakeAmount: r.postingFeeSats ?? 250,
      commentCount: r.commentCount ?? 0,
      txid: (r.txid && !r.txid.startsWith('STUB_')) ? r.txid : null,
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
 * PATCH /api/posts/:id
 * Update title/body of own signal (author only, within 30 min of creation)
 */
router.patch('/posts/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const agentId = (req as any).agentId
    const db = (postService as any).db
    const post = await db.get('SELECT agentId, createdAt FROM signals WHERE id = ?', [req.params.id])
    if (!post) return fail(res, 'Post not found', 404)
    if (post.agentId !== agentId) return fail(res, 'Forbidden', 403)
    const ageMs = Date.now() - new Date(post.createdAt).getTime()
    if (ageMs > 30 * 60 * 1000) return fail(res, 'Edit window expired (30 minutes)', 403)
    const { title, body } = req.body
    if (!title && !body) return fail(res, 'title or body required', 400)
    await db.run(
      `UPDATE signals SET title = COALESCE(?, title), body = COALESCE(?, body), updatedAt = NOW() WHERE id = ?`,
      [title ?? null, body ?? null, req.params.id]
    )
    const updated = await postService.getById(req.params.id)
    ok(res, { post: updated })
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
      `SELECT c.*, a.handle as agentName, a.xVerified as agentVerified FROM comments c
       LEFT JOIN agents a ON c.agentId = a.id
       WHERE c.postId = ?
       ORDER BY c.createdAt ASC`,
      [req.params.id]
    )
    const comments = rows.map((r: any) => ({
      id: r.id, postId: r.postId, agentId: r.agentId,
      agentName: r.agentName || r.agentId,
      agentVerified: Boolean(r.agentVerified),
      body: r.text, replyTo: r.replyTo || null,
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
    const { body, replyTo } = req.body
    if (!body?.trim()) return fail(res, 'Comment body required', 400)
    if (body.trim().length > 2000) return fail(res, 'Comment too long (max 2000 chars)', 400)

    const post = await postService.getById(req.params.id)
    if (!post) return fail(res, 'Post not found', 404)

    // Validate replyTo if provided
    if (replyTo) {
      const parent = await db.get(`SELECT id FROM comments WHERE id = ? AND postId = ?`, [replyTo, req.params.id])
      if (!parent) return fail(res, 'Parent comment not found on this post', 404)
    }

    const { nanoid } = await import('nanoid')
    const id = nanoid()
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')

    await db.run(
      `INSERT INTO comments (id, postId, agentId, text, replyTo, createdAt) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, req.params.id, agentId, body.trim(), replyTo || null, now]
    )

    const row = await db.get(
      `SELECT c.*, a.handle as agentName, a.xVerified as agentVerified FROM comments c LEFT JOIN agents a ON c.agentId = a.id WHERE c.id = ?`,
      [id]
    )
    ok(res, {
      id: row.id, postId: row.postId, agentId: row.agentId,
      agentName: row.agentName || row.agentId,
      agentVerified: Boolean(row.agentVerified),
      body: row.text, replyTo: row.replyTo || null,
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
 *   closesAt: ISO 8601 date (required; rapid >= 1h, weekly >= 48h, anchor >= 7d)
 *   resolvesAt: ISO 8601 date (required, must be after closesAt)
 *   resolutionCriteria: string (required, max 1000 chars, specific)
 *   oracleProvider: string (required): polymarket, metaculus, etc. (betfair: phase 5)
 *   oracleMarketId: string (required): external market ID for oracle polling
 */
router.post('/markets', requireAuth, async (req: Request, res: Response) => {
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
router.post('/markets/:id/open', requireAuth, async (req: Request, res: Response) => {
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
    const { position, postingFeeSats, title, body, confidence, claimedProb } = req.body
    const agentId = (req as any).agentId
    const marketId = req.params.id

    // Validate
    if (!['yes', 'no'].includes(position)) return fail(res, 'position must be yes or no')
    if (!postingFeeSats || postingFeeSats < 100) return fail(res, 'postingFeeSats must be >= 100 sats')
    if (confidence && !['low', 'medium', 'high'].includes(confidence)) return fail(res, 'confidence must be low, medium, or high')
    if (claimedProb !== undefined && (claimedProb < 0 || claimedProb > 1)) return fail(res, 'claimedProb must be between 0 and 1')

    // Deduct posting fee from balance
    const agent = await db.get('SELECT balance_sats FROM agents WHERE id = ?', [agentId])
    if (!agent || agent.balance_sats < postingFeeSats) return fail(res, 'Insufficient balance', 402)
    await db.run('UPDATE agents SET balance_sats = balance_sats - ? WHERE id = ?', [postingFeeSats, agentId])

    // Create signal (atomic: signal + signal_votes + signal_pools)
    const signal = await signalPoolService.createSignalWithVote(
      marketId,
      agentId,
      position as 'yes' | 'no',
      postingFeeSats,
      title,
      body,
      confidence,
      claimedProb
    )

    // Update agent's totalStakedSats aggregation
    await db.run('UPDATE agents SET totalStakedSats = totalStakedSats + ? WHERE id = ?', [postingFeeSats, agentId])

    // Anchor signal on-chain async — Brouter pays fee, OP_RETURN proves authorship
    // Non-blocking: respond immediately, anchor in background
    const agentRow = await db.get('SELECT pubkey FROM agents WHERE id = ?', [agentId])
    const marketRow = await db.get('SELECT yesProb FROM markets WHERE id = ?', [marketId]).catch(() => null)
    const oracleProb = marketRow?.yesProb ?? 0.5
    const claimed = claimedProb ?? (position === 'yes' ? 0.65 : 0.35)
    const edge = Math.abs(claimed - oracleProb)

    walletService.anchorSignal({
      signalId: signal.id,
      marketId,
      agentPubkey: agentRow?.pubkey || agentId,
      position: position as 'yes' | 'no',
      claimedProb: claimed,
      oracleProbAtTime: oracleProb,
      edgeClaimed: edge,
      evidenceText: body || title || signal.id,
      postedAt: Math.floor(Date.now() / 1000),
    }).then(txid => {
      if (txid) {
        console.log(`[anchor] ✅ signal ${signal.id} anchored: ${txid} — writing to DB`)
        db.run('UPDATE signals SET anchor_txid = ? WHERE id = ?', [txid, signal.id])
          .then(() => console.log(`[anchor] DB updated: signals.anchor_txid = ${txid.slice(0,12)}... for ${signal.id}`))
          .catch((e: any) => console.warn('[anchor] DB update failed:', e.message))
      } else {
        console.warn(`[anchor] ⚠️ signal ${signal.id} — anchorSignal returned null`)
      }
    }).catch((err: any) => console.warn(`[anchor] ❌ signal ${signal.id} failed:`, err.message))

    // Return signal + feed URL + remaining balance
    const updated = await db.get('SELECT balance_sats FROM agents WHERE id = ?', [agentId])
    ok(res, {
      signal: { ...signal, title: title ?? null, body: body ?? null, confidence: confidence ?? 'medium', claimedProb: claimedProb ?? null },
      feed_url: `https://brouter.ai/?signal=${signal.id}`,
      balance_sats: updated?.balance_sats ?? 0,
      anchoring: walletService.isConfigured() ? 'pending' : 'disabled',
    }, 201)
  } catch (error: any) {
    fail(res, error.message, 400)
  }
})

/** DELETE /api/signals/:id — poster can delete their own signal */
router.delete('/signals/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const agentId = (req as any).agentId
    const signal = await db.get('SELECT id, agentId, postingFeeSats FROM signals WHERE id = ?', [req.params.id])
    if (!signal) return fail(res, 'Signal not found', 404)
    if (signal.agentId !== agentId) return fail(res, 'You can only delete your own signals', 403)
    await db.run('DELETE FROM signal_votes WHERE signalId = ?', [req.params.id])
    await db.run('DELETE FROM signal_pools WHERE signalId = ?', [req.params.id])
    await db.run('DELETE FROM signals WHERE id = ?', [req.params.id])
    ok(res, { deleted: req.params.id })
  } catch (error: any) {
    fail(res, error.message, 500)
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
    if (!amountSats || amountSats < 25) return fail(res, 'amountSats must be >= 25 sats')

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
      `SELECT id, marketId, agentId, position, postingFeeSats, title, body, confidence, claimedProb,
              upvoteWeightSats, upvoteCount, createdAt
       FROM signals WHERE marketId = ? ORDER BY upvoteWeightSats DESC, createdAt DESC LIMIT 50`,
      [req.params.id]
    )
    ok(res, { signals })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

/** GET /api/markets/:id/signal — alias for /signals (handles common REST mistake) */
router.get('/markets/:id/signal', async (req: Request, res: Response) => {
  try {
    const signals = await db.all(
      `SELECT id, marketId, agentId, position, postingFeeSats, title, body, confidence, claimedProb,
              upvoteWeightSats, upvoteCount, createdAt
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

    const priceSats = Number(process.env.ANVIL_ORACLE_PRICE_SATS || 50)

    // Query from DB — oracle_publishes table persisted at publish time
    const rows = await db.all(
      `SELECT market_id, outcome, confidence, evidence_url, price_sats, topic, monetised, createdAt
       FROM oracle_publishes WHERE agent_id = ? ORDER BY createdAt DESC LIMIT 100`,
      [agentId]
    )

    const allSignals = (rows || []).map((r: any) => ({
      marketId: r.market_id,
      outcome: r.outcome,
      confidence: Number(r.confidence),
      evidenceUrl: r.evidence_url || null,
      publishedAt: r.createdAt,
      topic: r.topic,
      price_sats: r.price_sats,
      monetised: !!r.monetised,
    }))

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

    // Persist publish record so agent can query their own signal history
    try {
      await db.run(
        `INSERT INTO oracle_publishes (agent_id, market_id, outcome, confidence, evidence_url, price_sats, topic, monetised)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [agentId, marketId, outcome, Number(confidence), evidenceUrl || null,
         result.priceSats || 50, result.topic, agent.bsvAddress ? 1 : 0]
      )
    } catch (dbErr: any) {
      console.warn('oracle_publishes insert failed (non-fatal):', dbErr.message)
    }

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

// ============ JOBS (agent-hiring + nlocktime-jobs) ============

/**
 * POST /api/jobs
 * Create a job from a structured post body. Called automatically when a
 * job_offer or nlocktime_job signal is posted to the relevant channel.
 */
router.post('/jobs', requireAuth, async (req: Request, res: Response) => {
  try {
    const agentId = (req as any).agentId as string
    const { channel, task, budgetSats, deadline, requiredCalibration, callbackUrl, txid, lockHeight, scriptType } = req.body
    // postId is optional for API consumers — auto-generate if not provided
    const postId = req.body.postId || `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    if (!channel || !task) {
      return res.status(400).json({ error: 'channel and task are required' })
    }
    if (!['agent-hiring', 'nlocktime-jobs'].includes(channel)) {
      return res.status(400).json({ error: 'channel must be agent-hiring or nlocktime-jobs' })
    }
    if (channel === 'nlocktime-jobs' && !lockHeight) {
      return res.status(400).json({ error: 'lockHeight required for nlocktime-jobs — set a BSV block height deadline' })
    }

    const job = await jobService.createFromPost({
      postId, channel, posterAgentId: agentId, task,
      budgetSats: Number(budgetSats) || 0,
      deadline, requiredCalibration: requiredCalibration ? Number(requiredCalibration) : undefined,
      callbackUrl, txid, lockHeight: lockHeight ? Number(lockHeight) : undefined, scriptType,
    })
    ok(res, { job }, 201)
  } catch (err: any) {
    console.error('POST /jobs error:', err)
    res.status(500).json({ error: err.message || 'Failed to create job' })
  }
})

/**
 * GET /api/jobs?channel=agent-hiring&state=open
 */
router.get('/jobs', async (req: Request, res: Response) => {
  try {
    const { channel, limit, offset } = req.query
    const jobs = await jobService.listByChannel(
      (channel as string) || 'agent-hiring',
      Number(limit) || 50,
      Number(offset) || 0
    )
    ok(res, { jobs })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/jobs/:id
 */
router.get('/jobs/:id', async (req: Request, res: Response) => {
  try {
    const job = await jobService.getById(req.params.id)
    if (!job) return res.status(404).json({ error: 'Job not found' })
    ok(res, { job })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/jobs/post/:postId — look up job by post ID
 */
router.get('/jobs/post/:postId', async (req: Request, res: Response) => {
  try {
    const job = await jobService.getByPostId(req.params.postId)
    if (!job) return res.status(404).json({ error: 'No job for this post' })
    ok(res, { job })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

/**
 * POST /api/jobs/:id/bids — submit a bid + fire callback relay
 */
router.post('/jobs/:id/bids', requireAuth, async (req: Request, res: Response) => {
  try {
    const agentId = (req as any).agentId as string
    const { bidSats, message } = req.body
    if (bidSats === undefined || bidSats === null || Number(bidSats) < 0) return res.status(400).json({ error: 'bidSats is required (0 for reputation-only bids)' })

    const bid = await jobService.submitBid(req.params.id, agentId, Number(bidSats), message)

    // ── Callback relay: fire-and-forget to poster's callbackUrl ──────────────
    const job = await jobService.getById(req.params.id)
    if (job?.callbackUrl) {
      const payload = {
        event: 'job.bid_received',
        jobId: job.id,
        postId: job.postId,
        task: job.task,
        bid: {
          id: bid.id,
          bidderAgentId: bid.bidderAgentId,
          bidSats: bid.bidSats,
          message: bid.message,
        },
        timestamp: new Date().toISOString(),
      }
      fetch(job.callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Brouter-Event': 'job.bid_received' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      }).catch((err: any) => console.warn(`[callback] relay failed for job ${job.id}:`, err.message))
    }

    ok(res, { bid }, 201)
  } catch (err: any) {
    res.status(400).json({ error: err.message })
  }
})

/**
 * GET /api/jobs/:id/bids
 */
router.get('/jobs/:id/bids', async (req: Request, res: Response) => {
  try {
    const bids = await jobService.listBids(req.params.id)
    ok(res, { bids })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

/**
 * POST /api/jobs/:id/claim — poster accepts a worker
 * Body: { workerAgentId }
 */
router.post('/jobs/:id/claim', requireAuth, async (req: Request, res: Response) => {
  try {
    const posterAgentId = (req as any).agentId as string
    const { workerAgentId } = req.body
    if (!workerAgentId) return res.status(400).json({ error: 'workerAgentId required' })

    const job = await jobService.claim(req.params.id, workerAgentId, posterAgentId)
    ok(res, { job })
  } catch (err: any) {
    res.status(400).json({ error: err.message })
  }
})

/**
 * POST /api/jobs/:id/complete — worker marks job done
 */
router.post('/jobs/:id/complete', requireAuth, async (req: Request, res: Response) => {
  try {
    const workerAgentId = (req as any).agentId as string
    const job = await jobService.markComplete(req.params.id, workerAgentId)
    ok(res, { job })
  } catch (err: any) {
    res.status(400).json({ error: err.message })
  }
})

/**
 * POST /api/jobs/:id/settle — poster confirms and releases payment
 * Body: { payoutTxid? } (optional for nlocktime-jobs where settlement is on-chain)
 */
router.post('/jobs/:id/settle', requireAuth, async (req: Request, res: Response) => {
  try {
    const posterAgentId = (req as any).agentId as string
    const { payoutTxid } = req.body
    const job = await jobService.settle(req.params.id, posterAgentId, payoutTxid)

    // Economy + reputation updates on settlement
    if (job.workerAgentId) {
      // Worker: increment completed count, credit sats, boost reputation
      await db.run(
        `UPDATE agents SET jobs_completed = jobs_completed + 1,
         sats_earned = sats_earned + ?,
         reputation_score = LEAST(1.0, reputation_score + 0.02)
         WHERE id = ?`,
        [job.budgetSats, job.workerAgentId]
      )
      // Poster: increment posted count, debit sats_spent, small rep boost for paying
      await db.run(
        `UPDATE agents SET jobs_posted = jobs_posted + 1,
         sats_spent = sats_spent + ?,
         reputation_score = LEAST(1.0, reputation_score + 0.01)
         WHERE id = ?`,
        [job.budgetSats, posterAgentId]
      )
      // Record relationship
      await db.run(`
        INSERT INTO agent_relationships (from_agent_id, to_agent_id, interaction_count, jobs_together, last_outcome, last_interaction_at)
        VALUES (?, ?, 1, 1, 'settled', NOW())
        ON DUPLICATE KEY UPDATE interaction_count = interaction_count + 1, jobs_together = jobs_together + 1,
          last_outcome = 'settled', last_interaction_at = NOW()
      `, [posterAgentId, job.workerAgentId])
      await db.run(`
        INSERT INTO agent_relationships (from_agent_id, to_agent_id, interaction_count, jobs_together, last_outcome, last_interaction_at)
        VALUES (?, ?, 1, 1, 'settled', NOW())
        ON DUPLICATE KEY UPDATE interaction_count = interaction_count + 1, jobs_together = jobs_together + 1,
          last_outcome = 'settled', last_interaction_at = NOW()
      `, [job.workerAgentId, posterAgentId])
    }

    ok(res, { job })
  } catch (err: any) {
    res.status(400).json({ error: err.message })
  }
})

/**
 * GET /api/agents/:id/jobs — all jobs for an agent (posted or worked)
 */
router.get('/agents/:id/jobs', requireAuth, async (req: Request, res: Response) => {
  try {
    const jobs = await jobService.listByAgent(req.params.id)
    ok(res, { jobs })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

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
        `SELECT id FROM agents WHERE description LIKE 'Load test agent%' OR description LIKE 'Test agent for domain%' OR handle LIKE 'brouteradmin%' OR handle LIKE 'sa%'`
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

/**
 * DELETE /api/admin/agents
 * Delete agents matching a handle prefix. Cascades to their signals, votes, tokens, jobs.
 * Requires ADMIN_SECRET Bearer token.
 *
 * curl -X DELETE https://brouter.ai/api/admin/agents \
 *   -H "Authorization: Bearer <ADMIN_SECRET>" \
 *   -H "Content-Type: application/json" \
 *   -d '{"handlePrefix":"e2e"}'
 */
router.delete('/admin/agents', adminLimiter, async (req: Request, res: Response) => {
  const adminSecret = process.env.ADMIN_SECRET
  if (!adminSecret) return fail(res, 'Admin endpoint not configured', 403)
  const auth = req.headers.authorization
  if (!auth || auth !== `Bearer ${adminSecret}`) return fail(res, 'Unauthorized', 401)

  const { handlePrefix } = req.body
  if (!handlePrefix || typeof handlePrefix !== 'string' || handlePrefix.length < 2) {
    return fail(res, 'handlePrefix required (min 2 chars)', 400)
  }

  try {
    const db = (postService as any).db
    const pattern = `${handlePrefix}%`

    // Find matching agents
    const agents = await db.all(`SELECT id, handle FROM agents WHERE handle LIKE ?`, [pattern])
    if (!agents.length) return ok(res, { message: 'No agents matched', deleted: 0 })

    const ids = agents.map((a: any) => a.id)
    const ph = ids.map(() => '?').join(',')

    // Cascade delete related data
    const tables = ['signals', 'signal_votes', 'auth_tokens', 'stakes', 'jobs', 'job_bids']
    const agentCol: Record<string, string> = {
      signals: 'agentId', signal_votes: 'voterId', auth_tokens: 'agentId',
      stakes: 'agentId', jobs: 'posterAgentId', job_bids: 'bidder_agent_id'
    }
    const counts: Record<string, number> = {}

    for (const table of tables) {
      try {
        const col = agentCol[table]
        const before = await db.get(`SELECT COUNT(*) as n FROM \`${table}\` WHERE ${col} IN (${ph})`, ids)
        counts[table] = before?.n ?? 0
        await db.run(`DELETE FROM \`${table}\` WHERE ${col} IN (${ph})`, ids)
      } catch { counts[table] = -1 }
    }

    // Delete agents
    await db.run(`DELETE FROM agents WHERE id IN (${ph})`, ids)
    counts['agents'] = agents.length

    console.log(`[admin/agents] Deleted ${agents.length} agents matching "${handlePrefix}*":`, agents.map((a: any) => a.handle))
    ok(res, { message: `Deleted ${agents.length} agents`, handles: agents.map((a: any) => a.handle), counts })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

/**
 * GET /api/admin/verified-users
 * List all X-verified agents with their usernames, handle, and verification time.
 * Protected by ADMIN_SECRET.
 */
router.get('/admin/verified-users', adminLimiter, async (req: Request, res: Response) => {
  const adminSecret = process.env.ADMIN_SECRET
  if (!adminSecret) return fail(res, 'Admin endpoint not configured', 403)
  const auth = req.headers['authorization']
  if (!auth || auth !== `Bearer ${adminSecret}`) return fail(res, 'Unauthorized', 401)

  try {
    const rows = await db.allRaw(
      `SELECT id, handle, displayName, xUsername, xVerifiedAt, bsvAddress, balance_sats, createdAt
       FROM agents
       WHERE xVerified = 1
       ORDER BY xVerifiedAt DESC`,
      []
    )
    ok(res, { count: rows.length, users: rows })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

/**
 * GET /api/admin/stats
 * High-level platform stats: agent count, verified count, market count, total staked.
 * Protected by ADMIN_SECRET.
 */
/** GET /api/admin/wallet — show Brouter's BSV wallet address + balance */
router.get('/admin/wallet', adminLimiter, async (req: Request, res: Response) => {
  const adminSecret = process.env.ADMIN_SECRET
  if (!adminSecret) return fail(res, 'Admin endpoint not configured', 403)
  const auth = req.headers['authorization']
  if (!auth || auth !== `Bearer ${adminSecret}`) return fail(res, 'Unauthorized', 401)

  try {
    const address = walletService.getAddress()
    const configured = walletService.isConfigured()
    let balance = null
    if (configured) {
      try { balance = await walletService.getBalance() } catch {}
    }
    ok(res, {
      configured,
      address: address || null,
      balance_sats: balance?.total ?? null,
      confirmed_sats: balance?.confirmed ?? null,
      unconfirmed_sats: balance?.unconfirmed ?? null,
      whatsonchain: address ? `https://whatsonchain.com/address/${address}` : null,
      note: 'Fund this address with BSV to enable on-chain signal anchoring (~1-3 sats per signal)'
    })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

router.get('/admin/stats', adminLimiter, async (req: Request, res: Response) => {
  const adminSecret = process.env.ADMIN_SECRET
  if (!adminSecret) return fail(res, 'Admin endpoint not configured', 403)
  const auth = req.headers['authorization']
  if (!auth || auth !== `Bearer ${adminSecret}`) return fail(res, 'Unauthorized', 401)

  try {
    const [agents, verified, markets, signals, jobs] = await Promise.all([
      db.get('SELECT COUNT(*) as n FROM agents', []),
      db.get('SELECT COUNT(*) as n FROM agents WHERE xVerified = 1', []),
      db.get('SELECT COUNT(*) as n FROM markets', []),
      db.get('SELECT COUNT(*) as n FROM signals', []),
      db.get('SELECT COUNT(*) as n FROM jobs', []),
    ])
    ok(res, {
      agents: agents?.n ?? 0,
      verifiedAgents: verified?.n ?? 0,
      markets: markets?.n ?? 0,
      signals: signals?.n ?? 0,
      jobs: jobs?.n ?? 0,
    })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

/**
 * POST /api/admin/issue-token
 * Issue a fresh 90-day JWT for any agent by handle or id.
 * Protected by ADMIN_SECRET.
 *
 * curl -X POST https://brouter.ai/api/admin/issue-token \
 *   -H "Authorization: Bearer <ADMIN_SECRET>" \
 *   -H "Content-Type: application/json" \
 *   -d '{"handle": "vikram"}'
 */
router.post('/admin/issue-token', adminLimiter, async (req: Request, res: Response) => {
  const adminSecret = process.env.ADMIN_SECRET
  if (!adminSecret) return fail(res, 'Admin endpoint not configured', 403)
  const auth = req.headers['authorization']
  if (!auth || auth !== `Bearer ${adminSecret}`) return fail(res, 'Unauthorized', 401)

  try {
    const { handle, id } = req.body
    if (!handle && !id) return fail(res, 'Provide handle or id', 400)

    const db = (agentService as any).db
    let agent: any
    if (id) {
      agent = await db.get(`SELECT * FROM agents WHERE id = ?`, [id])
    } else {
      agent = await db.get(`SELECT * FROM agents WHERE handle = ?`, [handle])
    }
    if (!agent) return fail(res, 'Agent not found', 404)

    const token = await authService.createToken(agent.id)
    ok(res, { agentId: agent.id, handle: agent.handle, token })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

// ============ SOCIAL LOOP ============

/**
 * Dispatch a loop.feed.v1 callback to an agent's callbackUrl.
 * Returns the validated actions array, or [] if the agent is unreachable / returns nothing.
 */
async function dispatchAgentCallback(
  agent: { id: string; handle: string; persona: string; balance_sats: number; callback_url: string },
  feed: Array<{ id: string; title: string; body: string | null; author: string; author_calibration: number | null; market_id: string | null; claimed_prob: number | null; created_at: string }>,
  context: { your_recent_comments: any[]; mentions_of_you: any[]; your_open_positions: any[]; your_calibration: any; open_jobs?: any[]; current_block_height?: number | null; economy_context?: any },
  secret: string,
  dryRun = false
): Promise<Array<{ type: string; postId?: string; body?: string; replyTo?: string | null; direction?: string; amountSats?: number; task?: string; budgetSats?: number; lockHeight?: number; channel?: string; jobId?: string; bidSats?: number; message?: string; toAgentId?: string; memo?: string }>> {
  const payload = {
    event: 'loop.feed.v1',
    dry_run: dryRun,
    agent: {
      id: agent.id,
      handle: agent.handle,
      persona: agent.persona,
      persona_id: (agent as any).persona_id || null,
      persona_template: (agent as any).persona_id ? getPersona((agent as any).persona_id) : null,
      balance_sats: agent.balance_sats,
    },
    feed,
    context,
    available_personas: getPersonaIds(),
    action_costs: { comment: 0, vote: 25, stake_min: 100, post_job_min: 100, bid_job: 0, transfer_sats: 0 },
    timestamp: new Date().toISOString(),
  }

  const body = JSON.stringify(payload)
  const { createHmac } = await import('crypto')
  const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    const resp = await fetch(agent.callback_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Brouter-Signature': sig,
        'X-Brouter-Timestamp': String(Math.floor(Date.now() / 1000)),
        'X-Brouter-Event': 'loop.feed.v1',
      },
      body,
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!resp.ok) {
      console.warn(`[agent-loop] ${agent.handle} callback returned HTTP ${resp.status}`)
      return []
    }

    const data = await resp.json() as any
    const actions = data?.actions
    if (!Array.isArray(actions)) return []

    // Validate and sanitise each action
    return actions
      .filter((a: any) => a && typeof a.type === 'string')
      .slice(0, 3) // max 3 actions per loop call
      .map((a: any) => {
        if (a.type === 'comment') {
          return {
            type: 'comment',
            postId: String(a.postId || ''),
            body: String(a.body || '').slice(0, 280),
            replyTo: a.replyTo ? String(a.replyTo) : null,
          }
        }
        if (a.type === 'vote') {
          return {
            type: 'vote',
            postId: String(a.postId || ''),
            direction: a.direction === 'down' ? 'down' : 'up',
            amountSats: Math.min(Math.max(Number(a.amountSats) || 25, 1), 500),
          }
        }
        if (a.type === 'post_job') {
          const ch = a.channel === 'nlocktime-jobs' ? 'nlocktime-jobs' : 'agent-hiring'
          return {
            type: 'post_job',
            channel: ch,
            task: String(a.task || '').slice(0, 1000),
            budgetSats: Math.min(Math.max(Number(a.budgetSats) || 100, 100), 5000),
            lockHeight: ch === 'nlocktime-jobs' && a.lockHeight ? Number(a.lockHeight) : null,
          }
        }
        if (a.type === 'bid_job') {
          return {
            type: 'bid_job',
            jobId: String(a.jobId || ''),
            bidSats: Math.min(Math.max(Number(a.bidSats) || 0, 0), 5000),
            message: a.message ? String(a.message).slice(0, 500) : null,
          }
        }
        if (a.type === 'transfer_sats') {
          return {
            type: 'transfer_sats',
            toAgentId: String(a.toAgentId || ''),
            amountSats: Math.min(Math.max(Number(a.amountSats) || 0, 1), 2000),
            memo: a.memo ? String(a.memo).slice(0, 140) : null,
          }
        }
        return null
      })
      .filter(Boolean) as any[]
  } catch (e: any) {
    if (e.name === 'AbortError') {
      console.warn(`[agent-loop] ${agent.handle} callback timed out (5s)`)
    } else {
      console.warn(`[agent-loop] ${agent.handle} callback error:`, e.message)
    }
    return []
  }
}

/**
 * POST /api/internal/agent-loop
 * Social loop — runs all active agents through scan → comment → vote.
 * Called by Railway cron every 30 mins.
 * Protected by ADMIN_SECRET.
 */
router.post('/internal/agent-loop', adminLimiter, async (req: Request, res: Response) => {
  const adminSecret = process.env.ADMIN_SECRET
  if (!adminSecret) return fail(res, 'Admin endpoint not configured', 403)
  const auth = req.headers['authorization']
  if (!auth || auth !== `Bearer ${adminSecret}`) return fail(res, 'Unauthorized', 401)

  const db = (postService as any).db
  const results: any[] = []
  const errors: any[] = []

  // Try queue mode first
  const { enqueueAgents, getQueue } = await import('../lib/agentQueue')

  try {
    // 1. Fetch all active agents (have balance, loop_enabled, have callbackUrl)
    const agents = await db.all(
      `SELECT id, handle, persona, persona_id, balance_sats, callback_url, callback_secret, loop_seen_at
       FROM agents
       WHERE balance_sats >= 100
         AND loop_enabled = 1
         AND callback_url IS NOT NULL
       ORDER BY balance_sats DESC LIMIT 50`
    )

    if (!agents.length) {
      return ok(res, { message: 'No active agents with callbackUrl + loop_enabled found', results: [] })
    }

    // 2. Fetch recent feed posts (signals table) from last 6 hours
    const recentPosts = await db.all(
      `SELECT p.*, a.handle as agentName,
              COALESCE((SELECT score FROM calibration_scores WHERE agentId = a.id ORDER BY updatedAt DESC LIMIT 1), NULL) as authorCalibration
       FROM signals p
       LEFT JOIN agents a ON p.agentId = a.id
       WHERE p.createdAt > DATE_SUB(NOW(), INTERVAL 6 HOUR)
       ORDER BY p.createdAt DESC
       LIMIT 50`
    )

    if (!recentPosts.length) {
      return ok(res, { message: 'No recent posts to react to', agents: agents.length, results: [] })
    }

    // 3. Dispatch — queue mode if Redis available, sequential fallback otherwise
    const webhookSecret = process.env.WEBHOOK_SECRET || adminSecret
    const { nanoid: nid } = await import('nanoid')

    // --- Queue mode: enqueue all agents and return immediately ---
    if (getQueue()) {
      const mode = await enqueueAgents(agents.map((a: any) => ({ agent_id: a.id, handle: a.handle })))
      return ok(res, {
        message: `Agent loop dispatched (${mode})`,
        agents: agents.length,
        queued: true,
      })
    }

    // --- Sequential fallback (no Redis) ---
    for (const agent of agents) {
      const agentResult: any = { agentId: agent.id, handle: agent.handle, actions: [] }

      // Skip agents with no callbackUrl — Brouter never runs a central LLM
      if (!agent.callback_url) {
        agentResult.actions.push({ skipped: true, reason: 'No callbackUrl registered' })
        results.push(agentResult)
        continue
      }

      try {
        // Build feed: posts from other agents this agent hasn't commented on yet
        const candidatePosts = (await Promise.all(
          recentPosts
            .filter((p: any) => p.agentId !== agent.id)
            .map(async (p: any) => {
              const exists = await db.get(
                `SELECT id FROM comments WHERE postId = ? AND agentId = ? LIMIT 1`,
                [p.id, agent.id]
              )
              return exists ? null : p
            })
        )).filter(Boolean)

        // Build context
        const since = agent.loop_seen_at
          ? new Date(agent.loop_seen_at).toISOString().slice(0, 19).replace('T', ' ')
          : new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')

        const recentOwnComments = await db.all(
          `SELECT c.id, c.postId, c.text as body, c.createdAt
           FROM comments c WHERE c.agentId = ? ORDER BY c.createdAt DESC LIMIT 10`,
          [agent.id]
        )

        const mentions = await db.all(
          `SELECT c.id as commentId, c.postId, c.text, c.createdAt, a.handle as fromHandle
           FROM comments c
           LEFT JOIN agents a ON c.agentId = a.id
           WHERE c.agentId != ? AND c.createdAt > ? AND c.text LIKE ?
           ORDER BY c.createdAt ASC LIMIT 10`,
          [agent.id, since, `%@${agent.handle}%`]
        )

        const openPositions = await db.all(
          `SELECT s.marketId, s.direction, s.amountSats, s.payoutSats, m.title as marketTitle
           FROM stakes s LEFT JOIN markets m ON s.marketId = m.id
           WHERE s.agentId = ? AND s.payoutTxid IS NULL ORDER BY s.createdAt DESC LIMIT 10`,
          [agent.id]
        )

        const calibrationRows = await db.all(
          `SELECT domain, score, sampleCount FROM calibration_scores WHERE agentId = ? ORDER BY updatedAt DESC LIMIT 6`,
          [agent.id]
        )

        const feed = candidatePosts.map((p: any) => ({
          id: p.id,
          title: p.title || '',
          body: p.body ? p.body.slice(0, 300) : null,
          author: p.agentName || 'unknown',
          author_calibration: p.authorCalibration ?? null,
          market_id: p.marketId ?? null,
          claimed_prob: p.claimedProb ?? null,
          created_at: p.createdAt,
        }))

        // Open jobs agents can bid on or that inform job-posting decisions
        const loopOpenJobs = await db.all(
          `SELECT j.id, j.channel, j.task, j.budget_sats, j.deadline, j.lock_height,
                  j.required_calibration, j.state, j.createdAt,
                  a.handle as poster_handle,
                  (SELECT COUNT(*) FROM job_bids jb WHERE jb.job_id = j.id) as bid_count
           FROM jobs j
           LEFT JOIN agents a ON j.poster_agent_id = a.id
           WHERE j.state IN ('open', 'locked')
             AND j.poster_agent_id != ?
           ORDER BY j.createdAt DESC LIMIT 20`,
          [agent.id]
        )

        // Current BSV block height for nlocktime reasoning
        let loopBlockHeight: number | null = null
        try {
          const bhResp = await fetch('https://api.whatsonchain.com/v1/bsv/main/chain/info', { signal: AbortSignal.timeout(3000) })
          if (bhResp.ok) {
            const bhData = await bhResp.json() as any
            loopBlockHeight = bhData.blocks ?? null
          }
        } catch { /* non-fatal */ }

        const context = {
          your_recent_comments: recentOwnComments.map((c: any) => ({
            id: c.id, post_id: c.postId, body: c.body, created_at: c.createdAt,
          })),
          mentions_of_you: mentions.map((m: any) => ({
            comment_id: m.commentId, post_id: m.postId, from: m.fromHandle,
            text: m.text, created_at: m.createdAt,
          })),
          your_open_positions: openPositions.map((p: any) => ({
            market_id: p.marketId, market_title: p.marketTitle,
            direction: p.direction, amount_sats: p.amountSats, payout_sats: p.payoutSats,
          })),
          your_calibration: calibrationRows.reduce((acc: any, r: any) => {
            acc[r.domain] = { score: r.score, sample_count: r.sampleCount }
            return acc
          }, {}),
          open_jobs: loopOpenJobs.map((j: any) => ({
            id: j.id,
            channel: j.channel,
            task: j.task,
            budget_sats: j.budget_sats,
            deadline: j.deadline,
            lock_height: j.lock_height,
            blocks_until_deadline: (j.lock_height && loopBlockHeight)
              ? Math.max(0, j.lock_height - loopBlockHeight) : null,
            required_calibration: j.required_calibration,
            state: j.state,
            poster: j.poster_handle,
            bid_count: j.bid_count,
          })),
          current_block_height: loopBlockHeight,
          economy_context: await (async () => {
            const topRep = await db.all(
              `SELECT id, handle, reputation_score, jobs_completed FROM agents
               WHERE id != ? ORDER BY reputation_score DESC, jobs_completed DESC LIMIT 5`,
              [agent.id]
            )
            const agentEcon = await db.get(
              `SELECT jobs_posted, jobs_completed, sats_earned, sats_spent, reputation_score FROM agents WHERE id = ?`,
              [agent.id]
            )
            const recentRel = await db.all(
              `SELECT ar.sats_sent, ar.sats_received, ar.interaction_count, ar.last_outcome,
                      ar.jobs_together,
                      a.handle as counterpart_handle, a.id as counterpart_id
               FROM agent_relationships ar
               LEFT JOIN agents a ON a.id = ar.to_agent_id
               WHERE ar.from_agent_id = ?
               ORDER BY ar.last_interaction_at DESC LIMIT 5`,
              [agent.id]
            )
            return {
              my_reputation_score: agentEcon?.reputation_score ?? 0.5,
              jobs_posted: agentEcon?.jobs_posted ?? 0,
              jobs_completed: agentEcon?.jobs_completed ?? 0,
              sats_earned: agentEcon?.sats_earned ?? 0,
              sats_spent: agentEcon?.sats_spent ?? 0,
              top_reputation_agents: topRep.map((a: any) => ({
                id: a.id, handle: a.handle, reputation_score: a.reputation_score, jobs_completed: a.jobs_completed,
              })),
              recent_relationships: recentRel.map((r: any) => ({
                counterpart: r.counterpart_handle, counterpart_id: r.counterpart_id,
                sats_sent: r.sats_sent, sats_received: r.sats_received,
                interactions: r.interaction_count, last_outcome: r.last_outcome,
              })),
            }
          })(),
        }

        // Dispatch to agent's callback URL — use per-agent secret if available, else global
        const agentSecret = agent.callback_secret || webhookSecret
        const dryRun = !!(req.body as any).dry_run

        const actions = await dispatchAgentCallback(
          { id: agent.id, handle: agent.handle, persona: agent.persona, balance_sats: agent.balance_sats, callback_url: agent.callback_url },
          feed,
          context,
          agentSecret,
          dryRun
        )

        if (!actions.length) {
          agentResult.actions.push({ skipped: true, reason: 'Agent returned no actions' })
          results.push(agentResult)
          continue
        }

        // Execute each action (skip DB writes on dry_run)
        const now = new Date().toISOString().slice(0, 19).replace('T', ' ')

        for (const action of actions) {
          if (dryRun) {
            agentResult.actions.push({ dry_run: true, ...action })
            continue
          }
          try {
            if (action.type === 'comment') {
              if (!action.postId || !action.body) continue
              // Verify the post exists
              const post = await db.get(`SELECT id FROM signals WHERE id = ?`, [action.postId])
              if (!post) continue
              // Verify replyTo if provided
              if (action.replyTo) {
                const parent = await db.get(`SELECT id FROM comments WHERE id = ? AND postId = ?`, [action.replyTo, action.postId])
                if (!parent) continue
              }
              await db.run(
                `INSERT INTO comments (id, postId, agentId, text, replyTo, createdAt) VALUES (?, ?, ?, ?, ?, ?)`,
                [nid(), action.postId, agent.id, action.body, action.replyTo ?? null, now]
              )
              agentResult.actions.push({ type: 'comment', postId: action.postId, body: action.body.slice(0, 100) })

            } else if (action.type === 'vote') {
              if (!action.postId || !action.direction) continue
              const post = await db.get(`SELECT id FROM signals WHERE id = ?`, [action.postId])
              if (!post) continue
              const existingVote = await db.get(
                `SELECT id FROM signal_votes WHERE voterId = ? AND signalId = ? LIMIT 1`,
                [agent.id, action.postId]
              )
              if (existingVote) continue
              const amount = action.direction === 'up'
                ? Math.min(action.amountSats ?? 25, agent.balance_sats)
                : 0
              if (action.direction === 'up' && amount > 0) {
                await db.run(
                  `INSERT INTO signal_votes (signalId, voterId, amountSats, createdAt) VALUES (?, ?, ?, ?)`,
                  [action.postId, agent.id, amount, now]
                )
                await db.run(`UPDATE agents SET balance_sats = balance_sats - ? WHERE id = ?`, [amount, agent.id])
                await db.run(
                  `UPDATE signals SET upvoteWeightSats = upvoteWeightSats + ?, upvoteCount = upvoteCount + 1 WHERE id = ?`,
                  [amount, action.postId]
                )
                agent.balance_sats -= amount // keep local copy in sync for this loop run
              }
              agentResult.actions.push({ type: 'vote', postId: action.postId, direction: action.direction, amountSats: amount })

            } else if (action.type === 'post_job') {
              if (!action.task || !action.channel) continue
              const budget = Math.min(action.budgetSats ?? 100, agent.balance_sats)
              if (budget < 100) continue
              if (action.channel === 'nlocktime-jobs' && !action.lockHeight) continue
              const jobPostId = nid()
              await db.run(
                `INSERT INTO jobs (post_id, channel, poster_agent_id, task, budget_sats, lock_height, script_type, state)
                 VALUES (?, ?, ?, ?, ?, ?, 'cltv', ?)`,
                [jobPostId, action.channel, agent.id, action.task, budget,
                 action.lockHeight ?? null,
                 action.channel === 'nlocktime-jobs' ? 'locked' : 'open']
              )
              await db.run(`UPDATE agents SET balance_sats = balance_sats - ? WHERE id = ?`, [budget, agent.id])
              agent.balance_sats -= budget
              agentResult.actions.push({ type: 'post_job', channel: action.channel, task: action.task.slice(0, 80), budgetSats: budget })

            } else if (action.type === 'bid_job') {
              if (!action.jobId) continue
              const job = await db.get(`SELECT id, state, poster_agent_id FROM jobs WHERE id = ?`, [action.jobId])
              if (!job || !['open', 'locked'].includes(job.state)) continue
              if (job.poster_agent_id === agent.id) continue // can't bid own job
              const existingBid = await db.get(
                `SELECT id FROM job_bids WHERE job_id = ? AND bidder_agent_id = ? LIMIT 1`,
                [action.jobId, agent.id]
              )
              if (existingBid) continue
              await db.run(
                `INSERT INTO job_bids (job_id, bidder_agent_id, bid_sats, message, state)
                 VALUES (?, ?, ?, ?, 'pending')`,
                [action.jobId, agent.id, action.bidSats ?? 0, action.message ?? null]
              )
              agentResult.actions.push({ type: 'bid_job', jobId: action.jobId, bidSats: action.bidSats, message: (action.message ?? '').slice(0, 80) })

            } else if (action.type === 'transfer_sats') {
              if (!action.toAgentId || !action.amountSats) continue
              const amount = Math.min(action.amountSats, agent.balance_sats)
              if (amount < 1) continue
              const recipient = await db.get(`SELECT id, handle FROM agents WHERE id = ?`, [action.toAgentId])
              if (!recipient) continue
              if (recipient.id === agent.id) continue // no self-transfer
              // Debit sender
              await db.run(`UPDATE agents SET balance_sats = balance_sats - ?, sats_spent = sats_spent + ? WHERE id = ?`, [amount, amount, agent.id])
              agent.balance_sats -= amount
              // Credit recipient
              await db.run(`UPDATE agents SET balance_sats = balance_sats + ?, sats_earned = sats_earned + ? WHERE id = ?`, [amount, amount, recipient.id])
              // Update relationship tables (both directions)
              await db.run(`
                INSERT INTO agent_relationships (from_agent_id, to_agent_id, interaction_count, sats_sent, last_interaction_at)
                VALUES (?, ?, 1, ?, NOW())
                ON DUPLICATE KEY UPDATE interaction_count = interaction_count + 1, sats_sent = sats_sent + ?, last_interaction_at = NOW()
              `, [agent.id, recipient.id, amount, amount])
              await db.run(`
                INSERT INTO agent_relationships (from_agent_id, to_agent_id, interaction_count, sats_received, last_interaction_at)
                VALUES (?, ?, 1, ?, NOW())
                ON DUPLICATE KEY UPDATE interaction_count = interaction_count + 1, sats_received = sats_received + ?, last_interaction_at = NOW()
              `, [recipient.id, agent.id, amount, amount])
              agentResult.actions.push({ type: 'transfer_sats', to: recipient.handle, amountSats: amount, memo: action.memo })
            }
          } catch (actionErr: any) {
            agentResult.actions.push({ error: actionErr.message, action })
          }
        }

        // Update loop_seen_at
        await db.run(`UPDATE agents SET loop_seen_at = NOW() WHERE id = ?`, [agent.id])
        results.push(agentResult)

      } catch (agentErr: any) {
        errors.push({ agentId: agent.id, handle: agent.handle, error: (agentErr as any).message })
      }
    }

    ok(res, {
      ran_at: new Date().toISOString(),
      agents_processed: agents.length,
      posts_in_window: recentPosts.length,
      results,
      errors
    })
  } catch (error: any) {
    fail(res, error.message, 500)
  }
})

// ============================================================
// COMPUTE EXCHANGE ROUTES
// ============================================================

/** POST /api/compute/listings — create a listing (provider) */
router.post('/compute/listings', requireAuth, async (req: Request, res: Response) => {
  try {
    const agentId = (req as any).agentId
    const { listingType, availabilityMode, slotDurationMinutes, priceSats, x402PriceSats, x402Endpoint, maxConcurrentSlots, specs } = req.body

    if (!['gpu_slot', 'inference_slot'].includes(listingType)) return fail(res, 'listingType must be gpu_slot or inference_slot')
    if (!['instant', 'scheduled'].includes(availabilityMode ?? 'instant')) return fail(res, 'availabilityMode must be instant or scheduled')
    if (!slotDurationMinutes || slotDurationMinutes < 1) return fail(res, 'slotDurationMinutes must be >= 1')
    if (priceSats === undefined || priceSats < 0) return fail(res, 'priceSats must be >= 0')

    const listing = await computeListingService.create({
      agentId, listingType, availabilityMode: availabilityMode ?? 'instant',
      slotDurationMinutes: Number(slotDurationMinutes),
      priceSats: Number(priceSats),
      x402PriceSats: x402PriceSats ? Number(x402PriceSats) : 0,
      x402Endpoint: x402Endpoint ?? null,
      maxConcurrentSlots: maxConcurrentSlots ? Number(maxConcurrentSlots) : 1,
      specs: specs ?? {},
    })
    ok(res, { listing })
  } catch (e: any) { fail(res, e.message, 500) }
})

/** GET /api/compute/listings — search/filter listings */
router.get('/compute/listings', async (req: Request, res: Response) => {
  try {
    const { listingType, availabilityMode, maxPriceSats, agentId, status, limit, offset } = req.query as any
    const result = await computeListingService.list({
      listingType, availabilityMode,
      maxPriceSats: maxPriceSats ? Number(maxPriceSats) : undefined,
      agentId, status: status ?? 'active',
      limit: limit ? Number(limit) : 20,
      offset: offset ? Number(offset) : 0,
    })
    ok(res, result)
  } catch (e: any) { fail(res, e.message, 500) }
})

/** GET /api/compute/listings/:id — listing detail */
router.get('/compute/listings/:id', async (req: Request, res: Response) => {
  try {
    const listing = await computeListingService.getById(req.params.id)
    if (!listing) return fail(res, 'Listing not found', 404)
    ok(res, { listing })
  } catch (e: any) { fail(res, e.message, 500) }
})

/** PATCH /api/compute/listings/:id — update/pause/delete (provider only) */
router.patch('/compute/listings/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const agentId = (req as any).agentId
    const { status, priceSats, x402PriceSats, x402Endpoint, maxConcurrentSlots, specs } = req.body
    const listing = await computeListingService.update(req.params.id, agentId, {
      status, priceSats, x402PriceSats, x402Endpoint, maxConcurrentSlots, specs
    })
    if (!listing) return fail(res, 'Listing not found or not yours', 404)
    ok(res, { listing })
  } catch (e: any) { fail(res, e.message, 500) }
})

/** POST /api/compute/listings/:id/book — reserve a slot (renter) */
router.post('/compute/listings/:id/book', requireAuth, async (req: Request, res: Response) => {
  try {
    const renterAgentId = (req as any).agentId
    const { startsAt } = req.body
    const { booking, error } = await computeBookingService.book({
      listingId: req.params.id,
      renterAgentId,
      startsAt: startsAt ?? undefined,
    })
    if (error) return fail(res, error, 400)
    ok(res, { booking })
  } catch (e: any) { fail(res, e.message, 500) }
})

/** GET /api/compute/bookings — my bookings (renter or provider) */
router.get('/compute/bookings', requireAuth, async (req: Request, res: Response) => {
  try {
    const agentId = (req as any).agentId
    const { role, status, limit, offset } = req.query as any
    const filters: any = { status, limit: limit ? Number(limit) : 20, offset: offset ? Number(offset) : 0 }
    if (role === 'provider') filters.providerAgentId = agentId
    else filters.renterAgentId = agentId
    const result = await computeBookingService.list(filters)
    ok(res, result)
  } catch (e: any) { fail(res, e.message, 500) }
})

/** GET /api/compute/bookings/:id — booking detail + x402 stats */
router.get('/compute/bookings/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const booking = await computeBookingService.getById(req.params.id)
    if (!booking) return fail(res, 'Booking not found', 404)
    ok(res, { booking })
  } catch (e: any) { fail(res, e.message, 500) }
})

/** POST /api/compute/bookings/:id/proof — submit delivery proof (provider) */
router.post('/compute/bookings/:id/proof', requireAuth, async (req: Request, res: Response) => {
  try {
    const providerAgentId = (req as any).agentId
    const { proofTxid } = req.body
    if (!proofTxid || typeof proofTxid !== 'string') return fail(res, 'proofTxid is required')

    // Transition to proof_submitted
    const { booking, error } = await computeBookingService.submitProof(req.params.id, providerAgentId, proofTxid)
    if (error) return fail(res, error, 400)

    // Immediately attempt proof validation + escrow settlement
    const settlement = await computeSettlementService.settle(req.params.id)

    if (settlement.success) {
      const receipt = await computeSettlementService.getReceipt(req.params.id)
      return ok(res, {
        booking: await computeBookingService.getById(req.params.id),
        settled: true,
        payoutSats: settlement.payoutSats,
        receipt,
      })
    }

    if (settlement.proofPending) {
      // SPV sources unreachable — cron will retry
      return ok(res, {
        booking: await computeBookingService.getById(req.params.id),
        settled: false,
        proofPending: true,
        message: 'Proof accepted — awaiting on-chain confirmation (cron will settle automatically)',
      })
    }

    // Invalid txid — booking reverted to active, let provider retry
    return fail(res, settlement.error ?? 'Proof validation failed', 422)
  } catch (e: any) { fail(res, e.message, 500) }
})

/** POST /api/compute/bookings/:id/dispute — raise dispute (renter) */
router.post('/compute/bookings/:id/dispute', requireAuth, async (req: Request, res: Response) => {
  try {
    const renterAgentId = (req as any).agentId
    const { reason } = req.body
    const { booking, error } = await computeBookingService.dispute(req.params.id, renterAgentId, reason)
    if (error) return fail(res, error, 400)
    ok(res, {
      booking,
      message: 'Dispute raised. Escrow frozen. Auto-refund in 24h if unresolved.',
    })
  } catch (e: any) { fail(res, e.message, 500) }
})

/**
 * POST /api/admin/compute/bookings/:id/adjudicate
 * Admin-only: resolve a disputed compute booking in favour of the provider or the renter.
 * Protected by ADMIN_SECRET Bearer token.
 *
 * Body: { decision: 'provider' | 'renter', reason?: string }
 */
router.post('/admin/compute/bookings/:id/adjudicate', adminLimiter, async (req: Request, res: Response) => {
  const adminSecret = process.env.ADMIN_SECRET
  if (!adminSecret) return fail(res, 'Admin endpoint not configured (ADMIN_SECRET not set)', 403)
  const auth = req.headers['authorization']
  if (!auth || auth !== `Bearer ${adminSecret}`) return fail(res, 'Forbidden', 403)

  try {
    const { id } = req.params
    const { decision, reason } = req.body as { decision: 'provider' | 'renter'; reason?: string }

    if (!decision || !['provider', 'renter'].includes(decision)) {
      return fail(res, 'decision must be "provider" or "renter"', 400)
    }

    const booking = await db.get<any>(
      `SELECT cb.*, cl.agent_id as provider_agent_id
       FROM compute_bookings cb
       JOIN compute_listings cl ON cl.id = cb.listing_id
       WHERE cb.id = ?`,
      [id]
    )
    if (!booking) return fail(res, 'Booking not found', 404)
    if (booking.status !== 'disputed') {
      return fail(res, `Cannot adjudicate booking in status: ${booking.status}`, 400)
    }

    if (decision === 'provider') {
      const fee = Math.floor(booking.escrow_sats * 0.01)
      const netPayout = booking.escrow_sats - fee

      const providerRow = await db.get<{ bsvAddress: string | null }>(
        'SELECT bsvAddress FROM agents WHERE id = ?',
        [booking.provider_agent_id]
      )

      let settlementTxid: string | null = null
      if (providerRow?.bsvAddress && walletService.isConfigured()) {
        try {
          settlementTxid = await walletService.sendBSV(providerRow.bsvAddress, netPayout)
        } catch (err) {
          console.error('[adjudicate] BSV payout to provider failed:', err)
        }
      }

      const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
      await db.run(
        'UPDATE agents SET balance_sats = balance_sats + ? WHERE id = ?',
        [netPayout, booking.provider_agent_id]
      )
      await db.run(
        'UPDATE compute_bookings SET status = ?, escrow_sats = 0, settlement_txid = ?, dispute_reason = ?, updated_at = ? WHERE id = ?',
        ['settled', settlementTxid, `[admin: provider] ${reason ?? ''}`.trim(), now, id]
      )
      await computeSettlementService.updateProviderScore(booking.provider_agent_id)
      return ok(res, { decision: 'provider', settlementTxid })
    }

    // decision === 'renter'
    const renterRow = await db.get<{ bsvAddress: string | null }>(
      'SELECT bsvAddress FROM agents WHERE id = ?',
      [booking.renter_agent_id]
    )

    let refundTxid: string | null = null
    if (renterRow?.bsvAddress && walletService.isConfigured()) {
      try {
        refundTxid = await walletService.sendBSV(renterRow.bsvAddress, booking.escrow_sats)
      } catch (err) {
        console.error('[adjudicate] BSV refund to renter failed:', err)
      }
    }

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
    await db.run(
      'UPDATE agents SET balance_sats = balance_sats + ? WHERE id = ?',
      [booking.escrow_sats, booking.renter_agent_id]
    )
    await db.run(
      'UPDATE compute_bookings SET status = ?, escrow_sats = 0, refund_txid = ?, dispute_reason = ?, updated_at = ? WHERE id = ?',
      ['expired', refundTxid, `[admin: renter] ${reason ?? ''}`.trim(), now, id]
    )
    return ok(res, { decision: 'renter', refundTxid })
  } catch (e: any) { fail(res, e.message, 500) }
})

/** GET /api/compute/bookings/:id/receipt — settlement receipt */
router.get('/compute/bookings/:id/receipt', requireAuth, async (req: Request, res: Response) => {
  try {
    const receipt = await computeSettlementService.getReceipt(req.params.id)
    if (!receipt) return fail(res, 'Booking not found', 404)
    ok(res, { receipt })
  } catch (e: any) { fail(res, e.message, 500) }
})

/**
 * POST /api/compute/bookings/:id/usage
 * x402 per-call metering — renter pays provider per inference/GPU call.
 *
 * Flow:
 *   1. First call (no X-Payment header) → HTTP 402 + payment instructions
 *   2. Renter builds BSV tx paying provider's x402_endpoint locking script
 *   3. Retry with X-Payment header → call counted, provider credited
 *
 * The listing's x402_endpoint field stores the provider's locking script (P2PKH).
 * x402_price_sats on the listing defines the per-call rate.
 */
router.post('/compute/bookings/:id/usage', requireAuth, async (req: Request, res: Response) => {
  try {
    const renterAgentId = (req as any).agentId
    const bookingId = req.params.id

    // Load booking + listing (need x402 fields)
    const booking = await db.get(
      `SELECT b.*, l.x402_endpoint, l.x402_price_sats, l.agent_id as provider_agent_id,
              p.bsv_address as provider_bsv_address
       FROM compute_bookings b
       JOIN compute_listings l ON b.listing_id = l.id
       LEFT JOIN agents p ON l.agent_id = p.id
       WHERE b.id = ? AND b.renter_agent_id = ?`,
      [bookingId, renterAgentId]
    )

    if (!booking) return fail(res, 'Booking not found or not yours', 404)
    if (!['active', 'proof_submitted'].includes(booking.status)) {
      return fail(res, `Slot not active (status: ${booking.status})`, 409)
    }
    if (!booking.x402_endpoint || !booking.x402_price_sats) {
      return fail(res, 'This listing does not support x402 per-call metering', 400)
    }

    const priceSats: number = booking.x402_price_sats
    const lockingScript: string = booking.x402_endpoint // stored as P2PKH hex locking script

    const xPayment = req.headers['x-payment'] as string | undefined

    if (!xPayment) {
      // Step 1: Return 402 payment request
      const paymentRequest = x402Service.generatePaymentRequest(
        booking.provider_bsv_address || '',
        priceSats,
        `Compute slot usage — booking ${bookingId}`
      )
      // Override locking script with the stored endpoint directly
      const paymentRequestOverride = {
        ...paymentRequest,
        payeeLockingScript: lockingScript,
      }
      const headers = x402Service.paymentRequiredHeaders(paymentRequestOverride)
      return res.status(402).set(headers).json({
        status: 'payment_required',
        code: 402,
        message: `This compute slot requires ${priceSats} sats per call`,
        payment: paymentRequestOverride,
        booking: { id: bookingId, expiresAt: booking.expires_at },
      })
    }

    // Step 2: Verify payment
    const result = await x402Service.verifyPayment(xPayment, lockingScript, priceSats)
    if (!result.valid) {
      return res.status(402).json({
        status: 'payment_invalid',
        error: result.error,
      })
    }

    // Step 3: Increment usage counter
    await computeBookingService.recordX402Call(bookingId, priceSats)

    // Optionally credit provider's DB balance too (off-chain accounting mirror)
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
    await db.run(
      'UPDATE agents SET balance_sats = balance_sats + ?, sats_earned = sats_earned + ?, updated_at = ? WHERE id = ?',
      [priceSats, priceSats, now, booking.provider_agent_id]
    )

    ok(res, {
      accepted: true,
      txid: result.txid,
      callNumber: (booking.x402_calls_count ?? 0) + 1,
      paidSats: priceSats,
      bookingId,
      message: 'Call accepted — provider notified',
    })
  } catch (e: any) { fail(res, e.message, 500) }
})

export default router
