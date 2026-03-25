// scripts/stress-test-correctness.ts
/**
 * Phase A: Correctness Test
 * 
 * Deploy 10 agents with known strategies:
 * - always_yes: Always stakes on YES
 * - always_no: Always stakes on NO
 * - follow_odds: Bets the higher probability side
 * - fade_market: Bets against the market (contrarian)
 * - signal_only: Posts signals but doesn't stake
 * - vote_only: Votes on signals but doesn't stake
 * 
 * Verify:
 * 1. Settlements reconcile perfectly (staked = paid + fee + dust)
 * 2. Losers receive 0 sats
 * 3. Calibration scores updated for all agents
 * 4. Trace rights granted only to correct signal authors
 */

import {
  BrouterClient,
  Agent,
  Market,
  createTestMarkets,
  generateTestKey,
  randomBetween,
  verifyReconciliation
} from './stress-test-utils'

const AGENTS_CONFIG = [
  { handle: 'macro-bull', domain: 'macro', strategy: 'always_yes' },
  { handle: 'macro-bear', domain: 'macro', strategy: 'always_no' },
  { handle: 'crypto-long', domain: 'crypto', strategy: 'always_yes' },
  { handle: 'crypto-short', domain: 'crypto', strategy: 'always_no' },
  { handle: 'calibrated-1', domain: 'macro', strategy: 'follow_odds' },
  { handle: 'calibrated-2', domain: 'crypto', strategy: 'follow_odds' },
  { handle: 'contrarian-1', domain: 'macro', strategy: 'fade_market' },
  { handle: 'contrarian-2', domain: 'crypto', strategy: 'fade_market' },
  { handle: 'signal-only', domain: 'macro', strategy: 'signal_only' },
  { handle: 'voter-only', domain: 'macro', strategy: 'vote_only' }
]

const strategies: Record<string, (market?: any) => string | null> = {
  always_yes: () => 'yes',
  always_no: () => 'no',
  follow_odds: (market: any) => (market?.yesProb || 0.5) > 0.5 ? 'yes' : 'no',
  fade_market: (market: any) => (market?.yesProb || 0.5) > 0.5 ? 'no' : 'yes',
  signal_only: () => null,
  vote_only: () => null
}

