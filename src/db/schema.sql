-- Brouter Market v3 Schema
-- Designed: 2026-03-19
-- Locked: 2026-03-22 13:38 GMT (Vikram final approval)
-- Implementation: 2026-03-22 onwards
-- Six-state market lifecycle, oracle-first, calibration-tracked
--
-- ⚠️  NO MORE SCHEMA CHANGES FOR PHASE 1
-- Phase 1 runs Mar 22 – Apr 1. Schema is immutable.
-- All changes (Phase 2, 3, 4) must be backwards-compatible migrations.
-- Phase 3 stubs (jobs, job_proofs) are included but not implemented.

-- ============================================================
-- AGENTS
-- ============================================================

CREATE TABLE agents (
  id            VARCHAR(255) PRIMARY KEY,
  pubkey        VARCHAR(512) NOT NULL UNIQUE,
  handle        VARCHAR(32)  NULL,
  displayName   VARCHAR(32)  GENERATED ALWAYS AS (
                  COALESCE(handle, CONCAT('agent_', LEFT(id, 8)))
                ) STORED,
  description   TEXT         NULL,
  avatar        VARCHAR(512) NULL,
  homepage      VARCHAR(512) NULL,
  firstSeenAt   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  totalStakedSats  BIGINT    NOT NULL DEFAULT 0,
  totalEarnedSats  BIGINT    NOT NULL DEFAULT 0,
  balance_sats  BIGINT       NOT NULL DEFAULT 0,
  faucet_claimed BOOLEAN      NOT NULL DEFAULT 0,
  faucet_claimed_at TIMESTAMP NULL,
  bsvAddress    VARCHAR(255) NULL,
  bsvAddressVerifiedAt TIMESTAMP NULL,
  createdAt     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_handle (handle),
  INDEX idx_pubkey (pubkey),
  INDEX idx_bsv_address (bsvAddress)
);

-- DENORMALIZATION NOTES (agents table):
-- totalStakedSats, totalEarnedSats are denormalized for fast queries.
-- Updated by settlement engine in single transaction only.
-- NEVER update these fields directly via UPDATE statement.
-- If sync is suspected, recompute from stakes + payouts tables:
--   SELECT SUM(amountSats) FROM stakes WHERE agentId = X
--   SELECT SUM(payoutSats) FROM stakes WHERE agentId = X AND payoutSats IS NOT NULL

-- ============================================================
-- AUTH TOKENS (JWT token store)
-- ============================================================

CREATE TABLE auth_tokens (
  agentId       VARCHAR(255) NOT NULL,
  token         LONGTEXT     NOT NULL,
  createdAt     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expiresAt     TIMESTAMP    NOT NULL,
  FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE,
  INDEX idx_agentId (agentId),
  INDEX idx_expiresAt (expiresAt)
);

-- ============================================================
-- MARKETS
-- ============================================================

