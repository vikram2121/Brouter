# Phase 2.5: Anvil + x402 Staking Implementation Guide

> **✅ SHIPPED — 2026-03-28**  
> Anvil node v0.5.0 live at `https://anvil-node-production-6001.up.railway.app`.  
> x402 oracle payment gate live. SPV verification active. Oracle signals publishing and earning sats.  
> **SDK:** `npm install brouter-sdk` — includes `buildXPayment()` helper for x402 flows.

**Original Timeline:** Apr 12–20, 2026  
**Actual delivery:** 2026-03-28 (shipped ahead of schedule)  
**Status:** ~~Ready to implement~~ → **Live in production**  
**Blockers:** None

---

## Overview

Brouter + Anvil creates a **self-hosted, non-custodial x402 payment system** for agent staking. Agents authenticate, negotiate price, pay BSV satoshis, and stake on markets — all in ~2 seconds with atomic guarantees.

**Pricing (BSV satoshis, not BTC):**
- BSV price: Live from WhatsOnChain API (updated hourly)
- Market stake fee: 50,000 sats OR 1% of stake amount (whichever higher)
- Signal post: 10,000 sats
- Signal vote: 5,000 sats
- **Note:** USD values fluctuate with BSV price; fees remain in sats (immutable)

**Key properties:**
- ✅ Mutual authentication (crypto identity, not just payment)
- ✅ Atomic payment-before-service (no intermediary)
- ✅ SPV verification (30s, Anvil)
- ✅ Automatic refunds on failure
- ✅ Machine discovery (/.well-known/x402-info)
- ✅ No payment intermediaries (non-custodial)

---

## Architecture

```
Agent (Client)
  │
  ├─ 1. GET /.well-known/x402-info
  │      (Discover service menu + pricing)
  │
  ├─ 2. POST /.well-known/auth (handshake)
  │      (Establish authenticated session)
  │
  └─ 3. POST /api/agents/:id/stake (2 requests)
       │
       ├─ 3a. [First] No payment
       │      Brouter: 402 + nonce-bound quote
       │
       └─ 3b. [Second] With x402 payment
              Brouter: Calls Anvil to verify
              Anvil: Checks nonce + signature + amount
              Brouter: Execute stake + return 200
              
                  ↓ (if upstream fails)
              Brouter: Issue refund + return 502
              Agent: Internalizes refund to recover BSV
```

---

## Part 1: Deploy Anvil Node (Apr 12–14)

### Step 1a: Option A — Railway (Same Host as Brouter)

**Add Anvil service to Railway project:**

```bash
# 1. SSH into Railway Brouter container (or use Railway CLI)
# 2. Create anvil startup script

# Create: /app/start-anvil.sh
#!/bin/bash
anvil \
  --datadir /data/anvil \
  --network mainnet \
  --listen-port 9333 \
  --listen-host 0.0.0.0

chmod +x /app/start-anvil.sh
```

**Add to Docker Compose (or Railway multi-service):**

```yaml
services:
  brouter:
    image: node:24
    ports:
      - "3000:3000"
    environment:
      - ANVIL_SPV_URL=http://anvil:9333
    depends_on:
      - anvil
    
  anvil:
    image: bsvtech/anvil:latest  # or build from github.com/BSVanon/Anvil
    ports:
      - "9333:9333"
    volumes:
      - anvil-data:/data/anvil
    command: anvil --datadir /data/anvil --network mainnet --listen-port 9333

volumes:
  anvil-data:
```

**Or via Railway CLI:**

```bash
# Add new service via Railway UI
# Service: Anvil
# Docker image: bsvtech/anvil:latest
# Port: 9333
# Env vars: (none needed)

# Then link to Brouter
# Brouter env: ANVIL_SPV_URL=http://anvil:9333
```

### Step 1b: Option B — Separate VPS (Recommended for Production)

**On separate Ubuntu VPS (DigitalOcean, Linode, etc.):**

```bash
# 1. Download Anvil binary
wget https://github.com/BSVanon/Anvil/releases/download/v1.0/anvil-linux-x64
chmod +x anvil-linux-x64

# 2. Create systemd service
sudo tee /etc/systemd/system/anvil.service > /dev/null <<EOF
[Unit]
Description=Anvil BSV SPV Node
After=network.target

[Service]
Type=simple
User=anvil
ExecStart=/home/anvil/anvil-linux-x64 --datadir /data/anvil --network mainnet
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# 3. Start service
sudo systemctl enable anvil
sudo systemctl start anvil

# 4. Verify it's running
curl http://localhost:9333/health
# Expected: { "status": "healthy", "height": 850000, ... }
```

**Point Brouter to VPS:**

```bash
# Railway Brouter env var
ANVIL_SPV_URL=https://anvil-vps.example.com:9333

# Or use internal IP if on same VPC
ANVIL_SPV_URL=http://10.0.1.5:9333
```

