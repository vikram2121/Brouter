/**
 * verify-migrations.ts
 * Verify Phase 3 migrations applied correctly against target DB.
 * 
 * Usage:
 *   Local:      npx ts-node scripts/verify-migrations.ts
 *   Production: DB_HOST=... DB_USER=... DB_PASSWORD=... DB_NAME=... npx ts-node scripts/verify-migrations.ts
 */
import mysql from 'mysql2/promise'

async function main() {
  const host = process.env.DB_HOST || 'localhost'
  const user = process.env.DB_USER || 'root'
  const password = process.env.DB_PASSWORD || ''
  const database = process.env.DB_NAME || 'brouter'

  console.log(`\n🔍 Verifying migrations on ${host}/${database}...\n`)

  const conn = await mysql.createConnection({ host, user, password, database })
  let passed = 0
  let failed = 0

  function assert(condition: boolean, message: string) {
    if (condition) {
      console.log(`  ✅ ${message}`)
      passed++
    } else {
      console.log(`  ❌ FAIL: ${message}`)
      failed++
    }
  }

  try {
    // ── Markets: Phase 3 resolution columns ──────────────────────────────────
    const [marketCols] = await conn.query(`
      SELECT COLUMN_NAME, COLUMN_DEFAULT, IS_NULLABLE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'markets'
        AND COLUMN_NAME IN (
          'resolution_mechanism',
          'consensus_window_hours',
          'consensus_min_stake_sats',
          'consensus_supermajority_pct',
          'oracle_verified'
        )
    `) as any[][]
    assert(marketCols.length === 5, `All 5 Phase 3 columns present on markets (found ${marketCols.length}/5)`)

    const colMap = Object.fromEntries((marketCols as any[]).map((c: any) => [c.COLUMN_NAME, c]))
    assert(colMap['resolution_mechanism']?.COLUMN_DEFAULT === 'oracle_auto', "resolution_mechanism defaults to 'oracle_auto'")
    assert(colMap['consensus_window_hours']?.COLUMN_DEFAULT === '24', 'consensus_window_hours defaults to 24')
    assert(colMap['consensus_min_stake_sats']?.COLUMN_DEFAULT === '1000', 'consensus_min_stake_sats defaults to 1000')
    assert(colMap['consensus_supermajority_pct']?.COLUMN_DEFAULT === '66', 'consensus_supermajority_pct defaults to 66')
    assert(colMap['oracle_verified']?.COLUMN_DEFAULT === '0', 'oracle_verified defaults to 0')

    // ── Tables exist ──────────────────────────────────────────────────────────
    const [tables] = await conn.query(`
      SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN ('resolution_claims', 'resolution_claim_dust')
    `) as any[][]
    const tableNames = (tables as any[]).map((t: any) => t.TABLE_NAME)
    assert(tableNames.includes('resolution_claims'), 'resolution_claims table exists')
    assert(tableNames.includes('resolution_claim_dust'), 'resolution_claim_dust table exists')

    // ── UNIQUE constraint name ────────────────────────────────────────────────
    const [indexes] = await conn.query(`
      SHOW INDEX FROM resolution_claims WHERE Key_name = 'unique_agent_claim'
    `) as any[][]
    assert((indexes as any[]).length > 0, "UNIQUE KEY 'unique_agent_claim' on resolution_claims(market_id, agent_id)")

    // ── Existing markets have defaults (no NULLs on NOT NULL columns) ─────────
    const [nullCheck] = await conn.query(`
      SELECT COUNT(*) as count FROM markets
      WHERE resolution_mechanism IS NULL
        OR consensus_window_hours IS NULL
    `) as any[][]
    assert((nullCheck as any[])[0].count === 0, 'All existing markets have non-null resolution defaults')

    // ── resolution_claims columns ─────────────────────────────────────────────
    const [claimCols] = await conn.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'resolution_claims'
        AND COLUMN_NAME IN (
          'id', 'market_id', 'agent_id', 'claimed_outcome',
          'stake_sats', 'commitment_hash', 'revealed_at',
          'payout_sats', 'outcome_correct', 'submitted_at', 'resolved_at'
        )
    `) as any[][]
    assert((claimCols as any[]).length === 11, `resolution_claims has all 11 expected columns (found ${(claimCols as any[]).length}/11)`)

  } finally {
    await conn.end()
  }

  console.log(`\n${'─'.repeat(40)}`)
  console.log(`  Passed: ${passed}  Failed: ${failed}`)
  if (failed === 0) {
    console.log('  ✅ All migration assertions passed\n')
    process.exit(0)
  } else {
    console.log('  ❌ Some assertions failed — do NOT deploy to production\n')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Fatal error:', err.message)
  process.exit(1)
})
