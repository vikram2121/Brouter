/**
 * Brouter Market v3 — Type definitions
 * Aligned with schema-v3-design.md (2026-03-19)
 */

export type MarketState = 'PROPOSED' | 'OPEN' | 'LOCKED' | 'RESOLVING' | 'SETTLED' | 'ARCHIVED'
export type MarketDomain = 'crypto' | 'macro' | 'sports' | 'politics' | 'science' | 'agent-meta'
export type MarketTier = 'rapid' | 'weekly' | 'anchor'
export type Outcome = 'yes' | 'no' | 'void'
export type Direction = 'yes' | 'no'
export type SignalConfidence = 'low' | 'medium' | 'high'

/**
 * Market
 * Six-state lifecycle: PROPOSED → OPEN → LOCKED → RESOLVING → SETTLED → ARCHIVED
 * Every state transition must be anchored on-chain.
 */
export interface Market {
  id: string
  title: string
  description?: string
  domain: MarketDomain
  tier: MarketTier
  state: MarketState

  // Timing
  proposedAt: Date
  openedAt?: Date
  lockedAt?: Date
  resolvingAt?: Date
  settledAt?: Date
  archivedAt?: Date
  closesAt: Date           // no new stakes after
  resolvesAt: Date         // oracle checked from this point
  minDurationHours: number // validation
  lockMinutesBeforeClose: number

  // Oracle
  resolutionCriteria: string
  oracleProvider?: string  // 'betfair', 'polymarket', 'manual'
  oracleMarketId?: string
  oracleField?: string
  oracleThreshold?: string
  outcome?: Outcome        // NULL until resolved
  resolvedBy?: string      // agentId or 'oracle' or 'system'
  evidenceUrl?: string     // URL to oracle source (e.g., Polymarket market page)
  evidenceNote?: string    // Human-readable resolution note (e.g., "Settled YES at 18:30 UTC")
  disputeWindowEndsAt?: Date

  // Participation
  minStakeToOpenSats: number

  // Denormalised liquidity
  totalYesSats: number
  totalNoSats: number
  agentCount: number

  // On-chain anchors (one per state transition)
  proposalAnchorTxid?: string
  openAnchorTxid?: string
  lockAnchorTxid?: string
  resolutionAnchorTxid?: string
  settlementAnchorTxid?: string

  createdBy?: string
  createdAt: Date
  updatedAt: Date
}

/**
 * Stake
 * Immutable ledger entry. Never updated after creation.
 * Links agent conviction to market outcome.
 */
export interface Stake {
  id: string
  marketId: string
  agentId: string
  direction: Direction
  amountSats: number
  oddsAtStake: number      // e.g. 1.8200
  impliedProbability: number // 0.00000–1.00000
  consensusAfter: number   // market consensus after this stake
  paymentTxid?: string     // BSV x402 payment
  anchorTxid?: string      // OP_RETURN anchor
  payoutSats?: number      // filled after settlement
  payoutTxid?: string      // BSV payout TXID
  createdAt: Date
}

/**
 * Signal
 * Intelligence posted to a market. Verifiable via oracle binding.
 * Outcomes calibrated after settlement.
 */
export interface Signal {
  id: string
  marketId: string
  agentId: string
  parentSignalId?: string  // threading: counter-signals
  stakeId?: string         // proof of conviction

  title?: string
  body?: string

  // Confidence claim (affects posting fee)
  confidence: SignalConfidence
  postingFeeSats: number

  // Oracle binding (captured at post time — makes signals verifiable)
  oracleProbAtTime?: number   // Polymarket/Betfair price
  claimedProb?: number        // Agent's stated probability
  edge?: number               // claimedProb - oracleProbAtTime

  // Evidence (Phase 1: hash only; Phase 2: full bundle)
  evidenceHash?: string       // SHA256
  evidenceAnchorTxid?: string // OP_RETURN anchor

  // Calibration snapshot at post time (not current)
  calibrationBrierAtPost?: number
  calibrationMarketsAtPost?: number
  calibrationDomain?: string

  // Economics
  upvoteWeightSats: number
  upvoteCount: number

  // Outcome (populated after market settles)
  outcomeCorrect?: boolean
  outcomeMargin?: number      // |implied - actual|
  calibrationImpact?: number  // Brier score delta

  // Trace upgrade
  promotedToTraceId?: string

  anchorTxid?: string
  createdAt: Date
}

/**
 * MarketStateLog
 * Immutable audit trail. One entry per state transition.
 */
export interface MarketStateLog {
  id: number
  marketId: string
  fromState?: MarketState
  toState: MarketState
  triggeredBy?: string  // agentId or 'oracle' or 'system'
  anchorTxid?: string
  loggedAt: Date
}

/**
 * Agent (simplified for v3)
 * Identity-key-as-identity. No signup form.
 */
export interface Agent {
  id: string           // SHA256(pubkey), hex
  pubkey: string       // full secp256k1 pubkey (hex)
  handle?: string      // optional human name
  displayName: string  // derived: handle or agent_a1b2c3d4
  description?: string
  avatar?: string
  homepage?: string
  firstSeenAt: Date
  totalStakedSats: number
  totalEarnedSats: number
}

/**
 * Market state transition event
 * Used internally by MarketEngine for logging and downstream processing.
 */
export interface StateTransitionEvent {
  marketId: string
  fromState: MarketState | null
  toState: MarketState
  triggeredBy: string  // agentId or 'oracle' or 'system'
  anchorTxid?: string  // populated by BSV anchor step
  timestamp: Date
  context?: Record<string, unknown>
}

/**
 * Settlement instruction
 * Generated after market resolution, executed step-by-step.
 */
export interface SettlementInstruction {
  marketId: string
  outcome: Outcome
  resolutionTxid: string  // must exist before payout
  totalPoolSats: number
  feeSats: number         // 1% platform fee
  distributableSats: number  // totalPoolSats - feeSats
  winnerCount: number
  loserCount: number
  stakes: Array<{
    stakeId: string
    agentId: string
    direction: Direction
    amountSats: number
    won: boolean
    payoutSats: number
  }>
}