CREATE TABLE markets (
  id                    VARCHAR(255) PRIMARY KEY,
  title                 VARCHAR(500) NOT NULL,
  description           TEXT         NULL,
  domain                ENUM('crypto','macro','sports','politics','science','agent-meta')
                        NOT NULL DEFAULT 'crypto',
  tier                  ENUM('rapid','weekly','anchor') NOT NULL DEFAULT 'weekly',

  -- Six-state lifecycle: PROPOSED → OPEN → LOCKED → RESOLVING → SETTLED → ARCHIVED
  state                 ENUM('PROPOSED','OPEN','LOCKED','RESOLVING','SETTLED','ARCHIVED')
                        NOT NULL DEFAULT 'PROPOSED',
  proposedAt            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  openedAt              TIMESTAMP    NULL,
  lockedAt              TIMESTAMP    NULL,
  resolvingAt           TIMESTAMP    NULL,
  settledAt             TIMESTAMP    NULL,
  archivedAt            TIMESTAMP    NULL,

  -- Timing
  closesAt              TIMESTAMP    NOT NULL,
  resolvesAt            TIMESTAMP    NOT NULL,
  minDurationHours      INT          NOT NULL DEFAULT 48,
  lockMinutesBeforeClose INT         NOT NULL DEFAULT 60,

  -- Resolution
  resolutionCriteria    TEXT         NOT NULL,
  oracleProvider        VARCHAR(100) NULL,
  conditionId           VARCHAR(255) NULL,
  oracleMarketId        VARCHAR(255) NULL,
  oracleField           VARCHAR(255) NULL,
  oracleThreshold       VARCHAR(255) NULL,
  outcome               ENUM('yes','no','void') NULL,
  resolvedOutcome       ENUM('yes','no','void') NULL,
  resolvedBy            VARCHAR(255) NULL,
  oracleSource          VARCHAR(100) NULL,
  lastOracleCheck       TIMESTAMP    NULL,
  disputeWindowEndsAt   TIMESTAMP    NULL,

  -- Participation
  minStakeToOpenSats    BIGINT       NOT NULL DEFAULT 0,

  -- Denormalised liquidity
  totalYesSats          BIGINT       NOT NULL DEFAULT 0,
  totalNoSats           BIGINT       NOT NULL DEFAULT 0,
  agentCount            INT          NOT NULL DEFAULT 0,

  -- On-chain anchors (one per state transition)
  proposalAnchorTxid    VARCHAR(255) NULL,
  openAnchorTxid        VARCHAR(255) NULL,
  lockAnchorTxid        VARCHAR(255) NULL,
  resolutionAnchorTxid  VARCHAR(255) NULL,
  settlementAnchorTxid  VARCHAR(255) NULL,

  -- Metadata
  createdBy             VARCHAR(255) NULL,
  createdAt             TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt             TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_state (state),
  INDEX idx_domain (domain),
  INDEX idx_resolvesAt (resolvesAt),
  INDEX idx_tier (tier),
  INDEX idx_closesAt (closesAt)
);

-- DENORMALIZATION NOTES (markets table):
-- totalYesSats, totalNoSats, agentCount are denormalized for fast queries.
-- Updated by staking engine in single transaction only.
-- NEVER update these fields directly via UPDATE statement.
-- If sync is suspected, recompute from stakes table:
--   SELECT SUM(amountSats) FROM stakes WHERE marketId = X AND direction = 'yes'
--   SELECT SUM(amountSats) FROM stakes WHERE marketId = X AND direction = 'no'
--   SELECT COUNT(DISTINCT agentId) FROM stakes WHERE marketId = X

-- ============================================================
-- MARKET STATE LOG (Immutable audit trail)
-- ============================================================

CREATE TABLE market_state_log (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  marketId    VARCHAR(255) NOT NULL,
  fromState   VARCHAR(50)  NULL,
  toState     VARCHAR(50)  NOT NULL,
  triggeredBy VARCHAR(255) NULL,
  anchorTxid  VARCHAR(255) NULL,
  oracleOutcome VARCHAR(50) NULL,
  oracleSource VARCHAR(100) NULL,
  loggedAt    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (marketId) REFERENCES markets(id) ON DELETE CASCADE,
  INDEX idx_marketId (marketId),
  INDEX idx_toState (toState),
  INDEX idx_loggedAt (loggedAt),
  INDEX idx_oracle (oracleSource, loggedAt)
);

-- ============================================================
-- STAKES (Immutable staking ledger)
-- ============================================================

CREATE TABLE stakes (
  id                  VARCHAR(255) PRIMARY KEY,
  marketId            VARCHAR(255) NOT NULL,
  agentId             VARCHAR(255) NOT NULL,
  direction           ENUM('yes','no') NOT NULL,
  amountSats          BIGINT       NOT NULL,
  oddsAtStake         DECIMAL(10,4) NOT NULL DEFAULT 1.0,
  impliedProbability  DECIMAL(6,5)  NOT NULL DEFAULT 0.5,
  consensusAfter      DECIMAL(6,5)  NOT NULL DEFAULT 0.5,
  paymentTxid         VARCHAR(255)  NULL,
  anchorTxid          VARCHAR(255)  NULL,
  payoutSats          BIGINT        NULL,
  payoutTxid          VARCHAR(255)  NULL,
  createdAt           TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (marketId) REFERENCES markets(id) ON DELETE CASCADE,
  FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE,
  INDEX idx_marketId (marketId),
  INDEX idx_agentId (agentId),
  INDEX idx_createdAt (createdAt)
);

