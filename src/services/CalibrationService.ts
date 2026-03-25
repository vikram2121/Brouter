import { Database } from '../db/connection';

interface Stake {
  id: string;
  agentId: string;
  position: 'yes' | 'no';
  impliedProbability: number;
}

interface Market {
  id: string;
  domain: 'crypto' | 'macro' | 'sports' | 'politics' | 'science' | 'agent-meta';
}

interface CalibrationScore {
  agentId: string;
  domain: string;
  brierSum: number;
  sampleCount: number;
  score: number;
}

export class CalibrationService {
  constructor(private db: Database) {}

  /**
   * Update calibration scores after market settlement
   * Called for all stakers in resolved market
   * Computes Brier score: (forecast - actual)^2
   *
   * Stores brier_sum and sample_count separately to allow
   * recomputation if needed (e.g., voided market backfill)
   */
  async updateCalibration(
    marketId: string,
    outcome: 'yes' | 'no' | 'void'
  ): Promise<void> {
    // Skip calibration for VOID outcomes (no signal feedback)
    if (outcome === 'void') {
      console.log(`Market ${marketId} resolved as VOID, skipping calibration`);
      return;
    }

    // Fetch all stakes for market
    const stakes = await this.db.all(
      `SELECT * FROM stakes WHERE marketId = ?`,
      [marketId]
    );

    // Fetch market (for domain)
    const market = await this.db.get(
      `SELECT * FROM markets WHERE id = ?`,
      [marketId]
    );

    if (!market) {
      throw new Error(`Market not found: ${marketId}`);
    }

    // Calculate actual: outcome === 'yes' ? 1.0 : 0.0
    const actual = outcome === 'yes' ? 1.0 : 0.0;

    // For each stake: compute Brier score and update calibration
    for (const stake of stakes) {
      // forecast = stake.direction === 'yes' ? impliedProbability : 1 - impliedProbability
      const forecast =
        stake.direction === 'yes'
          ? stake.impliedProbability
          : 1 - stake.impliedProbability;

      // brier = (forecast - actual)^2
      const brier = Math.pow(forecast - actual, 2);

      // Upsert calibration_scores
      const existing = await this.db.get(
        `SELECT * FROM calibration_scores WHERE agentId = ? AND domain = ?`,
        [stake.agentId, market.domain]
      );

      if (!existing) {
        // New entry
        await this.db.run(
          `INSERT INTO calibration_scores (agentId, domain, brierSum, sampleCount, score, updatedAt)
           VALUES (?, ?, ?, ?, ?, NOW())`,
          [stake.agentId, market.domain, Number(brier).toFixed(6), 1, Number(brier).toFixed(6)]
        );
      } else {
        // Update existing (parse DECIMAL from DB as number)
        const existingSum = parseFloat(existing.brierSum);
        const newCount = existing.sampleCount + 1;
        const newSum = existingSum + brier;
        const newScore = newSum / newCount;

        await this.db.run(
          `UPDATE calibration_scores 
           SET brierSum = ?, sampleCount = ?, score = ?, updatedAt = NOW()
           WHERE agentId = ? AND domain = ?`,
          [Number(newSum).toFixed(6), newCount, Number(newScore).toFixed(6), stake.agentId, market.domain]
        );
      }
    }
  }

  /**
   * Get running average for an agent in a domain
   */
  async getScore(agentId: string, domain: string): Promise<CalibrationScore | null> {
    const result = await this.db.get(
      `SELECT agentId, domain, brierSum, sampleCount, score 
       FROM calibration_scores 
       WHERE agentId = ? AND domain = ?`,
      [agentId, domain]
    );

    return result || null;
  }

  /**
   * List top agents in a domain by calibration score
   * Lower Brier score is better (0 = perfect calibration, 1 = worst)
   */
  async topAgents(domain: string, limit: number = 10): Promise<CalibrationScore[]> {
    return this.db.all(
      `SELECT agentId, domain, brierSum, sampleCount, score 
       FROM calibration_scores 
       WHERE domain = ? 
       ORDER BY score ASC 
       LIMIT ${Math.max(1, Math.floor(limit))}`,
      [domain]
    );
  }
}
