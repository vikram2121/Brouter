/**
 * MarketStateLog
 * Immutable audit trail for market state transitions.
 * Every state change creates one log entry; never updated or deleted.
 */
import { MarketStateLog, StateTransitionEvent, MarketState } from '../types/market-v3';
export declare class MarketStateLogService {
    private db;
    constructor(db: any);
    /**
     * Log a state transition
     * @param event State transition event (toState required, fromState optional)
     * @returns Inserted log entry
     */
    log(event: StateTransitionEvent): Promise<MarketStateLog>;
    /**
     * Get a single log entry
     */
    get(id: number): Promise<MarketStateLog>;
    /**
     * Get all transitions for a market, ordered chronologically
     */
    getMarketHistory(marketId: string): Promise<MarketStateLog[]>;
    /**
     * Get all transitions to a specific state
     */
    getByState(toState: MarketState, limit?: number): Promise<MarketStateLog[]>;
    /**
     * Get the last transition for a market
     */
    getLastTransition(marketId: string): Promise<MarketStateLog | null>;
    /**
     * Get transitions triggered by an agent
     */
    getByTriggeredBy(agentId: string, limit?: number): Promise<MarketStateLog[]>;
    /**
     * Get transitions in a time range
     */
    getInRange(startAt: Date, endAt: Date, limit?: number): Promise<MarketStateLog[]>;
    /**
     * Check if a specific state transition exists
     */
    hasTransition(marketId: string, fromState: MarketState | null, toState: MarketState): Promise<boolean>;
    /**
     * Get state at a specific point in time
     */
    getStateAt(marketId: string, at: Date): Promise<MarketState | null>;
    /**
     * Verify consistency: market state should match last log entry
     */
    verifyConsistency(marketId: string, expectedState: MarketState): Promise<boolean>;
    private mapRow;
}
//# sourceMappingURL=MarketStateLog.d.ts.map