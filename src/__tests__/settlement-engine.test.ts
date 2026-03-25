/**
 * SettlementEngine Tests
 * 
 * Tests payout calculation logic for all outcome scenarios:
 * - YES outcome: YES stakes win, split pool
 * - NO outcome: NO stakes win, split pool
 * - VOID outcome: All stakes refunded
 * - Edge cases: No winners, single winner, 50-50 split
 */

import { describe, it, expect } from 'vitest'
import { Outcome, Stake } from '../types/market-v3'

// Payout calculation logic (extracted for testing)
function calculatePayouts(
  stakes: Stake[],
  outcome: Outcome,
  totalPoolSats: number
): Array<{
  stakeId: string
  agentId: string
  direction: 'yes' | 'no'
  amountSats: number
  won: boolean
  payoutSats: number
}> {
  const payouts = []

  if (outcome === 'void') {
    // Refund all
    for (const stake of stakes) {
      payouts.push({
        stakeId: stake.id,
        agentId: stake.agentId,
        direction: stake.direction,
        amountSats: stake.amountSats,
        won: false,
        payoutSats: stake.amountSats
      })
    }
  } else {
    // Calculate winners pool size
    const winningStakes = stakes.filter((s) => s.direction === outcome)
    const winningPoolSats = winningStakes.reduce((sum, s) => sum + s.amountSats, 0)

    if (winningPoolSats === 0) {
      // No one bet on the outcome — refund everyone
      for (const stake of stakes) {
        payouts.push({
          stakeId: stake.id,
          agentId: stake.agentId,
          direction: stake.direction,
          amountSats: stake.amountSats,
          won: false,
          payoutSats: stake.amountSats
        })
      }
    } else {
      // Distribute pool to winners
      for (const stake of stakes) {
        const won = stake.direction === outcome
        const payout = won
          ? Math.floor((stake.amountSats / winningPoolSats) * totalPoolSats)
          : 0

        payouts.push({
          stakeId: stake.id,
          agentId: stake.agentId,
          direction: stake.direction,
          amountSats: stake.amountSats,
          won,
          payoutSats: payout
        })
      }
    }
  }

  return payouts
}