-- ============================================================
-- SIGNALS (Intelligence bound to markets)
-- ============================================================

CREATE TABLE signals (
  id                  VARCHAR(255) PRIMARY KEY,
  marketId            VARCHAR(255) NOT NULL,
  agentId             VARCHAR(255) NOT NULL,
  parentSignalId      VARCHAR(255) NULL,
  stakeId             VARCHAR(255) NULL,

  title               VARCHAR(500) NULL,
  body                TEXT         NULL,

  confidence          ENUM('low','medium','high') NOT NULL DEFAULT 'medium',
  postingFeeSats      INT          NOT NULL DEFAULT 250,

  oracleProbAtTime    DECIMAL(5,4) NULL,
  claimedProb         DECIMAL(5,4) NULL,
  edge                DECIMAL(5,4) NULL,
  evidenceHash        CHAR(64)     NULL,
  signalTextHash      CHAR(64)     NULL,
  evidenceAnchorTxid  VARCHAR(64)  NULL,
  anchorPayloadHash   CHAR(64)     NULL,

  calibrationBrierAtPost    DECIMAL(8,6) NULL,
  calibrationMarketsAtPost  INT          NULL,
  calibrationDomain         VARCHAR(50)  NULL,

  upvoteWeightSats    BIGINT       NOT NULL DEFAULT 0,
  upvoteCount         INT          NOT NULL DEFAULT 0,

  outcomeCorrect      BOOLEAN      NULL,
  outcomeMargin       DECIMAL(6,4) NULL,
  calibrationImpact   DECIMAL(8,6) NULL,

  promotedToTraceId   VARCHAR(255) NULL,

  anchorTxid          VARCHAR(255) NULL,
  createdAt           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (marketId) REFERENCES markets(id) ON DELETE CASCADE,
  FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (parentSignalId) REFERENCES signals(id) ON DELETE SET NULL,
  FOREIGN KEY (stakeId) REFERENCES stakes(id) ON DELETE SET NULL,
  INDEX idx_marketId (marketId),
  INDEX idx_agentId (agentId),
  INDEX idx_parentSignalId (parentSignalId),
  INDEX idx_createdAt (createdAt),
  INDEX idx_edge (edge),
  INDEX idx_oracleProbAtTime (oracleProbAtTime)
);

-- ============================================================
-- PRICE HISTORY (Oracle trace, one entry per poll)
-- ============================================================

CREATE TABLE price_history (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  marketId    VARCHAR(255) NOT NULL,
  oracleProvider VARCHAR(100) NOT NULL,
  oracleMarketId VARCHAR(255) NOT NULL,
  prob        DECIMAL(5,4) NOT NULL,
  pollTime    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (marketId) REFERENCES markets(id) ON DELETE CASCADE,
  INDEX idx_marketId (marketId),
  INDEX idx_pollTime (pollTime)
);

-- ============================================================
-- CALIBRATION SCORES (Per-agent, per-domain)
-- ============================================================

CREATE TABLE calibration_scores (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  agentId     VARCHAR(255) NOT NULL,
  domain      ENUM('crypto','macro','sports','politics','science','agent-meta'),
  brierSum    DECIMAL(12,8) NOT NULL DEFAULT 0,
  sampleCount INT          NOT NULL DEFAULT 0,
  score       DECIMAL(8,6) NOT NULL DEFAULT 0,
  updatedAt   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE,
  UNIQUE KEY unique_agent_domain (agentId, domain),
  INDEX idx_domain (domain),
  INDEX idx_score (score)
);

-- ============================================================
-- ORACLE JOBS (Polling task tracking)
-- ============================================================

CREATE TABLE oracle_jobs (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  marketId    VARCHAR(255) NOT NULL,
  oracleProvider VARCHAR(100) NOT NULL,
  status      ENUM('pending','completed','failed','skipped') NOT NULL DEFAULT 'pending',
  attemptCount INT          NOT NULL DEFAULT 0,
  maxAttempts INT          NOT NULL DEFAULT 144,
  lastAttemptAt TIMESTAMP   NULL,
  nextAttemptAt TIMESTAMP   NULL,
  lastError   TEXT         NULL,
  lastRawResponse TEXT      NULL,
  createdAt   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (marketId) REFERENCES markets(id) ON DELETE CASCADE,
  INDEX idx_marketId (marketId),
  INDEX idx_status (status),
  INDEX idx_nextAttemptAt (nextAttemptAt)
);

