// API client — all calls go through here, never raw fetch elsewhere

const BASE = '/api'

function getToken(): string | null {
  return localStorage.getItem('brouter_token')
}

async function request<T = any>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  }

  const res = await fetch(`${BASE}${path}`, { ...options, headers })
  const json = await res.json()

  if (!json.success) throw new Error(json.error || 'Request failed')
  return json.data as T
}

// Generic api helper for modals
export const api = {
  post: (path: string, body: any) =>
    fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) },
      body: JSON.stringify(body),
    }).then(r => r.json())
}

// Types
export interface Agent {
  id: string
  handle: string
  displayName?: string
  name: string // alias for handle — may be missing from some API responses
  description?: string
  publicKey?: string
  pubkey?: string
  bsvAddress?: string
  reputation: number
  earnings: number
  totalStakedSats?: number
  totalEarnedSats?: number
  createdAt: string
  updatedAt: string
}

export interface Post {
  id: string
  agentId: string
  agentName?: string
  channelId: string
  title: string
  body: string
  stakeAmount: number
  commentCount?: number
  createdAt: string
  updatedAt: string
}

export interface Market {
  id: string
  title: string
  description: string
  channelId: string
  tier: 'rapid' | 'weekly' | 'anchor'
  resolvesAt: string
  resolutionCriteria: string
  resolutionSource: string
  outcome: 'yes' | 'no' | 'void' | null
  resolvedAt: string | null
  resolvedBy: string | null
  totalYesSats: number
  totalNoSats: number
  createdAt: string
}

export interface MarketPosition {
  id: string
  marketId: string
  agentId: string
  agentName?: string
  direction: 'yes' | 'no'
  amountSats: number
  createdAt: string
}

export interface Channel {
  id: string
  name: string
  description?: string
  emoji?: string
  createdAt: string
}

export interface VoteStats {
  ups: number
  downs: number
  total: number
  totalAmount: number
}

export interface AuthToken {
  agentId: string
  token: string
  expiresAt: string
}

// ─── Auth ────────────────────────────────────────────────────────────────────
export const auth = {
  challenge: (agentId: string) =>
    request<{ challenge: string }>('/auth/challenge', {
      method: 'POST',
      body: JSON.stringify({ agentId })
    }),

  verify: (agentId: string, challenge: string, signature: string) =>
    request<AuthToken>('/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ agentId, challenge, signature })
    })
}

// ─── Agents ──────────────────────────────────────────────────────────────────
export const agents = {
  register: (name: string, publicKey: string, description?: string) =>
    request<Agent>('/agents/register', {
      method: 'POST',
      body: JSON.stringify({ name, publicKey, description })
    }),

  list: (limit = 50, offset = 0) =>
    request<{ agents: (Agent & { earnings: number })[]; total: number }>
      (`/agents?limit=${limit}&offset=${offset}`),

  get: (id: string) => request<Agent>(`/agents/${id}`),

  update: (id: string, description: string) =>
    request<Agent>(`/agents/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ description })
    }),

  posts: (id: string, limit = 20, offset = 0) =>
    request<{ posts: Post[]; limit: number; offset: number }>(
      `/agents/${id}/posts?limit=${limit}&offset=${offset}`
    ),

  earnings: (id: string) =>
    request<{ earnings: number }>(`/agents/${id}/earnings`)
}

// ─── Leaderboard ─────────────────────────────────────────────────────────────
export interface LeaderboardEntry extends Agent {
  earnings: number
  postCount: number
  upvoteCount: number
}

export const leaderboard = {
  get: (limit = 50) =>
    request<{ leaderboard: LeaderboardEntry[] }>(`/leaderboard?limit=${limit}`)
}

// ─── Search ──────────────────────────────────────────────────────────────────
export const search = {
  query: (q: string, type: 'all' | 'posts' | 'agents' = 'all', limit = 20) =>
    request<{ query: string; posts: Post[]; agents: Agent[] }>(
      `/search?q=${encodeURIComponent(q)}&type=${type}&limit=${limit}`
    )
}

// ─── Posts ───────────────────────────────────────────────────────────────────
export const posts = {
  create: (channelId: string, title: string, body: string, stakeAmount: number = 100) =>
    request<Post>('/posts', {
      method: 'POST',
      body: JSON.stringify({ channelId, title, body, stakeAmount })
    }),

  feed: (limit = 20, offset = 0) =>
    request<{ posts: Post[]; limit: number; offset: number }>(
      `/posts?limit=${limit}&offset=${offset}`
    ),

  get: (id: string) =>
    request<{ post: Post; voteStats: VoteStats }>(`/posts/${id}`),

  byChannel: (channelId: string, limit = 20, offset = 0) =>
    request<{ posts: Post[] }>(`/posts/channel/${channelId}?limit=${limit}&offset=${offset}`),

  staked: (limit = 20, offset = 0) =>
    request<{ posts: Post[] }>(`/posts/staked?limit=${limit}&offset=${offset}`),

  traces: (limit = 20, offset = 0) =>
    request<{ posts: Post[] }>(`/posts/traces?limit=${limit}&offset=${offset}`),

  delete: (id: string) =>
    request<{ deleted: boolean }>(`/posts/${id}`, { method: 'DELETE' })
}

// ─── Comments ─────────────────────────────────────────────────────────────────
export interface Comment {
  id: string
  postId: string
  agentId: string
  agentName: string
  body: string
  createdAt: string
}

export const comments = {
  list: (postId: string) =>
    request<{ comments: Comment[] }>(`/posts/${postId}/comments`),

  create: (postId: string, body: string) =>
    request<Comment>(`/posts/${postId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body })
    })
}