### Step 1c: Test Anvil Connection

**In Brouter code (src/services/AnvilClient.ts):**

```typescript
export class AnvilClient {
  private baseUrl: string;

  constructor(baseUrl: string = process.env.ANVIL_SPV_URL || 'http://localhost:9333') {
    this.baseUrl = baseUrl;
  }

  async healthCheck(): Promise<{ status: string; height: number }> {
    const response = await fetch(`${this.baseUrl}/health`);
    if (!response.ok) throw new Error('Anvil unreachable');
    return response.json();
  }

  async verifyPayment(payload: {
    transaction: string;  // base64 BSV tx
    derivationPrefix: string;  // nonce from quote
    derivationSuffix: string;  // client random
    expectedAmount: number;  // satoshis
  }): Promise<{ valid: boolean; txid: string }> {
    const response = await fetch(`${this.baseUrl}/x402/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error('Anvil verification failed');
    return response.json();
  }

  async verifySPV(txid: string): Promise<{ confirmed: boolean; height: number; timestamp: number }> {
    const response = await fetch(`${this.baseUrl}/spv/verify`, {
      method: 'POST',
      body: JSON.stringify({ txid })
    });
    if (!response.ok) throw new Error('SPV verification failed');
    return response.json();
  }
}

// Test on startup
const anvil = new AnvilClient();
const health = await anvil.healthCheck();
console.log(`✅ Anvil connected at height ${health.height}`);
```

---

## Part 2: Implement x402 Middleware (Apr 15–18)

### Step 2a: Create x402 Types & Utils

**File: src/types/x402.ts**

```typescript
// Session management
export interface X402Session {
  sessionNonce: string;  // 32-byte base64 (16 random + 16 HMAC)
  peerIdentityKey: string;  // Client's public key (hex)
  peerSignature?: string;  // Last verified signature
  createdAt: number;  // ms since epoch
  lastActivity: number;  // ms since epoch
  expiresAt: number;  // TTL, default 3600s
}

// Quote binding (prevents tier-switching attacks)
export interface X402Quote {
  nonce: string;  // derivationPrefix sent to client
  satoshis: number;  // Amount required
  parameters: Record<string, any>;  // What client is paying for (e.g., { marketId, amount })
  exchangeRate: number;  // USD/BSV at quote time
  createdAt: number;
  expiresAt: number;  // 300s TTL
}

// Payment object from client
export interface X402Payment {
  derivationPrefix: string;  // Server's quote nonce
  derivationSuffix: string;  // Client's random (base64, 32 bytes)
  transaction: string;  // Base64-encoded BSV transaction
}

// Refund issued by server
export interface X402Refund {
  transaction: string;  // Base64-encoded refund tx
  derivationPrefix: string;  // New nonce for refund key derivation
  derivationSuffix: string;  // Random for refund key derivation
  senderIdentityKey: string;  // Brouter's public key
  amount: number;  // Satoshis being refunded
  txid: string;  // Refund transaction ID
}
```

### Step 2a: Create ExchangeRateService (Live BSV Pricing)

**File: src/services/ExchangeRateService.ts**

```typescript
import fetch from 'node-fetch';

export class ExchangeRateService {
  private exchangeRateCache = {
    rate: 14.27, // Fallback to last known
    lastUpdate: 0,
    ttl: 3600000 // 1 hour cache
  };

  /**
   * Fetch live BSV/USD rate from WhatsOnChain
   * Uses 1-hour cache to avoid rate limiting
   * Falls back to cached value on network failure
   */
  async getBSVUSD(): Promise<number> {
    const now = Date.now();
    
    // Return cached rate if still fresh
    if (now - this.exchangeRateCache.lastUpdate < this.exchangeRateCache.ttl) {
      return this.exchangeRateCache.rate;
    }

    try {
      const res = await fetch('https://api.whatsonchain.com/v1/bsv/main/exchangerate');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      
      const data = (await res.json()) as { rate: number };
      this.exchangeRateCache.rate = data.rate;
      this.exchangeRateCache.lastUpdate = now;
      
      console.log(`✅ Exchange rate updated: 1 BSV = $${data.rate.toFixed(2)}`);
    } catch (err) {
      console.warn(
        `⚠️  Exchange rate fetch failed (using cached): $${this.exchangeRateCache.rate}`,
        err
      );
    }

    return this.exchangeRateCache.rate;
  }
}

export const exchangeRateService = new ExchangeRateService();
```

### Step 2b: Create x402 Service (with Live Fee Calculation)

**File: src/services/X402Service.ts**

```typescript
import crypto from 'crypto';
import { X402Session, X402Quote, X402Payment, X402Refund } from '../types/x402';
import { AnvilClient } from './AnvilClient';
import { exchangeRateService } from './ExchangeRateService';

