"use strict";
/**
 * WalletService
 * Handles real BSV transactions: faucet sends, future settlement payouts.
 * Uses bsv library for signing + WhatsOnChain for UTXO fetching and broadcast.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.walletService = exports.WalletService = void 0;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bsv = require('bsv');
class WalletService {
    constructor() {
        this.wif = process.env.BROUTER_BSV_PRIVATE_KEY || '';
        if (this.wif) {
            try {
                const privKey = bsv.PrivKey.fromWif(this.wif);
                const pubKey = bsv.PubKey.fromPrivKey(privKey);
                this.address = bsv.Address.fromPubKey(pubKey).toString();
            }
            catch {
                console.error('[WalletService] Invalid BROUTER_BSV_PRIVATE_KEY — falling back to mock mode');
                this.address = '';
            }
        }
        else {
            this.address = '';
        }
        console.log('[WalletService] Initialized:', {
            realMode: !!this.wif && !!this.address,
            address: this.address || '(mock mode)',
        });
    }
    getAddress() {
        return this.address;
    }
    isConfigured() {
        return !!this.wif && !!this.address;
    }
    /**
     * Get wallet balance from WhatsOnChain
     */
    async getBalance() {
        if (!this.address)
            return { confirmed: 0, unconfirmed: 0, total: 0 };
        const res = await fetch(`https://api.whatsonchain.com/v1/bsv/main/address/${this.address}/balance`);
        if (!res.ok)
            throw new Error(`WhatsOnChain balance error: ${res.status}`);
        const data = await res.json();
        return { confirmed: data.confirmed || 0, unconfirmed: data.unconfirmed || 0, total: (data.confirmed || 0) + (data.unconfirmed || 0) };
    }
    /**
     * Fetch UTXOs from WhatsOnChain
     */
    async getUTXOs() {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(`https://api.whatsonchain.com/v1/bsv/main/address/${this.address}/unspent`, { signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok)
            throw new Error(`WhatsOnChain UTXO error: ${res.status}`);
        const utxos = await res.json();
        return utxos.map(u => ({
            txid: u.tx_hash,
            vout: u.tx_pos,
            satoshis: u.value,
            script: bsv.Address.fromString(this.address).toTxOutScript().toHex()
        }));
    }
    /**
     * Send BSV to a recipient address.
     * Builds a real P2PKH transaction, signs it, and broadcasts via WhatsOnChain.
     * Falls back to mock TXID if wallet not configured (dev/test mode).
     *
     * @param to   Recipient BSV address
     * @param amountSats Amount in satoshis
     * @returns Real transaction TXID (or mock_ prefix in mock mode)
     */
    async sendBSV(to, amountSats) {
        if (!this.isConfigured()) {
            console.warn('[WalletService] No private key — returning mock TXID');
            return 'mock_' + Date.now();
        }
        // 1. Validate recipient address
        try {
            bsv.Address.fromString(to);
        }
        catch {
            throw new Error(`Invalid BSV recipient address: ${to}`);
        }
        // 2. Fetch UTXOs
        const utxos = await this.getUTXOs();
        if (!utxos.length)
            throw new Error('No UTXOs available in server wallet');
        // 3. Coin selection — smallest-first to keep UTXO set clean
        const FEE_PER_KB = 500; // sats/kb, conservative
        const ESTIMATED_TX_BYTES = 250; // typical P2PKH tx
        const fee = Math.ceil((ESTIMATED_TX_BYTES / 1000) * FEE_PER_KB);
        const needed = amountSats + fee;
        const sorted = [...utxos].sort((a, b) => a.satoshis - b.satoshis);
        const selected = [];
        let totalIn = 0;
        for (const u of sorted) {
            selected.push(u);
            totalIn += u.satoshis;
            if (totalIn >= needed)
                break;
        }
        if (totalIn < needed) {
            throw new Error(`Insufficient wallet balance: have ${totalIn} sats, need ${needed} (${amountSats} + ${fee} fee)`);
        }
        const change = totalIn - amountSats - fee;
        // 4. Build transaction
        const privKey = bsv.PrivKey.fromWif(this.wif);
        const pubKey = bsv.PubKey.fromPrivKey(privKey);
        const fromAddr = bsv.Address.fromPubKey(pubKey);
        const toAddr = bsv.Address.fromString(to);
        const txBuilder = new bsv.TxBuilder();
        txBuilder.setFeePerKbNum(FEE_PER_KB);
        txBuilder.setChangeAddress(fromAddr);
        // Add inputs
        for (const u of selected) {
            const txHashBuf = Buffer.from(u.txid, 'hex').reverse();
            const scriptPubKey = fromAddr.toTxOutScript();
            txBuilder.inputFromPubKeyHash(txHashBuf, u.vout, bsv.TxOut.fromProperties(new bsv.Bn(u.satoshis), scriptPubKey));
        }
        // Add output to recipient
        txBuilder.outputToAddress(bsv.Bn(amountSats), toAddr);
        // Build + sign
        txBuilder.build({ useAllInputs: true });
        txBuilder.signWithKeyPairs([bsv.KeyPair.fromPrivKey(privKey)]);
        const tx = txBuilder.tx;
        const txHex = tx.toHex();
        const txid = tx.id();
        console.log(`[WalletService] Broadcasting tx: ${txid} (${amountSats} sats → ${to})`);
        // 5. Broadcast via WhatsOnChain
        const broadcastRes = await fetch('https://api.whatsonchain.com/v1/bsv/main/tx/raw', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ txhex: txHex })
        });
        if (!broadcastRes.ok) {
            const errText = await broadcastRes.text();
            throw new Error(`Broadcast failed (${broadcastRes.status}): ${errText}`);
        }
        const broadcastedTxid = (await broadcastRes.json());
        console.log(`[WalletService] ✅ Broadcast confirmed txid: ${broadcastedTxid}`);
        return broadcastedTxid || txid;
    }
}
exports.WalletService = WalletService;
exports.walletService = new WalletService();
//# sourceMappingURL=WalletService.js.map