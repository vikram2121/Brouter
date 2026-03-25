/**
 * SettlementEngine Integration Test
 *
 * Full settlement flow:
 * 1. Create market with agents and stakes
 * 2. Create signals for each agent (calibration)
 * 3. Call settle() with outcome
 * 4. Verify:
 *    - Payouts written to stakes table
 *    - Agent earnings updated
 *    - Calibration scores calculated
 *    - Market marked as SETTLED
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import mysql from 'mysql2/promise'
import { SettlementEngine } from '../services/SettlementEngine'
import { CalibrationService } from '../services/CalibrationService'

describe('SettlementEngine Integration', () => {
  let conn: mysql.Connection
  let db: any
  let settlementEngine: SettlementEngine
  let calibrationService: CalibrationService

  beforeAll(async () => {
    // Create database
    const tempConn = await mysql.createConnection({
      host: 'localhost',
      user: 'root',
      password: ''
    })
    await tempConn.execute('CREATE DATABASE IF NOT EXISTS scout_settlement_test')
    await tempConn.end()

    // Connect
    conn = await mysql.createConnection({
      host: 'localhost',
      user: 'root',
      password: '',
      database: 'scout_settlement_test'
    })

    // Create schema
    await conn.execute(`SET FOREIGN_KEY_CHECKS = 0`)
    await conn.execute(`DROP TABLE IF EXISTS calibration_scores`)
    await conn.execute(`DROP TABLE IF EXISTS signals`)
    await conn.execute(`DROP TABLE IF EXISTS market_state_log`)
    await conn.execute(`DROP TABLE IF EXISTS settlement_dust`)
    await conn.execute(`DROP TABLE IF EXISTS stakes`)
    await conn.execute(`DROP TABLE IF EXISTS agents`)
    await conn.execute(`DROP TABLE IF EXISTS markets`)
    await conn.execute(`SET FOREIGN_KEY_CHECKS = 1`)

    // Create tables
    await conn.execute(`
      CREATE TABLE agents (
        id VARCHAR(255) PRIMARY KEY,
        pubkey VARCHAR(512) NOT NULL UNIQUE,
        handle VARCHAR(32),
        totalEarnedSats BIGINT DEFAULT 0,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await conn.execute(`
      CREATE TABLE markets (
        id VARCHAR(255) PRIMARY KEY,
        title VARCHAR(500) NOT NULL,
        domain VARCHAR(50) DEFAULT 'crypto',
        state VARCHAR(50) DEFAULT 'PROPOSED',
        totalYesSats BIGINT DEFAULT 0,
        totalNoSats BIGINT DEFAULT 0,
        outcome VARCHAR(10) NULL,
        resolutionAnchorTxid VARCHAR(255) NULL,
        closesAt TIMESTAMP NOT NULL,
        resolvesAt TIMESTAMP NOT NULL,
        resolutionCriteria TEXT,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await conn.execute(`
      CREATE TABLE stakes (
        id VARCHAR(255) PRIMARY KEY,
        marketId VARCHAR(255) NOT NULL,
        agentId VARCHAR(255) NOT NULL,
        direction VARCHAR(10) NOT NULL,
        amountSats BIGINT NOT NULL,
        impliedProbability DECIMAL(5, 4) DEFAULT 0.5,
        payoutSats BIGINT DEFAULT 0,
        payoutTxid VARCHAR(255) NULL,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_market (marketId),
        INDEX idx_agent (agentId)
      )
    `)

    await conn.execute(`
      CREATE TABLE signals (
        id VARCHAR(255) PRIMARY KEY,
        marketId VARCHAR(255) NOT NULL,
        agentId VARCHAR(255) NOT NULL,
        signalValue DECIMAL(5, 4) NOT NULL,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_market (marketId),
        INDEX idx_agent (agentId)
      )
    `)

    await conn.execute(`
      CREATE TABLE calibration_scores (
        agentId VARCHAR(255) NOT NULL,
        domain VARCHAR(50) NOT NULL,
        brierSum DECIMAL(10, 6) DEFAULT 0,
        sampleCount INT DEFAULT 0,
        score DECIMAL(10, 6) DEFAULT 0,
        updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (agentId, domain),
        FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE,
        INDEX idx_domain (domain)
      )
    `)

    await conn.execute(`
      CREATE TABLE settlement_dust (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        marketId VARCHAR(255) NOT NULL UNIQUE,
        feeSats BIGINT NOT NULL,
        roundingDustSats BIGINT NOT NULL,
        totalDustSats BIGINT NOT NULL,
        settledAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (marketId) REFERENCES markets(id) ON DELETE CASCADE,
        INDEX idx_marketId (marketId),
        INDEX idx_settledAt (settledAt)
      )
    `)

    await conn.execute(`
      CREATE TABLE market_state_log (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        marketId VARCHAR(255) NOT NULL,
        oldState VARCHAR(50),
        newState VARCHAR(50) NOT NULL,
        transitionAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (marketId) REFERENCES markets(id) ON DELETE CASCADE,
        INDEX idx_marketId (marketId),
        INDEX idx_transitionAt (transitionAt)
      )
    `)

    // Create mock db wrapper
    db = {
      run: async (sql: string, params: any[]) => {
        return conn.execute(sql, params)
      },
      get: async (sql: string, params: any[]) => {
        const [rows] = await conn.execute(sql, params) as any
        return (rows as any[])[0]
      },
      all: async (sql: string, params: any[]) => {
        const [rows] = await conn.execute(sql, params) as any
        return rows as any[]
      }
    }

    // Initialize settlement engine
    settlementEngine = new SettlementEngine(
      {
        bsvClient: {},
        walletAddress: 'bsv_test_wallet',
        walletPrivKey: '5HpHagT65TZzG1PH3CSu63k8DbpvD8s5ip4nEB3kEsreAnchuDf', // Mock WIF
        network: 'testnet'
      },
      db
    )

    // Initialize calibration service
    calibrationService = new CalibrationService(db)
  })

  afterAll(async () => {
    await conn.end()
  })

  it('settles market with payouts and calibration', async () => {
    // STEP 1: Create agents
    const agents = ['alice', 'bob', 'charlie']
    for (const handle of agents) {
      const agentId = `agent-${handle}`
      await conn.execute(
        `INSERT INTO agents (id, pubkey, handle) VALUES (?, ?, ?)`,
        [agentId, `pubkey_${handle}`, handle]
      )
    }

    // STEP 2: Create market
    const marketId = 'settlement-test-market'
    const now = new Date()
    const closesAt = new Date(now.getTime() + 72 * 60 * 60 * 1000)
    const resolvesAt = new Date(closesAt.getTime() + 60 * 60 * 1000)

    await conn.execute(
      `INSERT INTO markets (id, title, domain, state, closesAt, resolvesAt, resolutionCriteria, totalYesSats, totalNoSats)
       VALUES (?, ?, 'crypto', 'RESOLVING', ?, ?, ?, 1500, 1500)`,
      [marketId, 'Test Market', closesAt, resolvesAt, 'test']
    )

    // STEP 3: Create stakes with implied probabilities
    // alice: 1000 YES at 0.7 (70% confidence)
    // bob: 1500 NO at 0.4 (40% yes = 60% no)
    // charlie: 500 YES at 0.8 (80% confidence)
    await conn.execute(
      `INSERT INTO stakes (id, marketId, agentId, direction, amountSats, impliedProbability) VALUES (?, ?, ?, ?, ?, ?)`,
      ['stake-1', marketId, 'agent-alice', 'yes', 1000, 0.7]
    )
    await conn.execute(
      `INSERT INTO stakes (id, marketId, agentId, direction, amountSats, impliedProbability) VALUES (?, ?, ?, ?, ?, ?)`,
      ['stake-2', marketId, 'agent-bob', 'no', 1500, 0.4]
    )
    await conn.execute(
      `INSERT INTO stakes (id, marketId, agentId, direction, amountSats, impliedProbability) VALUES (?, ?, ?, ?, ?, ?)`,
      ['stake-3', marketId, 'agent-charlie', 'yes', 500, 0.8]
    )

    // STEP 4: Create signals (for calibration)
    // alice predicted 0.7 (70% yes)
    // bob predicted 0.4 (40% yes)
    // charlie predicted 0.8 (80% yes)
    await conn.execute(
      `INSERT INTO signals (id, marketId, agentId, signalValue) VALUES (?, ?, ?, ?)`,
      ['signal-1', marketId, 'agent-alice', 0.7]
    )
    await conn.execute(
      `INSERT INTO signals (id, marketId, agentId, signalValue) VALUES (?, ?, ?, ?)`,
      ['signal-2', marketId, 'agent-bob', 0.4]
    )
    await conn.execute(
      `INSERT INTO signals (id, marketId, agentId, signalValue) VALUES (?, ?, ?, ?)`,
      ['signal-3', marketId, 'agent-charlie', 0.8]
    )

    // STEP 5: Call settle() with YES outcome
    const settlement = await (settlementEngine as any).settle(marketId, 'yes', 'oracle')

    // STEP 5B: Update calibration scores (called separately in resolve endpoint)
    await calibrationService.updateCalibration(marketId, 'yes')

    // STEP 6: Verify settlement returned correct structure
    expect(settlement.marketId).toBe(marketId)
    expect(settlement.outcome).toBe('yes')
    expect(settlement.resolutionTxid).toBeTruthy()
    expect(settlement.stakes.length).toBe(3)

    // STEP 7: Verify payouts written to stakes table
    const [stakes] = await conn.execute(
      'SELECT * FROM stakes WHERE marketId = ? ORDER BY createdAt ASC',
      [marketId]
    ) as any
    const stakeList = stakes as any[]

    // Pool: alice 1000 YES + charlie 500 YES + bob 1500 NO = 3000 total
    // Fee: 1% = 30 sats
    // Distributable: 3000 - 30 = 2970 sats
    // Winners (YES): alice + charlie = 1500 total stake
    // Alice payout: (1000/1500) * 2970 = 1980
    // Charlie payout: (500/1500) * 2970 = 990
    // Dust: 0
    expect(stakeList[0].payoutSats).toBe(1980) // alice: (1000/1500) * 2970 = 1980
    expect(stakeList[1].payoutSats).toBe(0)    // bob: loser, 0 payout
    expect(stakeList[2].payoutSats).toBe(990)  // charlie: (500/1500) * 2970 = 990

    // STEP 8: Verify agent earnings updated
    const [aliceRows] = await conn.execute('SELECT * FROM agents WHERE id = ?', [
      'agent-alice'
    ]) as any
    const aliceAgent = (aliceRows as any[])[0]
    expect(aliceAgent.totalEarnedSats).toBe(1980)

    const [charlieRows] = await conn.execute('SELECT * FROM agents WHERE id = ?', [
      'agent-charlie'
    ]) as any
    const charlieAgent = (charlieRows as any[])[0]
    expect(charlieAgent.totalEarnedSats).toBe(990)

    // STEP 9: Verify calibration scores updated
    const [calibRows] = await conn.execute(
      'SELECT * FROM calibration_scores WHERE domain = ? ORDER BY agentId',
      ['crypto']
    ) as any
    const calibrationList = (calibRows as any[]) || []

    // Should have 3 calibration records (one per agent)
    expect(calibrationList.length).toBeGreaterThanOrEqual(3)

    // Check Brier scores calculated
    // Outcome is YES (1.0)
    // alice predicted 0.7: (0.7 - 1.0)^2 = 0.09
    // bob predicted 0.4: (0.4 - 1.0)^2 = 0.36
    // charlie predicted 0.8: (0.8 - 1.0)^2 = 0.04

    const aliceCalib = calibrationList.find((c: any) => c.agentId === 'agent-alice')
    if (aliceCalib) {
      expect(parseFloat(aliceCalib.brierSum)).toBeCloseTo(0.09, 2)
      expect(parseFloat(aliceCalib.score)).toBeCloseTo(0.09, 2)
      expect(aliceCalib.sampleCount).toBe(1)
    }

    const charlieCalib = calibrationList.find((c: any) => c.agentId === 'agent-charlie')
    if (charlieCalib) {
      expect(parseFloat(charlieCalib.brierSum)).toBeCloseTo(0.04, 2)
      expect(parseFloat(charlieCalib.score)).toBeCloseTo(0.04, 2)
      expect(charlieCalib.sampleCount).toBe(1)
    }

    // STEP 10: Verify market marked as settled
    const [marketRows] = await conn.execute(
      'SELECT * FROM markets WHERE id = ?',
      [marketId]
    ) as any
    const market = (marketRows as any[])[0]

    expect(market.outcome).toBe('yes')
    expect(market.resolutionAnchorTxid).toBeTruthy()
  })

  it('handles VOID outcome with refunds and no calibration', async () => {
    // Create market
    const marketId = 'void-test-market'
    const now = new Date()
    const closesAt = new Date(now.getTime() + 72 * 60 * 60 * 1000)
    const resolvesAt = new Date(closesAt.getTime() + 60 * 60 * 1000)

    await conn.execute(
      `INSERT INTO agents (id, pubkey, handle) VALUES (?, ?, ?)`,
      ['agent-void-tester', 'pubkey_void', 'void-tester']
    )

    await conn.execute(
      `INSERT INTO markets (id, title, domain, state, closesAt, resolvesAt, resolutionCriteria, totalYesSats, totalNoSats)
       VALUES (?, ?, 'crypto', 'RESOLVING', ?, ?, ?, 1000, 0)`,
      [marketId, 'Void Test', closesAt, resolvesAt, 'test']
    )

    // Add stake
    await conn.execute(
      `INSERT INTO stakes (id, marketId, agentId, direction, amountSats) VALUES (?, ?, ?, ?, ?)`,
      ['void-stake-1', marketId, 'agent-void-tester', 'yes', 1000]
    )

    // Add signal (won't be calibrated on VOID)
    await conn.execute(
      `INSERT INTO signals (id, marketId, agentId, signalValue) VALUES (?, ?, ?, ?)`,
      ['void-signal-1', marketId, 'agent-void-tester', 0.5]
    )

    // Settle as VOID
    const settlement = await (settlementEngine as any).settle(marketId, 'void', 'oracle')

    // Update calibration (will skip VOID outcomes)
    await calibrationService.updateCalibration(marketId, 'void')

    expect(settlement.outcome).toBe('void')

    // Verify full refund
    const [stakes] = await conn.execute(
      'SELECT * FROM stakes WHERE marketId = ?',
      [marketId]
    ) as any
    const stakeList = stakes as any[]

    expect(stakeList[0].payoutSats).toBe(1000) // Full refund

    // Verify no new calibration records created for VOID
    const [calibRows] = await conn.execute(
      'SELECT * FROM calibration_scores WHERE agentId = ?',
      ['agent-void-tester']
    ) as any
    const calibList = (calibRows as any[]) || []

    // Should have no records (VOID doesn't calibrate)
    expect(calibList.length).toBe(0)
  })
})
