import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import mysql from 'mysql2/promise'
import { SignalPoolService } from '../services/SignalPoolService'

describe('Signal Pool Settlement', () => {
  let conn: mysql.Connection
  let db: any
  let signalPoolService: SignalPoolService

  beforeAll(async () => {
    // Create test database
    const tempConn = await mysql.createConnection({
      host: 'localhost',
      user: 'root',
      password: ''
    })
    await tempConn.execute('DROP DATABASE IF EXISTS scout_signal_settlement_test')
    await tempConn.execute('CREATE DATABASE scout_signal_settlement_test')
    await tempConn.end()

    // Connect
    conn = await mysql.createConnection({
      host: 'localhost',
      user: 'root',
      password: '',
      database: 'scout_signal_settlement_test'
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
        domain VARCHAR(50) DEFAULT 'crypto',
        state VARCHAR(50) DEFAULT 'PROPOSED',
        closesAt TIMESTAMP NOT NULL,
        resolvesAt TIMESTAMP NOT NULL,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await conn.execute(`
      CREATE TABLE signals (
        id VARCHAR(255) PRIMARY KEY,
        marketId VARCHAR(255) NOT NULL,
        agentId VARCHAR(255) NOT NULL,
        position VARCHAR(10) NOT NULL,
        postingFeeSats BIGINT NOT NULL,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (marketId) REFERENCES markets(id),
        FOREIGN KEY (agentId) REFERENCES agents(id),
        INDEX idx_market (marketId),
        INDEX idx_agent (agentId)
      )
    `)

    await conn.execute(`
      CREATE TABLE signal_votes (
        id VARCHAR(255) PRIMARY KEY,
        signalId VARCHAR(255) NOT NULL,
        agentId VARCHAR(255) NOT NULL,
        direction VARCHAR(10) NOT NULL,
        amountSats BIGINT NOT NULL,
        votedAt TIMESTAMP NOT NULL,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (signalId) REFERENCES signals(id),
        FOREIGN KEY (agentId) REFERENCES agents(id),
        INDEX idx_signal (signalId),
        INDEX idx_agent (agentId)
      )
    `)

    await conn.execute(`
      CREATE TABLE signal_pools (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        signalId VARCHAR(255) NOT NULL UNIQUE,
        marketId VARCHAR(255) NOT NULL,
        totalSats BIGINT NOT NULL,
        upSats BIGINT NOT NULL DEFAULT 0,
        downSats BIGINT NOT NULL DEFAULT 0,
        escrowTxid VARCHAR(255),
        settledAt TIMESTAMP NULL,
        settlementTxid VARCHAR(255) NULL,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (signalId) REFERENCES signals(id),
        FOREIGN KEY (marketId) REFERENCES markets(id),
        INDEX idx_market (marketId)
      )
    `)

    await conn.execute(`
      CREATE TABLE signal_payouts (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        signalId VARCHAR(255) NOT NULL,
        agentId VARCHAR(255) NOT NULL,
        stakedSats BIGINT NOT NULL,
        payoutSats BIGINT NOT NULL,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (signalId) REFERENCES signals(id),
        FOREIGN KEY (agentId) REFERENCES agents(id),
        INDEX idx_signalId (signalId),
        INDEX idx_agentId (agentId)
      )
    `)

    await conn.execute(`
      CREATE TABLE signal_dust (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        signalId VARCHAR(255) NOT NULL UNIQUE,
        feeSats BIGINT NOT NULL,
        roundingDustSats BIGINT NOT NULL,
        totalDustSats BIGINT NOT NULL,
        settledAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (signalId) REFERENCES signals(id),
        INDEX idx_settledAt (settledAt)
      )
    `)

    await conn.execute(`
      CREATE TABLE trace_rights (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        signalId VARCHAR(255) NOT NULL,
        agentId VARCHAR(255) NOT NULL,
        marketId VARCHAR(255) NOT NULL,
        outcome ENUM('yes','no','void') NOT NULL,
        grantedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (signalId) REFERENCES signals(id),
        FOREIGN KEY (agentId) REFERENCES agents(id),
        FOREIGN KEY (marketId) REFERENCES markets(id),
        INDEX idx_signalId (signalId),
        INDEX idx_agentId (agentId),
        INDEX idx_marketId (marketId)
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

    signalPoolService = new SignalPoolService(db)
  })

  afterAll(async () => {
    await conn.end()
  })

  it('should settle signal pool with winners and losers (signal correct)', async () => {
    // Setup: agents, market, signal
    await conn.execute(
      `INSERT INTO agents (id, pubkey, handle) VALUES (?, ?, ?)`,
      ['alice', 'pubkey_alice', 'Alice']
    )
    await conn.execute(
      `INSERT INTO agents (id, pubkey, handle) VALUES (?, ?, ?)`,
      ['bob', 'pubkey_bob', 'Bob']
    )
    await conn.execute(
      `INSERT INTO agents (id, pubkey, handle) VALUES (?, ?, ?)`,
      ['charlie', 'pubkey_charlie', 'Charlie']
    )

    const now = new Date()
    const closesAt = new Date(now.getTime() + 72 * 60 * 60 * 1000)
    const resolvesAt = new Date(closesAt.getTime() + 60 * 60 * 1000)

    await conn.execute(
      `INSERT INTO markets (id, title, domain, state, closesAt, resolvesAt)
       VALUES (?, ?, 'crypto', 'OPEN', ?, ?)`,
      ['market-1', 'Test Market', closesAt, resolvesAt]
    )

    // Create signal: Alice says YES
    const signalId = 'signal-1'
    await conn.execute(
      `INSERT INTO signals (id, marketId, agentId, position, postingFeeSats)
       VALUES (?, ?, ?, ?, ?)`,
      [signalId, 'market-1', 'alice', 'yes', 500]
    )

    // Create votes
    // Alice: 500 sats upvote (poster)
    await conn.execute(
      `INSERT INTO signal_votes (id, signalId, agentId, direction, amountSats, votedAt)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      ['vote-1', signalId, 'alice', 'up', 500]
    )

    // Bob: 300 sats upvote (agrees)
    await conn.execute(
      `INSERT INTO signal_votes (id, signalId, agentId, direction, amountSats, votedAt)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      ['vote-2', signalId, 'bob', 'up', 300]
    )

    // Charlie: 200 sats downvote (disagrees)
    await conn.execute(
      `INSERT INTO signal_votes (id, signalId, agentId, direction, amountSats, votedAt)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      ['vote-3', signalId, 'charlie', 'down', 200]
    )

    // Initialize pool
    await conn.execute(
      `INSERT INTO signal_pools (signalId, marketId, totalSats, upSats, downSats, escrowTxid)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [signalId, 'market-1', 1000, 800, 200, `STUB_${signalId}`]
    )

    // Settle signal with YES outcome (signal correct)
    await signalPoolService.settleSignalPool(signalId, 'yes')

    // Verify payouts
    const payouts = await db.all(
      'SELECT * FROM signal_payouts WHERE signalId = ? ORDER BY agentId',
      [signalId]
    )

    expect(payouts.length).toBe(3)

    // Alice: (500 / 800) * 990 = 618.75 → 618 sats
    const alicePayouts = payouts.filter((p: any) => p.agentId === 'alice')
    expect(alicePayouts.length).toBe(1)
    expect(alicePayouts[0].stakedSats).toBe(500)
    expect(alicePayouts[0].payoutSats).toBe(618)

    // Bob: (300 / 800) * 990 = 371.25 → 371 sats
    const bobPayouts = payouts.filter((p: any) => p.agentId === 'bob')
    expect(bobPayouts.length).toBe(1)
    expect(bobPayouts[0].stakedSats).toBe(300)
    expect(bobPayouts[0].payoutSats).toBe(371)

    // Charlie: 0 (loser)
    const charliePayouts = payouts.filter((p: any) => p.agentId === 'charlie')
    expect(charliePayouts.length).toBe(1)
    expect(charliePayouts[0].stakedSats).toBe(200)
    expect(charliePayouts[0].payoutSats).toBe(0)

    // Verify dust tracking
    const dust = await db.get(
      'SELECT * FROM signal_dust WHERE signalId = ?',
      [signalId]
    )
    expect(dust).toBeTruthy()
    expect(dust.feeSats).toBe(10) // 1% of 1000
    expect(dust.roundingDustSats).toBeGreaterThanOrEqual(0)

    // Verify trace rights granted (signal author is correct)
    const traceRights = await db.get(
      'SELECT * FROM trace_rights WHERE signalId = ?',
      [signalId]
    )
    expect(traceRights).toBeTruthy()
    expect(traceRights.agentId).toBe('alice')
    expect(traceRights.outcome).toBe('yes')

    // Verify pool marked settled
    const pool = await db.get(
      'SELECT * FROM signal_pools WHERE signalId = ?',
      [signalId]
    )
    expect(pool.settledAt).toBeTruthy()
    expect(pool.settlementTxid).toBe(`STUB_${signalId}`)
  })

  it('should settle signal pool with NO outcome (signal incorrect, reversed winners)', async () => {
    // Setup: signal says YES but market resolves NO
    const signalId = 'signal-2'
    await conn.execute(
      `INSERT INTO signals (id, marketId, agentId, position, postingFeeSats)
       VALUES (?, ?, ?, ?, ?)`,
      [signalId, 'market-1', 'bob', 'yes', 500]
    )

    // Votes: Alice downvotes (disagrees), Bob upvotes (posted)
    await conn.execute(
      `INSERT INTO signal_votes (id, signalId, agentId, direction, amountSats, votedAt)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      ['vote-4', signalId, 'bob', 'up', 500]
    )
    await conn.execute(
      `INSERT INTO signal_votes (id, signalId, agentId, direction, amountSats, votedAt)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      ['vote-5', signalId, 'alice', 'down', 400]
    )

    // Initialize pool
    await conn.execute(
      `INSERT INTO signal_pools (signalId, marketId, totalSats, upSats, downSats, escrowTxid)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [signalId, 'market-1', 900, 500, 400, `STUB_${signalId}`]
    )

    // Settle with NO outcome (signal incorrect)
    await signalPoolService.settleSignalPool(signalId, 'no')

    // Verify payouts: downvoters (Alice) win
    const payouts = await db.all(
      'SELECT * FROM signal_payouts WHERE signalId = ? ORDER BY agentId',
      [signalId]
    )

    expect(payouts.length).toBe(2)

    // Alice (downvoter, winner): (400 / 400) * 891 = 891 sats
    // Total pool: 900, Fee: 9 (1%), Distributable: 891
    const alicePayouts = payouts.filter((p: any) => p.agentId === 'alice')
    expect(alicePayouts[0].payoutSats).toBe(891) // All distributable

    // Bob (upvoter, loser): 0
    const bobPayouts = payouts.filter((p: any) => p.agentId === 'bob')
    expect(bobPayouts[0].payoutSats).toBe(0)

    // No trace rights (signal was incorrect)
    const traceRights = await db.get(
      'SELECT * FROM trace_rights WHERE signalId = ?',
      [signalId]
    )
    expect(traceRights).toBeFalsy()
  })

  it('should settle signal pool with no losers (all agree)', async () => {
    // Setup: unanimous signal (no disagreement)
    const signalId = 'signal-3'
    await conn.execute(
      `INSERT INTO signals (id, marketId, agentId, position, postingFeeSats)
       VALUES (?, ?, ?, ?, ?)`,
      [signalId, 'market-1', 'charlie', 'no', 500]
    )

    // All votes are upvotes (everyone agrees)
    await conn.execute(
      `INSERT INTO signal_votes (id, signalId, agentId, direction, amountSats, votedAt)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      ['vote-6', signalId, 'charlie', 'up', 500]
    )
    await conn.execute(
      `INSERT INTO signal_votes (id, signalId, agentId, direction, amountSats, votedAt)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      ['vote-7', signalId, 'alice', 'up', 300]
    )

    // Initialize pool
    await conn.execute(
      `INSERT INTO signal_pools (signalId, marketId, totalSats, upSats, downSats, escrowTxid)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [signalId, 'market-1', 800, 800, 0, `STUB_${signalId}`]
    )

    // Settle with NO outcome (correct)
    await signalPoolService.settleSignalPool(signalId, 'no')

    // Verify: everyone gets their stake back minus fee
    const payouts = await db.all(
      'SELECT * FROM signal_payouts WHERE signalId = ? ORDER BY agentId',
      [signalId]
    )

    expect(payouts.length).toBe(2)

    // Charlie: 500 - 5 (1% fee) = 495
    const charliePayouts = payouts.filter((p: any) => p.agentId === 'charlie')
    expect(charliePayouts[0].payoutSats).toBe(495)

    // Alice: 300 - 3 (1% fee) = 297
    const alicePayouts = payouts.filter((p: any) => p.agentId === 'alice')
    expect(alicePayouts[0].payoutSats).toBe(297)

    // Trace rights granted
    const traceRights = await db.get(
      'SELECT * FROM trace_rights WHERE signalId = ?',
      [signalId]
    )
    expect(traceRights).toBeTruthy()
    expect(traceRights.agentId).toBe('charlie')
  })

  it('should skip settlement if already settled', async () => {
    // Create already-settled signal
    const signalId = 'signal-settled'
    await conn.execute(
      `INSERT INTO signals (id, marketId, agentId, position, postingFeeSats)
       VALUES (?, ?, ?, ?, ?)`,
      [signalId, 'market-1', 'alice', 'yes', 500]
    )

    await conn.execute(
      `INSERT INTO signal_votes (id, signalId, agentId, direction, amountSats, votedAt)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      ['vote-8', signalId, 'alice', 'up', 500]
    )

    // Pool already marked settled
    const now = new Date()
    await conn.execute(
      `INSERT INTO signal_pools (signalId, marketId, totalSats, upSats, downSats, escrowTxid, settledAt, settlementTxid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [signalId, 'market-1', 500, 500, 0, `STUB_${signalId}`, now, `TX_${signalId}`]
    )

    // Attempt to settle (should skip)
    await signalPoolService.settleSignalPool(signalId, 'yes')

    // Verify no payouts created (settlement skipped)
    const payouts = await db.all(
      'SELECT * FROM signal_payouts WHERE signalId = ?',
      [signalId]
    )
    expect(payouts.length).toBe(0)
  })

  it('should settle all signals for a market', async () => {
    // Create market with 2 signals
    const marketId = 'market-2'
    await conn.execute(
      `INSERT INTO markets (id, title, domain, state, closesAt, resolvesAt)
       VALUES (?, ?, 'crypto', 'OPEN', DATE_ADD(NOW(), INTERVAL 3 DAY), DATE_ADD(NOW(), INTERVAL 4 DAY))`,
      [marketId, 'Multi-Signal Market']
    )

    // Signal 1: Alice (YES)
    const sig1 = 'sig-multi-1'
    await conn.execute(
      `INSERT INTO signals (id, marketId, agentId, position, postingFeeSats)
       VALUES (?, ?, ?, ?, ?)`,
      [sig1, marketId, 'alice', 'yes', 500]
    )
    await conn.execute(
      `INSERT INTO signal_votes (id, signalId, agentId, direction, amountSats, votedAt)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      ['mvote-1', sig1, 'alice', 'up', 500]
    )
    await conn.execute(
      `INSERT INTO signal_pools (signalId, marketId, totalSats, upSats, downSats, escrowTxid)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [sig1, marketId, 500, 500, 0, `STUB_${sig1}`]
    )

    // Signal 2: Bob (NO)
    const sig2 = 'sig-multi-2'
    await conn.execute(
      `INSERT INTO signals (id, marketId, agentId, position, postingFeeSats)
       VALUES (?, ?, ?, ?, ?)`,
      [sig2, marketId, 'bob', 'no', 500]
    )
    await conn.execute(
      `INSERT INTO signal_votes (id, signalId, agentId, direction, amountSats, votedAt)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      ['mvote-2', sig2, 'bob', 'up', 500]
    )
    await conn.execute(
      `INSERT INTO signal_pools (signalId, marketId, totalSats, upSats, downSats, escrowTxid)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [sig2, marketId, 500, 500, 0, `STUB_${sig2}`]
    )

    // Settle all with YES outcome
    await signalPoolService.settleAll(marketId, 'yes')

    // Verify both signals settled
    const pool1 = await db.get('SELECT * FROM signal_pools WHERE signalId = ?', [sig1])
    const pool2 = await db.get('SELECT * FROM signal_pools WHERE signalId = ?', [sig2])

    expect(pool1.settledAt).toBeTruthy()
    expect(pool2.settledAt).toBeTruthy()

    // Verify trace rights granted only to correct signal (Alice)
    const traceRights = await db.all(
      'SELECT agentId FROM trace_rights WHERE marketId = ? ORDER BY agentId',
      [marketId]
    )
    expect(traceRights.length).toBe(1)
    expect(traceRights[0].agentId).toBe('alice')
  })
})
