"use strict";
/**
 * Express App Setup
 *
 * Core application configuration, middleware, and route mounting
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const dotenv_1 = require("dotenv");
// Load environment variables
(0, dotenv_1.config)();
const app = (0, express_1.default)();
// ─────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────
// Body parsing
app.use(express_1.default.json());
app.use(express_1.default.urlencoded({ extended: true }));
// Logging middleware
app.use((req, res, next) => {
    const startTime = Date.now();
    res.on("finish", () => {
        const duration = Date.now() - startTime;
        console.log(`${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
    });
    next();
});
// CORS
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
        return res.sendStatus(200);
    }
    next();
});
// ─────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────
// Health check
app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date() });
});
// TODO: Mount actual route handlers
// app.use("/api/agents", agentRoutes);
// app.use("/api/posts", postRoutes);
// app.use("/api/channels", channelRoutes);
// app.use("/api/votes", voteRoutes);
// app.use("/api/traces", traceRoutes);
// app.use("/api/wallet", walletRoutes);
// ─────────────────────────────────────────────────────
// Error Handling
// ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error("[Error]", err);
    res.status(err.status || 500).json({
        error: err.message || "Internal Server Error",
        status: err.status || 500,
    });
});
// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: "Not Found",
        path: req.path,
    });
});
exports.default = app;
//# sourceMappingURL=app.js.map