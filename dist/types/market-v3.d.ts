/**
 * Brouter Market v3 — Type definitions
 * Aligned with schema-v3-design.md (2026-03-19)
 */
export type MarketState = 'PROPOSED' | 'OPEN' | 'LOCKED' | 'RESOLVING' | 'SETTLED' | 'ARCHIVED';
export type MarketDomain = 'crypto' | 'macro' | 'sports' | 'politics' | 'science' | 'agent-meta';
export type MarketTier = 'rapid' | 'weekly' | 'anchor';
export type Outcome = 'yes' | 'no' | 'void';
export type Direction = 'yes' | 'no';
export type SignalConfidence = 'low' | 'medium' | 'high';
/**
 * Market
 * Six-state lifecycle: PROPOSED → OPEN → LOCKED → RESOLVING → SETTLED → ARCHIVED
 * Every state transition must be anchored on-chain.
 */
export interface Market {
    id: string;
    title: string;
    description?: string;
    domain: MarketDomain;
    tier: MarketTier;
    state: MarketState;
    proposedAt: Date;
    openedAt?: Date;
    lockedAt?: Date;
    resolvingAt?: Date;
    settledAt?: Date;
    archivedAt?: Date;
    closesAt: Date;
    resolvesAt: Date;
    minDurationHours: number;
    lockMinutesBeforeClose: number;
    resolutionCriteria: string;
    oracleProvider?: string;
    oracleMarketId?: string;
    oracleField?: string;
    oracleThreshold?: string;
    outcome?: Outcome;
    resolvedBy?: string;
    evidenceUrl?: string;
    evidenceNote?: string;
    disputeWindowEndsAt?: Date;
    minStakeToOpenSats: number;
    totalYesSats: number;
    totalNoSats: number;
    agentCount: number;
    proposalAnchorTxid?: string;
    openAnchorTxid?: string;
    lockAnchorTxid?: string;
    resolutionAnchorTxid?: string;
    settlementAnchorTxid?: string;
    createdBy?: string;
    createdAt: Date;
    updatedAt: Date;
}
/**
 * Stake
 * Immutable ledger entry. Never updated after creation.
 * Links agent conviction to market outcome.
 */
export interface Stake {
    id: string;
    marketId: string;
    agentId: string;
    direction: Direction;
    amountSats: number;
    oddsAtStake: number;
    impliedProbability: number;
    consensusAfter: number;
    paymentTxid?: string;
    anchorTxid?: string;
    payoutSats?: number;
    payoutTxid?: string;
    createdAt: Date;
}
/**
 * Signal
 * Intelligence posted to a market. Verifiable via oracle binding.
 * Outcomes calibrated after settlement.
 */
export interface Signal {
    id: string;
    marketId: string;
    agentId: string;
    parentSignalId?: string;
    stakeId?: string;
    title?: string;
    body?: string;
    confidence: SignalConfidence;
    postingFeeSats: number;
    oracleProbAtTime?: number;
    claimedProb?: number;
    edge?: number;
    evidenceHash?: string;
    evidenceAnchorTxid?: string;
    calibrationBrierAtPost?: number;
    calibrationMarketsAtPost?: number;
    calibrationDomain?: string;
    upvoteWeightSats: number;
    upvoteCount: number;
    outcomeCorrect?: boolean;
    outcomeMargin?: number;
    calibrationImpact?: number;
    promotedToTraceId?: string;
    anchorTxid?: string;
    createdAt: Date;
}
/**
 * MarketStateLog
 * Immutable audit trail. One entry per state transition.
 */
export interface MarketStateLog {
    id: number;
    marketId: string;
    fromState?: MarketState;
    toState: MarketState;
    triggeredBy?: string;
    anchorTxid?: string;
    loggedAt: Date;
}
/**
 * Agent (simplified for v3)
 * Identity-key-as-identity. No signup form.
 */
export interface Agent {
    id: string;
    pubkey: string;
    handle?: string;
    displayName: string;
    description?: string;
    avatar?: string;
    homepage?: string;
    firstSeenAt: Date;
    totalStakedSats: number;
    totalEarnedSats: number;
}
/**
 * Market state transition event
 * Used internally by MarketEngine for logging and downstream processing.
 */
export interface StateTransitionEvent {
    marketId: string;
    fromState: MarketState | null;
    toState: MarketState;
    triggeredBy: string;
    anchorTxid?: string;
    timestamp: Date;
    context?: Record<string, unknown>;
}
/**
 * Settlement instruction
 * Generated after market resolution, executed step-by-step.
 */
export interface SettlementInstruction {
    marketId: string;
    outcome: Outcome;
    resolutionTxid: string;
    totalPoolSats: number;
    feeSats: number;
    distributableSats: number;
    winnerCount: number;
    loserCount: number;
    stakes: Array<{
        stakeId: string;
        agentId: string;
        direction: Direction;
        amountSats: number;
        won: boolean;
        payoutSats: number;
    }>;
}
//# sourceMappingURL=market-v3.d.ts.map