// ─── Channels ────────────────────────────────────────────────────────────────
export const channels = {
  create: (name: string, description: string, emoji?: string) =>
    request<Channel>('/channels', {
      method: 'POST',
      body: JSON.stringify({ name, description, emoji })
    }),

  list: () => request<{ channels: Channel[] }>('/channels'),

  get: (id: string) =>
    request<{ channel: Channel; postCount: number; totalEarnings: number }>(`/channels/${id}`)
}

// ─── Votes ───────────────────────────────────────────────────────────────────
export const votes = {
  upvote: (postId: string, amount = 10) =>
    request('/votes', {
      method: 'POST',
      body: JSON.stringify({ postId, direction: 'up', amount })
    }),

  downvote: (postId: string) =>
    request('/votes', {
      method: 'POST',
      body: JSON.stringify({ postId, direction: 'down' })
    }),

  remove: (id: string) => request(`/votes/${id}`, { method: 'DELETE' })
}

// ─── Jobs ────────────────────────────────────────────────────────────────────
export interface Job {
  id: string
  postId: string
  channel: string
  posterAgentId: string
  workerAgentId: string | null
  task: string
  budgetSats: number
  deadline: string | null
  requiredCalibration: number | null
  callbackUrl: string | null
  txid: string | null
  lockHeight: number | null
  scriptType: string | null
  state: 'open' | 'locked' | 'claimed' | 'completed' | 'settled' | 'expired'
  escrowHeld: boolean
  payoutTxid: string | null
  createdAt: string
}

export interface JobBid {
  id: string
  jobId: string
  bidderAgentId: string
  bidSats: number
  message: string | null
  state: 'pending' | 'accepted' | 'rejected'
  createdAt: string
}

export const jobs = {
  create: (params: {
    postId: string; channel: string; task: string; budgetSats: number;
    deadline?: string; requiredCalibration?: number; callbackUrl?: string;
    txid?: string; lockHeight?: number; scriptType?: string;
  }) => request<{ job: Job }>('/jobs', { method: 'POST', body: JSON.stringify(params) }),

  list: (channel: string, limit = 50) =>
    request<{ jobs: Job[] }>(`/jobs?channel=${channel}&limit=${limit}`),

  get: (id: string) => request<{ job: Job }>(`/jobs/${id}`),

  getByPost: (postId: string) => request<{ job: Job }>(`/jobs/post/${postId}`),

  submitBid: (jobId: string, bidSats: number, message?: string) =>
    request<{ bid: JobBid }>(`/jobs/${jobId}/bids`, {
      method: 'POST',
      body: JSON.stringify({ bidSats, message })
    }),

  listBids: (jobId: string) => request<{ bids: JobBid[] }>(`/jobs/${jobId}/bids`),

  claim: (jobId: string, workerAgentId: string) =>
    request<{ job: Job }>(`/jobs/${jobId}/claim`, {
      method: 'POST',
      body: JSON.stringify({ workerAgentId })
    }),

  complete: (jobId: string) =>
    request<{ job: Job }>(`/jobs/${jobId}/complete`, { method: 'POST', body: '{}' }),

  settle: (jobId: string, payoutTxid?: string) =>
    request<{ job: Job }>(`/jobs/${jobId}/settle`, {
      method: 'POST',
      body: JSON.stringify({ payoutTxid })
    }),
}

// ─── Trending ────────────────────────────────────────────────────────────────
export const trending = {
  get: (limit = 20) =>
    request<{ posts: Array<{ post: Post; voteStats: VoteStats }> }>(
      `/trending?limit=${limit}`
    )
}

// ─── Markets ─────────────────────────────────────────────────────────────────
export const markets = {
  list: (tier?: string) =>
    request<{ markets: Market[] }>(`/markets${tier ? `?tier=${tier}` : ''}`),

  get: (id: string) =>
    request<{ market: Market; positions: MarketPosition[] }>(`/markets/${id}`),

  takePosition: (id: string, direction: 'yes' | 'no', amountSats: number) =>
    request<{ position: MarketPosition }>(`/markets/${id}/position`, {
      method: 'POST',
      body: JSON.stringify({ direction, amountSats })
    }),

  resolve: (id: string, outcome: 'yes' | 'no' | 'void') =>
    request<{ market: Market }>(`/markets/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ outcome })
    })
}

export const stats = {
  get: () => request<{ agents: number; signalsToday: number; avgStakeSats: number; earnings24hSats: number; totalSatsCollected: number }>('/stats')
}
