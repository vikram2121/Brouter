/**
 * ConsensusService — Tier 2 (stake-weighted) + Tier 3 (commit-reveal) resolution
 */
import crypto from 'crypto'
import { nanoid } from 'nanoid'
import { DbConnection } from '../db/connection'

export interface ConsensusResult {
  outcome: 'yes' | 'no' | 'void'
  yesSats: number
  noSats: number
  voidSats: number
  totalSats: number
  supermajorityPct: number
  achieved: boolean
  claimsCount: number
}

export interface ClaimPayout {
  agentId: string
  claimedOutcome: string
  stakeSats: number
  payoutSats: number
  correct: boolean
}

export class ConsensusService {
  constructor(private db: DbConnection) {}

  /**
   * Submit a resolution claim (Tier 2).
   * Agent stakes sats on their claimed outcome.
   * One claim per agent per market (UNIQUE constraint enforced by DB).
   */
  async submitClaim(
    marketId: string,
    agentId: string,
    claimedOutcome: 'yes' | 'no' | 'void',
    stakeSats: number
  ): Promise<{ id: string }> {
    // Validate market is in RESOLVING state and uses consensus
    const market = await this.db.get(
      `SELECT state, resolution_mechanism, consensus_min_stake_sats, consensus_window_hours, consensus_started_at
       FROM markets WHERE id = ?`,
      [marketId]
    )
    if (!market) throw new Error('Market not found')
    if (market.state !== 'RESOLVING') throw new Error('Market is not in RESOLVING state')
    if (market.resolution_mechanism !== 'consensus') throw new Error('Market does not use consensus resolution')
    if (stakeSats < (market.consensus_min_stake_sats || 1000)) {
      throw new Error(`Minimum stake is ${market.consensus_min_stake_sats || 1000} sats`)
    }

    // Check window still open
    if (market.consensus_started_at) {
      const windowEnd = new Date(market.consensus_started_at)
      windowEnd.setHours(windowEnd.getHours() + (market.consensus_window_hours || 24))
      if (new Date() > windowEnd) throw new Error('Consensus window has closed')
    }

    // Check agent balance
    const agent = await this.db.get('SELECT balance_sats FROM agents WHERE id = ?', [agentId])
    if (!agent) throw new Error('Agent not found')
    if ((agent.balance_sats || 0) < stakeSats) {
      throw new Error(`Insufficient balance: have ${agent.balance_sats} sats, need ${stakeSats}`)
    }

    const id = nanoid()

    // Deduct balance and insert claim atomically
    await this.db.run('UPDATE agents SET balance_sats = balance_sats - ? WHERE id = ?', [stakeSats, agentId])
    await this.db.run(
      `INSERT INTO resolution_claims (id, market_id, agent_id, claimed_outcome, stake_sats)
       VALUES (?, ?, ?, ?, ?)`,
      [id, marketId, agentId, claimedOutcome, stakeSats]
    )

    return { id }
  }

  /**
   * Submit a commit (Tier 3 — phase 1 of commit-reveal).
   * Agent commits SHA256(outcome + salt) without revealing their vote.
   */
  async submitCommit(
    marketId: string,
    agentId: string,
    commitmentHash: string,
    stakeSats: number
  ): Promise<{ id: string }> {
    if (!/^[a-f0-9]{64}$/.test(commitmentHash)) throw new Error('commitmentHash must be 64-char hex SHA256')

    const market = await this.db.get(
      `SELECT state, resolution_mechanism, consensus_min_stake_sats FROM markets WHERE id = ?`,
      [marketId]
    )
    if (!market) throw new Error('Market not found')
    if (market.state !== 'RESOLVING') throw new Error('Market is not in RESOLVING state')
    if (!['consensus', 'manual'].includes(market.resolution_mechanism)) {
      throw new Error('Market does not support commit-reveal')
    }
    if (stakeSats < (market.consensus_min_stake_sats || 1000)) {
      throw new Error(`Minimum stake is ${market.consensus_min_stake_sats || 1000} sats`)
    }

    const agent = await this.db.get('SELECT balance_sats FROM agents WHERE id = ?', [agentId])
    if (!agent) throw new Error('Agent not found')
    if ((agent.balance_sats || 0) < stakeSats) {
      throw new Error(`Insufficient balance: have ${agent.balance_sats} sats, need ${stakeSats}`)
    }

    const id = nanoid()
    await this.db.run('UPDATE agents SET balance_sats = balance_sats - ? WHERE id = ?', [stakeSats, agentId])
    await this.db.run(
      `INSERT INTO resolution_claims (id, market_id, agent_id, claimed_outcome, stake_sats, commitment_hash)
       VALUES (?, ?, ?, 'void', ?, ?)`,
      [id, marketId, agentId, stakeSats, commitmentHash]
    )

    return { id }
  }

  /**
   * Reveal a commit (Tier 3 — phase 2 of commit-reveal).
   * Agent reveals their outcome + salt. Hash must match commitment.
   */
  async revealCommit(
    marketId: string,
    agentId: string,
    outcome: 'yes' | 'no' | 'void',
    salt: string
  ): Promise<void> {
    const claim = await this.db.get(
      `SELECT id, commitment_hash, revealed_at FROM resolution_claims 
       WHERE market_id = ? AND agent_id = ?`,
      [marketId, agentId]
    )
    if (!claim) throw new Error('No commit found for this agent on this market')
    if (claim.revealed_at) throw new Error('Already revealed')
    if (!claim.commitment_hash) throw new Error('No commitment hash — submit a commit first')

    // Verify hash: SHA256(outcome + salt)
    const expected = crypto.createHash('sha256').update(outcome + salt).digest('hex')
    if (expected !== claim.commitment_hash) {
      throw new Error('Hash mismatch — commitment does not match revealed outcome + salt')
    }

    await this.db.run(
      `UPDATE resolution_claims SET claimed_outcome = ?, revealed_at = NOW(), reveal_valid = 1 WHERE id = ?`,
      [outcome, claim.id]
    )
  }