describe('SettlementEngine — Payout Calculation', () => {
  // ============ TEST 1: YES Outcome ============
  describe('YES Outcome', () => {
    it('distributes pool to YES holders only', () => {
      const stakes: Stake[] = [
        {
          id: 'stake-1',
          marketId: 'mkt-1',
          agentId: 'agent-1',
          direction: 'yes',
          amountSats: 1000,
          oddsAtStake: 1.0,
          impliedProbability: 0.5,
          consensusAfter: 0.5,
          paymentTxid: 'tx1',
          anchorTxid: 'tx1',
          payoutSats: 0,
          payoutTxid: null,
          createdAt: new Date()
        },
        {
          id: 'stake-2',
          marketId: 'mkt-1',
          agentId: 'agent-2',
          direction: 'yes',
          amountSats: 1000,
          oddsAtStake: 1.0,
          impliedProbability: 0.5,
          consensusAfter: 0.5,
          paymentTxid: 'tx2',
          anchorTxid: 'tx2',
          payoutSats: 0,
          payoutTxid: null,
          createdAt: new Date()
        },
        {
          id: 'stake-3',
          marketId: 'mkt-1',
          agentId: 'agent-3',
          direction: 'no',
          amountSats: 1000,
          oddsAtStake: 1.0,
          impliedProbability: 0.5,
          consensusAfter: 0.5,
          paymentTxid: 'tx3',
          anchorTxid: 'tx3',
          payoutSats: 0,
          payoutTxid: null,
          createdAt: new Date()
        }
      ]

      const payouts = calculatePayouts(stakes, 'yes', 3000)

      expect(payouts.length).toBe(3)
      expect(payouts[0].won).toBe(true)
      expect(payouts[1].won).toBe(true)
      expect(payouts[2].won).toBe(false)

      // YES holders split the 3000 sats pool
      // agent-1: 1000/2000 * 3000 = 1500
      // agent-2: 1000/2000 * 3000 = 1500
      expect(payouts[0].payoutSats).toBe(1500)
      expect(payouts[1].payoutSats).toBe(1500)
      expect(payouts[2].payoutSats).toBe(0)
    })

    it('handles single YES winner', () => {
      const stakes: Stake[] = [
        {
          id: 'stake-1',
          marketId: 'mkt-1',
          agentId: 'agent-1',
          direction: 'yes',
          amountSats: 2000,
          oddsAtStake: 1.0,
          impliedProbability: 0.5,
          consensusAfter: 0.5,
          paymentTxid: 'tx1',
          anchorTxid: 'tx1',
          payoutSats: 0,
          payoutTxid: null,
          createdAt: new Date()
        },
        {
          id: 'stake-2',
          marketId: 'mkt-1',
          agentId: 'agent-2',
          direction: 'no',
          amountSats: 1000,
          oddsAtStake: 1.0,
          impliedProbability: 0.5,
          consensusAfter: 0.5,
          paymentTxid: 'tx2',
          anchorTxid: 'tx2',
          payoutSats: 0,
          payoutTxid: null,
          createdAt: new Date()
        }
      ]

      const payouts = calculatePayouts(stakes, 'yes', 3000)

      expect(payouts[0].payoutSats).toBe(3000) // Winner gets entire pool
      expect(payouts[1].payoutSats).toBe(0)     // Loser gets nothing
    })

    it('handles 50-50 split', () => {
      const stakes: Stake[] = [
        {
          id: 'stake-1',
          marketId: 'mkt-1',
          agentId: 'agent-1',
          direction: 'yes',
          amountSats: 1000,
          oddsAtStake: 1.0,
          impliedProbability: 0.5,
          consensusAfter: 0.5,
          paymentTxid: 'tx1',
          anchorTxid: 'tx1',
          payoutSats: 0,
          payoutTxid: null,
          createdAt: new Date()
        },
        {
          id: 'stake-2',
          marketId: 'mkt-1',
          agentId: 'agent-2',
          direction: 'no',
          amountSats: 1000,
          oddsAtStake: 1.0,
          impliedProbability: 0.5,
          consensusAfter: 0.5,
          paymentTxid: 'tx2',
          anchorTxid: 'tx2',
          payoutSats: 0,
          payoutTxid: null,
          createdAt: new Date()
        }
      ]

      const payouts = calculatePayouts(stakes, 'yes', 2000)

      // YES winner gets all 2000 sats
      expect(payouts[0].payoutSats).toBe(2000)
      expect(payouts[1].payoutSats).toBe(0)
    })
  })

  // ============ TEST 2: NO Outcome ============
  describe('NO Outcome', () => {
    it('distributes pool to NO holders only', () => {
      const stakes: Stake[] = [
        {
          id: 'stake-1',
          marketId: 'mkt-1',
          agentId: 'agent-1',
          direction: 'yes',
          amountSats: 1000,
          oddsAtStake: 1.0,
          impliedProbability: 0.5,
          consensusAfter: 0.5,
          paymentTxid: 'tx1',
          anchorTxid: 'tx1',
          payoutSats: 0,
          payoutTxid: null,
          createdAt: new Date()
        },
        {
          id: 'stake-2',
          marketId: 'mkt-1',
          agentId: 'agent-2',
          direction: 'no',
          amountSats: 1500,
          oddsAtStake: 1.0,
          impliedProbability: 0.5,
          consensusAfter: 0.5,
          paymentTxid: 'tx2',
          anchorTxid: 'tx2',
          payoutSats: 0,
          payoutTxid: null,
          createdAt: new Date()
        },
        {
          id: 'stake-3',
          marketId: 'mkt-1',
          agentId: 'agent-3',
          direction: 'no',
          amountSats: 500,
          oddsAtStake: 1.0,
          impliedProbability: 0.5,
          consensusAfter: 0.5,
          paymentTxid: 'tx3',
          anchorTxid: 'tx3',
          payoutSats: 0,
          payoutTxid: null,
          createdAt: new Date()
        }
      ]

      const payouts = calculatePayouts(stakes, 'no', 3000)

      expect(payouts[0].won).toBe(false)
      expect(payouts[1].won).toBe(true)
      expect(payouts[2].won).toBe(true)

      // NO holders (total 2000 sats) split the 3000 sats pool
      // agent-2: 1500/2000 * 3000 = 2250
      // agent-3: 500/2000 * 3000 = 750
      expect(payouts[0].payoutSats).toBe(0)
      expect(payouts[1].payoutSats).toBe(2250)
      expect(payouts[2].payoutSats).toBe(750)
    })
  })

  // ============ TEST 3: VOID Outcome ============
  describe('VOID Outcome', () => {
    it('refunds all stakes on VOID', () => {
      const stakes: Stake[] = [
        {
          id: 'stake-1',
          marketId: 'mkt-1',
          agentId: 'agent-1',
          direction: 'yes',
          amountSats: 1000,
          oddsAtStake: 1.0,
          impliedProbability: 0.5,
          consensusAfter: 0.5,
          paymentTxid: 'tx1',
          anchorTxid: 'tx1',
          payoutSats: 0,
          payoutTxid: null,
          createdAt: new Date()
        },
        {
          id: 'stake-2',
          marketId: 'mkt-1',
          agentId: 'agent-2',
          direction: 'no',
          amountSats: 2000,
          oddsAtStake: 1.0,
          impliedProbability: 0.5,
          consensusAfter: 0.5,
          paymentTxid: 'tx2',
          anchorTxid: 'tx2',
          payoutSats: 0,
          payoutTxid: null,
          createdAt: new Date()
        },
        {
          id: 'stake-3',
          marketId: 'mkt-1',
          agentId: 'agent-3',
          direction: 'yes',
          amountSats: 500,
          oddsAtStake: 1.0,
          impliedProbability: 0.5,
          consensusAfter: 0.5,
          paymentTxid: 'tx3',
          anchorTxid: 'tx3',
          payoutSats: 0,
          payoutTxid: null,
          createdAt: new Date()
        }
      ]

      const payouts = calculatePayouts(stakes, 'void', 3500)

      // Everyone gets their original stake back
      expect(payouts[0].payoutSats).toBe(1000)
      expect(payouts[1].payoutSats).toBe(2000)
      expect(payouts[2].payoutSats).toBe(500)

      // All marked as non-winners
      expect(payouts.every(p => !p.won)).toBe(true)
    })
  })

  // ============ TEST 4: Edge Cases ============
  describe('Edge Cases', () => {
    it('handles zero stakes (market with no betting)', () => {
      const stakes: Stake[] = []
      const payouts = calculatePayouts(stakes, 'yes', 0)

      expect(payouts.length).toBe(0)
    })

    it('handles no winners (no one bet on outcome)', () => {
      const stakes: Stake[] = [
        {
          id: 'stake-1',
          marketId: 'mkt-1',
          agentId: 'agent-1',
          direction: 'no',
          amountSats: 1000,
          oddsAtStake: 1.0,
          impliedProbability: 0.5,
          consensusAfter: 0.5,
          paymentTxid: 'tx1',
          anchorTxid: 'tx1',
          payoutSats: 0,
          payoutTxid: null,
          createdAt: new Date()
        }
      ]

      const payouts = calculatePayouts(stakes, 'yes', 1000)

      // No winners — refund everyone
      expect(payouts[0].won).toBe(false)
      expect(payouts[0].payoutSats).toBe(1000) // Full refund
    })

    it('handles large numbers without overflow', () => {
      const stakes: Stake[] = [
        {
          id: 'stake-1',
          marketId: 'mkt-1',
          agentId: 'agent-1',
          direction: 'yes',
          amountSats: 1_000_000_000, // 1 BTC
          oddsAtStake: 1.0,
          impliedProbability: 0.5,
          consensusAfter: 0.5,
          paymentTxid: 'tx1',
          anchorTxid: 'tx1',
          payoutSats: 0,
          payoutTxid: null,
          createdAt: new Date()
        },
        {
          id: 'stake-2',
          marketId: 'mkt-1',
          agentId: 'agent-2',
          direction: 'no',
          amountSats: 500_000_000,
          oddsAtStake: 1.0,
          impliedProbability: 0.5,
          consensusAfter: 0.5,
          paymentTxid: 'tx2',
          anchorTxid: 'tx2',
          payoutSats: 0,
          payoutTxid: null,
          createdAt: new Date()
        }
      ]

      const payouts = calculatePayouts(stakes, 'yes', 1_500_000_000)

      expect(payouts[0].payoutSats).toBe(1_500_000_000) // Winner gets all
      expect(payouts[1].payoutSats).toBe(0)
    })
  })

  // ============ TEST 5: Multi-Agent Distribution ============
  describe('Multi-Agent Distribution', () => {
    it('distributes proportionally across many winners', () => {
      const stakes: Stake[] = [
        {
          id: 'stake-1',
          marketId: 'mkt-1',
          agentId: 'agent-1',
          direction: 'yes',
          amountSats: 100,
          oddsAtStake: 1.0,
          impliedProbability: 0.5,
          consensusAfter: 0.5,
          paymentTxid: 'tx1',
          anchorTxid: 'tx1',
          payoutSats: 0,
          payoutTxid: null,
          createdAt: new Date()
        },
        {
          id: 'stake-2',
          marketId: 'mkt-1',
          agentId: 'agent-2',
          direction: 'yes',
          amountSats: 200,
          oddsAtStake: 1.0,
          impliedProbability: 0.5,
          consensusAfter: 0.5,
          paymentTxid: 'tx2',
          anchorTxid: 'tx2',
          payoutSats: 0,
          payoutTxid: null,
          createdAt: new Date()
        },
        {
          id: 'stake-3',
          marketId: 'mkt-1',
          agentId: 'agent-3',
          direction: 'yes',
          amountSats: 300,
          oddsAtStake: 1.0,
          impliedProbability: 0.5,
          consensusAfter: 0.5,
          paymentTxid: 'tx3',
          anchorTxid: 'tx3',
          payoutSats: 0,
          payoutTxid: null,
          createdAt: new Date()
        },
        {
          id: 'stake-4',
          marketId: 'mkt-1',
          agentId: 'agent-4',
          direction: 'no',
          amountSats: 400,
          oddsAtStake: 1.0,
          impliedProbability: 0.5,
          consensusAfter: 0.5,
          paymentTxid: 'tx4',
          anchorTxid: 'tx4',
          payoutSats: 0,
          payoutTxid: null,
          createdAt: new Date()
        }
      ]

      const payouts = calculatePayouts(stakes, 'yes', 1000)

      const total = payouts.reduce((sum, p) => sum + p.payoutSats, 0)
      // Note: Due to floor() rounding, total may be less than pool by up to 1 sat per winner
      expect(total).toBe(999) // Floor division loses 1 satoshi (rounding dust)

      // agent-1: 100/600 * 1000 = 166.666... → 166 (floor)
      // agent-2: 200/600 * 1000 = 333.333... → 333 (floor)
      // agent-3: 300/600 * 1000 = 500.000 → 500
      // agent-4: 0
      // Total: 166 + 333 + 500 = 999 (1 sat dust due to rounding)
      expect(payouts[0].payoutSats).toBe(166)
      expect(payouts[1].payoutSats).toBe(333)
      expect(payouts[2].payoutSats).toBe(500)
      expect(payouts[3].payoutSats).toBe(0)
    })
  })
})
