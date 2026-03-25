"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.db = exports.Database = void 0;
const promise_1 = __importDefault(require("mysql2/promise"));
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
class Database {
    constructor() {
        this.pool = null;
    }
    async initialize() {
        const host = process.env.DB_HOST || 'localhost';
        const user = process.env.DB_USER || 'root';
        const password = process.env.DB_PASSWORD || '';
        const database = process.env.DB_NAME || 'brouter';
        this.pool = promise_1.default.createPool({
            host,
            user,
            password,
            database,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0,
            namedPlaceholders: true,
            decimalNumbers: true,
            dateStrings: false
        });
        // Handle pool-level errors (prevents unhandled rejection crashes)
        this.pool.on('connection', (connection) => {
            connection.on('error', (err) => {
                console.error('[DB] Connection error:', err);
            });
        });
        // Initialize schema if needed
        await this.initializeSchema();
        // Run migrations (add any missing columns, etc.)
        const { runMigrations } = await Promise.resolve().then(() => __importStar(require('./migrations')));
        await runMigrations(this);
        console.log(`✓ Database connected: ${host}/${database}`);
    }
    async initializeSchema() {
        try {
            // Check if agents table exists
            const result = await this.all("SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'agents'", [process.env.DB_NAME || 'brouter']);
            if (result.length === 0) {
                console.log('📦 Initializing database schema...');
                const schemaPath = path_1.default.join(__dirname, 'schema.sql');
                const schema = await promises_1.default.readFile(schemaPath, 'utf-8');
                // Split by semicolon and execute each statement
                // Filter out comment-only lines, keep SQL statements
                const statements = schema
                    .split(';')
                    .map((s) => {
                    // Remove lines that are only comments
                    const lines = s.split('\n');
                    const sqlLines = lines.filter((line) => {
                        const trimmed = line.trim();
                        return trimmed.length > 0 && !trimmed.startsWith('--');
                    });
                    return sqlLines.join('\n').trim();
                })
                    .filter((s) => s.length > 0);
                let execCount = 0;
                for (const statement of statements) {
                    try {
                        await this.run(statement);
                        execCount++;
                        // Log first 100 chars of each executed statement for debugging
                        const preview = statement.substring(0, 100).replace(/\n/g, ' ');
                        console.log(`  [${execCount}] ${preview}...`);
                    }
                    catch (err) {
                        console.error(`[DB Schema] Failed to execute statement ${execCount + 1}:`, err);
                        console.error(`  Statement: ${statement.substring(0, 200)}`);
                        throw err;
                    }
                }
                console.log(`✓ Schema initialized (${execCount} statements executed)`);
            }
        }
        catch (error) {
            console.error('Schema initialization error:', error);
            throw error;
        }
    }
    async run(sql, params = []) {
        if (!this.pool)
            throw new Error('Database not initialized');
        const connection = await this.pool.getConnection();
        try {
            await connection.execute(sql, params);
        }
        finally {
            connection.release();
        }
    }
    async get(sql, params = []) {
        if (!this.pool)
            throw new Error('Database not initialized');
        const connection = await this.pool.getConnection();
        try {
            const [rows] = await connection.execute(sql, params);
            const arr = rows;
            return arr.length > 0 ? arr[0] : null;
        }
        finally {
            connection.release();
        }
    }
    async all(sql, params = []) {
        if (!this.pool)
            throw new Error('Database not initialized');
        const connection = await this.pool.getConnection();
        try {
            const [rows] = await connection.execute(sql, params);
            return rows;
        }
        finally {
            connection.release();
        }
    }
    // Use query() instead of execute() for dynamic IN clauses (array expansion)
    async allRaw(sql, params = []) {
        if (!this.pool)
            throw new Error('Database not initialized');
        const connection = await this.pool.getConnection();
        try {
            const [rows] = await connection.query(sql, params);
            return rows;
        }
        finally {
            connection.release();
        }
    }
    async close() {
        if (this.pool) {
            await this.pool.end();
            this.pool = null;
            console.log('✓ Database connection closed');
        }
    }
}
exports.Database = Database;
exports.db = new Database();
//# sourceMappingURL=connection.js.map