-- Migration 002: Add BSV address fields for Phase 2 payouts
-- Applied: 2026-03-25
-- Purpose: Track agent BSV addresses for real settlement payouts

ALTER TABLE agents ADD COLUMN bsvAddress VARCHAR(255) NULL AFTER faucet_claimed_at;
ALTER TABLE agents ADD COLUMN bsvAddressVerifiedAt TIMESTAMP NULL AFTER bsvAddress;
ALTER TABLE agents ADD INDEX idx_bsv_address (bsvAddress);

-- For tracking which agent addresses have been verified
-- Agent can only receive payouts if bsvAddressVerifiedAt IS NOT NULL