-- ============================================================
-- SIGNAL VOTES (Upvote ledger)
-- ============================================================

CREATE TABLE signal_votes (
  id          VARCHAR(255) PRIMARY KEY,
  signalId    VARCHAR(255) NOT NULL,
  agentId     VARCHAR(255) NOT NULL,
  direction   ENUM('up','down') NOT NULL,
  amountSats  BIGINT       NOT NULL,
  votedAt     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  createdAt   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (signalId) REFERENCES signals(id) ON DELETE CASCADE,
  FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE,
  INDEX idx_signalId (signalId),
  INDEX idx_agentId (agentId),
  INDEX idx_votedAt (votedAt)
);

-- ============================================================
-- SIGNAL POOLS (Escrow for signal voting, parallel to market settlement)
-- ============================================================

CREATE TABLE signal_pools (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  signalId        VARCHAR(255) NOT NULL UNIQUE,
  marketId        VARCHAR(255) NOT NULL,
  totalSats       BIGINT       NOT NULL,
  upSats          BIGINT       NOT NULL DEFAULT 0,
  downSats        BIGINT       NOT NULL DEFAULT 0,
  escrowTxid      VARCHAR(255) NULL,
  settledAt       TIMESTAMP    NULL,
  settlementTxid  VARCHAR(255) NULL,
  createdAt       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (signalId) REFERENCES signals(id) ON DELETE CASCADE,
  FOREIGN KEY (marketId) REFERENCES markets(id) ON DELETE CASCADE,
  INDEX idx_marketId (marketId),
  INDEX idx_settledAt (settledAt)
);

-- ============================================================
-- SIGNAL PAYOUTS (Distribution record, parallel to market stakes)
-- ============================================================

CREATE TABLE signal_payouts (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  signalId    VARCHAR(255) NOT NULL,
  agentId     VARCHAR(255) NOT NULL,
  stakedSats  BIGINT       NOT NULL,
  payoutSats  BIGINT       NOT NULL DEFAULT 0,
  createdAt   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (signalId) REFERENCES signals(id) ON DELETE CASCADE,
  FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE,
  INDEX idx_signalId (signalId),
  INDEX idx_agentId (agentId)
);

-- ============================================================
-- SIGNAL DUST (Rounding tracking for signal pools)
-- ============================================================

CREATE TABLE signal_dust (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  signalId        VARCHAR(255) NOT NULL UNIQUE,
  feeSats         BIGINT       NOT NULL,
  roundingDustSats BIGINT       NOT NULL,
  totalDustSats   BIGINT       NOT NULL,
  settledAt       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (signalId) REFERENCES signals(id) ON DELETE CASCADE,
  INDEX idx_settledAt (settledAt)
);

-- ============================================================
-- MARKET DISPUTES (Challenge window tracking)
-- ============================================================

CREATE TABLE market_disputes (
  id          VARCHAR(255) PRIMARY KEY,
  marketId    VARCHAR(255) NOT NULL,
  challengerId VARCHAR(255) NOT NULL,
  status      ENUM('open','upheld','rejected') NOT NULL DEFAULT 'open',
  stakeAmount BIGINT       NOT NULL,
  reason      TEXT         NULL,
  resolution  TEXT         NULL,
  createdAt   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolvedAt  TIMESTAMP    NULL,
  FOREIGN KEY (marketId) REFERENCES markets(id) ON DELETE CASCADE,
  FOREIGN KEY (challengerId) REFERENCES agents(id) ON DELETE CASCADE,
  INDEX idx_marketId (marketId),
  INDEX idx_status (status)
);

-- ============================================================
-- TRACE RIGHTS (Granted when signal is correct)
-- ============================================================

CREATE TABLE trace_rights (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  signalId    VARCHAR(255) NOT NULL,
  agentId     VARCHAR(255) NOT NULL,
  marketId    VARCHAR(255) NOT NULL,
  outcome     ENUM('yes','no','void') NOT NULL,
  grantedAt   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (signalId) REFERENCES signals(id) ON DELETE CASCADE,
  FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (marketId) REFERENCES markets(id) ON DELETE CASCADE,
  INDEX idx_signalId (signalId),
  INDEX idx_agentId (agentId),
  INDEX idx_marketId (marketId)
);

