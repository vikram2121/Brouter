/**
 * WalletService
 * Handles BSV wallet operations: balance checking, faucet sends, payout transactions
 */
export interface UTXO {
    txid: string;
    vout: number;
    satoshis: number;
    script: string;
}
export declare class WalletService {
    private privateKeyHex;
    private walletAddress;
    private network;
    constructor();
    /**
     * Get Brouter's wallet address
     */
    getAddress(): string;
    /**
     * Get wallet balance from BSV API
     * Uses WhatsOnChain API for balance queries (free, no auth needed)
     */
    getBalance(): Promise<{
        confirmed: number;
        unconfirmed: number;
        total: number;
    }>;
    /**
     * Get UTXOs for the Brouter wallet
     * Used for building transactions
     */
    getUTXOs(): Promise<UTXO[]>;
    /**
     * Send BSV to a recipient address
     * Used for faucet claims and settlement payouts
     *
     * @param to Recipient BSV address
     * @param amountSats Amount in satoshis
     * @param data Optional OP_RETURN data (as array of buffers)
     * @returns Transaction TXID
     */
    sendBSV(to: string, amountSats: number, data?: Buffer[]): Promise<string>;
    /**
     * Send BSV to multiple recipients in a single transaction (batching for efficiency)
     *
     * @param recipients Array of {address, satoshis}
     * @returns Transaction TXID
     */
    batchSend(recipients: Array<{
        address: string;
        satoshis: number;
    }>): Promise<string>;
    /**
     * Generate mock TXID (for testing; replace with real broadcast in Phase 2)
     */
    private generateMockTxid;
}
export declare const walletService: WalletService;
//# sourceMappingURL=WalletService.d.ts.map