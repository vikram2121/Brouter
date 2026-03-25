/**
 * Express App Setup
 * 
 * Core application configuration, middleware, and route mounting
 */

import express, { Express, Request, Response, NextFunction } from "express";
import { config } from "dotenv";

// Load environment variables
config();

const app: Express = express();

// ─────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const startTime = Date.now();
  
  res.on("finish", () => {
    const duration = Date.now() - startTime;
    console.log(
      `${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`
    );
  });
  
  next();
});

// CORS
app.use((req: Request, res: Response, next: NextFunction) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization"
  );
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
app.get("/api/health", (req: Request, res: Response) => {
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

app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error("[Error]", err);
  
  res.status(err.status || 500).json({
    error: err.message || "Internal Server Error",
    status: err.status || 500,
  });
});

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: "Not Found",
    path: req.path,
  });
});

export default app;
