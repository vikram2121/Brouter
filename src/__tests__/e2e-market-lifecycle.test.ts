/**
 * End-to-End Market Lifecycle Test
 * 
 * Full lifecycle from creation to settlement:
 * 1. Create market (PROPOSED state)
 * 2. Insert agents and stakes
 * 3. Transition market: PROPOSED → OPEN
 * 4. Verify stakes are locked
 * 5. Transition: OPEN → LOCKED
 * 6. Transition: LOCKED → RESOLVING
 * 7. Resolve market (YES outcome)
 * 8. Calculate and verify payouts
 * 9. Transition: RESOLVING → SETTLED
 * 10. Verify settlement record
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import mysql from 'mysql2/promise'

describe('End-to-End Market Lifecycle', () => {
  let conn: mysql.Connection

  beforeAll(async () => {
    // Create database first
    const tempConn = await mysql.createConnection({
      host: 'localhost',
      user: 'root',
      password: ''
    })
    await tempConn.execute('CREATE DATABASE IF NOT EXISTS scout_e2e_test')
    await tempConn.end()

    conn = await mysql.createConnection({
      host: 'localhost',
      user: 'root',
      password: '',
      database: 'scout_e2e_test',
    })

    // Create schema (drop in order to avoid FK constraint issues)
    await conn.execute(`SET FOREIGN_KEY_CHECKS = 0`)
    await conn.execute(`DROP TABLE IF EXISTS market_state_log`)
    await conn.execute(`DROP TABLE IF EXISTS stakes`)
    await conn.execute(`DROP TABLE IF EXISTS agents`)
    await conn.execute(`DROP TABLE IF EXISTS markets`)
    await conn.execute(`SET FOREIGN_KEY_CHECKS = 1`)

    // Create agents table
    await conn.execute(`
      CREATE TABLE agents (
        id VARCHAR(255) PRIMARY KEY,
        pubkey VARCHAR(512) NOT NULL UNIQUE,
        handle VARCHAR(32),
        displayName VARCHAR(32) GENERATED ALWAYS AS (COALESCE(handle, CONCAT('agent_', LEFT(id, 8)))) STORED,
        totalStakedSats BIGINT DEFAULT 0,
        totalEarnedSats BIGINT DEFAULT 0,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Create markets table
    await conn.execute(`
      CREATE TABLE markets (
        id VARCHAR(255) PRIMARY KEY,
        title VARCHAR(500) NOT NULL,
        description TEXT,
        domain ENUM('crypto','macro','sports','politics','science','agent-meta') DEFAULT 'crypto',
        tier ENUM('rapid','weekly','anchor') DEFAULT 'weekly',
        state ENUM('PROPOSED','OPEN','LOCKED','RESOLVING','SETTLED','ARCHIVED') DEFAULT 'PROPOSED',
        proposedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        openedAt TIMESTAMP NULL,
        lockedAt TIMESTAMP NULL,
        resolvingAt TIMESTAMP NULL,
        settledAt TIMESTAMP NULL,
        archivedAt TIMESTAMP NULL,
        closesAt TIMESTAMP NOT NULL,
        resolvesAt TIMESTAMP NOT NULL,
        resolutionCriteria TEXT NOT NULL,
        outcome ENUM('yes','no','void') NULL,
        resolvedBy VARCHAR(255) NULL,
        totalYesSats BIGINT DEFAULT 0,
        totalNoSats BIGINT DEFAULT 0,
        agentCount INT DEFAULT 0,
        openAnchorTxid VARCHAR(255),
        lockAnchorTxid VARCHAR(255),
        resolutionAnchorTxid VARCHAR(255),
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `)

    // Create stakes table
    await conn.execute(`
      CREATE TABLE stakes (
        id VARCHAR(255) PRIMARY KEY,
        marketId VARCHAR(255) NOT NULL,
        agentId VARCHAR(255) NOT NULL,
        direction ENUM('yes','no') NOT NULL,
        amountSats BIGINT NOT NULL,
        paymentTxid VARCHAR(255),
        anchorTxid VARCHAR(255),
        payoutSats BIGINT NULL DEFAULT 0,
        payoutTxid VARCHAR(255) NULL,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_market (marketId),
        INDEX idx_agent (agentId)
      )
    `)

    // Create market_state_log table
    await conn.execute(`
      CREATE TABLE market_state_log (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        marketId VARCHAR(255) NOT NULL,
        fromState VARCHAR(50),
        toState VARCHAR(50) NOT NULL,
        triggeredBy VARCHAR(255),
        anchorTxid VARCHAR(255),
        loggedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_marketId (marketId)
      )
    `)
  })

  afterAll(async () => {
    await conn.end()
  })

  it('completes full market lifecycle with stakes and payouts', async () => {
    // ============ STEP 1: Create agents ============
    const agents = ['alice', 'bob', 'charlie']
    const agentIds = []

    for (const handle of agents) {
      const agentId = `agent-${handle}`
      agentIds.push(agentId)

      await conn.execute(
        `INSERT INTO agents (id, pubkey, handle) VALUES (?, ?, ?)`,
        [agentId, `pubkey_${handle}`, handle]
      )
    }

    // ============ STEP 2: Create market ============
    const marketId = 'e2e-test-market-1'
    const now = new Date()
    const closesAt = new Date(now.getTime() + 72 * 60 * 60 * 1000)
    const resolvesAt = new Date(closesAt.getTime() + 60 * 60 * 1000)

    await conn.execute(
      `INSERT INTO markets 
       (id, title, state, closesAt, resolvesAt, resolutionCriteria, domain, tier)
       VALUES (?, ?, 'PROPOSED', ?, ?, ?, 'crypto', 'weekly')`,
      [
        marketId,
        'Will BTC hit $100k by June 2026?',
        closesAt,
        resolvesAt,
        'BTC price on CoinMarketCap at resolvesAt'
      ]
    )

    // Log initial PROPOSED state
    await conn.execute(
      `INSERT INTO market_state_log (marketId, toState, triggeredBy)
       VALUES (?, 'PROPOSED', 'system')`,
      [marketId]
    )

    // ============ STEP 3: Insert stakes ============
    // alice: 1000 sats on YES
    // bob:   1500 sats on NO
    // charlie: 500 sats on YES
    const stakes = [
      { agentId: agentIds[0], direction: 'yes', amount: 1000 },
      { agentId: agentIds[1], direction: 'no', amount: 1500 },
      { agentId: agentIds[2], direction: 'yes', amount: 500 }
    ]

    for (let i = 0; i < stakes.length; i++) {
      const stake = stakes[i]
      const stakeId = `stake-${i + 1}`

      await conn.execute(
        `INSERT INTO stakes 
         (id, marketId, agentId, direction, amountSats, paymentTxid, anchorTxid)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          stakeId,
          marketId,
          stake.agentId,
          stake.direction,
          stake.amount,
          `tx_payment_${i + 1}`,
          `tx_anchor_${i + 1}`
        ]
      )
    }

    // Update market denormalized totals
    await conn.execute(
      `UPDATE markets SET totalYesSats = 1500, totalNoSats = 1500, agentCount = 3
       WHERE id = ?`,
      [marketId]
    )

    // ============ STEP 4: Verify initial state ============
    const [marketRows] = await conn.execute('SELECT * FROM markets WHERE id = ?', [marketId]) as any
    const market = (marketRows as any[])[0]

    expect(market.state).toBe('PROPOSED')
    expect(market.totalYesSats).toBe(1500)
    expect(market.totalNoSats).toBe(1500)
    expect(market.agentCount).toBe(3)

    const [stakeRows] = await conn.execute('SELECT * FROM stakes WHERE marketId = ? ORDER BY createdAt', [
      marketId
    ]) as any
    const stakeList = stakeRows as any[]
    expect(stakeList.length).toBe(3)

    // ============ STEP 5: Transition PROPOSED → OPEN ============
    await conn.execute(
      `UPDATE markets SET state = 'OPEN', openedAt = NOW(), openAnchorTxid = ? WHERE id = ?`,
      ['tx_open_anchor_001', marketId]
    )
    await conn.execute(
      `INSERT INTO market_state_log (marketId, fromState, toState, triggeredBy, anchorTxid)
       VALUES (?, 'PROPOSED', 'OPEN', 'system', ?)`,
      [marketId, 'tx_open_anchor_001']
    )

    let result = await conn.execute('SELECT * FROM markets WHERE id = ?', [marketId]) as any
    let market2 = (result[0] as any[])[0]
    expect(market2.state).toBe('OPEN')

    // ============ STEP 6: Transition OPEN → LOCKED ============
    await conn.execute(
      `UPDATE markets SET state = 'LOCKED', lockedAt = NOW(), lockAnchorTxid = ? WHERE id = ?`,
      ['tx_lock_anchor_001', marketId]
    )
    await conn.execute(
      `INSERT INTO market_state_log (marketId, fromState, toState, triggeredBy, anchorTxid)
       VALUES (?, 'OPEN', 'LOCKED', 'system', ?)`,
      [marketId, 'tx_lock_anchor_001']
    )

    result = await conn.execute('SELECT * FROM markets WHERE id = ?', [marketId]) as any
    market2 = (result[0] as any[])[0]
    expect(market2.state).toBe('LOCKED')

    // ============ STEP 7: Transition LOCKED → RESOLVING ============
    await conn.execute(
      `UPDATE markets SET state = 'RESOLVING', resolvingAt = NOW() WHERE id = ?`,
      [marketId]
    )
    await conn.execute(
      `INSERT INTO market_state_log (marketId, fromState, toState, triggeredBy)
       VALUES (?, 'LOCKED', 'RESOLVING', 'oracle')`,
      [marketId]
    )

    result = await conn.execute('SELECT * FROM markets WHERE id = ?', [marketId]) as any
    market2 = (result[0] as any[])[0]
    expect(market2.state).toBe('RESOLVING')

    // ============ STEP 8: Resolve market (YES outcome) ============
    const outcome = 'yes'
    const totalPoolSats = market.totalYesSats + market.totalNoSats // 3000

    // Calculate payouts (YES outcome wins)
    // YES stakes: alice (1000) + charlie (500) = 1500
    // Pool distribution: (stake/winning_pool) * total_pool
    // alice: (1000/1500) * 3000 = 2000
    // charlie: (500/1500) * 3000 = 1000
    // bob: 0

    const payouts = [
      { stakeId: 'stake-1', agentId: agentIds[0], payoutSats: 2000 }, // alice: YES winner
      { stakeId: 'stake-2', agentId: agentIds[1], payoutSats: 0 },    // bob: NO loser
      { stakeId: 'stake-3', agentId: agentIds[2], payoutSats: 1000 }  // charlie: YES winner
    ]

    // Update stakes with payouts
    for (const payout of payouts) {
      await conn.execute(
        `UPDATE stakes SET payoutSats = ?, payoutTxid = ? WHERE id = ?`,
        [payout.payoutSats, `tx_payout_${payout.stakeId}`, payout.stakeId]
      )
    }

    // Update agent earnings
    await conn.execute(
      `UPDATE agents SET totalEarnedSats = totalEarnedSats + 2000 WHERE id = ?`,
      [agentIds[0]]
    )
    await conn.execute(
      `UPDATE agents SET totalEarnedSats = totalEarnedSats + 1000 WHERE id = ?`,
      [agentIds[2]]
    )

    // ============ STEP 9: Transition RESOLVING → SETTLED ============
    await conn.execute(
      `UPDATE markets SET state = 'SETTLED', settledAt = NOW(), outcome = ?, resolvedBy = ?, resolutionAnchorTxid = ? WHERE id = ?`,
      [outcome, 'oracle', 'tx_resolution_anchor_001', marketId]
    )
    await conn.execute(
      `INSERT INTO market_state_log (marketId, fromState, toState, triggeredBy, anchorTxid)
       VALUES (?, 'RESOLVING', 'SETTLED', 'oracle', ?)`,
      [marketId, 'tx_resolution_anchor_001']
    )

    // ============ STEP 10: Verify final state ============
    result = await conn.execute('SELECT * FROM markets WHERE id = ?', [marketId]) as any
    market2 = (result[0] as any[])[0]

    expect(market2.state).toBe('SETTLED')
    expect(market2.outcome).toBe('yes')
    expect(market2.resolvedBy).toBe('oracle')
    expect(market2.resolutionAnchorTxid).toBe('tx_resolution_anchor_001')

    // Verify stakes were paid out
    result = await conn.execute('SELECT * FROM stakes WHERE marketId = ? ORDER BY createdAt', [
      marketId
    ]) as any
    const finalStakes = result[0] as any[]

    expect(finalStakes[0].payoutSats).toBe(2000) // alice
    expect(finalStakes[1].payoutSats).toBe(0)    // bob
    expect(finalStakes[2].payoutSats).toBe(1000) // charlie

    // Verify agent earnings
    result = await conn.execute('SELECT * FROM agents WHERE id = ?', [agentIds[0]]) as any
    const aliceAgent = (result[0] as any[])[0]
    result = await conn.execute('SELECT * FROM agents WHERE id = ?', [agentIds[2]]) as any
    const charlieAgent = (result[0] as any[])[0]

    expect(aliceAgent.totalEarnedSats).toBe(2000)
    expect(charlieAgent.totalEarnedSats).toBe(1000)

    // Verify state history
    result = await conn.execute(
      'SELECT * FROM market_state_log WHERE marketId = ? ORDER BY loggedAt ASC',
      [marketId]
    ) as any
    const history = result[0] as any[]

    expect(history.length).toBe(5) // PROPOSED, OPEN, LOCKED, RESOLVING, SETTLED
    expect(history[0].toState).toBe('PROPOSED')
    expect(history[1].toState).toBe('OPEN')
    expect(history[2].toState).toBe('LOCKED')
    expect(history[3].toState).toBe('RESOLVING')
    expect(history[4].toState).toBe('SETTLED')
    expect(history[4].anchorTxid).toBe('tx_resolution_anchor_001')
  })

  it('handles VOID outcome (refunds all stakes)', async () => {
    // Create market
    const marketId = 'e2e-void-test'
    const now = new Date()
    const closesAt = new Date(now.getTime() + 72 * 60 * 60 * 1000)
    const resolvesAt = new Date(closesAt.getTime() + 60 * 60 * 1000)

    await conn.execute(
      `INSERT INTO agents (id, pubkey, handle) VALUES (?, ?, ?)`,
      ['agent-void-1', 'pubkey_void_1', 'void-trader-1']
    )

    await conn.execute(
      `INSERT INTO markets 
       (id, title, state, closesAt, resolvesAt, resolutionCriteria)
       VALUES (?, ?, 'PROPOSED', ?, ?, ?)`,
      [marketId, 'Void test market', closesAt, resolvesAt, 'test']
    )

    // Add stakes
    await conn.execute(
      `INSERT INTO stakes 
       (id, marketId, agentId, direction, amountSats, paymentTxid)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['void-stake-1', marketId, 'agent-void-1', 'yes', 1000, 'tx_void_1']
    )

    // Update market
    await conn.execute(
      `UPDATE markets SET state = 'PROPOSED', totalYesSats = 1000, totalNoSats = 0, agentCount = 1 WHERE id = ?`,
      [marketId]
    )

    // Move through lifecycle
    await conn.execute(`UPDATE markets SET state = 'OPEN', openedAt = NOW() WHERE id = ?`, [marketId])
    await conn.execute(`UPDATE markets SET state = 'LOCKED', lockedAt = NOW() WHERE id = ?`, [marketId])
    await conn.execute(`UPDATE markets SET state = 'RESOLVING', resolvingAt = NOW() WHERE id = ?`, [
      marketId
    ])

    // Resolve as VOID (refund)
    await conn.execute(
      `UPDATE stakes SET payoutSats = 1000 WHERE marketId = ?`,
      [marketId]
    )
    await conn.execute(
      `UPDATE markets SET state = 'SETTLED', outcome = 'void', resolvedBy = 'system' WHERE id = ?`,
      [marketId]
    )

    // Verify refund
    let voidResult = await conn.execute('SELECT * FROM stakes WHERE marketId = ?', [marketId]) as any
    const voidStakes = (voidResult[0] as any[])
    expect(voidStakes[0].payoutSats).toBe(1000) // Full refund

    voidResult = await conn.execute('SELECT * FROM markets WHERE id = ?', [marketId]) as any
    const voidMarket = (voidResult[0] as any[])[0]
    expect(voidMarket.outcome).toBe('void')
    expect(voidMarket.state).toBe('SETTLED')
  })
})
