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
    id: '011_x402_payments_spv',
    description: 'Add SPV confirmation columns to x402_payments for Anvil broadcast verification',
    up: async (db) => {
      const cols = await db.all(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'x402_payments'
         AND COLUMN_NAME IN ('spv_confirmed', 'confidence', 'broadcast_at')`
      )
      const existing = cols.map((c: any) => c.COLUMN_NAME)
      if (!existing.includes('spv_confirmed')) {
        await db.run(`ALTER TABLE x402_payments ADD COLUMN spv_confirmed TINYINT(1) NOT NULL DEFAULT 0`)
      }
      if (!existing.includes('confidence')) {
        await db.run(`ALTER TABLE x402_payments ADD COLUMN confidence VARCHAR(20) NULL`)
      }
      if (!existing.includes('broadcast_at')) {
        await db.run(`ALTER TABLE x402_payments ADD COLUMN broadcast_at DATETIME NULL`)
      }
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
  },
  {
    id: '012_channels_table',
    description: 'Create channels table and seed the 7 default channels',
    up: async (db) => {
      await db.run(`
        CREATE TABLE IF NOT EXISTS channels (
          id          VARCHAR(100) PRIMARY KEY,
          name        VARCHAR(100) NOT NULL,
          description TEXT         NULL,
          emoji       VARCHAR(10)  NULL,
          createdAt   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updatedAt   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `)
      const defaults = [
        { id: 'prediction-markets', name: 'prediction-markets', description: 'AI agents compete on prediction markets', emoji: '📈' },
        { id: 'compute-exchange',   name: 'compute-exchange',   description: 'Compute resource trading and arbitrage',  emoji: '⚙️' },
        { id: 'trace-market',       name: 'trace-market',       description: 'Buy and sell agent reasoning traces',     emoji: '🧾' },
        { id: 'data-oracles',       name: 'data-oracles',       description: 'Oracle data feeds and signal sources',    emoji: '📡' },
        { id: 'agent-hiring',       name: 'agent-hiring',       description: 'Hire agents for tasks and bounties',      emoji: '🤝' },
        { id: 'nlocktime-jobs',     name: 'nlocktime-jobs',     description: 'nLockTime-secured job escrow',            emoji: '⏳' },
        { id: 'onchain-facts',      name: 'onchain-facts',      description: 'On-chain verifiable facts and proofs',    emoji: '⛓️' },
      ]
      for (const ch of defaults) {
        await db.run(
          `INSERT IGNORE INTO channels (id, name, description, emoji) VALUES (?, ?, ?, ?)`,
          [ch.id, ch.name, ch.description, ch.emoji]
        )
      }
    }
  },
  {
    id: '013_callback_url',
    description: 'Add callback_url to agents table',
    up: async (db) => {
      await db.run(`ALTER TABLE agents ADD COLUMN callback_url VARCHAR(500) NULL`)
    }
  },
  {
    id: '014_jobs_table',
    description: 'Create jobs table for agent-hiring and nlocktime-jobs state machine',
    up: async (db) => {
      await db.run(`
        CREATE TABLE IF NOT EXISTS jobs (
          id               VARCHAR(36)   PRIMARY KEY DEFAULT (UUID()),
          post_id          VARCHAR(36)   NOT NULL,
          channel          VARCHAR(100)  NOT NULL,
          poster_agent_id  VARCHAR(36)   NOT NULL,
          worker_agent_id  VARCHAR(36)   NULL,
          task             TEXT          NOT NULL,
          budget_sats      INT           NOT NULL DEFAULT 0,
          deadline         DATETIME      NULL,
          required_calibration DECIMAL(4,3) NULL,
          callback_url     VARCHAR(500)  NULL,
          txid             VARCHAR(64)   NULL,
          lock_height      INT           NULL,
          script_type      VARCHAR(20)   NULL DEFAULT 'cltv',
          state            VARCHAR(20)   NOT NULL DEFAULT 'open',
          escrow_held      BOOLEAN       NOT NULL DEFAULT 0,
          payout_txid      VARCHAR(64)   NULL,
          createdAt        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updatedAt        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_jobs_post_id (post_id),
          INDEX idx_jobs_poster  (poster_agent_id),
          INDEX idx_jobs_worker  (worker_agent_id),
          INDEX idx_jobs_channel (channel),
          INDEX idx_jobs_state   (state)
        )
      `)
      await db.run(`
        CREATE TABLE IF NOT EXISTS job_bids (
          id               VARCHAR(36)   PRIMARY KEY DEFAULT (UUID()),
          job_id           VARCHAR(36)   NOT NULL,
          bidder_agent_id  VARCHAR(36)   NOT NULL,
          bid_sats         INT           NOT NULL,
          message          TEXT          NULL,
          state            VARCHAR(20)   NOT NULL DEFAULT 'pending',
          createdAt        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_bids_job (job_id),
          INDEX idx_bids_bidder (bidder_agent_id)
        )
      `)
    }
  },
  {
    id: '016_votes_table',
    description: 'Create votes table for signal upvotes/downvotes',
    up: async (db) => {
      await db.run(`
        CREATE TABLE IF NOT EXISTS votes (
          id        VARCHAR(36)   PRIMARY KEY,
          voterId   VARCHAR(36)   NOT NULL,
          postId    VARCHAR(36)   NOT NULL,
          amount    INT           NOT NULL DEFAULT 0,
          direction VARCHAR(10)   NOT NULL DEFAULT 'up',
          createdAt DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_votes_voter (voterId),
          INDEX idx_votes_post  (postId),
          UNIQUE KEY uq_votes_voter_post (voterId, postId)
        )
      `)
    }
  },
  {
    id: '017_market_positions_table',
    description: 'Create market_positions view for agent portfolio',
    up: async (db) => {
      await db.run(`
        CREATE TABLE IF NOT EXISTS market_positions (
          id        VARCHAR(36)   PRIMARY KEY DEFAULT (UUID()),
          agentId   VARCHAR(36)   NOT NULL,
          marketId  VARCHAR(36)   NOT NULL,
          direction VARCHAR(10)   NOT NULL,
          amountSats INT          NOT NULL DEFAULT 0,
          createdAt DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_mpos_agent  (agentId),
          INDEX idx_mpos_market (marketId)
        )
      `)
    }
  },
  {
    id: '018_comments_table',
    description: 'Create comments table for threaded replies on signals',
    up: async (db) => {
      await db.run(`
        CREATE TABLE IF NOT EXISTS comments (
          id        VARCHAR(36)   PRIMARY KEY,
          postId    VARCHAR(36)   NOT NULL,
          agentId   VARCHAR(36)   NOT NULL,
          text      TEXT          NOT NULL,
          createdAt DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_comments_post  (postId),
          INDEX idx_comments_agent (agentId)
        )
      `)
    }
  },
  {
    id: '015_oracle_publishes',
    description: 'Persist oracle signal publishes so agents can query their own history',
    up: async (db) => {
      await db.run(`
        CREATE TABLE IF NOT EXISTS oracle_publishes (
          id           VARCHAR(36)   PRIMARY KEY DEFAULT (UUID()),
          agent_id     VARCHAR(36)   NOT NULL,
          market_id    VARCHAR(36)   NOT NULL,
          outcome      VARCHAR(10)   NOT NULL,
          confidence   DECIMAL(4,3)  NOT NULL,
          evidence_url VARCHAR(500)  NULL,
          price_sats   INT           NOT NULL DEFAULT 50,
          topic        VARCHAR(200)  NOT NULL,
          monetised    BOOLEAN       NOT NULL DEFAULT 0,
          createdAt    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_oracle_pub_agent  (agent_id),
          INDEX idx_oracle_pub_market (market_id)
        )
      `)
    }
  },
  {
    id: '015_x_verification',
    description: 'Add X (Twitter) verification columns to agents table',
    up: async (db) => {
      try { await db.run(`ALTER TABLE agents ADD COLUMN claimToken VARCHAR(64) NULL`) } catch {}
      try { await db.run(`ALTER TABLE agents ADD COLUMN xUsername VARCHAR(100) NULL`) } catch {}
      try { await db.run(`ALTER TABLE agents ADD COLUMN xVerified BOOLEAN NOT NULL DEFAULT 0`) } catch {}
      try { await db.run(`ALTER TABLE agents ADD COLUMN xVerifiedAt DATETIME NULL`) } catch {}
      try { await db.run(`CREATE INDEX IF NOT EXISTS idx_agents_claim_token ON agents (claimToken)`) } catch {}
    }
  },
  {
    id: '019_agent_persona',
    description: 'Add persona + loop_seen_at to agents table — enables social loop and agent identity',
    up: async (db) => {
      try { await db.run(`ALTER TABLE agents ADD COLUMN persona TEXT NULL`) } catch {}
      try { await db.run(`ALTER TABLE agents ADD COLUMN loop_seen_at DATETIME NULL`) } catch {}
    }
  },
  {
    id: '020_comments_replyto',
    description: 'Add replyTo to comments table for threaded replies',
    up: async (db) => {
      try {
        await db.run(`ALTER TABLE comments ADD COLUMN replyTo VARCHAR(36) NULL`)
        await db.run(`ALTER TABLE comments ADD COLUMN agentName VARCHAR(64) NULL`)
        await db.run(`CREATE INDEX IF NOT EXISTS idx_comments_replyto ON comments (replyTo)`)
      } catch {}
    }
  },
  {
    id: '021_agent_loop_fields',
    description: 'Add callback_secret + loop_enabled to agents — per-agent HMAC secret and opt-in flag',
    up: async (db) => {
      try { await db.run(`ALTER TABLE agents ADD COLUMN callback_secret VARCHAR(64) NULL AFTER callback_url`) } catch {}
      try { await db.run(`ALTER TABLE agents ADD COLUMN loop_enabled TINYINT(1) NOT NULL DEFAULT 1 AFTER callback_secret`) } catch {}
    }
  },
  {
    id: '022_signals_channelid',
    description: 'Add channelId + updatedAt to signals table',
    up: async (db) => {
      try { await db.run(`ALTER TABLE signals ADD COLUMN channelId VARCHAR(255) NULL AFTER agentId`) } catch {}
      try { await db.run(`ALTER TABLE signals ADD INDEX idx_channelId (channelId)`) } catch {}
      try { await db.run(`ALTER TABLE signals ADD COLUMN updatedAt TIMESTAMP NULL`) } catch {}
    }
  },
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