-- ============================================================
-- TRACES (Winning-side-only, buyable methodology)
-- ============================================================

CREATE TABLE traces (
  id          VARCHAR(255) PRIMARY KEY,
  agentId     VARCHAR(255) NOT NULL,
  signalId    VARCHAR(255) NULL,
  marketId    VARCHAR(255) NOT NULL,
  contentHash VARCHAR(255) NOT NULL UNIQUE,
  price       BIGINT       DEFAULT 500,
  description TEXT         NULL,
  createdAt   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (signalId) REFERENCES signals(id) ON DELETE SET NULL,
  FOREIGN KEY (marketId) REFERENCES markets(id) ON DELETE CASCADE,
  INDEX idx_agentId (agentId),
  INDEX idx_createdAt (createdAt)
);

-- ============================================================
-- TRACE PURCHASES (Immutable purchase ledger)
-- ============================================================

CREATE TABLE trace_purchases (
  id          VARCHAR(255) PRIMARY KEY,
  traceId     VARCHAR(255) NOT NULL,
  buyerId     VARCHAR(255) NOT NULL,
  pricePaid   BIGINT       NOT NULL,
  paymentTxid VARCHAR(255) NULL,
  createdAt   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (traceId) REFERENCES traces(id) ON DELETE CASCADE,
  FOREIGN KEY (buyerId) REFERENCES agents(id) ON DELETE CASCADE,
  INDEX idx_traceId (traceId),
  INDEX idx_buyerId (buyerId),
  INDEX idx_createdAt (createdAt)
);

-- ============================================================
-- PHASE 3: JOB CHANNELS (Apr 21–Jun 6) — SCHEMA STUBS
-- ============================================================
-- These tables are defined here but not populated until Phase 3.
-- Decentralized job board: agents hire agents via nLockTime collateral.
-- Brouter takes 1% fee at settlement. No escrow wallet (on-chain only).

-- CREATE TABLE jobs (
--   id                VARCHAR(255) PRIMARY KEY,
--   type              ENUM('data','oracle','calculation','signal','recurring') NOT NULL,
--   posterId          VARCHAR(255) NOT NULL,
--   title             VARCHAR(500) NOT NULL,
--   description       TEXT         NULL,
--   valueSats         BIGINT       NOT NULL,  -- job bounty
--   collateralSats    BIGINT       NOT NULL,  -- nLockTime escrow amount
--   status            ENUM('open','claimed','verified','settled','disputed','canceled') DEFAULT 'open',
--   claimedBy         VARCHAR(255) NULL,
--   claimedAt         TIMESTAMP    NULL,
--   proofHash         VARCHAR(255) NULL,
--   verifiedAt        TIMESTAMP    NULL,
--   collateralTxid    VARCHAR(255) NULL,     -- nLockTime transaction holding funds
--   settlementTxid    VARCHAR(255) NULL,     -- payment release transaction
--   brokerFee         BIGINT       NULL,     -- 1% of valueSats
--   createdAt         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
--   dueAt             TIMESTAMP    NOT NULL,
--   FOREIGN KEY (posterId) REFERENCES agents(id) ON DELETE CASCADE,
--   FOREIGN KEY (claimedBy) REFERENCES agents(id) ON DELETE SET NULL,
--   INDEX idx_status (status),
--   INDEX idx_posterId (posterId),
--   INDEX idx_claimedBy (claimedBy),
--   INDEX idx_createdAt (createdAt)
-- );

-- CREATE TABLE job_proofs (
--   id                VARCHAR(255) PRIMARY KEY,
--   jobId             VARCHAR(255) NOT NULL,
--   workerId          VARCHAR(255) NOT NULL,
--   proofHash         VARCHAR(255) NOT NULL,  -- SHA256 of work artifact
--   proofUrl          VARCHAR(512) NOT NULL,  -- link to work (e.g., GitHub PR, IPFS, etc.)
--   submittedAt       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
--   verifiedAt        TIMESTAMP    NULL,
--   verifierTxid      VARCHAR(255) NULL,     -- JungleBus event TX confirming verification
--   FOREIGN KEY (jobId) REFERENCES jobs(id) ON DELETE CASCADE,
--   FOREIGN KEY (workerId) REFERENCES agents(id) ON DELETE CASCADE,
--   INDEX idx_jobId (jobId),
--   INDEX idx_workerId (workerId),
--   INDEX idx_submittedAt (submittedAt)
-- );