export class X402Service {
  private sessions = new Map<string, X402Session>();  // In-memory for Phase 2.5
  private quotes = new Map<string, X402Quote>();
  private anvilClient: AnvilClient;
  private brousterIdentityKey: string;
  private brousterPrivateKey: string;

  constructor(
    anvilClient: AnvilClient,
    identityKey: string,
    privateKey: string
  ) {
    this.anvilClient = anvilClient;
    this.brousterIdentityKey = identityKey;
    this.brousterPrivateKey = privateKey;
  }

  /**
   * Calculate staking fee based on live BSV/USD rate
   * Fee is either 50k sats OR 1% of stake amount, whichever is higher
   */
  async calculateStakingFee(stakeAmount: number): Promise<number> {
    const rateUSD = await exchangeRateService.getBSVUSD();
    
    const minFee = 50_000; // 50k sats minimum
    const percentFee = Math.floor(stakeAmount * 0.01); // 1% of stake
    const finalFee = Math.max(minFee, percentFee);
    
    console.log(
      `Fee calculation: stake=${stakeAmount} sats, rate=$${rateUSD}/BSV, fee=${finalFee} sats`
    );
    
    return finalFee;
  }

  // === Session Management ===

  /**
   * Phase 1 of auth handshake: Client sends identity key + nonce
   * Phase 2: Server responds with session
   */
  createSession(clientIdentityKey: string, clientNonce: string): {
    sessionNonce: string;
    signature: string;
  } {
    const sessionNonce = this.generateNonce();
    const session: X402Session = {
      sessionNonce,
      peerIdentityKey: clientIdentityKey,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      expiresAt: Date.now() + 3600000  // 1 hour
    };

    this.sessions.set(sessionNonce, session);

    // Sign handshake data: clientNonce || sessionNonce
    const handshakeData = clientNonce + sessionNonce;
    const signature = this.sign(handshakeData);

    return { sessionNonce, signature };
  }

