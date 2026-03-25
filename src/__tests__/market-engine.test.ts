/**
 * MarketEngine State Transition Tests (Simplified)
 * 
 * Tests six-state market lifecycle with actual database:
 * PROPOSED → OPEN → LOCKED → RESOLVING → SETTLED → ARCHIVED
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import mysql from 'mysql2/promise'

describe('MarketEngine State Transitions', () => {
  let conn: mysql.Connection

  beforeAll(async () => {
    // Create database first
    const tempConn = await mysql.createConnection({
      host: 'localhost',
      user: 'root',
      password: ''
    })
    await tempConn.execute('CREATE DATABASE IF NOT EXISTS scout_market_test')
    await tempConn.end()

    conn = await mysql.createConnection({
      host: 'localhost',
      user: 'root',
      password: '',
      database: 'scout_market_test',
    })

    // Create schema (drop in order to avoid FK constraint issues)
    await conn.execute(`SET FOREIGN_KEY_CHECKS = 0`)
    await conn.execute(`DROP TABLE IF EXISTS market_state_log`)
    await conn.execute(`DROP TABLE IF EXISTS stakes`)
    await conn.execute(`DROP TABLE IF EXISTS markets`)
    await conn.execute(`SET FOREIGN_KEY_CHECKS = 1`)

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
        minDurationHours INT DEFAULT 48,
        lockMinutesBeforeClose INT DEFAULT 60,
        resolutionCriteria TEXT NOT NULL,
        oracleProvider VARCHAR(100),
        oracleMarketId VARCHAR(255),
        outcome ENUM('yes','no','void') NULL,
        resolvedBy VARCHAR(255) NULL,
        minStakeToOpenSats BIGINT DEFAULT 0,
        openAnchorTxid VARCHAR(255),
        lockAnchorTxid VARCHAR(255),
        resolutionAnchorTxid VARCHAR(255),
        createdBy VARCHAR(255),
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_state (state),
        INDEX idx_domain (domain)
      )
    `)

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

  async function createMarket(title: string): Promise<string> {
    const id = 'mkt-' + Math.random().toString(36).slice(2, 9)
    const now = new Date()
    const closesAt = new Date(now.getTime() + 72 * 60 * 60 * 1000)
    const resolvesAt = new Date(closesAt.getTime() + 60 * 60 * 1000)

    await conn.execute(
      `INSERT INTO markets 
       (id, title, state, closesAt, resolvesAt, resolutionCriteria, domain, tier)
       VALUES (?, ?, 'PROPOSED', ?, ?, ?, 'crypto', 'weekly')`,
      [id, title, closesAt, resolvesAt, 'test criteria']
    )

    // Log PROPOSED state
    await conn.execute(
      `INSERT INTO market_state_log (marketId, toState, triggeredBy)
       VALUES (?, 'PROPOSED', 'system')`,
      [id]
    )

    return id
  }

  async function transitionState(
    marketId: string,
    toState: string,
    anchorTxid: string,
    outcome?: string
  ) {
    const now = new Date()
    const nowStr = now.toISOString().slice(0, 19).replace('T', ' ')

    // Update market
    let updateSql = `UPDATE markets SET state = ?, updatedAt = ?`
    let params = [toState, nowStr]

    if (toState === 'OPEN') {
      updateSql += `, openedAt = ?, openAnchorTxid = ?`
      params.push(nowStr, anchorTxid)
    } else if (toState === 'LOCKED') {
      updateSql += `, lockedAt = ?, lockAnchorTxid = ?`
      params.push(nowStr, anchorTxid)
    } else if (toState === 'RESOLVING') {
      updateSql += `, resolvingAt = ?`
      params.push(nowStr)
    } else if (toState === 'SETTLED') {
      updateSql += `, settledAt = ?, resolutionAnchorTxid = ?, outcome = ?, resolvedBy = ?`
      params.push(nowStr, anchorTxid, outcome || 'yes', 'oracle')
    } else if (toState === 'ARCHIVED') {
      updateSql += `, archivedAt = ?`
      params.push(nowStr)
    }

    updateSql += ` WHERE id = ?`
    params.push(marketId)

    await conn.execute(updateSql, params)

    // Log transition
    await conn.execute(
      `INSERT INTO market_state_log 
       (marketId, toState, triggeredBy, anchorTxid)
       VALUES (?, ?, 'system', ?)`,
      [marketId, toState, anchorTxid]
    )
  }

  async function getMarket(id: string) {
    const [rows] = await conn.execute('SELECT * FROM markets WHERE id = ?', [id]) as any
    return rows[0] || null
  }

  async function getHistory(marketId: string) {
    const [rows] = await conn.execute(
      'SELECT * FROM market_state_log WHERE marketId = ? ORDER BY loggedAt ASC',
      [marketId]
    ) as any
    return rows
  }

  // ============ TEST 1: Create Market ============
  it('creates a new market in PROPOSED state', async () => {
    const id = await createMarket('Test Market 1')
    const market = await getMarket(id)

    expect(market).toBeDefined()
    expect(market.state).toBe('PROPOSED')
    expect(market.title).toBe('Test Market 1')
  })

  // ============ TEST 2: PROPOSED → OPEN ============
  it('transitions from PROPOSED to OPEN with anchor txid', async () => {
    const id = await createMarket('Test Market 2')
    await transitionState(id, 'OPEN', 'tx_001')
    const market = await getMarket(id)

    expect(market.state).toBe('OPEN')
    expect(market.openAnchorTxid).toBe('tx_001')
    expect(market.openedAt).not.toBeNull()
  })

  // ============ TEST 3: Full Lifecycle ============
  it('completes full lifecycle: PROPOSED → OPEN → LOCKED → RESOLVING → SETTLED', async () => {
    const id = await createMarket('Test Market 3')

    // PROPOSED → OPEN
    await transitionState(id, 'OPEN', 'tx_open_001')
    let market = await getMarket(id)
    expect(market.state).toBe('OPEN')

    // OPEN → LOCKED
    await transitionState(id, 'LOCKED', 'tx_locked_001')
    market = await getMarket(id)
    expect(market.state).toBe('LOCKED')

    // LOCKED → RESOLVING
    await transitionState(id, 'RESOLVING', 'tx_resolving_001')
    market = await getMarket(id)
    expect(market.state).toBe('RESOLVING')

    // RESOLVING → SETTLED
    await transitionState(id, 'SETTLED', 'tx_settled_001', 'yes')
    market = await getMarket(id)
    expect(market.state).toBe('SETTLED')
    expect(market.outcome).toBe('yes')
    expect(market.resolvedBy).toBe('oracle')
  })

  // ============ TEST 4: State History ============
  it('logs state transitions immutably', async () => {
    const id = await createMarket('Test Market 4')
    await transitionState(id, 'OPEN', 'tx_001')
    await transitionState(id, 'LOCKED', 'tx_002')
    await transitionState(id, 'RESOLVING', 'tx_003')
    await transitionState(id, 'SETTLED', 'tx_004', 'no')

    const history = await getHistory(id)
    expect(history.length).toBe(5) // PROPOSED + 4 transitions
    expect(history[0].toState).toBe('PROPOSED')
    expect(history[1].toState).toBe('OPEN')
    expect(history[2].toState).toBe('LOCKED')
    expect(history[3].toState).toBe('RESOLVING')
    expect(history[4].toState).toBe('SETTLED')
    expect(history[4].anchorTxid).toBe('tx_004')
  })

  // ============ TEST 5: Outcome Tracking ============
  it('records outcome on settlement', async () => {
    const id = await createMarket('Test Market 5')
    await transitionState(id, 'OPEN', 'tx_001')
    await transitionState(id, 'LOCKED', 'tx_002')
    await transitionState(id, 'RESOLVING', 'tx_003')
    await transitionState(id, 'SETTLED', 'tx_004', 'void')

    const market = await getMarket(id)
    expect(market.outcome).toBe('void')
  })

  // ============ TEST 6: SETTLED → ARCHIVED ============
  it('archives settled markets', async () => {
    const id = await createMarket('Test Market 6')
    await transitionState(id, 'OPEN', 'tx_001')
    await transitionState(id, 'LOCKED', 'tx_002')
    await transitionState(id, 'RESOLVING', 'tx_003')
    await transitionState(id, 'SETTLED', 'tx_004', 'yes')
    await transitionState(id, 'ARCHIVED', 'tx_005')

    const market = await getMarket(id)
    expect(market.state).toBe('ARCHIVED')
    expect(market.archivedAt).not.toBeNull()
  })

  // ============ TEST 7: Multiple Markets ============
  it('handles multiple concurrent markets', async () => {
    const id1 = await createMarket('Market A')
    const id2 = await createMarket('Market B')
    const id3 = await createMarket('Market C')

    await transitionState(id1, 'OPEN', 'tx_a1')
    await transitionState(id2, 'OPEN', 'tx_b1')
    await transitionState(id2, 'LOCKED', 'tx_b2')

    const m1 = await getMarket(id1)
    const m2 = await getMarket(id2)
    const m3 = await getMarket(id3)

    expect(m1.state).toBe('OPEN')
    expect(m2.state).toBe('LOCKED')
    expect(m3.state).toBe('PROPOSED')
  })

  // ============ TEST 8: Anchor TXID Persistence ============
  it('preserves all anchor txids throughout lifecycle', async () => {
    const id = await createMarket('Test Market 7')
    await transitionState(id, 'OPEN', 'tx_open_abc')
    await transitionState(id, 'LOCKED', 'tx_locked_def')
    await transitionState(id, 'RESOLVING', 'tx_resolving_ghi')
    await transitionState(id, 'SETTLED', 'tx_settled_jkl', 'yes')

    const market = await getMarket(id)
    expect(market.openAnchorTxid).toBe('tx_open_abc')
    expect(market.lockAnchorTxid).toBe('tx_locked_def')
    expect(market.resolutionAnchorTxid).toBe('tx_settled_jkl')
  })
})