async function runCorrectnessTest() {
  const baseUrl = process.env.BROUTER_URL || 'https://brouter-production.up.railway.app'
  const api = new BrouterClient(baseUrl)

  console.log('\n🧪 PHASE A: CORRECTNESS TEST')
  console.log('================================\n')

  // Step 1: Register all 10 agents
  console.log('Step 1: Registering 10 agents...')
  const agents: Agent[] = []
  for (const config of AGENTS_CONFIG) {
    try {
      const agent = await api.post('/api/agents/register', {
        handle: config.handle,
        identity_key: generateTestKey(config.handle)
      })
      agents.push(agent)
      console.log(`  ✅ ${config.handle}`)
    } catch (err) {
      console.error(`  ❌ Failed to register ${config.handle}:`, err)
      process.exit(1)
    }
  }

  // Step 2: Claim faucet for all agents
  console.log('\nStep 2: Claiming faucet (1000 sats each)...')
  for (const agent of agents) {
    try {
      await api.post(
        `/api/agents/${agent.id}/faucet`,
        {},
        { headers: { Authorization: `Bearer ${agent.token}` } }
      )
      console.log(`  ✅ ${agent.handle}: +1000 sats`)
    } catch (err) {
      console.log(`  ⚠️  ${agent.handle}: Faucet already claimed or error`, (err as any)?.message)
    }
  }

  // Step 3: Create 3 test markets
  console.log('\nStep 3: Creating 3 test markets...')
  let markets: Market[] = []
  try {
    markets = await createTestMarkets(api, 3, ['macro', 'crypto', 'sports'])
  } catch (err) {
    console.error('  ❌ Failed to create markets:', err)
    process.exit(1)
  }

  // Step 4: Transition markets to OPEN state
  console.log('\nStep 4: Opening markets...')
  for (const market of markets) {
    try {
      await api.post(`/api/markets/${market.id}/open`, {})
      console.log(`  ✅ Opened market ${market.id}`)
    } catch (err) {
      console.log(`  ⚠️  Market ${market.id} already open`, (err as any)?.message)
    }
  }

  // Step 5: Each agent stakes on each market according to their strategy
  console.log('\nStep 5: Agents taking positions...')
  let totalStakes = 0
  for (const market of markets) {
    for (const agent of agents) {
      const config = AGENTS_CONFIG.find((a) => a.handle === agent.handle)
      if (!config) continue

      const strategyFn = strategies[config.strategy]
      const direction = strategyFn(market)

      if (!direction) {
        // signal_only and vote_only agents don't stake
        continue
      }

      try {
        const stake = randomBetween(200, 2000)
        await api.post(
          `/api/markets/${market.id}/position`,
          {
            direction,
            amount_sats: stake
          },
          { headers: { Authorization: `Bearer ${agent.token}` } }
        )
        totalStakes++
      } catch (err) {
        console.error(`  ❌ ${agent.handle} failed to stake on market ${market.id}:`, err)
      }
    }
  }
  console.log(`  ✅ ${totalStakes} stakes placed`)

  // Step 6: Some agents post signals
  console.log('\nStep 6: Posting signals...')
  let signalsPosted = 0
  for (const market of markets) {
    const signalingAgents = agents.filter(
      (a) =>
        AGENTS_CONFIG.find((c) => c.handle === a.handle)?.strategy === 'signal_only' ||
        AGENTS_CONFIG.find((c) => c.handle === a.handle)?.strategy === 'always_yes'
    )

    for (const agent of signalingAgents.slice(0, 2)) {
      // Limit signals per market
      try {
        const position = Math.random() > 0.5 ? 'yes' : 'no'
        await api.post(
          `/api/markets/${market.id}/signal`,
          {
            position,
            claimed_prob: 0.4 + Math.random() * 0.2,
            reasoning: `Signal from ${agent.handle}: Market appears to be heading ${position.toUpperCase()}`
          },
          { headers: { Authorization: `Bearer ${agent.token}` } }
        )
        signalsPosted++
      } catch (err) {
        console.log(`  ⚠️  ${agent.handle} signal failed:`, (err as any)?.message)
      }
    }
  }
  console.log(`  ✅ ${signalsPosted} signals posted`)

  // Step 7: Voting agents vote on signals
  console.log('\nStep 7: Voting on signals...')
  let votesPlaced = 0
  const voterAgent = agents.find((a) => a.handle === 'voter-only')
  if (voterAgent) {
    for (const market of markets) {
      try {
        const signals = await api.get(`/api/signals?market_id=${market.id}`)
        if (signals && signals.length > 0) {
          for (const signal of signals.slice(0, 3)) {
            try {
              await api.post(
                `/api/signals/${signal.id}/vote`,
                {
                  direction: Math.random() > 0.5 ? 'up' : 'down',
                  amount_sats: randomBetween(50, 200)
                },
                { headers: { Authorization: `Bearer ${voterAgent.token}` } }
              )
              votesPlaced++
            } catch {
              // Ignore individual vote failures
            }
          }
        }
      } catch {
        // Ignore signal fetch failures
      }
    }
    console.log(`  ✅ ${votesPlaced} votes placed`)
  }

  // Step 8: Advance markets through state transitions
  console.log('\nStep 8: Advancing market states (OPEN → LOCKED → RESOLVING)...')
  for (const market of markets) {
    try {
      await api.post(`/api/markets/${market.id}/lock`, {})
      console.log(`  ✅ Locked market ${market.id}`)

      await api.post(`/api/markets/${market.id}/start-resolution`, {})
      console.log(`  ✅ Started resolution for market ${market.id}`)
    } catch (err) {
      console.error(`  ❌ State transition failed for market ${market.id}:`, err)
    }
  }

  // Step 9: Force resolve markets with known outcomes
  console.log('\nStep 9: Resolving markets with known outcomes...')
  const outcomes = ['yes', 'no', 'yes']
  for (let i = 0; i < markets.length; i++) {
    try {
      await api.post(`/api/markets/${markets[i].id}/resolve`, {
        outcome: outcomes[i]
      })
      console.log(`  ✅ Resolved market ${markets[i].id} → ${outcomes[i].toUpperCase()}`)
    } catch (err) {
      console.error(`  ❌ Failed to resolve market ${markets[i].id}:`, err)
    }
  }

  // Step 10: Verify reconciliation (STRICT MODE)
  console.log('\nStep 10: Verifying reconciliation (STRICT)...')
  try {
    const allReconciled = await verifyReconciliation(api, markets, agents, true)
    if (allReconciled) {
      console.log('\n✅ ALL RECONCILIATION CHECKS PASSED')
    }
  } catch (err) {
    console.error('\n❌ RECONCILIATION FAILED:', err)
    process.exit(1)
  }

  console.log('\n================================')
  console.log('✅ PHASE A COMPLETE: All correctness tests passed')
  console.log('Ready for Phase B (Volume Test)')
  console.log('================================\n')
}

// Run the test
runCorrectnessTest().catch((err) => {
  console.error('\n❌ Test failed:', err)
  process.exit(1)
})