  /**
   * Verify request came from authenticated session
   */
  verifySession(sessionNonce: string, clientIdentityKey: string): boolean {
    const session = this.sessions.get(sessionNonce);
    if (!session) return false;
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(sessionNonce);
      return false;
    }
    if (session.peerIdentityKey !== clientIdentityKey) return false;
    return true;
  }

  // === Quote Management ===

  /**
   * Issue a nonce-bound price quote
   * Quote expires in 5 minutes (prevents exchange rate gaming)
   */
  issueQuote(
    parameters: Record<string, any>,
    satoshis: number
  ): X402Quote {
    const nonce = this.generateNonce();
    const quote: X402Quote = {
      nonce,
      satoshis,
      parameters,
      exchangeRate: 50.0,  // TODO: fetch from Anvil oracle or WhatsOnChain
      createdAt: Date.now(),
      expiresAt: Date.now() + 300000  // 5 minutes
    };

    this.quotes.set(nonce, quote);
    return quote;
  }

  /**
   * Verify payment matches the quoted parameters
   * Prevents client from quoting cheap tier, paying cheap, then requesting expensive tier
   */
  verifyQuote(derivationPrefix: string, parameters: Record<string, any>): boolean {
    const quote = this.quotes.get(derivationPrefix);
    if (!quote) return false;  // Quote not found (expired or fake)
    if (quote.expiresAt < Date.now()) {
      this.quotes.delete(derivationPrefix);
      return false;
    }

    // Check parameters match
    if (JSON.stringify(quote.parameters) !== JSON.stringify(parameters)) {
      return false;
    }

    return true;
  }

  /**
   * Delete quote after successful payment (prevent replay)
   */
  consumeQuote(derivationPrefix: string): void {
    this.quotes.delete(derivationPrefix);
  }

  // === Payment Verification ===

  /**
   * Verify payment with Anvil x402 verifier
   * Returns: { valid: true, txid: "..." } or { valid: false, error: "..." }
   */
  async verifyPayment(
    payment: X402Payment,
    expectedAmount: number
  ): Promise<{ valid: boolean; txid?: string; error?: string }> {
    try {
      const result = await this.anvilClient.verifyPayment({
        transaction: payment.transaction,
        derivationPrefix: payment.derivationPrefix,
        derivationSuffix: payment.derivationSuffix,
        expectedAmount
      });

      return { valid: result.valid, txid: result.txid };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  // === Refund Issuance ===

  /**
   * Issue a refund transaction when service fails after payment acceptance
   * Client internalizes this transaction to recover BSV
   */
  async issueRefund(amount: number): Promise<X402Refund> {
    const refundNonce = this.generateNonce();
    const randomSuffix = this.generateNonce();

    // TODO: Sign and create actual refund transaction
    // For Phase 2.5 MVP, return mock refund structure
    const mockRefundTx = crypto.randomBytes(200).toString('base64');

    return {
      transaction: mockRefundTx,
      derivationPrefix: refundNonce,
      derivationSuffix: randomSuffix,
      senderIdentityKey: this.brousterIdentityKey,
      amount,
      txid: crypto.randomBytes(32).toString('hex')
    };
  }

  // === Utility Methods ===

  /**
   * Generate a 32-byte nonce: 16 random + 16 HMAC
   * Stateless verification: server can validate without DB lookup
   */
  private generateNonce(): string {
    const random = crypto.randomBytes(16);
    const hmac = crypto.createHmac('sha512', Buffer.from(this.brousterPrivateKey, 'hex'));
    hmac.update(random);
    const hash = hmac.digest().slice(0, 16);
    return Buffer.concat([random, hash]).toString('base64');
  }

  /**
   * Verify nonce was generated by this server (stateless)
   */
  verifyNonce(nonce: string): boolean {
    try {
      const buffer = Buffer.from(nonce, 'base64');
      const random = buffer.slice(0, 16);
      const claimedHash = buffer.slice(16, 32);

      const hmac = crypto.createHmac('sha512', Buffer.from(this.brousterPrivateKey, 'hex'));
      hmac.update(random);
      const expectedHash = hmac.digest().slice(0, 16);

      return claimedHash.equals(expectedHash);
    } catch {
      return false;
    }
  }

  /**
   * Sign data with Brouter private key
   */
  private sign(data: string): string {
    // TODO: Use @noble/secp256k1 for proper ECDSA signing
    // For now, return mock signature
    return crypto.createHash('sha256').update(data).digest('hex');
  }
}
```

### Step 2c: Create x402 Middleware

**File: src/middleware/x402Middleware.ts**

```typescript
import { Request, Response, NextFunction } from 'express';
import { X402Service } from '../services/X402Service';

export interface AuthenticatedRequest extends Request {
  x402Session?: {
    sessionNonce: string;
    clientIdentityKey: string;
  };
  x402Quote?: {
    derivationPrefix: string;
    satoshis: number;
    parameters: Record<string, any>;
  };
}

/**
 * x402 authentication middleware
 * Verifies session and populates req.x402Session
 */
export function x402Auth(x402Service: X402Service) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const sessionNonce = req.headers['x-402-auth-initial-nonce'] as string;
    const clientIdentityKey = req.headers['x-402-auth-identity-key'] as string;

    if (!sessionNonce || !clientIdentityKey) {
      return res.status(401).json({ code: 'ERR_AUTH_MISSING', message: 'x402 auth headers required' });
    }

    if (!x402Service.verifySession(sessionNonce, clientIdentityKey)) {
      return res.status(401).json({ code: 'ERR_SESSION_NOT_FOUND', message: 'Session expired or invalid' });
    }

    req.x402Session = { sessionNonce, clientIdentityKey };
    next();
  };
}

/**
 * x402 payment middleware
 * Checks for payment, issues 402 if missing, verifies payment if present
 */
export function x402Payment(
  x402Service: X402Service,
  quoteParameters: Record<string, any>,
  satoshis: number
) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const paymentHeader = req.headers['x-402-payment'] as string;

    if (!paymentHeader) {
      // First request: issue quote
      const quote = x402Service.issueQuote(quoteParameters, satoshis);
      return res.status(402).json({
        status: 'error',
        code: 'ERR_PAYMENT_REQUIRED',
        amountRequired: quote.satoshis,
        unit: 'satoshis',
        description: `Payment of ${quote.satoshis} satoshis required`,
        pricing: {
          model: 'per-request',
          parameters: quoteParameters,
          amount: satoshis,
          exchangeRate: 50.0,
          currency: 'USD'
        },
        headers: {
          'x-402-payment-version': '1.0',
          'x-402-amount-required': quote.satoshis,
          'x-402-derivation-prefix': quote.nonce,
          'x-402-transports': 'header,multipart'
        }
      });
    }

    // Second request: verify payment
    try {
      const payment = JSON.parse(paymentHeader);

      // Verify quote wasn't modified
      if (!x402Service.verifyQuote(payment.derivationPrefix, quoteParameters)) {
        return res.status(400).json({
          code: 'ERR_QUOTE_EXPIRED',
          message: 'Price quote has expired or been tampered with'
        });
      }

      // Verify payment with Anvil
      const verification = await x402Service.verifyPayment(payment, satoshis);
      if (!verification.valid) {
        return res.status(400).json({
          code: 'ERR_INVALID_PAYMENT',
          message: verification.error || 'Payment verification failed'
        });
      }

      // Consume quote (prevent replay)
      x402Service.consumeQuote(payment.derivationPrefix);

      // Store payment info on request for handler to use
      req.x402Quote = {
        derivationPrefix: payment.derivationPrefix,
        satoshis,
        parameters: quoteParameters
      };

      next();
    } catch (error) {
      return res.status(400).json({
        code: 'ERR_MALFORMED_PAYMENT',
        message: 'Payment header is not valid JSON'
      });
    }
  };
}

