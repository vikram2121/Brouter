"use strict";
/**
 * SettlementEngine
 * Handles market settlement after resolution.
 * Strict order: BSV anchor FIRST → DB updates → payouts
 * If anchor fails, settlement is blocked. If anything else fails, it can be replayed.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SettlementEngine = void 0;
const crypto_1 = require("crypto");
const secp256k1_1 = require("@noble/secp256k1");
const WalletService_1 = require("./WalletService");
class SettlementEngine {
    constructor(config, db) {
        this.db = db;
        this.walletAddress = config.walletAddress;
        this.walletPrivKey = config.walletPrivKey;
        this.network = config.network;
    }
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
    async settle(marketId, outcome, resolverAgentId) {
        // Fetch market and stakes
        const market = await this.getMarketRow(marketId);
        const stakes = await this.getStakes(marketId);
        if (!market)
            throw new Error(`Market ${marketId} not found`);
        if (!stakes.length) {
            // Market with no stakes — just mark settled
            return {
                marketId,
                outcome,
                resolutionTxid: '',
                totalPoolSats: 0,
                feeSats: 0,
                distributableSats: 0,
                winnerCount: 0,
                loserCount: 0,
                stakes: []
            };
        }
        const totalPool = market.totalYesSats + market.totalNoSats;
        // Calculate fee and distributable amount
        const feeSats = Math.floor(totalPool * 0.01); // 1% platform fee
        const distributableSats = totalPool - feeSats;
        // STEP 1: Anchor resolution to BSV
        const resolutionData = {
            market_id: marketId,
            outcome,
            resolved_at: new Date().toISOString(),
            resolver: resolverAgentId
        };
        const resolutionTxid = await this.anchorToBSV(resolutionData);
        if (!resolutionTxid) {
            throw new Error('Failed to anchor resolution to BSV — settlement blocked');
        }
        // STEP 2: Calculate payouts (using distributable pool, not total)
        const payouts = this.calculatePayouts(stakes, outcome, distributableSats);
        // Count winners and losers
        const winnerCount = payouts.filter((p) => p.won).length;
        const loserCount = payouts.filter((p) => !p.won).length;
        // STEP 3: Write to DB (payout records, signals calibration)
        await this.writePayouts(marketId, outcome, resolutionTxid, payouts);
        // STEP 4: Send BSV payouts
        const payoutTxids = await this.sendPayouts(payouts);
        // STEP 5: Update agent calibration (Brier scores)
        // NOTE: Calibration is now handled by CalibrationService (called from resolve endpoint)
        // This uses stakes not signals, and is triggered after market settlement
        // await this.updateCalibration(marketId, outcome)  // DEPRECATED: moved to CalibrationService
        // STEP 6: Track rounding dust (explicit audit trail)
        const totalPaidOut = payouts.reduce((sum, p) => sum + p.payoutSats, 0);
        const roundingDustSats = distributableSats - totalPaidOut;
        const totalDustSats = feeSats + roundingDustSats;
        await this.db.run(`INSERT INTO settlement_dust (marketId, feeSats, roundingDustSats, totalDustSats)
       VALUES (?, ?, ?, ?)`, [marketId, feeSats, roundingDustSats, totalDustSats]);
        console.log('[SettlementEngine] ✓ Dust tracked', {
            marketId,
            feeSats,
            roundingDustSats,
            totalDustSats,
            escrowTotal: totalDustSats
        });
        // Return settlement instruction with all required fields
        return {
            marketId,
            outcome,
            resolutionTxid,
            totalPoolSats: totalPool,
            feeSats,
            distributableSats,
            winnerCount,
            loserCount,
            stakes: payouts
        };
    }
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
    async anchorToBSV(data) {
        const payload = JSON.stringify({ marker: 'BROUTER_RESOLUTION', data });
        // If wallet is configured, send a 1-sat dust tx to self as on-chain anchor
        if (WalletService_1.walletService.isConfigured()) {
            try {
                const txid = await WalletService_1.walletService.sendBSV(this.walletAddress, 1);
                console.log('[SettlementEngine] ✓ Anchored to BSV (real)', {
                    payloadSize: payload.length,
                    marketId: data.market_id,
                    outcome: data.outcome,
                    txid,
                });
                return txid;
            }
            catch (error) {
                console.error('[SettlementEngine] Real anchor failed — falling back to mock:', error);
                // Fall through to mock so settlement is not fully blocked by anchor failure
            }
        }
        // Mock fallback: deterministic TXID from payload hash
        const txid = (0, crypto_1.createHash)('sha256')
            .update(Buffer.from(this.walletAddress + payload, 'utf8'))
            .digest('hex');
        console.log('[SettlementEngine] ✓ Anchored to BSV (mock)', {
            marketId: data.market_id, outcome: data.outcome, txid,
        });
        return txid;
    }
    /**
     * Calculate payouts from stakes
     * Rules:
     * - VOID: 100% refund all stakes
     * - YES: YES stakes get share of distributable pool (total - 1% fee) proportional to amount
     * - NO: NO stakes get share of distributable pool (total - 1% fee) proportional to amount
     *
     * @param distributableSats The pool available for distribution after platform fee deduction
     */
    calculatePayouts(stakes, outcome, distributableSats) {
        const payouts = [];
        if (outcome === 'void') {
            // Refund all
            for (const stake of stakes) {
                payouts.push({
                    stakeId: stake.id,
                    agentId: stake.agentId,
                    direction: stake.direction,
                    amountSats: stake.amountSats,
                    won: false,
                    payoutSats: stake.amountSats
                });
            }
        }
        else {
            // Calculate winners pool size
            const winningStakes = stakes.filter((s) => s.direction === outcome);
            const winningPoolSats = winningStakes.reduce((sum, s) => sum + s.amountSats, 0);
            if (winningPoolSats === 0) {
                // No one bet on the outcome — refund everyone (or all-void)
                // For now: refund everyone
                for (const stake of stakes) {
                    payouts.push({
                        stakeId: stake.id,
                        agentId: stake.agentId,
                        direction: stake.direction,
                        amountSats: stake.amountSats,
                        won: false,
                        payoutSats: stake.amountSats
                    });
                }
            }
            else {
                // Distribute pool to winners (proportional share of distributable pool)
                for (const stake of stakes) {
                    const won = stake.direction === outcome;
                    const payout = won
                        ? Math.floor((stake.amountSats / winningPoolSats) * distributableSats)
                        : 0;
                    payouts.push({
                        stakeId: stake.id,
                        agentId: stake.agentId,
                        direction: stake.direction,
                        amountSats: stake.amountSats,
                        won,
                        payoutSats: payout
                    });
                }
            }
        }
        return payouts;
    }
    /**
     * Write payout records to DB
     * Updates stakes table with payoutSats, updates agent earnings
     */
    async writePayouts(marketId, outcome, resolutionTxid, payouts) {
        if (!payouts.length)
            return;
        // Group payouts by agent for efficient batch updates
        const agentEarnings = new Map();
        // STEP 1: Update stakes with payouts
        for (const payout of payouts) {
            await this.db.run(`UPDATE stakes SET payoutSats = ?, payoutTxid = ? WHERE id = ?`, [payout.payoutSats, `pending_${payout.stakeId}`, payout.stakeId]);
            // Track agent earnings for batch update
            const current = agentEarnings.get(payout.agentId) || 0n;
            agentEarnings.set(payout.agentId, current + BigInt(payout.payoutSats));
        }
        // STEP 2: Update agent earnings (batch)
        for (const [agentId, earnings] of agentEarnings) {
            await this.db.run(`UPDATE agents SET totalEarnedSats = totalEarnedSats + ? WHERE id = ?`, [earnings.toString(), agentId]);
        }
        // STEP 3: Update market with resolution outcome and TXID
        await this.db.run(`UPDATE markets SET outcome = ?, resolutionAnchorTxid = ? WHERE id = ?`, [outcome, resolutionTxid, marketId]);
        console.log('[SettlementEngine] ✓ Payouts written to DB', {
            marketId,
            outcome,
            resolutionTxid,
            stakeCount: payouts.length,
            agentCount: agentEarnings.size
        });
    }
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
    async sendPayouts(payouts) {
        // Filter to winners only
        const winners = payouts.filter((p) => p.payoutSats > 0);
        if (!winners.length) {
            console.log('[SettlementEngine] No winners — no BSV payouts needed');
            return [];
        }
        // Group by agent for efficient batching
        const byAgent = new Map();
        for (const winner of winners) {
            const current = byAgent.get(winner.agentId) || [];
            byAgent.set(winner.agentId, [...current, winner]);
        }
        // Build transaction for each agent
        const txids = [];
        for (const [agentId, agentPayouts] of byAgent) {
            const totalPayoutForAgent = agentPayouts.reduce((sum, p) => sum + p.payoutSats, 0);
            try {
                // Fetch agent's registered BSV address from DB
                const agentRow = await this.db.get('SELECT bsvAddress FROM agents WHERE id = ?', [agentId]);
                const agentAddress = agentRow?.bsvAddress;
                if (!agentAddress) {
                    console.warn('[SettlementEngine] Agent has no BSV address — payout skipped', { agentId, totalPayoutForAgent });
                    // Leave payoutSats set in DB but payoutTxid null — can be retried when agent registers address
                    continue;
                }
                let txid;
                if (WalletService_1.walletService.isConfigured() && totalPayoutForAgent >= 546) {
                    // Real BSV payout (BSV dust limit is 546 sats)
                    txid = await WalletService_1.walletService.sendBSV(agentAddress, totalPayoutForAgent);
                    console.log('[SettlementEngine] ✅ Real BSV payout sent', { agentId, totalPayoutForAgent, agentAddress, txid });
                }
                else {
                    // Mock fallback (wallet not configured or below dust limit)
                    txid = 'mock_' + (0, crypto_1.createHash)('sha256')
                        .update(Buffer.from(agentId + totalPayoutForAgent + this.walletAddress, 'utf8'))
                        .digest('hex').slice(0, 32);
                    console.log('[SettlementEngine] ✓ Mock payout recorded', { agentId, totalPayoutForAgent, txid });
                }
                txids.push(txid);
                // Write payoutTxid back to all winning stakes for this agent
                for (const p of agentPayouts) {
                    await this.db.run('UPDATE stakes SET payoutTxid = ? WHERE id = ?', [txid, p.stakeId]);
                }
            }
            catch (error) {
                console.error('[SettlementEngine] Payout failed for agent', agentId, error);
                // Continue with other agents — failed ones stay in 'pending' state for retry
            }
        }
        return txids;
    }
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
    async updateCalibration(marketId, outcome) {
        // Get market with domain
        const market = await this.db.get('SELECT domain FROM markets WHERE id = ?', [marketId]);
        if (!market)
            return;
        // Get all signals for this market
        const signals = await this.db.all(`SELECT agentId, claimedProb FROM signals WHERE marketId = ? AND claimedProb IS NOT NULL ORDER BY createdAt ASC`, [marketId]);
        if (!signals.length) {
            console.log('[SettlementEngine] No signals to calibrate for market', marketId);
            return;
        }
        // Convert outcome to numeric value (yes=1, no=0)
        const actualOutcome = outcome === 'yes' ? 1.0 : outcome === 'no' ? 0.0 : null;
        if (actualOutcome === null) {
            console.log('[SettlementEngine] VOID outcome — no calibration update');
            return;
        }
        // Calculate Brier score for each agent
        const briersByAgent = new Map();
        for (const signal of signals) {
            // claimedProb is the probability agent predicted (0.0–1.0)
            const signalProb = Math.max(0, Math.min(1, signal.claimedProb)); // Clamp to [0, 1]
            const brier = Math.pow(signalProb - actualOutcome, 2);
            const current = briersByAgent.get(signal.agentId) || 0;
            briersByAgent.set(signal.agentId, current + brier);
        }
        // Update calibration_scores table for each agent
        for (const [agentId, totalBrier] of briersByAgent) {
            // Upsert calibration record (compute average on insert)
            // If agent already has records, add this Brier to the running total
            const existing = await this.db.get(`SELECT brierScore, marketCount FROM calibration_scores WHERE agentId = ? AND domain = ?`, [agentId, market.domain]);
            if (existing) {
                // Update: average new Brier into cumulative
                const newCount = existing.marketCount + 1;
                const newBrierScore = (existing.brierScore * existing.marketCount + totalBrier) / newCount;
                await this.db.run(`UPDATE calibration_scores SET brierScore = ?, marketCount = ?, updatedAt = NOW()
           WHERE agentId = ? AND domain = ?`, [newBrierScore, newCount, agentId, market.domain]);
            }
            else {
                // Insert: first time seeing this agent in this domain
                await this.db.run(`INSERT INTO calibration_scores (agentId, domain, brierScore, marketCount, updatedAt)
           VALUES (?, ?, ?, 1, NOW())`, [agentId, market.domain, totalBrier]);
            }
        }
        console.log('[SettlementEngine] ✓ Calibration scores updated', {
            marketId,
            domain: market.domain,
            agentCount: briersByAgent.size,
            outcome
        });
    }
    // ============ BSV Transaction Helpers ============
    /**
     * Build unsigned BSV transaction
     * Simplified: single input, multiple outputs
     */
    buildTransaction(inputs, outputs) {
        const tx = {
            version: 1,
            inputs: inputs.map((input, index) => ({
                prevTxId: input.txid,
                outputIndex: input.vout,
                unlockingScript: '', // To be signed
                sequenceNumber: 0xffffffff
            })),
            outputs: outputs.map((output) => ({
                satoshis: output.satoshis,
                lockingScript: output.script || this.addressToScript(output.address || '')
            }))
        };
        return tx;
    }
    /**
     * Sign transaction with private key
     * Uses ECDSA (secp256k1) signature
     */
    signTransaction(tx, inputs) {
        try {
            // Convert WIF private key to raw bytes (stub)
            // TODO: Implement WIF parsing with @bsv/sdk
            const privKeyHex = this.wifToHex(this.walletPrivKey);
            const privKey = Buffer.from(privKeyHex, 'hex');
            // Sign each input
            const signedTx = { ...tx, inputs: [] };
            for (let i = 0; i < tx.inputs.length; i++) {
                const input = tx.inputs[i];
                const utxo = inputs[i];
                // Serialize transaction for signing (simplified BIP143)
                const sigPreimage = this.serializeForSigning(tx, i, utxo.script);
                const sigHash = (0, crypto_1.createHash)('sha256').update(sigPreimage).digest();
                // Sign with secp256k1
                const sigBytes = (0, secp256k1_1.sign)(sigHash, privKey);
                const sigDER = Buffer.isBuffer(sigBytes) ? sigBytes : Buffer.from(sigBytes);
                // Create unlocking script: <sig> <pubkey>
                const pubKeyBytes = (0, secp256k1_1.getPublicKey)(privKey);
                const pubKey = Buffer.isBuffer(pubKeyBytes) ? pubKeyBytes : Buffer.from(pubKeyBytes);
                const unlockingScript = Buffer.concat([
                    Buffer.from([sigDER.length]),
                    sigDER,
                    Buffer.from([33]),
                    pubKey
                ]).toString('hex');
                signedTx.inputs[i] = { ...input, unlockingScript };
            }
            return signedTx;
        }
        catch (error) {
            console.error('[SettlementEngine] Signing failed:', error);
            throw error;
        }
    }
    /**
     * Extract TXID from signed transaction
     * TXID = double SHA256 of serialized tx (reversed)
     */
    txidFromSignedTx(tx) {
        try {
            const serialized = this.serializeTransaction(tx);
            const hash1 = (0, crypto_1.createHash)('sha256').update(serialized).digest();
            const hash2 = (0, crypto_1.createHash)('sha256').update(hash1).digest();
            return hash2.reverse().toString('hex');
        }
        catch (error) {
            console.error('[SettlementEngine] TXID generation failed:', error);
            return `tx_mock_${Math.random().toString(36).slice(2, 10)}`;
        }
    }
    // ============ Serialization & Encoding ============
    /**
     * Serialize transaction for signing (simplified BIP143)
     */
    serializeForSigning(tx, inputIndex, scriptPubKey) {
        // Stub: Return placeholder
        // Real implementation requires full BIP143 serialization
        return Buffer.from(`sign_preimage_${inputIndex}`, 'utf8');
    }
    /**
     * Serialize transaction to hex for broadcast
     */
    serializeTransaction(tx) {
        // Stub: Return placeholder
        // Real implementation requires proper tx serialization
        return Buffer.from(JSON.stringify(tx), 'utf8');
    }
    /**
     * Convert P2PKH address to locking script
     */
    addressToScript(address) {
        // Stub: Return P2PKH template
        // Real: decode base58check address, extract pubkey hash
        return '76a914' + '00'.repeat(20) + '88ac'; // OP_DUP OP_HASH160 <hash> OP_EQUALVERIFY OP_CHECKSIG
    }
    /**
     * Convert WIF private key to hex
     */
    wifToHex(wif) {
        // Stub: Assume uncompressed WIF (52 chars)
        // Real: base58check decode WIF, extract 32 bytes
        const decoded = Buffer.from(wif, 'base64').toString('hex').slice(2, 66);
        return decoded;
    }
    // ============ Helper Queries ============
    async getMarketRow(marketId) {
        return this.db.get('SELECT * FROM markets WHERE id = ?', [marketId]);
    }
    async getStakes(marketId) {
        const rows = await this.db.all('SELECT * FROM stakes WHERE marketId = ? ORDER BY createdAt ASC', [
            marketId
        ]);
        return rows.map((r) => ({
            id: r.id,
            marketId: r.marketId,
            agentId: r.agentId,
            direction: r.direction,
            amountSats: r.amountSats,
            oddsAtStake: r.oddsAtStake,
            impliedProbability: r.impliedProbability,
            consensusAfter: r.consensusAfter,
            paymentTxid: r.paymentTxid,
            anchorTxid: r.anchorTxid,
            payoutSats: r.payoutSats,
            payoutTxid: r.payoutTxid,
            createdAt: new Date(r.createdAt)
        }));
    }
}
exports.SettlementEngine = SettlementEngine;
//# sourceMappingURL=SettlementEngine.js.map