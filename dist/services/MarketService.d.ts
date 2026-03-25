export interface Market {
    id: string;
    title: string;
    description: string | null;
    domain: 'crypto' | 'macro' | 'sports' | 'politics' | 'science' | 'agent-meta';
    tier: 'rapid' | 'weekly' | 'anchor';
    state: 'PROPOSED' | 'OPEN' | 'LOCKED' | 'RESOLVING' | 'SETTLED' | 'ARCHIVED';
    closesAt: Date;
    resolvesAt: Date;
    resolutionCriteria: string;
    oracleProvider: string | null;
    oracleMarketId: string | null;
    outcome: 'yes' | 'no' | 'void' | null;
    resolvedOutcome: 'yes' | 'no' | 'void' | null;
    totalYesSats: number;
    totalNoSats: number;
    agentCount: number;
    createdBy: string | null;
    createdAt: Date;
    updatedAt: Date;
}
export interface MarketPosition {
    id: string;
    marketId: string;
    agentId: string;
    direction: 'yes' | 'no';
    amountSats: number;
    createdAt: Date;
}
export declare class MarketService {
    private db;
    constructor(db: any);
    create(title: string, description: string | null, domain: "crypto" | "macro" | "sports" | "politics" | "science" | "agent-meta" | undefined, tier: "rapid" | "weekly" | "anchor" | undefined, closesAt: Date, resolvesAt: Date, resolutionCriteria: string, oracleProvider?: string | null, oracleMarketId?: string | null, createdBy?: string | null): Promise<Market>;
    list(tier?: string, domain?: string, state?: string, limit?: number): Promise<Market[]>;
    get(id: string): Promise<Market | null>;
    getPositions(marketId: string): Promise<MarketPosition[]>;
    takePosition(marketId: string, agentId: string, direction: 'yes' | 'no', amountSats: number): Promise<MarketPosition>;
    resolve(marketId: string, outcome: 'yes' | 'no' | 'void', resolvedBy: string): Promise<Market>;
    /**
     * State transition: PROPOSED → OPEN
     * Market becomes available for staking
     */
    open(marketId: string): Promise<Market>;
    /**
     * State transition: OPEN → LOCKED
     * Market closes to new positions; final odds are locked in
     */
    lock(marketId: string): Promise<Market>;
    /**
     * State transition: LOCKED → RESOLVING
     * Market enters resolution phase (waiting for oracle or manual input)
     */
    startResolution(marketId: string): Promise<Market>;
    private mapRow;
}
//# sourceMappingURL=MarketService.d.ts.map