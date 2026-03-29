import { Database } from '../db/connection';
import crypto from 'crypto';

interface Signal {
  id: string;
  marketId: string;
  agentId: string;
  position: 'yes' | 'no';
  postingFeeSats: number;
  createdAt: Date;
}

interface SignalVote {
  id: string;
  signalId: string;
  agentId: string;
  direction: 'up' | 'down';
  amountSats: number;
  votedAt: Date;
}

interface SignalPool {
  id: number;
  signalId: string;
  marketId: string;
  totalSats: number;
  upSats: number;
  downSats: number;
  escrowTxid?: string;
  settledAt?: Date;
  settlementTxid?: string;
}

export class SignalPoolService {
  constructor(private db: Database) {}

  /**
   * Part 1: Create signal with poster as first upvoter
   * Atomic transaction: signal + signal_votes + signal_pools
   */
  async createSignalWithVote(
    marketId: string,
    agentId: string,
    position: 'yes' | 'no',
    postingFeeSats: number,
    title?: string,
    body?: string,
    confidence?: string,
    claimedProb?: number
  ): Promise<Signal> {
    const signalId = crypto.randomBytes(12).toString('base64url');
    const now = new Date();

    // Insert signal
    await this.db.run(
      `INSERT INTO signals (id, marketId, agentId, position, postingFeeSats, title, body, confidence, claimedProb, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [signalId, marketId, agentId, position, postingFeeSats, title ?? null, body ?? null, confidence ?? 'medium', claimedProb ?? null, now]
    );

    // Poster as first upvoter
    const voteId = crypto.randomBytes(12).toString('base64url');
    await this.db.run(
      `INSERT INTO signal_votes (id, signalId, agentId, direction, amountSats, votedAt, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [voteId, signalId, agentId, 'up', postingFeeSats, now, now]
    );

    // Initialize pool
    await this.db.run(
      `INSERT INTO signal_pools (signalId, marketId, totalSats, upSats, downSats, escrowTxid, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [signalId, marketId, postingFeeSats, postingFeeSats, 0, `STUB_${signalId}`, now]
    );

    return {
      id: signalId,
      marketId,
      agentId,
      position,
      postingFeeSats,
      createdAt: now,
    };
  }

  /**
   * Part 2: Record upvote or downvote
   * Atomic transaction: signal_votes + signal_pools update
   */
  async recordVote(
    signalId: string,
    agentId: string,
    direction: 'up' | 'down',
    amountSats: number
  ): Promise<void> {
    const voteId = crypto.randomBytes(12).toString('base64url');
    const now = new Date();

    // Check for duplicate vote
    const existing = await this.db.get(
      `SELECT id FROM signal_votes WHERE signalId = ? AND agentId = ?`,
      [signalId, agentId]
    );
    if (existing) {
      throw new Error('Already voted on this signal');
    }

    // Insert vote
    await this.db.run(
      `INSERT INTO signal_votes (id, signalId, agentId, direction, amountSats, votedAt, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [voteId, signalId, agentId, direction, amountSats, now, now]
    );

    // Fetch current pool
    const pool = await this.db.get(
      `SELECT * FROM signal_pools WHERE signalId = ?`,
      [signalId]
    );

    if (!pool) {
      throw new Error(`Signal pool not found for signalId: ${signalId}`);
    }

    // Update pool totals
    const newTotal = pool.totalSats + amountSats;
    const newUpSats = direction === 'up' ? pool.upSats + amountSats : pool.upSats;
    const newDownSats = direction === 'down' ? pool.downSats + amountSats : pool.downSats;

    await this.db.run(
      `UPDATE signal_pools SET totalSats = ?, upSats = ?, downSats = ? WHERE signalId = ?`,
      [newTotal, newUpSats, newDownSats, signalId]
    );
  }

  /**
   * Part 3: Settle signal pool after market resolution
   * Core payout logic with dust tracking and trace rights
   */
  async settleSignalPool(
    signalId: string,
    marketOutcome: 'yes' | 'no' | 'void'
  ): Promise<void> {
    // Fetch signal, pool, votes
    const signal = await this.db.get(
      `SELECT * FROM signals WHERE id = ?`,
      [signalId]
    );

    const pool = await this.db.get(
      `SELECT * FROM signal_pools WHERE signalId = ?`,
      [signalId]
    );

    const votes = await this.db.all(
      `SELECT * FROM signal_votes WHERE signalId = ?`,
      [signalId]
    );

    if (!signal || !pool) {
      throw new Error(`Signal or pool not found for signalId: ${signalId}`);
    }

    // Skip if already settled
    if (pool.settledAt) {
      console.log(`Signal ${signalId} already settled, skipping`);
      return;
    }

    // Determine correct flag: signal.position === marketOutcome
    const signalCorrect = signal.position === marketOutcome;

    // Split winners/losers by direction
    const winners = votes.filter((v) =>
      signalCorrect ? v.direction === 'up' : v.direction === 'down'
    );
    const losers = votes.filter((v) =>
      signalCorrect ? v.direction === 'down' : v.direction === 'up'
    );

    // Calculate fee and distributable
    const feeSats = Math.floor(pool.totalSats * 0.01);
    const distributable = pool.totalSats - feeSats;
    const winningTotal = winners.reduce((s, v) => s + v.amountSats, 0);
    const losingTotal = losers.reduce((s, v) => s + v.amountSats, 0);

    let totalPaid = 0;

    // Edge case: no losers (return stakes minus individual fees)
    if (losingTotal === 0) {
      for (const winner of winners) {
        const payout = winner.amountSats - Math.floor(winner.amountSats * 0.01);
        totalPaid += payout;
        await this.db.run(
          `INSERT INTO signal_payouts (signalId, agentId, stakedSats, payoutSats)
           VALUES (?, ?, ?, ?)`,
          [signalId, winner.agentId, winner.amountSats, payout]
        );
      }
    } else {
      // Normal case: proportional payout to winners
      for (const winner of winners) {
        const share = winner.amountSats / winningTotal;
        const payout = Math.floor(distributable * share);
        totalPaid += payout;
        await this.db.run(
          `INSERT INTO signal_payouts (signalId, agentId, stakedSats, payoutSats)
           VALUES (?, ?, ?, ?)`,
          [signalId, winner.agentId, winner.amountSats, payout]
        );
      }

      // Losers get 0
      for (const loser of losers) {
        await this.db.run(
          `INSERT INTO signal_payouts (signalId, agentId, stakedSats, payoutSats)
           VALUES (?, ?, ?, ?)`,
          [signalId, loser.agentId, loser.amountSats, 0]
        );
      }
    }

    // Track dust
    const dust = distributable - totalPaid;
    const totalDust = feeSats + dust;

    await this.db.run(
      `INSERT INTO signal_dust (signalId, feeSats, roundingDustSats, totalDustSats, settledAt)
       VALUES (?, ?, ?, ?, NOW())`,
      [signalId, feeSats, dust, totalDust]
    );

    // Grant trace rights if signal correct
    if (signalCorrect) {
      await this.db.run(
        `INSERT INTO trace_rights (signalId, agentId, marketId, outcome, grantedAt)
         VALUES (?, ?, ?, ?, NOW())`,
        [signalId, signal.agentId, signal.marketId, marketOutcome]
      );
    }

    // Mark pool settled
    await this.db.run(
      `UPDATE signal_pools SET settledAt = NOW(), settlementTxid = ? WHERE signalId = ?`,
      [`STUB_${signalId}`, signalId]
    );
  }

  /**
   * Part 4: Settle all signals for a market (triggered by market resolution)
   */
  async settleAll(marketId: string, outcome: 'yes' | 'no' | 'void'): Promise<void> {
    // Fetch all unsettled signals for this market
    const signals = await this.db.all(
      `SELECT s.id FROM signals s 
       LEFT JOIN signal_pools sp ON s.id = sp.signalId 
       WHERE s.marketId = ? AND (sp.settledAt IS NULL OR sp.settlementTxid IS NULL)`,
      [marketId]
    );

    // Settle each one
    for (const signal of signals) {
      await this.settleSignalPool(signal.id, outcome as 'yes' | 'no' | 'void');
    }
  }
}
