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
const dotenv = __importStar(require("dotenv"));
// Load .env BEFORE any other imports that reference process.env
dotenv.config();
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const path_1 = __importDefault(require("path"));
const swagger_ui_express_1 = __importDefault(require("swagger-ui-express"));
const connection_1 = require("./db/connection");
const routes_1 = __importDefault(require("./routes"));
const openapi_1 = require("./openapi");
const ResolutionCron_1 = require("./services/ResolutionCron");
const AnvilService_1 = require("./services/AnvilService");
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';
let dbReady = false;
const anvilService = new AnvilService_1.AnvilService();
// Trust proxy (required for correct IP extraction behind nginx/load balancer)
app.set('trust proxy', 1);
// Middleware
app.use((0, cors_1.default)());
app.use(express_1.default.json());
// Broadcast agent instructions URL on every response
app.use((_req, res, next) => {
    res.setHeader('X-Agent-Instructions', 'https://agent.brouter.ai');
    next();
});
// Health check — always responds, reports DB status
app.get('/api/health', async (_req, res) => {
    // Check Anvil with a generous timeout — don't let it block the health response
    const anvil = await Promise.race([
        anvilService.healthCheck(),
        new Promise((r) => setTimeout(() => r({ ok: false }), 8000)),
    ]);
    res.status(200).json({
        status: 'ok',
        db: dbReady ? 'connected' : 'connecting',
        env: process.env.NODE_ENV || 'development',
        anvil: anvil.ok ? { status: 'connected', height: anvil.height } : { status: 'disconnected', node: process.env.ANVIL_NODE_URL || 'not set' },
    });
});
// agent.brouter.ai — serve agent.md as plain text for machine consumption
// Any AI agent can curl https://agent.brouter.ai and get full onboarding instructions
app.get('*', (req, res, next) => {
    const host = req.hostname || '';
    if (host === 'agent.brouter.ai' || host.startsWith('agent.')) {
        const agentMdPath = path_1.default.join(__dirname, '../agent.md');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('X-Brouter-Agent-Instructions', 'true');
        res.sendFile(agentMdPath, (err) => {
            if (err)
                res.status(500).send('agent.md not found');
        });
        return;
    }
    next();
});
// Routes
app.use('/api/docs', swagger_ui_express_1.default.serve, swagger_ui_express_1.default.setup(openapi_1.openApiSpec, {
    customSiteTitle: 'Brouter API Docs',
    customCss: '.swagger-ui .topbar { background: #0e0f0f; } .swagger-ui .topbar-wrapper img { display: none; } .swagger-ui .topbar-wrapper::after { content: "Brouter API"; color: #00e5b0; font-family: monospace; font-size: 1.1rem; }'
}));
app.use('/api', routes_1.default);
// Serve React frontend in production
if (isProd) {
    const clientDist = path_1.default.join(__dirname, '../client/dist');
    app.use(express_1.default.static(clientDist));
    app.get('*', (_req, res) => {
        res.sendFile(path_1.default.join(clientDist, 'index.html'));
    });
}
// Global error handler
app.use((err, _req, res, _next) => {
    console.error('[Error]', err);
    res.status(500).json({
        success: false,
        error: isProd ? 'Internal server error' : err.message
    });
});
// Start server — always starts, DB connects in background with retries
const start = async () => {
    // Start listening immediately so healthcheck passes
    app.listen(PORT, () => {
        console.log(`🚀 Brouter API running at http://localhost:${PORT}`);
        console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
    });
    // Connect to DB with retries
    let attempts = 0;
    const maxAttempts = 10;
    const retryDelay = 5000;
    const connectDb = async () => {
        while (attempts < maxAttempts) {
            try {
                await connection_1.db.initialize();
                dbReady = true;
                console.log('✅ Database connected');
                // Start autonomous resolution cron (60s interval)
                const cron = new ResolutionCron_1.ResolutionCron(connection_1.db);
                const cronHandle = cron.start(60000);
                // Stop cron on graceful shutdown
                process.on('SIGINT', () => clearInterval(cronHandle));
                process.on('SIGTERM', () => clearInterval(cronHandle));
                return;
            }
            catch (error) {
                attempts++;
                console.error(`⚠️ DB connection attempt ${attempts}/${maxAttempts} failed:`, error);
                if (attempts < maxAttempts) {
                    console.log(`   Retrying in ${retryDelay / 1000}s...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                }
                else {
                    console.error('❌ DB connection failed after all retries. API running without DB.');
                }
            }
        }
    };
    connectDb();
};
start();
// Graceful shutdown
const shutdown = async (signal) => {
    console.log(`\n[${signal}] Shutting down...`);
    await connection_1.db.close();
    process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
//# sourceMappingURL=index.js.map