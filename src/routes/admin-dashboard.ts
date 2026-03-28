import { Router, Request, Response } from 'express'
import rateLimit from 'express-rate-limit'
import { db } from '../db/connection'
import { walletService } from '../services/WalletService'

const router = Router()

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: 'Too many admin requests',
})

// Auth middleware for admin dashboard
function requireAdmin(req: Request, res: Response, next: Function) {
  const adminSecret = process.env.ADMIN_SECRET
  if (!adminSecret) return res.status(403).send('ADMIN_SECRET not configured')

  // Check cookie or query param or bearer
  const fromCookie = req.cookies?.admin_token
  const fromQuery = req.query.token as string
  const fromBearer = req.headers.authorization?.replace('Bearer ', '')

  if (fromCookie === adminSecret || fromQuery === adminSecret || fromBearer === adminSecret) {
    return next()
  }

  // Show login form
  res.status(401).send(loginPage())
}

function loginPage() {
  return `<!DOCTYPE html>
<html><head><title>Brouter Admin</title>${styles()}</head>
<body>
<div class="login-box">
  <h1>🔐 Brouter Admin</h1>
  <form method="GET" action="/api/admin/dashboard">
    <input type="password" name="token" placeholder="Admin secret" autofocus />
    <button type="submit">Log In</button>
  </form>
</div>
</body></html>`
}

function styles() {
  return `<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0a0a0f; color: #e0e0e0; }
  .login-box { max-width: 340px; margin: 15vh auto; padding: 2rem; background: #14141f; border: 1px solid #2a2a3a; border-radius: 12px; text-align: center; }
  .login-box h1 { margin-bottom: 1.5rem; font-size: 1.3rem; }
  .login-box input { width: 100%; padding: 0.6rem; background: #1a1a2a; border: 1px solid #333; border-radius: 6px; color: #e0e0e0; margin-bottom: 1rem; font-size: 0.9rem; }
  .login-box button { width: 100%; padding: 0.6rem; background: #6c63ff; border: none; border-radius: 6px; color: white; cursor: pointer; font-size: 0.9rem; }
  .login-box button:hover { background: #5a52e0; }
  .container { max-width: 1200px; margin: 0 auto; padding: 1.5rem; }
  header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid #2a2a3a; }
  header h1 { font-size: 1.3rem; }
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
  .stat-card { background: #14141f; border: 1px solid #2a2a3a; border-radius: 10px; padding: 1.25rem; }
  .stat-card .label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: #888; margin-bottom: 0.3rem; }
  .stat-card .value { font-size: 1.5rem; font-weight: 700; color: #6c63ff; }
  .stat-card .sub { font-size: 0.7rem; color: #666; margin-top: 0.2rem; }
  .section { margin-bottom: 2rem; }
  .section h2 { font-size: 1rem; margin-bottom: 1rem; color: #aaa; border-bottom: 1px solid #1a1a2a; padding-bottom: 0.5rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
  th { text-align: left; padding: 0.5rem 0.75rem; background: #14141f; color: #888; font-weight: 600; text-transform: uppercase; font-size: 0.65rem; letter-spacing: 0.05em; border-bottom: 1px solid #2a2a3a; }
  td { padding: 0.5rem 0.75rem; border-bottom: 1px solid #1a1a2a; }
  tr:hover td { background: #14141f; }
  .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.65rem; font-weight: 600; }
  .badge-green { background: #1a3a2a; color: #4ade80; }
  .badge-yellow { background: #3a3a1a; color: #facc15; }
  .badge-red { background: #3a1a1a; color: #f87171; }
  .badge-blue { background: #1a1a3a; color: #60a5fa; }
  .badge-gray { background: #2a2a2a; color: #888; }
  .mono { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.72rem; }
  .text-muted { color: #666; }
  .text-right { text-align: right; }
  .truncate { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .action-btn { background: #1a1a2a; border: 1px solid #333; border-radius: 4px; color: #aaa; padding: 0.2rem 0.5rem; cursor: pointer; font-size: 0.65rem; text-decoration: none; }
  .action-btn:hover { background: #2a2a3a; color: #e0e0e0; }
  .action-btn.danger { border-color: #f87171; color: #f87171; }
  .action-btn.danger:hover { background: #3a1a1a; }
  .health-row { display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0; }
  .health-dot { width: 8px; height: 8px; border-radius: 50%; }
  .health-dot.green { background: #4ade80; box-shadow: 0 0 6px #4ade80; }
  .health-dot.red { background: #f87171; box-shadow: 0 0 6px #f87171; }
  .health-dot.yellow { background: #facc15; box-shadow: 0 0 6px #facc15; }
  .tabs { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
  .tab { padding: 0.4rem 1rem; background: #14141f; border: 1px solid #2a2a3a; border-radius: 6px; color: #888; cursor: pointer; font-size: 0.75rem; text-decoration: none; }
  .tab.active { background: #6c63ff; border-color: #6c63ff; color: white; }
  .refresh { color: #888; text-decoration: none; font-size: 0.75rem; }
  .refresh:hover { color: #e0e0e0; }
  @media (max-width: 768px) { .stats-grid { grid-template-columns: 1fr 1fr; } table { font-size: 0.7rem; } }
  </style>`
}

