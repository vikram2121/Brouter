import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import mysql from 'mysql2/promise'
import { CalibrationService } from '../services/CalibrationService'

describe('CalibrationService', () => {
  let conn: mysql.Connection
  let db: any
  let calibrationService: CalibrationService

  beforeAll(async () => {
    // Create test database
    const tempConn = await mysql.createConnection({
      host: 'localhost',
      user: 'root',
      password: ''
    })
    await tempConn.execute('DROP DATABASE IF EXISTS scout_calibration_test')
    await tempConn.execute('CREATE DATABASE scout_calibration_test')
    await tempConn.end()

    // Connect
    conn = await mysql.createConnection({
      host: 'localhost',
      user: 'root',
      password: '',
      database: 'scout_calibration_test'
    })

    // Create schema
    await conn.execute(`SET FOREIGN_KEY_CHECKS = 0`)
    await conn.execute(`
      CREATE TABLE agents (
        id VARCHAR(255) PRIMARY KEY,
        pubkey VARCHAR(512) NOT NULL UNIQUE,
        handle VARCHAR(32),
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await conn.execute(`
      CREATE TABLE markets (
        id VARCHAR(255) PRIMARY KEY,
        title VARCHAR(500) NOT NULL,
        domain ENUM('crypto','macro','sports','politics','science','agent-meta') DEFAULT 'crypto',
        state VARCHAR(50) DEFAULT 'PROPOSED',
        closesAt TIMESTAMP NOT NULL,
        resolvesAt TIMESTAMP NOT NULL,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await conn.execute(`
      CREATE TABLE stakes (
        id VARCHAR(255) PRIMARY KEY,
        marketId VARCHAR(255) NOT NULL,
        agentId VARCHAR(255) NOT NULL,
        direction ENUM('yes','no') NOT NULL,
        amountSats BIGINT NOT NULL,
        oddsAtStake DECIMAL(10,4) NOT NULL DEFAULT 1.0000,
        impliedProbability DECIMAL(6,5) NOT NULL DEFAULT 0.50000,
        consensusAfter DECIMAL(6,5) NOT NULL DEFAULT 0.50000,
        paymentTxid VARCHAR(255),
        anchorTxid VARCHAR(255),
        payoutSats BIGINT,
        payoutTxid VARCHAR(255),
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (marketId) REFERENCES markets(id),
        FOREIGN KEY (agentId) REFERENCES agents(id),
        INDEX idx_market (marketId),
        INDEX idx_agent (agentId)
      )
    `)

    await conn.execute(`
      CREATE TABLE calibration_scores (
        agentId VARCHAR(255) NOT NULL,
        domain VARCHAR(50) NOT NULL,
        brierSum DECIMAL(8,6) NOT NULL DEFAULT 0,
        sampleCount INT NOT NULL DEFAULT 0,
        score DECIMAL(8,6) NOT NULL DEFAULT 0,
        updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (agentId, domain),
        FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE,
        INDEX idx_domain (domain)
      )
    `)

    await conn.execute(`SET FOREIGN_KEY_CHECKS = 1`)

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

    calibrationService = new CalibrationService(db)
  })

  afterAll(async () => {
    await conn.end()
  })

  it('should calculate Brier score for single YES market (accurate forecast)', async () => {
    // Setup: agents
    await conn.execute(
      `INSERT INTO agents (id, pubkey, handle) VALUES (?, ?, ?)`,
      ['alice', 'pubkey_alice', 'Alice']
    )

    // Market
    const now = new Date()
    const closesAt = new Date(now.getTime() + 72 * 60 * 60 * 1000)
    const resolvesAt = new Date(closesAt.getTime() + 60 * 60 * 1000)

    const marketId = 'market-1'
    await conn.execute(
      `INSERT INTO markets (id, title, domain, state, closesAt, resolvesAt)
       VALUES (?, ?, 'crypto', 'OPEN', ?, ?)`,
      [marketId, 'Test Market', closesAt, resolvesAt]
    )

    // Stake: Alice forecasts 0.75 (75% YES) on YES position
    const stakeId = 'stake-1'
    await conn.execute(
      `INSERT INTO stakes (id, marketId, agentId, direction, amountSats, impliedProbability)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [stakeId, marketId, 'alice', 'yes', 5000, 0.75]
    )

    // Update calibration: market resolves YES
    await calibrationService.updateCalibration(marketId, 'yes')

    // Verify: Brier score = (0.75 - 1.0)^2 = 0.0625
    const score = await db.get(
      'SELECT * FROM calibration_scores WHERE agentId = ? AND domain = ?',
      ['alice', 'crypto']
    )

    expect(score).toBeTruthy()
    expect(score.sampleCount).toBe(1)
    expect(parseFloat(score.brierSum)).toBeCloseTo(0.0625, 4)
    expect(parseFloat(score.score)).toBeCloseTo(0.0625, 4)
  })

  it('should calculate Brier score for single NO market (inaccurate forecast)', async () => {
    // Setup: agent
    await conn.execute(
      `INSERT INTO agents (id, pubkey, handle) VALUES (?, ?, ?)`,
      ['bob', 'pubkey_bob', 'Bob']
    )

    // Market
    const now = new Date()
    const closesAt = new Date(now.getTime() + 72 * 60 * 60 * 1000)
    const resolvesAt = new Date(closesAt.getTime() + 60 * 60 * 1000)

    const marketId = 'market-2'
    await conn.execute(
      `INSERT INTO markets (id, title, domain, state, closesAt, resolvesAt)
       VALUES (?, ?, 'crypto', 'OPEN', ?, ?)`,
      [marketId, 'Test Market 2', closesAt, resolvesAt]
    )

    // Stake: Bob forecasts 0.8 (80% YES) on NO position
    // NO position means implied probability is: 1 - 0.8 = 0.2 (20% YES)
    const stakeId = 'stake-2'
    await conn.execute(
      `INSERT INTO stakes (id, marketId, agentId, direction, amountSats, impliedProbability)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [stakeId, marketId, 'bob', 'no', 3000, 0.8]
    )

    // Update calibration: market resolves NO (actual = 0.0)
    // Bob's forecast = 1 - 0.8 = 0.2
    // Brier = (0.2 - 0.0)^2 = 0.04
    await calibrationService.updateCalibration(marketId, 'no')

    const score = await db.get(
      'SELECT * FROM calibration_scores WHERE agentId = ? AND domain = ?',
      ['bob', 'crypto']
    )

    expect(score).toBeTruthy()
    expect(score.sampleCount).toBe(1)
    expect(parseFloat(score.brierSum)).toBeCloseTo(0.04, 4)
    expect(parseFloat(score.score)).toBeCloseTo(0.04, 4)
  })

  it('should handle VOID outcomes (skip calibration)', async () => {
    // Setup: agent
    await conn.execute(
      `INSERT INTO agents (id, pubkey, handle) VALUES (?, ?, ?)`,
      ['charlie', 'pubkey_charlie', 'Charlie']
    )

    // Market
    const now = new Date()
    const closesAt = new Date(now.getTime() + 72 * 60 * 60 * 1000)
    const resolvesAt = new Date(closesAt.getTime() + 60 * 60 * 1000)

    const marketId = 'market-3'
    await conn.execute(
      `INSERT INTO markets (id, title, domain, state, closesAt, resolvesAt)
       VALUES (?, ?, 'crypto', 'OPEN', ?, ?)`,
      [marketId, 'VOID Market', closesAt, resolvesAt]
    )

    // Stake
    const stakeId = 'stake-3'
    await conn.execute(
      `INSERT INTO stakes (id, marketId, agentId, direction, amountSats, impliedProbability)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [stakeId, marketId, 'charlie', 'yes', 2000, 0.5]
    )

    // Update calibration: VOID outcome
    await calibrationService.updateCalibration(marketId, 'void')

    // Verify: No calibration record created
    const score = await db.get(
      'SELECT * FROM calibration_scores WHERE agentId = ? AND domain = ?',
      ['charlie', 'crypto']
    )

    expect(score).toBeFalsy()
  })

  it('should compute running average across multiple markets', async () => {
    // Setup: agent
    await conn.execute(
      `INSERT INTO agents (id, pubkey, handle) VALUES (?, ?, ?)`,
      ['dave', 'pubkey_dave', 'Dave']
    )

    const now = new Date()
    const closesAt = new Date(now.getTime() + 72 * 60 * 60 * 1000)
    const resolvesAt = new Date(closesAt.getTime() + 60 * 60 * 1000)

    // Market 1: Dave forecasts 0.6 on YES, outcome YES
    // Brier = (0.6 - 1.0)^2 = 0.16
    const market1 = 'market-dave-1'
    await conn.execute(
      `INSERT INTO markets (id, title, domain, state, closesAt, resolvesAt)
       VALUES (?, ?, 'macro', 'OPEN', ?, ?)`,
      [market1, 'Market 1', closesAt, resolvesAt]
    )
    await conn.execute(
      `INSERT INTO stakes (id, marketId, agentId, direction, amountSats, impliedProbability)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['stake-dave-1', market1, 'dave', 'yes', 1000, 0.6]
    )
    await calibrationService.updateCalibration(market1, 'yes')

    // Market 2: Dave forecasts 0.7 on NO, outcome NO
    // Implied forecast = 1 - 0.7 = 0.3
    // Actual = 0.0
    // Brier = (0.3 - 0.0)^2 = 0.09
    const market2 = 'market-dave-2'
    await conn.execute(
      `INSERT INTO markets (id, title, domain, state, closesAt, resolvesAt)
       VALUES (?, ?, 'macro', 'OPEN', ?, ?)`,
      [market2, 'Market 2', closesAt, resolvesAt]
    )
    await conn.execute(
      `INSERT INTO stakes (id, marketId, agentId, direction, amountSats, impliedProbability)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['stake-dave-2', market2, 'dave', 'no', 1000, 0.7]
    )
    await calibrationService.updateCalibration(market2, 'no')

    // Verify running average
    // brierSum = 0.16 + 0.09 = 0.25
    // sampleCount = 2
    // score = 0.25 / 2 = 0.125
    const score = await db.get(
      'SELECT * FROM calibration_scores WHERE agentId = ? AND domain = ?',
      ['dave', 'macro']
    )

    expect(score).toBeTruthy()
    expect(score.sampleCount).toBe(2)
    expect(parseFloat(score.brierSum)).toBeCloseTo(0.25, 4)
    expect(parseFloat(score.score)).toBeCloseTo(0.125, 4)
  })

  it('should track scores per domain (domain isolation)', async () => {
    // Setup: agent
    await conn.execute(
      `INSERT INTO agents (id, pubkey, handle) VALUES (?, ?, ?)`,
      ['eve', 'pubkey_eve', 'Eve']
    )

    const now = new Date()
    const closesAt = new Date(now.getTime() + 72 * 60 * 60 * 1000)
    const resolvesAt = new Date(closesAt.getTime() + 60 * 60 * 1000)

    // Crypto market
    const cryptoMarket = 'market-eve-crypto'
    await conn.execute(
      `INSERT INTO markets (id, title, domain, state, closesAt, resolvesAt)
       VALUES (?, ?, 'crypto', 'OPEN', ?, ?)`,
      [cryptoMarket, 'Crypto Market', closesAt, resolvesAt]
    )
    await conn.execute(
      `INSERT INTO stakes (id, marketId, agentId, direction, amountSats, impliedProbability)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['stake-eve-crypto', cryptoMarket, 'eve', 'yes', 1000, 0.9]
    )
    // Outcome: YES, Brier = (0.9 - 1.0)^2 = 0.01
    await calibrationService.updateCalibration(cryptoMarket, 'yes')

    // Politics market
    const politicsMarket = 'market-eve-politics'
    await conn.execute(
      `INSERT INTO markets (id, title, domain, state, closesAt, resolvesAt)
       VALUES (?, ?, 'politics', 'OPEN', ?, ?)`,
      [politicsMarket, 'Politics Market', closesAt, resolvesAt]
    )
    await conn.execute(
      `INSERT INTO stakes (id, marketId, agentId, direction, amountSats, impliedProbability)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['stake-eve-politics', politicsMarket, 'eve', 'no', 1000, 0.4]
    )
    // NO stake at 0.4 means forecast = 1 - 0.4 = 0.6
    // Outcome: NO (actual = 0.0)
    // Brier = (0.6 - 0.0)^2 = 0.36
    await calibrationService.updateCalibration(politicsMarket, 'no')

    // Verify: Separate scores per domain
    const cryptoScore = await db.get(
      'SELECT * FROM calibration_scores WHERE agentId = ? AND domain = ?',
      ['eve', 'crypto']
    )
    const politicsScore = await db.get(
      'SELECT * FROM calibration_scores WHERE agentId = ? AND domain = ?',
      ['eve', 'politics']
    )

    expect(cryptoScore).toBeTruthy()
    expect(parseFloat(cryptoScore.score)).toBeCloseTo(0.01, 4)

    expect(politicsScore).toBeTruthy()
    expect(parseFloat(politicsScore.score)).toBeCloseTo(0.36, 4)
  })

  it('should compute getScore() for single agent domain', async () => {
    // Use alice from first test
    const score = await calibrationService.getScore('alice', 'crypto')

    expect(score).toBeTruthy()
    expect(score!.agentId).toBe('alice')
    expect(score!.domain).toBe('crypto')
    expect(parseFloat(score!.score)).toBeCloseTo(0.0625, 4)
  })

  it('should return null for non-existent score', async () => {
    const score = await calibrationService.getScore('nonexistent', 'crypto')
    expect(score).toBeNull()
  })

  it('should list top agents by calibration score', async () => {
    // Get top 3 agents in macro domain
    // dave: 0.125 (2 markets)
    // should be #1
    const topAgents = await calibrationService.topAgents('macro', 3)

    expect(topAgents.length).toBeGreaterThan(0)
    expect(topAgents[0].agentId).toBe('dave')
    expect(parseFloat(topAgents[0].score)).toBeCloseTo(0.125, 4)
  })

  it('should handle multiple agents on same market', async () => {
    // Setup: new agents
    await conn.execute(
      `INSERT INTO agents (id, pubkey, handle) VALUES (?, ?, ?)`,
      ['frank', 'pubkey_frank', 'Frank']
    )
    await conn.execute(
      `INSERT INTO agents (id, pubkey, handle) VALUES (?, ?, ?)`,
      ['grace', 'pubkey_grace', 'Grace']
    )

    // Market
    const now = new Date()
    const closesAt = new Date(now.getTime() + 72 * 60 * 60 * 1000)
    const resolvesAt = new Date(closesAt.getTime() + 60 * 60 * 1000)

    const marketId = 'market-multi'
    await conn.execute(
      `INSERT INTO markets (id, title, domain, state, closesAt, resolvesAt)
       VALUES (?, ?, 'sports', 'OPEN', ?, ?)`,
      [marketId, 'Multi-Agent Market', closesAt, resolvesAt]
    )

    // Frank: forecasts 0.6 on YES
    await conn.execute(
      `INSERT INTO stakes (id, marketId, agentId, direction, amountSats, impliedProbability)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['stake-frank', marketId, 'frank', 'yes', 1000, 0.6]
    )

    // Grace: forecasts 0.3 on NO
    await conn.execute(
      `INSERT INTO stakes (id, marketId, agentId, direction, amountSats, impliedProbability)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['stake-grace', marketId, 'grace', 'no', 1000, 0.3]
    )

    // Market resolves YES
    await calibrationService.updateCalibration(marketId, 'yes')

    // Frank: forecast 0.6, actual 1.0 → Brier = 0.16
    const frankScore = await db.get(
      'SELECT * FROM calibration_scores WHERE agentId = ? AND domain = ?',
      ['frank', 'sports']
    )
    expect(parseFloat(frankScore.score)).toBeCloseTo(0.16, 4)

    // Grace: forecast 1 - 0.3 = 0.7, actual 1.0 → Brier = 0.09
    const graceScore = await db.get(
      'SELECT * FROM calibration_scores WHERE agentId = ? AND domain = ?',
      ['grace', 'sports']
    )
    expect(parseFloat(graceScore.score)).toBeCloseTo(0.09, 4)
  })

  it('should compute perfect calibration (Brier = 0)', async () => {
    // Agent with perfect forecast
    await conn.execute(
      `INSERT INTO agents (id, pubkey, handle) VALUES (?, ?, ?)`,
      ['hank', 'pubkey_hank', 'Hank']
    )

    const now = new Date()
    const closesAt = new Date(now.getTime() + 72 * 60 * 60 * 1000)
    const resolvesAt = new Date(closesAt.getTime() + 60 * 60 * 1000)

    const marketId = 'market-perfect'
    await conn.execute(
      `INSERT INTO markets (id, title, domain, state, closesAt, resolvesAt)
       VALUES (?, ?, 'science', 'OPEN', ?, ?)`,
      [marketId, 'Perfect Market', closesAt, resolvesAt]
    )

    // Hank forecasts 1.0 (100% YES) on YES position
    await conn.execute(
      `INSERT INTO stakes (id, marketId, agentId, direction, amountSats, impliedProbability)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['stake-hank', marketId, 'hank', 'yes', 1000, 1.0]
    )

    // Market resolves YES
    await calibrationService.updateCalibration(marketId, 'yes')

    // Brier = (1.0 - 1.0)^2 = 0
    const score = await db.get(
      'SELECT * FROM calibration_scores WHERE agentId = ? AND domain = ?',
      ['hank', 'science']
    )
    expect(parseFloat(score.score)).toBe(0)
  })

  it('should compute worst calibration (Brier = 1)', async () => {
    // Agent with worst forecast
    await conn.execute(
      `INSERT INTO agents (id, pubkey, handle) VALUES (?, ?, ?)`,
      ['iris', 'pubkey_iris', 'Iris']
    )

    const now = new Date()
    const closesAt = new Date(now.getTime() + 72 * 60 * 60 * 1000)
    const resolvesAt = new Date(closesAt.getTime() + 60 * 60 * 1000)

    const marketId = 'market-worst'
    await conn.execute(
      `INSERT INTO markets (id, title, domain, state, closesAt, resolvesAt)
       VALUES (?, ?, 'science', 'OPEN', ?, ?)`,
      [marketId, 'Worst Market', closesAt, resolvesAt]
    )

    // Iris forecasts 0.0 (0% YES) on YES position
    await conn.execute(
      `INSERT INTO stakes (id, marketId, agentId, direction, amountSats, impliedProbability)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['stake-iris', marketId, 'iris', 'yes', 1000, 0.0]
    )

    // Market resolves YES
    await calibrationService.updateCalibration(marketId, 'yes')

    // Brier = (0.0 - 1.0)^2 = 1
    const score = await db.get(
      'SELECT * FROM calibration_scores WHERE agentId = ? AND domain = ?',
      ['iris', 'science']
    )
    expect(parseFloat(score.score)).toBeCloseTo(1, 4)
  })
})
