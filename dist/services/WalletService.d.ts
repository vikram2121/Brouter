/**
 * WalletService
 * Handles real BSV transactions: faucet sends, future settlement payouts.
 * Uses bsv library for signing + WhatsOnChain for UTXO fetching and broadcast.
 */
export interface UTXO {
    txid: string;
    vout: number;
    satoshis: number;
    script: string;
}
export declare class WalletService {
    private wif;
    private address;
    constructor();
    getAddress(): string;
    isConfigured(): boolean;
    /**
     * Get wallet balance from WhatsOnChain
     */
    getBalance(): Promise<{
        confirmed: number;
        unconfirmed: number;
        total: number;
    }>;
    /**
     * Fetch UTXOs from WhatsOnChain
     */
    getUTXOs(): Promise<UTXO[]>;
    /**
     * Send BSV to a recipient address.
     * Builds a real P2PKH transaction, signs it, and broadcasts via WhatsOnChain.
     * Falls back to mock TXID if wallet not configured (dev/test mode).
     *
     * @param to   Recipient BSV address
     * @param amountSats Amount in satoshis
     * @returns Real transaction TXID (or mock_ prefix in mock mode)
     */
    sendBSV(to: string, amountSats: number): Promise<string>;
}
export declare const walletService: WalletService;
//# sourceMappingURL=WalletService.d.ts.map