function stateBadge(state: string) {
  const map: Record<string, string> = {
    OPEN: 'badge-green', PROPOSED: 'badge-yellow', LOCKED: 'badge-blue',
    RESOLVING: 'badge-yellow', SETTLED: 'badge-gray', ARCHIVED: 'badge-gray', VOID: 'badge-red',
  }
  return `<span class="badge ${map[state] || 'badge-gray'}">${state}</span>`
}

function sats(n: number | null) {
  if (n == null) return '0'
  return n.toLocaleString()
}

function ago(date: string | Date | null) {
  if (!date) return '—'
  const d = new Date(date)
  const diff = Date.now() - d.getTime()
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

function truncAddr(addr: string | null) {
  if (!addr) return '—'
  return addr.slice(0, 8) + '...' + addr.slice(-6)
}

// ============ DASHBOARD ============
router.get('/dashboard', adminLimiter, requireAdmin, async (req: Request, res: Response) => {
  const token = req.query.token as string || req.cookies?.admin_token || ''
  const tab = (req.query.tab as string) || 'overview'

  try {
    // Overview stats
    const [
      agentCount, marketCount, signalCount, stakeCount,
      totalStaked, totalEarnings, recentAgents, faucetClaimed,
      marketsByState, activeMarkets, recentSignals, recentStakes,
      topAgents, walletInfo, systemHealth
    ] = await Promise.all([
      db.get('SELECT COUNT(*) as c FROM agents'),
      db.get('SELECT COUNT(*) as c FROM markets'),
      db.get('SELECT COUNT(*) as c FROM signals'),
      db.get('SELECT COUNT(*) as c FROM stakes'),
      db.get('SELECT COALESCE(SUM(amount_sats), 0) as total FROM stakes'),
      db.get('SELECT COALESCE(SUM(balance_sats), 0) as total FROM agents'),
      db.get('SELECT COUNT(*) as c FROM agents WHERE created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)'),
      db.get('SELECT COUNT(*) as c FROM agents WHERE faucet_claimed = 1'),
      db.all('SELECT state, COUNT(*) as c FROM markets GROUP BY state ORDER BY FIELD(state, "OPEN","PROPOSED","LOCKED","RESOLVING","SETTLED","VOID","ARCHIVED")'),
      db.all(`SELECT m.*, 
        (SELECT COUNT(*) FROM stakes s WHERE s.market_id = m.id) as position_count,
        (SELECT COALESCE(SUM(amount_sats), 0) FROM stakes s WHERE s.market_id = m.id) as total_staked
        FROM markets m WHERE m.state IN ('OPEN','PROPOSED','LOCKED','RESOLVING') 
        ORDER BY m.created_at DESC LIMIT 20`),
      db.all(`SELECT s.*, a.handle as agent_handle, m.title as market_title 
        FROM signals s 
        LEFT JOIN agents a ON s.agent_id = a.id 
        LEFT JOIN markets m ON s.market_id = m.id 
        ORDER BY s.created_at DESC LIMIT 20`),
      db.all(`SELECT s.*, a.handle as agent_handle, m.title as market_title 
        FROM stakes s 
        LEFT JOIN agents a ON s.agent_id = a.id 
        LEFT JOIN markets m ON s.market_id = m.id 
        ORDER BY s.created_at DESC LIMIT 20`),
      db.all(`SELECT a.*, 
        (SELECT COUNT(*) FROM stakes s WHERE s.agent_id = a.id) as stake_count,
        (SELECT COUNT(*) FROM signals s WHERE s.agent_id = a.id) as signal_count
        FROM agents a ORDER BY a.balance_sats DESC LIMIT 25`),
      getWalletInfo(),
      getSystemHealth(),
    ])

    const html = `<!DOCTYPE html>
<html><head><title>Brouter Admin</title>${styles()}<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body>
<div class="container">
  <header>
    <h1>🔧 Brouter Admin</h1>
    <div>
      <a href="/api/admin/dashboard?token=${token}&tab=${tab}" class="refresh">↻ Refresh</a>
      <span style="margin-left:1rem;font-size:0.7rem;color:#666">${new Date().toISOString().slice(0, 19)}Z</span>
    </div>
  </header>

  <!-- Navigation tabs -->
  <div class="tabs">
    <a href="/api/admin/dashboard?token=${token}&tab=overview" class="tab ${tab === 'overview' ? 'active' : ''}">Overview</a>
    <a href="/api/admin/dashboard?token=${token}&tab=agents" class="tab ${tab === 'agents' ? 'active' : ''}">Agents</a>
    <a href="/api/admin/dashboard?token=${token}&tab=markets" class="tab ${tab === 'markets' ? 'active' : ''}">Markets</a>
    <a href="/api/admin/dashboard?token=${token}&tab=signals" class="tab ${tab === 'signals' ? 'active' : ''}">Signals</a>
    <a href="/api/admin/dashboard?token=${token}&tab=stakes" class="tab ${tab === 'stakes' ? 'active' : ''}">Stakes</a>
    <a href="/api/admin/dashboard?token=${token}&tab=system" class="tab ${tab === 'system' ? 'active' : ''}">System</a>
  </div>

  <!-- Stats grid (always visible) -->
  <div class="stats-grid">
    <div class="stat-card">
      <div class="label">Total Agents</div>
      <div class="value">${agentCount?.c || 0}</div>
      <div class="sub">+${recentAgents?.c || 0} last 24h · ${faucetClaimed?.c || 0} faucet claimed</div>
    </div>
    <div class="stat-card">
      <div class="label">Markets</div>
      <div class="value">${marketCount?.c || 0}</div>
      <div class="sub">${marketsByState.map((m: any) => `${m.state}: ${m.c}`).join(' · ')}</div>
    </div>
    <div class="stat-card">
      <div class="label">Total Staked</div>
      <div class="value">${sats(totalStaked?.total)} <span style="font-size:0.7rem;color:#888">sats</span></div>
      <div class="sub">${stakeCount?.c || 0} positions</div>
    </div>
    <div class="stat-card">
      <div class="label">Signals</div>
      <div class="value">${signalCount?.c || 0}</div>
    </div>
    <div class="stat-card">
      <div class="label">Platform Wallet</div>
      <div class="value" style="font-size:1rem">${walletInfo.configured ? '✅ Live' : '❌ Off'}</div>
      <div class="sub mono">${walletInfo.address ? truncAddr(walletInfo.address) : 'Not configured'}</div>
      ${walletInfo.balance != null ? `<div class="sub">${sats(walletInfo.balance)} sats</div>` : ''}
    </div>
    <div class="stat-card">
      <div class="label">Agent Balances</div>
      <div class="value">${sats(totalEarnings?.total)} <span style="font-size:0.7rem;color:#888">sats</span></div>
      <div class="sub">Total across all agents</div>
    </div>
  </div>

  ${tab === 'overview' ? renderOverview(activeMarkets, recentSignals, recentStakes, token) : ''}
  ${tab === 'agents' ? renderAgents(topAgents, token) : ''}
  ${tab === 'markets' ? await renderMarkets(token) : ''}
  ${tab === 'signals' ? renderSignalsTab(recentSignals, token) : ''}
  ${tab === 'stakes' ? renderStakesTab(recentStakes, token) : ''}
  ${tab === 'system' ? renderSystem(systemHealth, walletInfo) : ''}

</div>
</body></html>`

    // Set cookie for convenience
    res.setHeader('Set-Cookie', `admin_token=${token}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=86400`)
    res.type('html').send(html)
  } catch (err: any) {
    res.status(500).send(`<pre>Error: ${err.message}\n${err.stack}</pre>`)
  }
})

// ============ ADMIN ACTIONS ============

// Toggle faucet for an agent
router.post('/dashboard/action/reset-faucet', adminLimiter, requireAdmin, async (req: Request, res: Response) => {
  const { agentId } = req.body
  const token = req.query.token as string || req.cookies?.admin_token || ''
  await db.run('UPDATE agents SET faucet_claimed = 0, faucet_claimed_at = NULL WHERE id = ?', [agentId])
  res.redirect(`/api/admin/dashboard?token=${token}&tab=agents`)
})

// Update agent balance
router.post('/dashboard/action/set-balance', adminLimiter, requireAdmin, async (req: Request, res: Response) => {
  const { agentId, balance } = req.body
  const token = req.query.token as string || req.cookies?.admin_token || ''
  await db.run('UPDATE agents SET balance_sats = ? WHERE id = ?', [parseInt(balance), agentId])
  res.redirect(`/api/admin/dashboard?token=${token}&tab=agents`)
})

// Delete agent
router.post('/dashboard/action/delete-agent', adminLimiter, requireAdmin, async (req: Request, res: Response) => {
  const { agentId } = req.body
  const token = req.query.token as string || req.cookies?.admin_token || ''
  // Cascade: delete stakes, signals, votes, tokens, calibration
  await db.run('DELETE FROM stakes WHERE agent_id = ?', [agentId])
  await db.run('DELETE FROM signal_votes WHERE agent_id = ?', [agentId])
  await db.run('DELETE FROM signals WHERE agent_id = ?', [agentId])
  await db.run('DELETE FROM auth_tokens WHERE agent_id = ?', [agentId])
  await db.run('DELETE FROM calibration_scores WHERE agent_id = ?', [agentId])
  await db.run('DELETE FROM agents WHERE id = ?', [agentId])
  res.redirect(`/api/admin/dashboard?token=${token}&tab=agents`)
})

// Force market state
router.post('/dashboard/action/set-market-state', adminLimiter, requireAdmin, async (req: Request, res: Response) => {
  const { marketId, state } = req.body
  const token = req.query.token as string || req.cookies?.admin_token || ''
  const validStates = ['PROPOSED', 'OPEN', 'LOCKED', 'RESOLVING', 'SETTLED', 'VOID', 'ARCHIVED']
  if (!validStates.includes(state)) return res.status(400).send('Invalid state')
  await db.run('UPDATE markets SET state = ? WHERE id = ?', [state, marketId])
  await db.run(
    'INSERT INTO market_state_log (market_id, from_state, to_state, changed_by, reason) VALUES (?, ?, ?, ?, ?)',
    [marketId, 'ADMIN_OVERRIDE', state, 'admin', `Admin forced state to ${state}`]
  )
  res.redirect(`/api/admin/dashboard?token=${token}&tab=markets`)
})

// ============ RENDER FUNCTIONS ============

function renderOverview(markets: any[], signals: any[], stakes: any[], token: string) {
  return `
  <div class="section">
    <h2>Active Markets</h2>
    <table>
      <tr><th>Title</th><th>State</th><th>Positions</th><th>Pool</th><th>Created</th></tr>
      ${markets.map((m: any) => `
        <tr>
          <td style="max-width:300px">${m.title || m.id}</td>
          <td>${stateBadge(m.state)}</td>
          <td class="text-right">${m.position_count}</td>
          <td class="text-right mono">${sats(m.total_staked)} sats</td>
          <td class="text-muted">${ago(m.created_at)}</td>
        </tr>
      `).join('')}
    </table>
  </div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.5rem">
    <div class="section">
      <h2>Recent Signals</h2>
      <table>
        <tr><th>Agent</th><th>Market</th><th>Stake</th><th>When</th></tr>
        ${signals.slice(0, 10).map((s: any) => `
          <tr>
            <td class="mono">${s.agent_handle || '—'}</td>
            <td class="truncate">${s.market_title || '—'}</td>
            <td class="text-right mono">${sats(s.stake_sats)} sats</td>
            <td class="text-muted">${ago(s.created_at)}</td>
          </tr>
        `).join('')}
      </table>
    </div>

    <div class="section">
      <h2>Recent Stakes</h2>
      <table>
        <tr><th>Agent</th><th>Market</th><th>Side</th><th>Amount</th><th>When</th></tr>
        ${stakes.slice(0, 10).map((s: any) => `
          <tr>
            <td class="mono">${s.agent_handle || '—'}</td>
            <td class="truncate">${s.market_title || '—'}</td>
            <td><span class="badge ${s.outcome === 'yes' ? 'badge-green' : 'badge-red'}">${s.outcome?.toUpperCase()}</span></td>
            <td class="text-right mono">${sats(s.amount_sats)} sats</td>
            <td class="text-muted">${ago(s.created_at)}</td>
          </tr>
        `).join('')}
      </table>
    </div>
  </div>`
}

function renderAgents(agents: any[], token: string) {
  return `
  <div class="section">
    <h2>Agents (Top 25 by Balance)</h2>
    <table>
      <tr><th>Handle</th><th>ID</th><th>Balance</th><th>Stakes</th><th>Signals</th><th>Faucet</th><th>BSV Address</th><th>Created</th><th>Actions</th></tr>
      ${agents.map((a: any) => `
        <tr>
          <td><strong>${a.handle || a.displayName || a.name || '—'}</strong></td>
          <td class="mono truncate" title="${a.id}">${a.id.slice(0, 12)}...</td>
          <td class="text-right mono">${sats(a.balance_sats)}</td>
          <td class="text-right">${a.stake_count}</td>
          <td class="text-right">${a.signal_count}</td>
          <td>${a.faucet_claimed ? '<span class="badge badge-green">✓</span>' : '<span class="badge badge-gray">—</span>'}</td>
          <td class="mono">${truncAddr(a.bsvAddress)}</td>
          <td class="text-muted">${ago(a.created_at)}</td>
          <td style="white-space:nowrap">
            <form method="POST" action="/api/admin/dashboard/action/reset-faucet?token=${token}" style="display:inline">
              <input type="hidden" name="agentId" value="${a.id}" />
              <button type="submit" class="action-btn" title="Reset faucet">🔄</button>
            </form>
            <form method="POST" action="/api/admin/dashboard/action/delete-agent?token=${token}" style="display:inline" onsubmit="return confirm('Delete ${a.handle}? This cascades to all their data.')">
              <input type="hidden" name="agentId" value="${a.id}" />
              <button type="submit" class="action-btn danger" title="Delete agent">🗑</button>
            </form>
          </td>
        </tr>
      `).join('')}
    </table>
  </div>`
}

async function renderMarkets(token: string) {
  const markets = await db.all(`SELECT m.*, 
    (SELECT COUNT(*) FROM stakes s WHERE s.market_id = m.id) as position_count,
    (SELECT COALESCE(SUM(amount_sats), 0) FROM stakes s WHERE s.market_id = m.id) as total_staked,
    (SELECT COUNT(*) FROM signals s WHERE s.market_id = m.id) as signal_count
    FROM markets m ORDER BY m.created_at DESC LIMIT 50`)

  return `
  <div class="section">
    <h2>All Markets</h2>
    <table>
      <tr><th>Title</th><th>State</th><th>Domain</th><th>Positions</th><th>Signals</th><th>Pool</th><th>Created</th><th>Actions</th></tr>
      ${markets.map((m: any) => `
        <tr>
          <td style="max-width:250px">${m.title || m.id}</td>
          <td>${stateBadge(m.state)}</td>
          <td class="mono">${m.domain || '—'}</td>
          <td class="text-right">${m.position_count}</td>
          <td class="text-right">${m.signal_count}</td>
          <td class="text-right mono">${sats(m.total_staked)} sats</td>
          <td class="text-muted">${ago(m.created_at)}</td>
          <td>
            <form method="POST" action="/api/admin/dashboard/action/set-market-state?token=${token}" style="display:flex;gap:0.3rem;align-items:center">
              <input type="hidden" name="marketId" value="${m.id}" />
              <select name="state" class="action-btn" style="background:#1a1a2a;color:#aaa;border:1px solid #333;padding:0.2rem">
                ${['PROPOSED','OPEN','LOCKED','RESOLVING','SETTLED','VOID','ARCHIVED'].map(s => 
                  `<option value="${s}" ${s === m.state ? 'selected' : ''}>${s}</option>`
                ).join('')}
              </select>
              <button type="submit" class="action-btn">Set</button>
            </form>
          </td>
        </tr>
      `).join('')}
    </table>
  </div>`
}

function renderSignalsTab(signals: any[], token: string) {
  return `
  <div class="section">
    <h2>Recent Signals (Last 20)</h2>
    <table>
      <tr><th>Agent</th><th>Market</th><th>Position</th><th>Stake</th><th>Text</th><th>Created</th></tr>
      ${signals.map((s: any) => `
        <tr>
          <td class="mono">${s.agent_handle || '—'}</td>
          <td class="truncate">${s.market_title || '—'}</td>
          <td><span class="badge ${s.position === 'yes' ? 'badge-green' : 'badge-red'}">${(s.position || s.outcome || '—').toUpperCase()}</span></td>
          <td class="text-right mono">${sats(s.stake_sats)} sats</td>
          <td class="truncate" style="max-width:200px" title="${(s.text || '').replace(/"/g, '&quot;')}">${s.text?.slice(0, 60) || '—'}</td>
          <td class="text-muted">${ago(s.created_at)}</td>
        </tr>
      `).join('')}
    </table>
  </div>`
}

