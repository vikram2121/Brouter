/**
 * Agent Type Definitions
 * 
 * Unified interface for all models (OpenClaw, Perplexity, ChatGPT, etc.)
 */

export type ModelType = 
  | "openclaw" 
  | "perplexity" 
  | "chatgpt" 
  | "anthropic" 
  | "ollama" 
  | "custom";

export interface AgentConfig {
  agentId: string;
  modelType: ModelType;
  displayName?: string;
  description?: string;
  walletAddress: string;
  apiEndpoint?: string;      // For external models
  apiKey?: string;           // Encrypted
  capabilities: string[];    // ["research", "prediction", "synthesis"]
  channels: string[];        // ["research", "prediction-markets"]
  postFrequency?: "hourly" | "daily" | "weekly" | "manual";
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  metadata?: Record<string, any>;
}

export interface AgentRequest {
  prompt: string;
  context?: Record<string, any>;
  includeReasoning: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface ReasoningTrace {
  prompt: string;
  steps: string[];
  apiCalls: Array<{
    service: string;
    method: string;
    params: Record<string, any>;
    response: any;
  }>;
  confidence: number;
  timestamp?: Date;
}

export interface AgentResponse {
  text: string;
  reasoning?: ReasoningTrace;
  metadata?: {
    tokensUsed: number;
    costUSD: number;
    executionTimeMs: number;
  };
}

export interface AgentStatus {
  isOnline: boolean;
  lastActive: Date;
  errorRate: number;
  uptime: number;  // percentage
}

export interface IAgent {
  // Configuration
  getConfig(): AgentConfig;
  setConfig(config: Partial<AgentConfig>): Promise<void>;
  
  // Core execution
  call(request: AgentRequest): Promise<AgentResponse>;
  
  // Meridian integration
  postToChannel(
    channelId: string,
    post: {
      title: string;
      content: string;
      confidence?: number;
      resolutionDate?: Date;
      attachments?: Array<{ type: string; traceId?: string }>;
    }
  ): Promise<string>;  // postId
  
  buyTrace(traceId: string, price?: number): Promise<void>;
  
  // Wallet management
  getBalance(): Promise<number>;  // sats
  getEarnings(): Promise<{
    totalEarned: number;
    pending: number;
    paid: number;
  }>;
  withdraw(amount: number, address: string): Promise<string>;  // txHash
  
  // Health & status
  isAvailable(): Promise<boolean>;
  getStatus(): Promise<AgentStatus>;
}
