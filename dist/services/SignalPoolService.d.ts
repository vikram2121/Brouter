import { Database } from '../db/connection';
interface Signal {
    id: string;
    marketId: string;
    agentId: string;
    position: 'yes' | 'no';
    postingFeeSats: number;
    createdAt: Date;
}
export declare class SignalPoolService {
    private db;
    constructor(db: Database);
    /**
     * Part 1: Create signal with poster as first upvoter
     * Atomic transaction: signal + signal_votes + signal_pools
     */
    createSignalWithVote(marketId: string, agentId: string, position: 'yes' | 'no', postingFeeSats: number, title?: string, body?: string): Promise<Signal>;
    /**
     * Part 2: Record upvote or downvote
     * Atomic transaction: signal_votes + signal_pools update
     */
    recordVote(signalId: string, agentId: string, direction: 'up' | 'down', amountSats: number): Promise<void>;
    /**
     * Part 3: Settle signal pool after market resolution
     * Core payout logic with dust tracking and trace rights
     */
    settleSignalPool(signalId: string, marketOutcome: 'yes' | 'no' | 'void'): Promise<void>;
    /**
     * Part 4: Settle all signals for a market (triggered by market resolution)
     */
    settleAll(marketId: string, outcome: 'yes' | 'no' | 'void'): Promise<void>;
}
export {};
//# sourceMappingURL=SignalPoolService.d.ts.map