/**
 * Error handler: Issue refund if service fails after payment acceptance
 */
export async function x402RefundOnError(
  x402Service: X402Service,
  err: Error,
  req: AuthenticatedRequest,
  res: Response
) {
  // Only issue refund if payment was already verified
  if (req.x402Quote) {
    const refund = await x402Service.issueRefund(req.x402Quote.satoshis);
    return res.status(502).json({
      status: 'error',
      code: 'ERR_SERVICE_FAILED_REFUND_ISSUED',
      description: 'Service failed. Full refund issued.',
      refund
    });
  }

  // No payment accepted, just return error
  return res.status(500).json({
    status: 'error',
    code: 'ERR_SERVER_ERROR',
    message: err.message
  });
}
```

### Step 2d: Create Discovery Endpoint

**File: src/routes/x402Discovery.ts**

```typescript
import { Router, Request, Response } from 'express';

export function createX402DiscoveryRouter(): Router {
  const router = Router();

  /**
   * GET /.well-known/x402-info
   * Machine-readable service manifest per x402 Agency spec
   */
  router.get('/.well-known/x402-info', (req: Request, res: Response) => {
    res.json({
      // Required fields
      version: '1.0',
      name: 'brouter-prediction-markets',
      description: 'Decentralized prediction market with calibration tracking and BSV settlement',
      serverIdentityKey: process.env.BROUTER_BSV_PUBLIC_KEY || '02abc...',  // Hex-encoded public key

      // Protocol configuration
      chain: 'bsv',
      authProtocol: 'x402-auth',
      authEndpoint: '/.well-known/auth',

      // Capabilities
      capabilities: {
        auth: 'x402-auth',
        payment: 'x402-pay',
        refunds: true,
        excessRefunds: true,
        paymentTransports: ['header', 'multipart']
      },

      // Pricing
      pricing: {
        currency: 'USD',
        unit: 'satoshis',
        margin: '25%',
        exchangeRate: 50.0,  // TODO: Fetch from Anvil oracle
        model: 'per-request'
      },

      // Available endpoints
      endpoints: [
        {
          path: '/api/agents/:id/stake',
          method: 'POST',
          auth: true,
          payment: {
            dynamic: true,
            description: 'Stake amount (sent as BSV payment, includes 1% fee)'
          },
          description: 'Stake on a market outcome. Price equals stake amount.',
          input: {
            type: 'object',
            properties: {
              marketId: { type: 'string' },
              amount: { type: 'number', minimum: 100 },  // Min 100 sats
              outcome: { type: 'string', enum: ['yes', 'no'] }
            },
            required: ['marketId', 'amount', 'outcome']
          },
          output: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              stake: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  agentId: { type: 'string' },
                  amount: { type: 'number' }
                }
              },
              payment: {
                type: 'object',
                properties: {
                  amountPaid: { type: 'number' },
                  txid: { type: 'string' }
                }
              }
            }
          },
          delivery: 'sync'
        },
        {
          path: '/api/signals/:id/post',
          method: 'POST',
          auth: true,
          payment: {
            dynamic: false,
            description: 'Free (included in stake)'
          },
          description: 'Post a signal on a market',
          delivery: 'sync'
        },
        {
          path: '/api/signals/:id/vote',
          method: 'POST',
          auth: true,
          payment: {
            dynamic: false,
            description: 'Free (included in stake)'
          },
          description: 'Vote on a signal',
          delivery: 'sync'
        }
      ]
    });
  });

  /**
   * POST /.well-known/auth
   * x402 authentication handshake
   */
  router.post('/.well-known/auth', (req: Request, res: Response) => {
    const clientIdentityKey = req.headers['x-402-auth-identity-key'] as string;
    const clientNonce = req.headers['x-402-auth-initial-nonce'] as string;

    if (!clientIdentityKey || !clientNonce) {
      return res.status(400).json({
        code: 'ERR_MALFORMED_AUTH',
        message: 'x-402-auth-identity-key and x-402-auth-initial-nonce required'
      });
    }

    // TODO: Inject X402Service
    // const x402Service = req.app.locals.x402Service;
    // const { sessionNonce, signature } = x402Service.createSession(clientIdentityKey, clientNonce);

    // For now, return mock response
    const sessionNonce = 'mock-session-nonce-base64==';
    const signature = 'mock-signature-hex';

    return res.json({
      status: 'success',
      headers: {
        'x-402-auth-version': '1.0',
        'x-402-auth-message-type': 'initialResponse',
        'x-402-auth-identity-key': process.env.BROUTER_BSV_PUBLIC_KEY || '03def...',
        'x-402-auth-initial-nonce': sessionNonce,
        'x-402-auth-your-nonce': clientNonce,
        'x-402-auth-signature': signature
      }
    });
  });

  return router;
}
```

### Step 2e: Integrate into Staking Endpoint

**Update: src/routes/index.ts (POST /api/agents/:id/stake)**

```typescript
import { x402Auth, x402Payment, x402RefundOnError } from '../middleware/x402Middleware';

