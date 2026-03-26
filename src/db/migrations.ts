/**
 * Database migrations for Phase 1
 * Run at startup to ensure schema is complete
 */
import { DbConnection } from './connection'

export async function runMigrations(db: DbConnection): Promise<void> {
  console.log('🔧 Running database migrations...')

  try {
    // Check if faucet_claimed column exists
    const faucetClaimedExists = await db.get(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agents' AND COLUMN_NAME = 'faucet_claimed'`,
      []
    )

    if (!faucetClaimedExists) {
      console.log('  📝 Adding faucet_claimed column...')
      await db.run(
        `ALTER TABLE agents ADD COLUMN faucet_claimed BOOLEAN NOT NULL DEFAULT 0`
      )
      console.log('  ✓ Added faucet_claimed')
    }

    // Check if faucet_claimed_at column exists
    const faucetClaimedAtExists = await db.get(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agents' AND COLUMN_NAME = 'faucet_claimed_at'`,
      []
    )

    if (!faucetClaimedAtExists) {
      console.log('  📝 Adding faucet_claimed_at column...')
      await db.run(
        `ALTER TABLE agents ADD COLUMN faucet_claimed_at TIMESTAMP NULL`
      )
      console.log('  ✓ Added faucet_claimed_at')
    }

    // Check if bsvAddress column exists (Phase 2)
    const bsvAddressExists = await db.get(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agents' AND COLUMN_NAME = 'bsvAddress'`,
      []
    )

    if (!bsvAddressExists) {
      console.log('  📝 Adding bsvAddress column...')
      await db.run(
        `ALTER TABLE agents ADD COLUMN bsvAddress VARCHAR(255) NULL AFTER faucet_claimed_at`
      )
      console.log('  ✓ Added bsvAddress')
    }

    // Check if bsvAddressVerifiedAt column exists (Phase 2)
    const bsvAddressVerifiedAtExists = await db.get(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agents' AND COLUMN_NAME = 'bsvAddressVerifiedAt'`,
      []
    )

    if (!bsvAddressVerifiedAtExists) {
      console.log('  📝 Adding bsvAddressVerifiedAt column...')
      await db.run(
        `ALTER TABLE agents ADD COLUMN bsvAddressVerifiedAt TIMESTAMP NULL AFTER bsvAddress`
      )
      console.log('  ✓ Added bsvAddressVerifiedAt')
      
      // Try to create index (if it already exists, will be ignored)
      try {
        await db.run(
          `CREATE INDEX idx_bsv_address ON agents (bsvAddress)`
        )
      } catch (err: any) {
        // Index might already exist, that's OK
        if (!err.message.includes('Duplicate key name')) {
          throw err
        }
      }
    }

    // Check if balance_sats column exists (Phase 2)
    const balanceSatsExists = await db.get(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agents' AND COLUMN_NAME = 'balance_sats'`,
      []
    )

    if (!balanceSatsExists) {
      console.log('  📝 Adding balance_sats column...')
      await db.run(
        `ALTER TABLE agents ADD COLUMN balance_sats BIGINT NOT NULL DEFAULT 0`
      )
      console.log('  ✓ Added balance_sats')
    }

    // Check if evidenceUrl column exists on markets (Phase 2.5)
    const evidenceUrlExists = await db.get(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'markets' AND COLUMN_NAME = 'evidenceUrl'`,
      []
    )
    if (!evidenceUrlExists) {
      console.log('  📝 Adding evidenceUrl + evidenceNote to markets...')
      await db.run(`ALTER TABLE markets ADD COLUMN evidenceUrl VARCHAR(512) NULL`)
      await db.run(`ALTER TABLE markets ADD COLUMN evidenceNote TEXT NULL`)
      console.log('  ✓ Added evidenceUrl, evidenceNote')
    }

    // Check if position column exists on signals (SignalPoolService uses it)
    const signalPositionExists = await db.get(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'signals' AND COLUMN_NAME = 'position'`,
      []
    )
    if (!signalPositionExists) {
      console.log('  📝 Adding position column to signals...')
      await db.run(`ALTER TABLE signals ADD COLUMN position ENUM('yes','no') NULL`)
      console.log('  ✓ Added signals.position')
    }

    console.log('✓ Migrations complete')
  } catch (err) {
    console.error('❌ Migration failed:', err)
    throw err
  }
}
