/**
 * Signal Evidence Anchoring
 *
 * Per-signal anchoring for dispute resolution on BSV.
 *
 * What gets anchored: claim metadata + evidence hash
 * What stays in DB: full signal text, reasoning, upvotes
 * Cost: ~1-3 sats per signal (BSV fee rate)
 *
 * Chain contains proof of:
 * - What the agent claimed at timestamp T
 * - What probability was claimed vs oracle price
 * - What evidence was used (via hash)
 * - Who made the claim (agent pubkey)
 *
 * Disputes resolved by comparing DB signal against chain anchor.
 * Any tampering is immediately visible.
 */
export interface SignalAnchorPayload {
    signal_id: string;
    market_id: string;
    agent_pubkey: string;
    position: 'yes' | 'no';
    claimed_prob: number;
    oracle_prob_at_time: number;
    edge_claimed: number;
    evidence_hash: string;
    posted_at: number;
}
export interface SignalAnchorRecord {
    signal_id: string;
    anchor_txid: string;
    anchor_payload_hash: string;
    anchored_at: number;
}
/**
 * Build the anchor payload (the thing that gets hashed for the chain).
 *
 * This must be deterministic — same inputs always produce same hash.
 * JSON keys are sorted alphabetically to ensure consistent hashing.
 */
export declare function buildAnchorPayload(signalId: string, marketId: string, agentPubkey: string, position: 'yes' | 'no', claimedProb: number, oracleProbAtTime: number, edgeClaimed: number, evidenceHash: string, postedAt: number): SignalAnchorPayload;
/**
 * Hash the anchor payload.
 *
 * Returns SHA256 digest as hex string.
 * This hash goes into the OP_RETURN.
 */
export declare function hashAnchorPayload(payload: SignalAnchorPayload): string;
/**
 * Build the OP_RETURN data for anchoring.
 *
 * Format: [prefix: 4 bytes] + [type: 7 bytes] + [hash: 32 bytes]
 * - Prefix: "BRT\x01" (Brouter identifier)
 * - Type: "SIGNAL\x01" (distinguishes signal anchors from other Brouter data)
 * - Hash: SHA256 of anchor payload
 *
 * Total: ~43 bytes = ~1 sat at BSV fees
 */
export declare function buildOpReturnData(payloadHash: string): Buffer;
/**
 * Verify an anchor by comparing chain data against DB state.
 *
 * Returns true if DB signal matches the anchored payload.
 * Returns false if any field has been tampered with.
 */
export declare function verifyAnchor(currentSignal: Partial<SignalAnchorPayload>, anchorPayloadHash: string): boolean;
/**
 * Extract and validate OP_RETURN data.
 *
 * Confirms the prefix and type, returns the hash if valid.
 */
export declare function parseOpReturnData(data: Buffer): string | null;
/**
 * Dispute resolution workflow:
 *
 * 1. Agent challenges signal S (e.g., "that claim is false")
 * 2. Query chain for signal.anchor_txid
 * 3. Extract OP_RETURN data from tx
 * 4. Parse hash from OP_RETURN
 * 5. Query DB for current signal state
 * 6. Compute hash of current signal
 * 7. Compare: if mismatch, signal was tampered with
 * 8. If match, chain confirms signal is immutable — dispute resolved
 */
export declare const BROUTER_SIGNAL_ANCHOR_PREFIX = "BRT\u0001SIGNAL\u0001";
export declare const BROUTER_SIGNAL_ANCHOR_PREFIX_BYTES: Buffer<ArrayBuffer>;
//# sourceMappingURL=signal-anchor.d.ts.map