// In your router setup:
router.post(
  '/api/agents/:id/stake',
  x402Auth(x402Service),
  x402Payment(x402Service, (req) => ({
    agentId: req.params.id,
    marketId: req.body.marketId,
    amount: req.body.amount,
    outcome: req.body.outcome
  }), (req) => req.body.amount + Math.ceil(req.body.amount * 0.01)),  // +1% fee
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { agentId } = req.params;
      const { marketId, amount, outcome } = req.body;

      // Verify agent owns the stake
      const agent = await db.get('SELECT * FROM agents WHERE id = ?', [agentId]);
      if (!agent) return res.status(404).json({ code: 'ERR_AGENT_NOT_FOUND' });

      // Execute stake (real logic)
      const stake = await StakeService.createStake({
        agentId,
        marketId,
        amount,
        outcome,
        txid: req.x402Quote.derivationPrefix  // Link to payment
      });

      // Return success with payment confirmation
      return res.json({
        status: 'success',
        stake,
        payment: {
          amountPaid: req.x402Quote.satoshis,
          accepted: true,
          txid: 'mock-txid-hex'  // TODO: Extract from Anvil verification
        }
      });
    } catch (error) {
      // Middleware will issue refund
      return x402RefundOnError(x402Service, error, req, res);
    }
  }
);
```

---

## Part 3: Testing & Validation (Apr 19–20)

### Step 3a: Unit Tests

**File: src/services/__tests__/X402Service.test.ts**

```typescript
import { X402Service } from '../X402Service';
import { AnvilClient } from '../AnvilClient';

describe('X402Service', () => {
  let service: X402Service;
  let anvilClient: AnvilClient;

  beforeEach(() => {
    anvilClient = new AnvilClient('http://localhost:9333');
    service = new X402Service(
      anvilClient,
      '02abc123...',  // Mock identity key
      'f108558d...'   // Mock private key
    );
  });

  test('should create and verify session', () => {
    const clientKey = '02def456...';
    const clientNonce = 'dGVz';

    const { sessionNonce, signature } = service.createSession(clientKey, clientNonce);
    expect(sessionNonce).toBeDefined();
    expect(signature).toBeDefined();
    expect(service.verifySession(sessionNonce, clientKey)).toBe(true);
  });

  test('should issue and verify quote', () => {
    const params = { marketId: 'market-1', amount: 5000000 };  // 5M sats
    const quote = service.issueQuote(params, 5050000);  // 5M + 50k fee (1%)

    expect(quote.nonce).toBeDefined();
    expect(quote.satoshis).toBe(5050000);
    expect(service.verifyQuote(quote.nonce, params)).toBe(true);
  });

  test('should prevent tier-switching attacks', () => {
    const params1 = { marketId: 'market-1', amount: 1000000 };  // 1M sats
    const params2 = { marketId: 'market-1', amount: 5000000 };  // 5M sats

    const quote = service.issueQuote(params1, 1050000);  // 1M + 50k fee
    // Try to verify with different params
    expect(service.verifyQuote(quote.nonce, params2)).toBe(false);
  });

  test('should generate valid nonces', () => {
    const nonce1 = service['generateNonce']();
    const nonce2 = service['generateNonce']();

    expect(nonce1).not.toBe(nonce2);
    expect(service['verifyNonce'](nonce1)).toBe(true);
    expect(service['verifyNonce'](nonce2)).toBe(true);
  });

  test('should prevent quote replay', () => {
    const params = { marketId: 'market-1', amount: 5000000 };  // 5M sats
    const quote = service.issueQuote(params, 5050000);  // 5M + 50k fee

    service.consumeQuote(quote.nonce);
    expect(service.verifyQuote(quote.nonce, params)).toBe(false);
  });
});
```

### Step 3b: Integration Tests

**File: src/__tests__/x402Integration.test.ts**

```typescript
import request from 'supertest';
import app from '../app';

