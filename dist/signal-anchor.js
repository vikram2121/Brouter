"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BROUTER_SIGNAL_ANCHOR_PREFIX_BYTES = exports.BROUTER_SIGNAL_ANCHOR_PREFIX = void 0;
exports.buildAnchorPayload = buildAnchorPayload;
exports.hashAnchorPayload = hashAnchorPayload;
exports.buildOpReturnData = buildOpReturnData;
exports.verifyAnchor = verifyAnchor;
exports.parseOpReturnData = parseOpReturnData;
const crypto_1 = __importDefault(require("crypto"));
/**
 * Build the anchor payload (the thing that gets hashed for the chain).
 *
 * This must be deterministic — same inputs always produce same hash.
 * JSON keys are sorted alphabetically to ensure consistent hashing.
 */
function buildAnchorPayload(signalId, marketId, agentPubkey, position, claimedProb, oracleProbAtTime, edgeClaimed, evidenceHash, postedAt) {
    return {
        signal_id: signalId,
        market_id: marketId,
        agent_pubkey: agentPubkey,
        position,
        claimed_prob: claimedProb,
        oracle_prob_at_time: oracleProbAtTime,
        edge_claimed: edgeClaimed,
        evidence_hash: evidenceHash,
        posted_at: postedAt,
    };
}
/**
 * Hash the anchor payload.
 *
 * Returns SHA256 digest as hex string.
 * This hash goes into the OP_RETURN.
 */
function hashAnchorPayload(payload) {
    const json = JSON.stringify(payload, Object.keys(payload).sort());
    return crypto_1.default.createHash('sha256').update(json).digest('hex');
}
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
function buildOpReturnData(payloadHash) {
    const prefix = Buffer.from('BRT\x01');
    const type = Buffer.from('SIGNAL\x01');
    const hash = Buffer.from(payloadHash, 'hex');
    return Buffer.concat([prefix, type, hash]);
}
/**
 * Verify an anchor by comparing chain data against DB state.
 *
 * Returns true if DB signal matches the anchored payload.
 * Returns false if any field has been tampered with.
 */
function verifyAnchor(currentSignal, anchorPayloadHash) {
    // Require all fields to be present
    if (!currentSignal.signal_id ||
        !currentSignal.market_id ||
        !currentSignal.agent_pubkey ||
        !currentSignal.position ||
        currentSignal.claimed_prob === undefined ||
        currentSignal.oracle_prob_at_time === undefined ||
        currentSignal.edge_claimed === undefined ||
        !currentSignal.evidence_hash ||
        !currentSignal.posted_at) {
        return false;
    }
    const payload = buildAnchorPayload(currentSignal.signal_id, currentSignal.market_id, currentSignal.agent_pubkey, currentSignal.position, currentSignal.claimed_prob, currentSignal.oracle_prob_at_time, currentSignal.edge_claimed, currentSignal.evidence_hash, currentSignal.posted_at);
    const computedHash = hashAnchorPayload(payload);
    return computedHash === anchorPayloadHash;
}
/**
 * Extract and validate OP_RETURN data.
 *
 * Confirms the prefix and type, returns the hash if valid.
 */
function parseOpReturnData(data) {
    if (data.length < 43) {
        return null; // Too short
    }
    const prefix = data.slice(0, 4).toString('ascii');
    const type = data.slice(4, 11).toString('ascii');
    const hash = data.slice(11, 43).toString('hex');
    if (prefix !== 'BRT\x01' || type !== 'SIGNAL\x01') {
        return null; // Wrong prefix or type
    }
    return hash;
}
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
exports.BROUTER_SIGNAL_ANCHOR_PREFIX = 'BRT\x01SIGNAL\x01';
exports.BROUTER_SIGNAL_ANCHOR_PREFIX_BYTES = Buffer.from(exports.BROUTER_SIGNAL_ANCHOR_PREFIX);
//# sourceMappingURL=signal-anchor.js.map