/**
 * Database migrations — tracked via schema_migrations table.
 * Each migration runs exactly once. Safe to call on every startup.
 * 
 * Adding a migration: append to the MIGRATIONS array with a unique id.
 * Never edit or delete existing entries — add new ones instead.
 */
import { DbConnection } from './connection'

interface Migration {
  id: string
  description: string
  up: (db: DbConnection) => Promise<void>
}

const MIGRATIONS: Migration[] = [
  {
    id: '001_faucet_fields',
    description: 'Add faucet_claimed + faucet_claimed_at to agents',
    up: async (db) => {
      await db.run(`ALTER TABLE agents ADD COLUMN faucet_claimed BOOLEAN NOT NULL DEFAULT 0`)
      await db.run(`ALTER TABLE agents ADD COLUMN faucet_claimed_at TIMESTAMP NULL`)
    }
  },
  {
    id: '002_bsv_wallet',
    description: 'Add BSV wallet fields + balance_sats to agents',
    up: async (db) => {
      await db.run(`ALTER TABLE agents ADD COLUMN bsvAddress VARCHAR(255) NULL`)
      await db.run(`ALTER TABLE agents ADD COLUMN bsvAddressVerifiedAt TIMESTAMP NULL`)
      await db.run(`ALTER TABLE agents ADD COLUMN balance_sats BIGINT NOT NULL DEFAULT 0`)
      try {
        await db.run(`CREATE INDEX idx_bsv_address ON agents (bsvAddress)`)
      } catch (err: any) {
        if (!err.message?.includes('Duplicate key name')) throw err
      }
    }
  },
  {
    id: '003_evidence_fields',
    description: 'Add evidenceUrl + evidenceNote to markets (Phase 2.5 oracle accountability)',
    up: async (db) => {
      await db.run(`ALTER TABLE markets ADD COLUMN evidenceUrl VARCHAR(512) NULL`)
      await db.run(`ALTER TABLE markets ADD COLUMN evidenceNote TEXT NULL`)
    }
  },
  {
    id: '004_signals_position',
    description: 'Add position column to signals (yes/no alignment)',
    up: async (db) => {
      await db.run(`ALTER TABLE signals ADD COLUMN position ENUM('yes','no') NULL`)
    }
  },
  {
    id: '005_resolution_mechanism',
    description: 'Add Phase 3 resolution fields to markets table',
    up: async (db) => {
      await db.run(`
        ALTER TABLE markets
          ADD COLUMN resolution_mechanism ENUM('oracle_auto','consensus','manual') NOT NULL DEFAULT 'oracle_auto',
          ADD COLUMN consensus_window_hours INT NOT NULL DEFAULT 24,
          ADD COLUMN consensus_min_stake_sats INT NOT NULL DEFAULT 1000,
          ADD COLUMN consensus_supermajority_pct DECIMAL(5,2) NOT NULL DEFAULT 66.00,
          ADD COLUMN consensus_opened_at DATETIME NULL,
          ADD COLUMN consensus_closes_at DATETIME NULL,
          ADD COLUMN oracle_verified TINYINT(1) NOT NULL DEFAULT 0,
          ADD COLUMN oracle_verified_at DATETIME NULL,
          ADD COLUMN oracle_verification_url VARCHAR(512) NULL
      `)
    }
  },
  {
    id: '006_resolution_claims',
    description: 'Create resolution_claims table for stake-weighted consensus (Phase 3)',
    up: async (db) => {
      await db.run(`
        CREATE TABLE IF NOT EXISTS resolution_claims (
          id VARCHAR(36) NOT NULL DEFAULT (UUID()),
          market_id VARCHAR(36) NOT NULL,
          agent_id VARCHAR(36) NOT NULL,
          claimed_outcome ENUM('yes','no','void') NOT NULL,
          stake_sats INT NOT NULL DEFAULT 1000,

          commitment_hash VARCHAR(64) NULL,
          revealed_at DATETIME NULL,
          reveal_valid TINYINT(1) NULL,

          payout_sats INT NULL,
          settled_at DATETIME NULL,

          submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

          PRIMARY KEY (id),
          UNIQUE KEY unique_agent_claim (market_id, agent_id),
          FOREIGN KEY (market_id) REFERENCES markets(id) ON DELETE CASCADE,
          FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
          INDEX idx_market_claims (market_id),
          INDEX idx_outcome (market_id, claimed_outcome)
        )
      `)
    }
  },
  {
    id: '007_resolution_claim_dust',
    description: 'Track rounding dust from resolution claim payouts',
    up: async (db) => {
      await db.run(`
        CREATE TABLE IF NOT EXISTS resolution_claim_dust (
          id VARCHAR(36) NOT NULL DEFAULT (UUID()),
          market_id VARCHAR(36) NOT NULL,
          fee_sats INT NOT NULL DEFAULT 0,
          rounding_dust INT NOT NULL DEFAULT 0,
          total_dust INT NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

          PRIMARY KEY (id),
          UNIQUE KEY unique_market_dust (market_id),
          FOREIGN KEY (market_id) REFERENCES markets(id)
        )
      `)
    }
  }
]

export async function runMigrations(db: DbConnection): Promise<void> {
  console.log('🔧 Running database migrations...')

  // Ensure tracking table exists
  await db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id VARCHAR(100) NOT NULL PRIMARY KEY,
      executed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)

  for (const migration of MIGRATIONS) {
    const already = await db.get(
      `SELECT id FROM schema_migrations WHERE id = ?`,
      [migration.id]
    )

    if (already) {
      // Already applied — skip
      continue
    }

    console.log(`  📝 [${migration.id}] ${migration.description}`)
    try {
      await migration.up(db)
      await db.run(
        `INSERT INTO schema_migrations (id) VALUES (?)`,
        [migration.id]
      )
      console.log(`  ✓ [${migration.id}] done`)
    } catch (err: any) {
      console.error(`  ❌ [${migration.id}] failed: ${err.message}`)
      throw err
    }
  }

  console.log('✓ Migrations complete')
}
