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
    id: '008_fix_resolution_claims_columns',
    description: 'Rename outcome_correct→reveal_valid, resolved_at→settled_at; add missing columns if absent',
    up: async (db) => {
      // outcome_correct → reveal_valid
      const outcomeCorrectExists = await db.get(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'resolution_claims' AND COLUMN_NAME = 'outcome_correct'`,
        []
      )
      if (outcomeCorrectExists) {
        await db.run(`ALTER TABLE resolution_claims CHANGE outcome_correct reveal_valid TINYINT(1) NULL`)
      }

      // resolved_at → settled_at
      const resolvedAtExists = await db.get(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'resolution_claims' AND COLUMN_NAME = 'resolved_at'`,
        []
      )
      if (resolvedAtExists) {
        await db.run(`ALTER TABLE resolution_claims CHANGE resolved_at settled_at DATETIME NULL`)
      }

      // Add reveal_valid if missing entirely
      const revealValidExists = await db.get(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'resolution_claims' AND COLUMN_NAME = 'reveal_valid'`,
        []
      )
      if (!revealValidExists) {
        await db.run(`ALTER TABLE resolution_claims ADD COLUMN reveal_valid TINYINT(1) NULL`)
      }

      // Add settled_at if missing entirely
      const settledAtExists = await db.get(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'resolution_claims' AND COLUMN_NAME = 'settled_at'`,
        []
      )
      if (!settledAtExists) {
        await db.run(`ALTER TABLE resolution_claims ADD COLUMN settled_at DATETIME NULL`)
      }
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
  },
  {
    id: '010_x402_payments',
    description: 'Create x402_payments table for replay protection on monetised oracle queries',
    up: async (db) => {
      await db.run(`
        CREATE TABLE IF NOT EXISTS x402_payments (
          txid VARCHAR(64) NOT NULL,
          locking_script VARCHAR(512) NOT NULL,
          amount_sats INT NOT NULL,
          paid_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (txid),
          INDEX idx_paid_at (paid_at)
        )
      `)
    }
  },
  {
    id: '009_commit_reveal_deadlines',
    description: 'Add commit_phase_ends_at + reveal_phase_ends_at to markets for Tier 3 timing enforcement',
    up: async (db) => {
      const cols = await db.all(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'markets'
         AND COLUMN_NAME IN ('commit_phase_ends_at', 'reveal_phase_ends_at')`
      )
      const existing = cols.map((c: any) => c.COLUMN_NAME)
      if (!existing.includes('commit_phase_ends_at')) {
        await db.run(`ALTER TABLE markets ADD COLUMN commit_phase_ends_at DATETIME NULL`)
      }
      if (!existing.includes('reveal_phase_ends_at')) {
        await db.run(`ALTER TABLE markets ADD COLUMN reveal_phase_ends_at DATETIME NULL`)
      }
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

  // Bootstrap guard: if schema_migrations is empty but old columns already exist,
  // the previous INFORMATION_SCHEMA-based system already applied 001–004.
  // Pre-mark them as done so we don't attempt duplicate column adds.
  const { n } = await db.get(`SELECT COUNT(*) as n FROM schema_migrations`, []) ?? { n: 0 }
  if (n === 0) {
    const faucetExists = await db.get(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agents' AND COLUMN_NAME = 'faucet_claimed'`,
      []
    )
    if (faucetExists) {
      console.log('  🔁 Bootstrap: pre-existing schema detected — marking migrations 001–004 as applied')
      for (const id of ['001_faucet_fields', '002_bsv_wallet', '003_evidence_fields', '004_signals_position']) {
        await db.run(`INSERT IGNORE INTO schema_migrations (id) VALUES (?)`, [id])
      }
      console.log('  ✓ Bootstrap complete')
    }
  }

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