  /**
   * Tally weighted votes and determine consensus outcome.
   * Called after consensus window closes.
   */
  async tally(marketId: string): Promise<ConsensusResult> {
    const market = await this.db.get(
      `SELECT consensus_supermajority_pct FROM markets WHERE id = ?`,
      [marketId]
    )
    const supermajorityPct = market?.consensus_supermajority_pct || 66

    const claims = await this.db.all(
      `SELECT claimed_outcome, stake_sats FROM resolution_claims WHERE market_id = ?`,
      [marketId]
    )

    let yesSats = 0, noSats = 0, voidSats = 0
    for (const c of claims) {
      if (c.claimed_outcome === 'yes') yesSats += c.stake_sats
      else if (c.claimed_outcome === 'no') noSats += c.stake_sats
      else voidSats += c.stake_sats
    }

    const totalSats = yesSats + noSats + voidSats
    if (totalSats === 0) {
      return { outcome: 'void', yesSats, noSats, voidSats, totalSats, supermajorityPct, achieved: false, claimsCount: claims.length }
    }

    // Determine winner by supermajority (excluding void from denominator)
    const votingSats = yesSats + noSats
    let outcome: 'yes' | 'no' | 'void' = 'void'
    let achieved = false

    if (votingSats > 0) {
      const yesPct = (yesSats / votingSats) * 100
      const noPct = (noSats / votingSats) * 100

      if (yesPct >= supermajorityPct) { outcome = 'yes'; achieved = true }
      else if (noPct >= supermajorityPct) { outcome = 'no'; achieved = true }
    }

    return { outcome, yesSats, noSats, voidSats, totalSats, supermajorityPct, achieved, claimsCount: claims.length }
  }

  /**
   * Settle consensus: distribute stakes to correct claimants.
   * Winners get their stake back + proportional share of losing pool.
   * Losers forfeit their entire stake.
   * Returns payout breakdown.
   */
  async settle(marketId: string, outcome: 'yes' | 'no' | 'void'): Promise<ClaimPayout[]> {
    const claims = await this.db.all(
      `SELECT id, agent_id, claimed_outcome, stake_sats FROM resolution_claims WHERE market_id = ?`,
      [marketId]
    )
    if (claims.length === 0) return []

    const payouts: ClaimPayout[] = []

    if (outcome === 'void') {
      // No supermajority — return all stakes
      for (const c of claims) {
        await this.db.run('UPDATE agents SET balance_sats = balance_sats + ? WHERE id = ?', [c.stake_sats, c.agent_id])
        await this.db.run(
          `UPDATE resolution_claims SET payout_sats = ?, settled_at = NOW() WHERE id = ?`,
          [c.stake_sats, c.id]
        )
        payouts.push({ agentId: c.agent_id, claimedOutcome: c.claimed_outcome, stakeSats: c.stake_sats, payoutSats: c.stake_sats, correct: false })
      }
      return payouts
    }

    const winners = claims.filter((c: any) => c.claimed_outcome === outcome)
    const losers = claims.filter((c: any) => c.claimed_outcome !== outcome)

    const loserPool = losers.reduce((s: number, c: any) => s + c.stake_sats, 0)
    const winnerPool = winners.reduce((s: number, c: any) => s + c.stake_sats, 0)
    const totalPool = loserPool + winnerPool

    // Winners: stake back + proportional share of loser pool
    let totalPaid = 0
    for (let i = 0; i < winners.length; i++) {
      const w = winners[i]
      const share = i < winners.length - 1
        ? Math.floor((w.stake_sats / winnerPool) * loserPool)
        : loserPool - totalPaid  // last winner gets remainder (no dust)
      const payout = w.stake_sats + share
      totalPaid += share

      await this.db.run('UPDATE agents SET balance_sats = balance_sats + ? WHERE id = ?', [payout, w.agent_id])
      await this.db.run(
        `UPDATE resolution_claims SET payout_sats = ?, settled_at = NOW() WHERE id = ?`,
        [payout, w.id]
      )
      payouts.push({ agentId: w.agent_id, claimedOutcome: w.claimed_outcome, stakeSats: w.stake_sats, payoutSats: payout, correct: true })
    }

    // Losers: forfeit stake (already deducted at submit time)
    for (const l of losers) {
      await this.db.run(
        `UPDATE resolution_claims SET payout_sats = 0, settled_at = NOW() WHERE id = ?`,
        [l.id]
      )
      payouts.push({ agentId: l.agent_id, claimedOutcome: l.claimed_outcome, stakeSats: l.stake_sats, payoutSats: 0, correct: false })
    }

    return payouts
  }

  /**
   * List resolution claims for a market
   */
  async listClaims(marketId: string) {
    return this.db.all(
      `SELECT rc.id, rc.agent_id, a.handle, rc.claimed_outcome, rc.stake_sats, 
              rc.commitment_hash IS NOT NULL as is_commit_reveal,
              rc.revealed_at IS NOT NULL as revealed,
              rc.reveal_valid,
              rc.payout_sats, rc.settled_at, rc.submitted_at
       FROM resolution_claims rc
       JOIN agents a ON rc.agent_id = a.id
       WHERE rc.market_id = ?
       ORDER BY rc.stake_sats DESC`,
      [marketId]
    )
  }
}
