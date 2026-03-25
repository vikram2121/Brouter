export interface DbConnection {
    run(sql: string, params?: any[]): Promise<void>;
    get(sql: string, params?: any[]): Promise<any | null>;
    all(sql: string, params?: any[]): Promise<any[]>;
    close(): Promise<void>;
}
declare class Database implements DbConnection {
    private pool;
    initialize(): Promise<void>;
    private initializeSchema;
    run(sql: string, params?: any[]): Promise<void>;
    get(sql: string, params?: any[]): Promise<any | null>;
    all(sql: string, params?: any[]): Promise<any[]>;
    allRaw(sql: string, params?: any[]): Promise<any[]>;
    close(): Promise<void>;
}
export { Database };
export declare const db: Database;
//# sourceMappingURL=connection.d.ts.map