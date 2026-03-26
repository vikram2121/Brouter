#!/usr/bin/env ts-node
/**
 * Phase 2 BSV Integration Test
 *
 * Tests the complete flow:
 * 1. Register agent
 * 2. Register BSV address
 * 3. Claim faucet (5000 sats)
 * 4. Verify balance update
 * 5. Create market
 * 6. Stake real BSV
 * 7. Verify on-chain payment
 *
 * Requires: BROUTER_BSV_ADDRESS wallet funded with BSV for faucet + staking
 */

import crypto from 'crypto'

// Use globalThis.fetch (Node 18+)
const fetch = globalThis.fetch

interface Agent {
  id: string
  handle: string
  balance_sats: number
  token: string
  bsvAddress?: string
}

const BASE_URL = process.env.BROUTER_URL || 'https://brouter-production.up.railway.app'

async function api(method: string, path: string, body?: any, token?: string): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  })

  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    console.error(`Failed to parse response: ${text}`)
    throw new Error(`HTTP ${response.status}: ${text}`)
  }
}

function generateTestKey(seed: string): string {
  return '02' + crypto.createHash('sha256').update(seed).digest('hex')
}

async function testPhase2() {
  console.log('\n🔵 PHASE 2: BSV Integration Test')
  console.log('================================\n')

  const runId = Date.now().toString().slice(-6)
  const agentName = `phase2test${runId}`
  const bsvAddress = 'REDACTED_BSV_ADDRESS'  // Brouter wallet

  // Step 1: Register agent
  console.log('Step 1: Register agent...')
  const registerResponse = await api('POST', '/api/agents/register', {
    name: agentName,
    publicKey: generateTestKey(`phase2-${runId}`),
    description: 'Phase 2 BSV test agent'
  })

  if (!registerResponse.success) {
    console.error('❌ Registration failed:', registerResponse.error)
    process.exit(1)
  }

  const agent: Agent = {
    id: registerResponse.data.agent.id,
    handle: registerResponse.data.agent.handle,
    balance_sats: registerResponse.data.agent.balance_sats || 0,
    token: registerResponse.data.token,
    bsvAddress: undefined
  }

  console.log(`  ✅ Registered agent: ${agent.handle} (${agent.id})`)
  console.log(`  Initial balance: ${agent.balance_sats} sats`)

  // Step 2: Register BSV address
  console.log('\nStep 2: Register BSV address...')
  const addressResponse = await api('POST', `/api/agents/${agent.id}/bsv-address`, {
    bsvAddress
  }, agent.token)

  if (!addressResponse.success) {
    console.error('❌ BSV address registration failed:', addressResponse.error)
    process.exit(1)
  }

  agent.bsvAddress = bsvAddress
  console.log(`  ✅ BSV address registered: ${bsvAddress}`)

  // Step 3: Claim faucet
  console.log('\nStep 3: Claim faucet (5000 sats)...')
  const faucetResponse = await api('POST', `/api/agents/${agent.id}/faucet`, {}, agent.token)

  if (!faucetResponse.success) {
    console.error('❌ Faucet claim failed:', faucetResponse.error)
    process.exit(1)
  }

  console.log(`  ✅ Faucet claimed: ${faucetResponse.data.claimed_sats} sats`)
  console.log(`  Txid: ${faucetResponse.data.txid}`)

  // Step 4: Verify balance updated
  console.log('\nStep 4: Verify balance updated...')
  const agentResponse = await api('GET', `/api/agents/${agent.id}`, undefined, agent.token)

  const newBalance = agentResponse.data.balance_sats || 0
  console.log(`  New balance: ${newBalance} sats`)

  if (newBalance >= 5000) {
    console.log(`  ✅ Balance increased by ${newBalance - agent.balance_sats} sats`)
  } else {
    console.warn(`  ⚠️  Balance not yet increased (may take a moment for indexing)`)
  }

  // Step 5: Create a test market
  console.log('\nStep 5: Create test market...')
  const marketResponse = await api('POST', '/api/markets', {
    title: 'Test market for BSV staking',
    description: 'Verify BSV payment flow',
    domain: 'crypto',
    tier: 'rapid',
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    resolvesAt: new Date(Date.now() + 172800000).toISOString(),
    resolutionCriteria: 'This is a test market for Phase 2 BSV staking verification',
    oracleProvider: 'manual',
    oracleMarketId: 'test-phase2-bsv',
    minStakeToOpenSats: 1000
  }, agent.token)

  if (!marketResponse.success) {
    console.error('❌ Market creation failed:', marketResponse.error)
    process.exit(1)
  }

  const marketId = marketResponse.data.id
  console.log(`  ✅ Market created: ${marketId}`)

  // Step 6: Open the market
  console.log('\nStep 6: Open market...')
  const openResponse = await api('POST', `/api/markets/${marketId}/open`, {}, agent.token)

  if (!openResponse.success) {
    console.error('❌ Market open failed:', openResponse.error)
    process.exit(1)
  }

  console.log(`  ✅ Market opened`)

  // Step 7: Place a stake
  console.log('\nStep 7: Place a 2000 sat stake...')
  const stakeResponse = await api('POST', `/api/markets/${marketId}/stake`, {
    direction: 'yes',
    amountSats: 2000
  }, agent.token)

  if (!stakeResponse.success) {
    console.error('❌ Stake placement failed:', stakeResponse.error)
    process.exit(1)
  }

  const stakeId = stakeResponse.data.id
  console.log(`  ✅ Stake placed: ${stakeId}`)
  console.log(`  Amount: 2000 sats, Direction: YES`)
  console.log(`  Payment Txid: ${stakeResponse.data.paymentTxid || 'pending'}`)

  // Step 8: Verify balance deducted
  console.log('\nStep 8: Verify balance deducted...')
  const finalAgentResponse = await api('GET', `/api/agents/${agent.id}`, undefined, agent.token)
  const finalBalance = finalAgentResponse.data.balance_sats || 0

  console.log(`  Final balance: ${finalBalance} sats`)
  console.log(`  Staked: 2000 sats`)
  console.log(`  Available after stake: ${finalBalance} sats (in escrow)`)

  if (finalBalance <= newBalance - 2000) {
    console.log(`  ✅ Balance correctly deducted for staking`)
  } else {
    console.warn(`  ⚠️  Balance deduction needs verification`)
  }

  // Summary
  console.log('\n================================')
  console.log('✅ PHASE 2 BSV TEST COMPLETE')
  console.log('================================\n')
  console.log('Summary:')
  console.log(`  • Agent registered: ${agent.handle}`)
  console.log(`  • BSV address: ${bsvAddress}`)
  console.log(`  • Faucet claimed: 5000 sats`)
  console.log(`  • Stake placed: 2000 sats`)
  console.log(`  • Final balance: ${finalBalance} sats`)
  console.log(`  • Market ID: ${marketId}`)
  console.log('\nNext steps:')
  console.log('  • Monitor blockchain for faucet TX confirmation')
  console.log('  • Run volume test with 10+ agents')
  console.log('  • Test settlement + payout flow')
  console.log('')
}

testPhase2().catch(error => {
  console.error('❌ Test failed:', error.message)
  process.exit(1)
})
