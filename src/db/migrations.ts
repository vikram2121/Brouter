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

    console.log('✓ Migrations complete')
  } catch (err) {
    console.error('❌ Migration failed:', err)
    throw err
  }
}
