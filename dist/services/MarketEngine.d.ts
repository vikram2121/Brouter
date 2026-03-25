/**
 * MarketEngine
 * Manages six-state market lifecycle: PROPOSED → OPEN → LOCKED → RESOLVING → SETTLED → ARCHIVED
 * Every state transition must be anchored on-chain before DB update.
 * Uses MarketStateLog for immutable audit trail.
 */
import { Market, MarketState, MarketDomain, MarketTier } from '../types/market-v3';
export interface CreateMarketInput {
    title: string;
    description?: string;
    domain: MarketDomain;
    tier: MarketTier;
    closesAt: Date;
    resolvesAt: Date;
    resolutionCriteria: string;
    oracleProvider?: string;
    oracleMarketId?: string;
    oracleField?: string;
    oracleThreshold?: string;
    minDurationHours?: number;
    minStakeToOpenSats?: number;
    createdBy?: string;
}
export interface StateTransitionInput {
    marketId: string;
    toState: MarketState;
    triggeredBy: string;
    anchorTxid?: string;
    context?: Record<string, unknown>;
}
export declare class MarketEngine {
    private db;
    private stateLog;
    constructor(db: any);
    /**
     * Create a new market (starts in PROPOSED state)
     */
    create(input: CreateMarketInput): Promise<Market>;
    /**
     * Get market by ID
     */
    get(id: string): Promise<Market>;
    /**
     * List markets by state
     */
    listByState(state: MarketState, limit?: number): Promise<Market[]>;
    /**
     * List markets by domain
     */
    listByDomain(domain: MarketDomain, limit?: number): Promise<Market[]>;
    /**
     * List open markets (accepting stakes)
     */
    listOpen(limit?: number): Promise<Market[]>;
    /**
     * Transition market to new state
     * Strict validation: only allowed transitions, anchored on-chain first
     *
     * Allowed transitions:
     * - PROPOSED → OPEN (if minStakeToOpenSats met)
     * - OPEN → LOCKED (at closesAt time)
     * - LOCKED → RESOLVING (at resolvesAt time, oracle checked)
     * - RESOLVING → SETTLED (with outcome)
     * - SETTLED → ARCHIVED (manual, cleanup)
     */
    transitionState(input: StateTransitionInput): Promise<Market>;
    /**
     * Validate that a state transition is legal
     */
    private validateTransition;
    /**
     * Get state history for a market
     */
    getHistory(marketId: string): Promise<import("../types/market-v3").MarketStateLog[]>;
    /**
     * Get current state
     */
    getState(marketId: string): Promise<MarketState>;
    private mapRow;
}
//# sourceMappingURL=MarketEngine.d.ts.map