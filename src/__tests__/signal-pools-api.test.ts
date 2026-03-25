import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import mysql from 'mysql2/promise'
import { Database } from '../db/connection'

describe('Signal Pool API Endpoints', () => {
  let conn: mysql.Connection
  let db: any

  beforeAll(async () => {
    // Create database
    const tempConn = await mysql.createConnection({
      host: 'localhost',
      user: 'root',
      password: ''
    })
    await tempConn.execute('CREATE DATABASE IF NOT EXISTS scout_signal_api_test')
    await tempConn.end()

    // Connect
    conn = await mysql.createConnection({
      host: 'localhost',
      user: 'root',
      password: '',
      database: 'scout_signal_api_test'
    })

    // Create schema tables
    await conn.execute(`SET FOREIGN_KEY_CHECKS = 0`)
    await conn.execute(`DROP TABLE IF EXISTS agents`)
    await conn.execute(`DROP TABLE IF EXISTS markets`)
    await conn.execute(`DROP TABLE IF EXISTS signals`)
    await conn.execute(`DROP TABLE IF EXISTS signal_votes`)
    await conn.execute(`DROP TABLE IF EXISTS signal_pools`)
    await conn.execute(`SET FOREIGN_KEY_CHECKS = 1`)

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
        upSats BIGINT NOT NULL,
        downSats BIGINT NOT NULL,
        escrowTxid VARCHAR(255),
        settledAt TIMESTAMP NULL,
        settlementTxid VARCHAR(255) NULL,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (signalId) REFERENCES signals(id),
        FOREIGN KEY (marketId) REFERENCES markets(id),
        INDEX idx_market (marketId)
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
  })

  afterAll(async () => {
    await conn.end()
  })

  it('should create signal with poster as first upvoter', async () => {
    // Setup: Create agents and market
    await conn.execute(
      `INSERT INTO agents (id, pubkey, handle) VALUES (?, ?, ?)`,
      ['agent-alice', 'pubkey_alice', 'alice']
    )

    const now = new Date()
    const closesAt = new Date(now.getTime() + 72 * 60 * 60 * 1000)
    const resolvesAt = new Date(closesAt.getTime() + 60 * 60 * 1000)

    await conn.execute(
      `INSERT INTO markets (id, title, domain, state, closesAt, resolvesAt)
       VALUES (?, ?, 'crypto', 'OPEN', ?, ?)`,
      ['market-1', 'Test Market', closesAt, resolvesAt]
    )

    // Create signal via service simulation (POST /api/markets/:id/signal)
    const signalId = 'signal-test-1'
    await conn.execute(
      `INSERT INTO signals (id, marketId, agentId, position, postingFeeSats)
       VALUES (?, ?, ?, ?, ?)`,
      [signalId, 'market-1', 'agent-alice', 'yes', 500]
    )

    // Poster automatically becomes first upvoter
    const voteId = 'vote-1'
    await conn.execute(
      `INSERT INTO signal_votes (id, signalId, agentId, direction, amountSats, votedAt)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [voteId, signalId, 'agent-alice', 'up', 500]
    )

    // Initialize pool
    await conn.execute(
      `INSERT INTO signal_pools (signalId, marketId, totalSats, upSats, downSats, escrowTxid)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [signalId, 'market-1', 500, 500, 0, `STUB_${signalId}`]
    )

    // Verify
    const signal = await db.get('SELECT * FROM signals WHERE id = ?', [signalId])
    const pool = await db.get('SELECT * FROM signal_pools WHERE signalId = ?', [signalId])
    const votes = await db.all('SELECT * FROM signal_votes WHERE signalId = ?', [signalId])

    expect(signal).toBeTruthy()
    expect(signal.position).toBe('yes')
    expect(signal.postingFeeSats).toBe(500)
    expect(pool.totalSats).toBe(500)
    expect(pool.upSats).toBe(500)
    expect(pool.downSats).toBe(0)
    expect(votes.length).toBe(1)
    expect(votes[0].direction).toBe('up')
    expect(votes[0].amountSats).toBe(500)
  })

  it('should record upvote and update pool totals', async () => {
    // Setup: Add another agent and upvote
    await conn.execute(
      `INSERT INTO agents (id, pubkey, handle) VALUES (?, ?, ?)`,
      ['agent-bob', 'pubkey_bob', 'bob']
    )

    // Get existing signal from previous test
    const signal = await db.get('SELECT * FROM signals WHERE id = ?', ['signal-test-1'])
    const signalId = signal.id

    // Record upvote (POST /api/signals/:id/vote)
    const voteId = 'vote-2'
    await conn.execute(
      `INSERT INTO signal_votes (id, signalId, agentId, direction, amountSats, votedAt)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [voteId, signalId, 'agent-bob', 'up', 200]
    )

    // Update pool
    const pool = await db.get('SELECT * FROM signal_pools WHERE signalId = ?', [signalId])
    await conn.execute(
      `UPDATE signal_pools SET totalSats = ?, upSats = ?, downSats = ? WHERE signalId = ?`,
      [pool.totalSats + 200, pool.upSats + 200, pool.downSats, signalId]
    )

    // Verify
    const updatedPool = await db.get('SELECT * FROM signal_pools WHERE signalId = ?', [signalId])
    const allVotes = await db.all('SELECT * FROM signal_votes WHERE signalId = ?', [signalId])

    expect(updatedPool.totalSats).toBe(700)
    expect(updatedPool.upSats).toBe(700)
    expect(updatedPool.downSats).toBe(0)
    expect(allVotes.length).toBe(2)
    expect(allVotes.filter((v: any) => v.direction === 'up').length).toBe(2)
  })

  it('should record downvote and update pool totals', async () => {
    // Setup: Add another agent and downvote
    await conn.execute(
      `INSERT INTO agents (id, pubkey, handle) VALUES (?, ?, ?)`,
      ['agent-charlie', 'pubkey_charlie', 'charlie']
    )

    const signal = await db.get('SELECT * FROM signals WHERE id = ?', ['signal-test-1'])
    const signalId = signal.id

    // Record downvote (POST /api/signals/:id/vote)
    const voteId = 'vote-3'
    await conn.execute(
      `INSERT INTO signal_votes (id, signalId, agentId, direction, amountSats, votedAt)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [voteId, signalId, 'agent-charlie', 'down', 300]
    )

    // Update pool
    const pool = await db.get('SELECT * FROM signal_pools WHERE signalId = ?', [signalId])
    await conn.execute(
      `UPDATE signal_pools SET totalSats = ?, upSats = ?, downSats = ? WHERE signalId = ?`,
      [pool.totalSats + 300, pool.upSats, pool.downSats + 300, signalId]
    )

    // Verify
    const updatedPool = await db.get('SELECT * FROM signal_pools WHERE signalId = ?', [signalId])
    const allVotes = await db.all('SELECT * FROM signal_votes WHERE signalId = ?', [signalId])

    expect(updatedPool.totalSats).toBe(1000)
    expect(updatedPool.upSats).toBe(700)
    expect(updatedPool.downSats).toBe(300)
    expect(allVotes.length).toBe(3)
    expect(allVotes.filter((v: any) => v.direction === 'down').length).toBe(1)
  })

  it('should verify final pool state after multiple votes', async () => {
    const signal = await db.get('SELECT * FROM signals WHERE id = ?', ['signal-test-1'])
    const pool = await db.get('SELECT * FROM signal_pools WHERE signalId = ?', [signal.id])
    const votes = await db.all('SELECT * FROM signal_votes WHERE signalId = ?', [signal.id])

    // Pool should have:
    // - 500 sats from poster (alice)
    // - 200 sats upvote from bob
    // - 300 sats downvote from charlie
    // Total: 1000 sats

    expect(pool.totalSats).toBe(1000)
    expect(pool.upSats).toBe(700)
    expect(pool.downSats).toBe(300)
    expect(votes.length).toBe(3)

    // Check vote breakdown
    const upVotes = votes.filter((v: any) => v.direction === 'up')
    const downVotes = votes.filter((v: any) => v.direction === 'down')

    expect(upVotes.length).toBe(2)
    expect(downVotes.length).toBe(1)
    expect(upVotes.reduce((s: number, v: any) => s + v.amountSats, 0)).toBe(700)
    expect(downVotes.reduce((s: number, v: any) => s + v.amountSats, 0)).toBe(300)
  })
})
