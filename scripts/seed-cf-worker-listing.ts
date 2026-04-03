/**
 * Registers the Cloudflare AI Worker as the first inference_slot listing
 * on the Compute Exchange.
 *
 * Required env vars:
 *   DATABASE_URL           — MySQL connection string (same as brouter-web)
 *   CF_WORKER_AGENT_ID     — Brouter agent ID of the CF Worker's owner account
 *   CF_WORKER_BSV_ADDRESS  — BSV address that receives x402 payments
 *   CF_WORKER_PRICE_SATS   — per-slot reservation fee in sats (default: 100)
 *   CF_WORKER_X402_SATS    — per-call fee in sats (default: 2)
 *   CF_WORKER_DURATION_MIN — slot duration in minutes (default: 60)
 */

import { db } from '../src/db/connection'
import { nanoid } from 'nanoid'
import { X402Service } from '../src/services/X402Service'

async function main() {
  const agentId = process.env.CF_WORKER_AGENT_ID
  const bsvAddress = process.env.CF_WORKER_BSV_ADDRESS
  const priceSats = Number(process.env.CF_WORKER_PRICE_SATS ?? 100)
  const x402Sats = Number(process.env.CF_WORKER_X402_SATS ?? 2)
  const durationMin = Number(process.env.CF_WORKER_DURATION_MIN ?? 60)

  if (!agentId || !bsvAddress) {
    console.error('Missing required env vars: CF_WORKER_AGENT_ID, CF_WORKER_BSV_ADDRESS')
    process.exit(1)
  }

  // Initialize the DB connection before use
  await db.initialize()

  // X402Service requires a DbConnection instance; db satisfies that interface
  const x402Service = new X402Service(db)
  const lockingScript = x402Service.addressToLockingScript(bsvAddress)

  const id = nanoid()
  const specs = JSON.stringify({
    model_name: 'cloudflare-workers-ai',
    context_length: 4096,
    tokens_per_sec: 80,
    provider: 'Cloudflare Workers AI',
    notes: 'Hosted inference via Cloudflare Workers. Instant availability.',
  })

  await db.run(
    `INSERT INTO compute_listings
       (id, agent_id, listing_type, availability_mode, status,
        slot_duration_minutes, price_sats, x402_price_sats, x402_endpoint,
        max_concurrent_slots, specs, created_at, updated_at)
     VALUES (?, ?, 'inference_slot', 'instant', 'active', ?, ?, ?, ?, 10, ?, NOW(), NOW())`,
    [id, agentId, durationMin, priceSats, x402Sats, lockingScript, specs]
  )

  console.log(`✓ Created inference_slot listing id=${id}`)
  console.log(`  Agent:       ${agentId}`)
  console.log(`  BSV address: ${bsvAddress}`)
  console.log(`  Price:       ${priceSats} sats/slot, ${x402Sats} sats/call`)
  console.log(`  Duration:    ${durationMin} minutes`)
  console.log(`  x402 script: ${lockingScript}`)

  await db.close()
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