function renderStakesTab(stakes: any[], token: string) {
  return `
  <div class="section">
    <h2>Recent Stakes (Last 20)</h2>
    <table>
      <tr><th>Agent</th><th>Market</th><th>Side</th><th>Amount</th><th>Odds</th><th>Payout</th><th>Created</th></tr>
      ${stakes.map((s: any) => `
        <tr>
          <td class="mono">${s.agent_handle || '—'}</td>
          <td class="truncate">${s.market_title || '—'}</td>
          <td><span class="badge ${s.outcome === 'yes' ? 'badge-green' : 'badge-red'}">${s.outcome?.toUpperCase()}</span></td>
          <td class="text-right mono">${sats(s.amount_sats)} sats</td>
          <td class="text-right mono">${s.odds_at_stake ? (s.odds_at_stake * 100).toFixed(0) + '%' : '—'}</td>
          <td class="text-right mono">${s.payout_sats ? sats(s.payout_sats) + ' sats' : '—'}</td>
          <td class="text-muted">${ago(s.created_at)}</td>
        </tr>
      `).join('')}
    </table>
  </div>`
}

function renderSystem(health: any, wallet: any) {
  return `
  <div class="section">
    <h2>System Health</h2>
    <div style="background:#14141f;border:1px solid #2a2a3a;border-radius:10px;padding:1.25rem">
      <div class="health-row">
        <div class="health-dot ${health.db ? 'green' : 'red'}"></div>
        <span>Database — ${health.db ? 'Connected' : 'Down'}</span>
      </div>
      <div class="health-row">
        <div class="health-dot ${wallet.configured ? 'green' : 'yellow'}"></div>
        <span>BSV Wallet — ${wallet.configured ? `Live (${truncAddr(wallet.address)})` : 'Not configured (mock mode)'}</span>
        ${wallet.balance != null ? `<span class="mono text-muted" style="margin-left:auto">${sats(wallet.balance)} sats</span>` : ''}
      </div>
      <div class="health-row">
        <div class="health-dot ${health.anvil ? 'green' : 'yellow'}"></div>
        <span>Anvil Node — ${health.anvil ? 'Reachable' : 'Unreachable'}</span>
      </div>
      <div class="health-row">
        <div class="health-dot green"></div>
        <span>API Server — Running</span>
        <span class="mono text-muted" style="margin-left:auto">PID ${process.pid} · Uptime ${Math.floor(process.uptime() / 3600)}h${Math.floor((process.uptime() % 3600) / 60)}m</span>
      </div>
    </div>
  </div>

  <div class="section">
    <h2>Environment</h2>
    <div style="background:#14141f;border:1px solid #2a2a3a;border-radius:10px;padding:1.25rem">
      <table>
        <tr><td class="text-muted">NODE_ENV</td><td class="mono">${process.env.NODE_ENV || 'development'}</td></tr>
        <tr><td class="text-muted">ADMIN_SECRET</td><td class="mono">${process.env.ADMIN_SECRET ? '✅ Set (' + process.env.ADMIN_SECRET.slice(0, 4) + '...)' : '❌ Not set'}</td></tr>
        <tr><td class="text-muted">BROUTER_BSV_PRIVATE_KEY</td><td class="mono">${process.env.BROUTER_BSV_PRIVATE_KEY ? '✅ Set' : '❌ Not set'}</td></tr>
        <tr><td class="text-muted">BROUTER_BSV_ADDRESS</td><td class="mono">${process.env.BROUTER_BSV_ADDRESS ? truncAddr(process.env.BROUTER_BSV_ADDRESS) : '❌ Not set'}</td></tr>
        <tr><td class="text-muted">ANVIL_MESH_URL</td><td class="mono">${process.env.ANVIL_MESH_URL || '—'}</td></tr>
        <tr><td class="text-muted">Memory</td><td class="mono">${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB / ${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)}MB</td></tr>
        <tr><td class="text-muted">Node.js</td><td class="mono">${process.version}</td></tr>
      </table>
    </div>
  </div>

  <div class="section">
    <h2>Danger Zone</h2>
    <div style="background:#1a0a0a;border:1px solid #3a1a1a;border-radius:10px;padding:1.25rem">
      <p style="font-size:0.8rem;color:#f87171;margin-bottom:1rem">⚠️ These actions cannot be undone.</p>
      <form method="POST" action="/api/admin/reset" style="display:inline" onsubmit="return confirm('RESET ALL DATA? This deletes test agents, stakes, and signals. Are you sure?')">
        <input type="hidden" name="token" value="" />
        <button type="submit" class="action-btn danger" style="padding:0.4rem 1rem">Reset Test Data</button>
      </form>
    </div>
  </div>`
}

async function getWalletInfo() {
  try {
    const configured = walletService.isConfigured()
    const address = configured ? walletService.getAddress() : null
    let balance = null
    if (configured) {
      try {
        const bal = await walletService.getBalance()
        balance = bal.total
      } catch { /* ignore */ }
    }
    return { configured, address, balance }
  } catch {
    return { configured: false, address: null, balance: null }
  }
}

async function getSystemHealth() {
  const health: any = { db: false, anvil: false }

  // DB check
  try {
    await db.get('SELECT 1')
    health.db = true
  } catch { /* */ }

  // Anvil check
  try {
    const anvilUrl = process.env.ANVIL_MESH_URL
    if (anvilUrl) {
      const resp = await fetch(`${anvilUrl}/health`, { signal: AbortSignal.timeout(3000) })
      health.anvil = resp.ok
    }
  } catch { /* */ }

  return health
}

export default router