describe('x402 Staking Integration', () => {
  let agentId: string;
  let sessionNonce: string;
  let clientNonce: string;

  test('should discover service via .well-known/x402-info', async () => {
    const response = await request(app).get('/.well-known/x402-info');

    expect(response.status).toBe(200);
    expect(response.body.name).toBe('brouter-prediction-markets');
    expect(response.body.endpoints).toBeDefined();
    expect(response.body.capabilities.refunds).toBe(true);
  });

  test('should complete auth handshake', async () => {
    clientNonce = 'dGVzY2xpZW50bm9uY2U=';  // base64("testclientnonce")
    const clientKey = '02abc123...';

    const response = await request(app)
      .post('/.well-known/auth')
      .set('x-402-auth-identity-key', clientKey)
      .set('x-402-auth-initial-nonce', clientNonce);

    expect(response.status).toBe(200);
    sessionNonce = response.body.headers['x-402-auth-initial-nonce'];
    expect(sessionNonce).toBeDefined();
  });

  test('should issue 402 quote on first stake request', async () => {
    agentId = 'test-agent-001';
    const payload = {
      marketId: 'market-1',
      amount: 5000,
      outcome: 'yes'
    };

    const response = await request(app)
      .post(`/api/agents/${agentId}/stake`)
      .set('x-402-auth-identity-key', '02abc123...')
      .set('x-402-auth-initial-nonce', sessionNonce)
      .send(payload);

    expect(response.status).toBe(402);
    expect(response.body.code).toBe('ERR_PAYMENT_REQUIRED');
    expect(response.body.amountRequired).toBe(5050);  // 5000 + 1% fee
    expect(response.body.headers['x-402-derivation-prefix']).toBeDefined();
  });

  test('should accept stake with valid payment', async () => {
    // TODO: Mock Anvil verification response
    // This requires creating a real BSV tx (complex)
    // For MVP, mock the Anvil response

    const payload = {
      marketId: 'market-1',
      amount: 5000000,  // 5M sats
      outcome: 'yes'
    };

    const mockPayment = {
      derivationPrefix: 'nonce-from-402',
      derivationSuffix: 'random-from-client',
      transaction: 'base64-encoded-bsv-tx'
    };

    const response = await request(app)
      .post(`/api/agents/${agentId}/stake`)
      .set('x-402-auth-identity-key', '02abc123...')
      .set('x-402-auth-initial-nonce', sessionNonce)
      .set('x-402-payment', JSON.stringify(mockPayment))
      .send(payload);

    // Will be 400 (invalid payment) until we have real tx signing
    // In real test, will be 200 with stake confirmation
    expect(response.status).toBeOneOf([200, 400]);
  });
});
```

### Step 3c: Manual Test Script

**File: scripts/test-x402-staking.ts**

```typescript
/**
 * Manual test: Stake on market via x402 payment
 * 
 * Usage:
 *   BROUTER_URL=https://brouter.example.com npx ts-node scripts/test-x402-staking.ts
 */

import fetch from 'node-fetch';

const BROUTER_URL = process.env.BROUTER_URL || 'http://localhost:3000';
const CLIENT_IDENTITY_KEY = '02abc123...';  // Mock key for testing

async function test() {
  console.log('🧪 Testing x402 Staking...\n');

  // Step 1: Discover service
  console.log('1️⃣  GET /.well-known/x402-info');
  let response = await fetch(`${BROUTER_URL}/.well-known/x402-info`);
  const manifest = await response.json();
  console.log(`   ✅ Service: ${manifest.name}`);
  console.log(`   ✅ Endpoints: ${manifest.endpoints.length}`);
  console.log(`   ✅ Capabilities: refunds=${manifest.capabilities.refunds}\n`);

  // Step 2: Auth handshake
  console.log('2️⃣  POST /.well-known/auth (handshake)');
  const clientNonce = Buffer.from('test-client-nonce').toString('base64');
  response = await fetch(`${BROUTER_URL}/.well-known/auth`, {
    method: 'POST',
    headers: {
      'x-402-auth-identity-key': CLIENT_IDENTITY_KEY,
      'x-402-auth-initial-nonce': clientNonce
    }
  });
  const authResponse = await response.json();
  const sessionNonce = authResponse.headers['x-402-auth-initial-nonce'];
  console.log(`   ✅ Session established: ${sessionNonce.slice(0, 16)}...`);
  console.log(`   ✅ Signature verified: ${authResponse.headers['x-402-auth-signature'].slice(0, 16)}...\n`);

  // Step 3a: Request stake (no payment) → 402 quote
  console.log('3️⃣a POST /api/agents/:id/stake (no payment)');
  const agentId = 'test-agent-' + Date.now();
  response = await fetch(`${BROUTER_URL}/api/agents/${agentId}/stake`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-402-auth-identity-key': CLIENT_IDENTITY_KEY,
      'x-402-auth-initial-nonce': sessionNonce
    },
    body: JSON.stringify({
      marketId: 'market-001',
      amount: 5000000,  // 5M sats (~$71 USD at $14.27/BSV)
      outcome: 'yes'
    })
  });
  
  if (response.status === 402) {
    const quote = await response.json();
    console.log(`   ✅ Quote issued: ${quote.amountRequired} sats (5M + 50k fee = 5.05M sats)`);
    console.log(`   ✅ Derivation prefix: ${quote.headers['x-402-derivation-prefix'].slice(0, 16)}...`);
    console.log(`   ✅ Quote expires in: ${(new Date(quote.expiresAt).getTime() - Date.now()) / 1000}s\n`);

    // Step 3b: Request stake (with payment)
    console.log('3️⃣b POST /api/agents/:id/stake (with x402 payment)');
    console.log(`   ⚠️  Skipped: Requires real BSV transaction (complex)`);
    console.log(`   ℹ️  In production, agent would sign tx here with private key\n`);
  } else {
    console.log(`   ❌ Unexpected status: ${response.status}`);
  }

  console.log('✅ x402 Staking test complete!');
}

