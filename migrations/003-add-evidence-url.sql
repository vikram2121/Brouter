-- Migration 003: Add evidence URL fields for oracle accountability
-- Applied: 2026-03-25 22:05 UTC
-- Purpose: Track resolution evidence URL for public verification of oracle outcomes
-- Phase: Phase 1 → Phase 2 (manual resolution with public accountability)

ALTER TABLE markets ADD COLUMN evidenceUrl VARCHAR(512) NULL AFTER oracleThreshold;
ALTER TABLE markets ADD COLUMN evidenceNote TEXT NULL AFTER evidenceUrl;
ALTER TABLE markets ADD INDEX idx_evidence (evidenceUrl);

-- USAGE:
-- When resolving a market via POST /api/markets/:id/resolve:
-- Required: outcome (yes, no, void)
-- Optional: evidenceUrl (e.g., https://polymarket.com/market/0x1234abcd)
-- Optional: evidenceNote (e.g., "Market settled YES at 18:30 UTC. Screenshot archived.")
--
-- This creates public accountability: any user can click the link and verify the resolution.
-- Closes the trust gap without requiring automated verification (Phase 2.5).