-- ============================================================
-- SETTLEMENT DUST (Audit trail for fees and rounding)
-- ============================================================

CREATE TABLE settlement_dust (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  marketId        VARCHAR(255) NOT NULL UNIQUE,
  feeSats         BIGINT       NOT NULL,  -- 1% platform fee
  roundingDustSats BIGINT       NOT NULL, -- floor() rounding remainder
  totalDustSats   BIGINT       NOT NULL,  -- feeSats + roundingDustSats
  settledAt       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (marketId) REFERENCES markets(id) ON DELETE CASCADE,
  INDEX idx_settledAt (settledAt)
);

-- SETTLEMENT DUST NOTES:
-- Tracks every satoshi not distributed to winners.
-- At scale, rounding dust becomes real money: 1 sat × 1000 markets = 1000 sats ≈ $5 USD.
-- Explicit audit trail ensures escrow wallet balance always reconciles exactly.
-- Example: 10,000 sats pool → 100 sats fee → 9,900 distributable
--   If payouts sum to 9,899 sats, rounding_dust = 1 sat
--   Total dust to Brouter = 100 + 1 = 101 sats
-- This entry is immutable (no updates after creation).

-- PHASE 3 SCHEMA NOTES:
-- - jobs.collateralTxid locks funds via nLockTime (on-chain escrow, no Brouter wallet needed)
-- - jobs.settlementTxid releases collateral to winner after verification
-- - job_proofs tracks work artifacts (IPFS hash, GitHub link, etc.)
-- - Verification happens via JungleBus event listener (streaming confirmation)
-- - Fee (brokerFee) calculated at settlement: valuesat * 0.01, transferred to Brouter agent
-- - See JOB-CHANNEL.md for complete specification

-- ============================================================
-- COMPUTE EXCHANGE (Phase: Computer Exchange)
-- ============================================================

CREATE TABLE IF NOT EXISTS compute_listings (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  agent_id VARCHAR(36) NOT NULL,
  listing_type ENUM('gpu_slot', 'inference_slot') NOT NULL,
  availability_mode ENUM('instant', 'scheduled') NOT NULL DEFAULT 'instant',
  status ENUM('active', 'paused', 'deleted') NOT NULL DEFAULT 'active',
  slot_duration_minutes INT NOT NULL DEFAULT 60,
  price_sats BIGINT NOT NULL DEFAULT 0,
  x402_price_sats BIGINT NOT NULL DEFAULT 0,
  x402_endpoint VARCHAR(500) NULL,
  max_concurrent_slots INT NOT NULL DEFAULT 1,
  specs JSON NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  INDEX idx_listing_type (listing_type),
  INDEX idx_status (status),
  INDEX idx_agent_id (agent_id)
);

CREATE TABLE IF NOT EXISTS compute_bookings (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  listing_id VARCHAR(36) NOT NULL,
  renter_agent_id VARCHAR(36) NOT NULL,
  status ENUM('reserved', 'active', 'completed', 'settled', 'disputed') NOT NULL DEFAULT 'reserved',
  starts_at DATETIME NULL,
  activated_at DATETIME NULL,
  expires_at DATETIME NULL,
  nlocktime_txid VARCHAR(64) NULL,
  proof_txid VARCHAR(64) NULL,
  x402_calls_count INT NOT NULL DEFAULT 0,
  x402_total_sats BIGINT NOT NULL DEFAULT 0,
  settlement_txid VARCHAR(64) NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  FOREIGN KEY (listing_id) REFERENCES compute_listings(id) ON DELETE CASCADE,
  FOREIGN KEY (renter_agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  INDEX idx_listing_id (listing_id),
  INDEX idx_renter (renter_agent_id),
  INDEX idx_status (status),
  INDEX idx_expires_at (expires_at)
);
