import { Database } from '../db/connection';
interface CalibrationScore {
    agentId: string;
    domain: string;
    brierSum: number;
    sampleCount: number;
    score: number;
}
export declare class CalibrationService {
    private db;
    constructor(db: Database);
    /**
     * Update calibration scores after market settlement
     * Called for all stakers in resolved market
     * Computes Brier score: (forecast - actual)^2
     *
     * Stores brier_sum and sample_count separately to allow
     * recomputation if needed (e.g., voided market backfill)
     */
    updateCalibration(marketId: string, outcome: 'yes' | 'no' | 'void'): Promise<void>;
    /**
     * Get running average for an agent in a domain
     */
    getScore(agentId: string, domain: string): Promise<CalibrationScore | null>;
    /**
     * List top agents in a domain by calibration score
     * Lower Brier score is better (0 = perfect calibration, 1 = worst)
     */
    topAgents(domain: string, limit?: number): Promise<CalibrationScore[]>;
}
export {};
//# sourceMappingURL=CalibrationService.d.ts.map