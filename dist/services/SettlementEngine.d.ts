/**
 * SettlementEngine
 * Handles market settlement after resolution.
 * Strict order: BSV anchor FIRST → DB updates → payouts
 * If anchor fails, settlement is blocked. If anything else fails, it can be replayed.
 */
import { Outcome, SettlementInstruction } from '../types/market-v3';
export interface SettlementConfig {
    bsvClient?: any;
    walletAddress: string;
    walletPrivKey: string;
    network: 'testnet' | 'mainnet';
}
export declare class SettlementEngine {
    private db;
    private walletAddress;
    private walletPrivKey;
    private network;
    constructor(config: SettlementConfig, db: any);
    /**
     * Execute full settlement for a market
     * Order of operations (CRITICAL):
     * 1. Anchor resolution to BSV (if fails, stop — market is unresolved)
     * 2. Write resolution to market record
     * 3. Calculate payouts from stakes
     * 4. Write payout records
     * 5. Send BSV payouts to winners
     * 6. Update agent calibration scores
     * 7. Mark market as SETTLED
     *
     * @param marketId Market to settle
     * @param outcome YES/NO/VOID
     * @param resolverAgentId Agent who triggered settlement (or 'oracle')
     * @returns Settlement instruction with payout details
     */
    settle(marketId: string, outcome: Outcome, resolverAgentId: string): Promise<SettlementInstruction>;
    /**
     * Anchor resolution data to BSV as OP_RETURN
     * Format: OP_RETURN "BROUTER_RESOLUTION" <JSON payload>
     * All fields are verifiable on-chain.
     *
     * Payload structure:
     * {
     *   "market_id": "market-123",
     *   "outcome": "yes",
     *   "resolved_at": "2026-03-23T06:30:00Z",
     *   "resolver": "agent-oracle"
     * }
     *
     * @returns TXID if successful, null if failed
     */
    private anchorToBSV;
    /**
     * Calculate payouts from stakes
     * Rules:
     * - VOID: 100% refund all stakes
     * - YES: YES stakes get share of distributable pool (total - 1% fee) proportional to amount
     * - NO: NO stakes get share of distributable pool (total - 1% fee) proportional to amount
     *
     * @param distributableSats The pool available for distribution after platform fee deduction
     */
    private calculatePayouts;
    /**
     * Write payout records to DB
     * Updates stakes table with payoutSats, updates agent earnings
     */
    private writePayouts;
    /**
     * Send BSV payouts to winners
     * Groups by agent, creates one BSV transaction per agent
     *
     * Transaction structure:
     * - Inputs: Brouter's unspent outputs (fees from staking)
     * - Outputs: One per winner agent + change back to Brouter
     * - OP_RETURN with market settlement metadata
     *
     * @returns Array of payout transaction TXIDs
     */
    private sendPayouts;
    /**
     * Generate mock BSV address for testing
     * Real: look up agent's registered address from DB
     */
    private generateMockAddress;
    /**
     * Update agent calibration scores (Brier score)
     * One row per agent per domain, updated after each market settles
     *
     * Brier Score: Mean squared error between predicted probability and actual outcome
     * Formula: BS = (1/N) * Σ (predicted_prob - actual)^2
     * Where actual = 1.0 if agent bet on winner, 0.0 if loser
     *
     * We track cumulative Brier and count per domain for averaging
     */
    private updateCalibration;
    /**
     * Build unsigned BSV transaction
     * Simplified: single input, multiple outputs
     */
    private buildTransaction;
    /**
     * Sign transaction with private key
     * Uses ECDSA (secp256k1) signature
     */
    private signTransaction;
    /**
     * Extract TXID from signed transaction
     * TXID = double SHA256 of serialized tx (reversed)
     */
    private txidFromSignedTx;
    /**
     * Serialize transaction for signing (simplified BIP143)
     */
    private serializeForSigning;
    /**
     * Serialize transaction to hex for broadcast
     */
    private serializeTransaction;
    /**
     * Convert P2PKH address to locking script
     */
    private addressToScript;
    /**
     * Convert WIF private key to hex
     */
    private wifToHex;
    private getMarketRow;
    private getStakes;
}
//# sourceMappingURL=SettlementEngine.d.ts.map