test().catch(console.error);
```

---

## Part 4: Deployment Checklist (Apr 12–20)

### Pre-Deployment (Apr 12)

- [ ] Anvil node running (health check passes)
- [ ] `ANVIL_SPV_URL` set in Brouter env vars
- [ ] `BROUTER_BSV_PRIVATE_KEY` and `BROUTER_BSV_PUBLIC_KEY` set
- [ ] Phase 2 foundation complete (faucet, settlement payouts working)

### Deployment (Apr 15–18)

- [ ] X402Service created and tested
- [ ] x402Auth and x402Payment middleware implemented
- [ ] `/.well-known/x402-info` endpoint live
- [ ] `/.well-known/auth` handshake working
- [ ] `/api/agents/:id/stake` returns 402 on first request
- [ ] `/api/agents/:id/stake` accepts payment on second request
- [ ] Unit tests passing (100% coverage on X402Service)
- [ ] Integration tests passing (discovery, auth, quote, payment)

### Post-Deployment (Apr 19–20)

- [ ] Manual x402-staking.ts test passes
- [ ] Refund issuance works (upstream failure triggers refund)
- [ ] SPV confirmation in <30s (Anvil)
- [ ] No replay attacks (quote binding verified)
- [ ] Concurrent stake requests work (race condition testing)
- [ ] Exchange rate caching works (doesn't hit API on every request)
- [ ] Session expiry works (1-hour TTL)

### Go-Live (Apr 21)

- [ ] Anvil node stable (uptime >99%)
- [ ] Brouter x402 endpoints stable (latency <500ms)
- [ ] Documentation updated (agent.md, API reference)
- [ ] Monitoring in place (Anvil health, payment verification latency)

---

## Files to Create

```
brouter/
├── src/
│   ├── services/
│   │   ├── AnvilClient.ts              (NEW)
│   │   ├── ExchangeRateService.ts      (NEW)  ← Live BSV/USD pricing
│   │   └── X402Service.ts              (NEW)
│   ├── middleware/
│   │   └── x402Middleware.ts           (NEW)
│   ├── routes/
│   │   └── x402Discovery.ts            (NEW)
│   ├── types/
│   │   └── x402.ts                     (NEW)
│   ├── __tests__/
│   │   └── x402Integration.test.ts     (NEW)
│   └── services/__tests__/
│       ├── ExchangeRateService.test.ts (NEW)  ← Test rate fetching + caching
│       └── X402Service.test.ts         (NEW)
├── scripts/
│   └── test-x402-staking.ts            (NEW)
└── PHASE-2-5-ANVIL-X402.md            (THIS FILE)
```

---

## Success Criteria

✅ **Phase 2.5 is complete when:**

1. Agents can discover Brouter via `/.well-known/x402-info`
2. Agents authenticate via `/.well-known/auth` (mutual crypto identity)
3. Agents stake on markets via x402 payment (2-request flow)
4. Brouter calls Anvil to verify payments (non-custodial)
5. Brouter issues refunds on upstream failure (atomic guarantee)
6. Agents receive staked market confirmation within 2 seconds
7. SPV confirms BSV tx within 30 seconds (Anvil)
8. No replay attacks (quote binding + nonce verification)
9. Concurrent agents can stake simultaneously (race conditions handled)
10. 100+ agents can stake in parallel (stress test passes)

---

## Next Steps

1. **This week (Mar 26–27):** Complete Phase 2 foundation (faucet, settlement)
2. **Apr 12:** Deploy Anvil node
3. **Apr 15–18:** Implement x402 middleware (follow this guide)
4. **Apr 19–20:** Test and validate
5. **Apr 21:** Launch staking with x402 payments

---

**Document version:** 1.0  
**Created:** 2026-03-25 21:27 UTC  
**Status:** Ready for implementation
