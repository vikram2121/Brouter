-- Migration 004: Add consensus resolution fields for Phase 3
-- Date: 2026-03-25
-- Purpose: Support stake-weighted agent consensus resolution mechanism
-- Impact: Backwards compatible (all fields nullable, new table only)
-- Phase: Phase 3 (Apr 21–Jun 6), designed now to avoid costly retrofits

-- ============================================================
-- MARKETS TABLE UPDATES
-- ============================================================
-- Add resolution_mechanism to markets (default: oracle_auto)
-- This field determines which resolution path is used:
--   'oracle_auto': Query external oracle (Polymarket, Betfair, etc.)
--   'consensus': Stake-weighted agent consensus (for oracle-less markets)
--   'manual': Fallback for edge cases (Phase 1/2 only)

ALTER TABLE markets 
ADD COLUMN resolution_mechanism 
ENUM('oracle_auto', 'consensus', 'manual') 
NOT NULL DEFAULT 'oracle_auto' AFTER oracleThreshold;

-- Consensus window configuration (all nullable for backwards compatibility)
-- consensus_window_hours: How long agents have to submit resolution claims (default 24h)
-- consensus_min_stake_sats: Minimum stake required per claim (default 1000 sats, ~$0.014)
-- consensus_supermajority_pct: Threshold for consensus win (default 66%)

ALTER TABLE markets 
ADD COLUMN consensus_window_hours INT DEFAULT 24 AFTER resolution_mechanism;

ALTER TABLE markets 
ADD COLUMN consensus_min_stake_sats INT DEFAULT 1000 AFTER consensus_window_hours;

ALTER TABLE markets 
ADD COLUMN consensus_supermajority_pct DECIMAL(5,2) DEFAULT 66.00 AFTER consensus_min_stake_sats;

-- Track when consensus resolution began (if applicable)
ALTER TABLE markets 
ADD COLUMN consensus_started_at TIMESTAMP NULL AFTER consensus_supermajority_pct;

-- ============================================================
-- NEW TABLE: RESOLUTION_CLAIMS
-- ============================================================
-- Immutable ledger of agent resolution claims
-- Each agent can submit ONE claim per market
-- Claim includes stake amount (agent is economically committed)
-- Phase 3: Supports commit-reveal scheme via commitment_hash

CREATE TABLE resolution_claims (
  id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
  market_id VARCHAR(255) NOT NULL,
  agent_id VARCHAR(255) NOT NULL,
  claimed_outcome ENUM('yes', 'no', 'void') NOT NULL,
  stake_sats INT NOT NULL DEFAULT 1000,
  
  -- Commit-reveal scheme fields (Phase 3)
  commitment_hash VARCHAR(64) NULL,  -- SHA256(outcome + salt) for Phase 2 commit
  revealed_at DATETIME NULL,         -- When Phase 2 reveal happens
  
  -- Settlement tracking
  payout_sats INT NULL,  -- Filled after resolution (stake back + share of wrong stakes)
  outcome_correct BOOLEAN NULL,  -- Whether this agent was on winning side
  
  -- Audit trail
  submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME NULL,
  
  FOREIGN KEY (market_id) REFERENCES markets(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  UNIQUE KEY unique_claim (market_id, agent_id),  -- One claim per agent per market
  INDEX idx_market_id (market_id),
  INDEX idx_agent_id (agent_id),
  INDEX idx_claimed_outcome (claimed_outcome),
  INDEX idx_submitted_at (submitted_at)
);

-- ============================================================
-- RESOLUTION CLAIMS NOTES
-- ============================================================
-- Phase 2 (Current): Claims are single-phase, non-binding
--   Agents can claim outcome but no economic commitment yet
--   Used for testing consensus mechanism before Phase 3
--   
-- Phase 3: Claims become binding with two-phase commit-reveal
--   Phase 1: Agent submits commitment_hash = SHA256(outcome + secret_salt)
--   Phase 2: After resolution window, agent reveals outcome + salt
--   Invalid reveals (wrong hash, no reveal, late reveal) forfeit stake
--   
-- Settlement formula (assuming YES wins with 66%+ supermajority):
--   YES claimants: get stake back + (NO_total_stakes / YES_claimant_count)
--   NO claimants: lose stake (all goes to YES pool)
--   
-- Example:
--   YES claims: 100 agents × 1000 sats = 100,000 sats total
--   NO claims: 25 agents × 1000 sats = 25,000 sats total
--   YES wins (100k / 125k = 80% > 66%)
--   
--   Each YES agent: 1000 sats back + (25,000 / 100) = 1000 + 250 = 1250 sats
--   Each NO agent: 0 sats (loses stake)
--   Total YES payouts: 100 × 1250 = 125,000 sats ✅
