/**
 * OpenRouter API Types and Interfaces
 * Comprehensive type definitions for OpenRouter integration
 */

// OpenRouter Model Information
export interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  pricing: {
    prompt: number;
    completion: number;
  };
  context_length: number;
  architecture: {
    modality: 'text' | 'multimodal' | 'image';
    tokenizer: string;
    instruct_type?: string;
  };
  top_provider: {
    context_length: number;
    max_completion_tokens?: number;
    is_moderated: boolean;
  };
  per_request_limits?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

// OpenRouter API Request/Response Types
export interface OpenRouterChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
}

export interface OpenRouterChatRequest {
  model: string;
  messages: OpenRouterChatMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
  seed?: number;
  stop?: string | string[];
  stream?: boolean;
  response_format?: {
    type: 'json_object' | 'text';
  };
  tools?: any[];
  tool_choice?: 'none' | 'auto' | object;
  transforms?: string[];
}

export interface OpenRouterChatResponse {
  id: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
      tool_calls?: any[];
    };
    finish_reason: 'stop' | 'length' | 'content_filter' | 'tool_calls';
    logprobs?: any;
  }>;
  created: number;
  model: string;
  object: string;
  system_fingerprint?: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenRouterError {
  error: {
    type: string;
    code: string;
    message: string;
    metadata?: {
      raw?: string;
      [key: string]: any;
    };
  };
}

// Usage and Cost Tracking
export interface UsageRecord {
  id: string;
  user_id: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost: number;
  timestamp: Date;
  request_type: 'chat' | 'completion' | 'summarization';
  metadata?: {
    article_count?: number;
    batch_size?: number;
    processing_time?: number;
    [key: string]: any;
  };
}

// User Settings and Preferences
export interface OpenRouterSettings {
  user_id: string;
  api_key_encrypted: string;
  preferred_models: {
    summarization: string;
    chat: string;
    fallback: string;
  };
  usage_limits: {
    daily_cost_limit: number;
    monthly_cost_limit: number;
    requests_per_hour: number;
    tokens_per_hour: number;
  };
  preferences: {
    temperature: number;
    max_tokens: number;
    enable_streaming: boolean;
    fallback_enabled: boolean;
    cost_optimization: boolean;
  };
  created_at: Date;
  updated_at: Date;
}

// Content Summarization Types
export interface SummarizationRequest {
  articles: Array<{
    id: string;
    title: string;
    content: string;
    url?: string;
    source?: string;
  }>;
  options: {
    model?: string;
    summary_length?: 'short' | 'medium' | 'long';
    summary_style?: 'bullet_points' | 'paragraph' | 'structured';
    language?: string;
    include_key_points?: boolean;
    include_sentiment?: boolean;
    batch_processing?: boolean;
  };
}

export interface SummarizationResponse {
  summaries: Array<{
    article_id: string;
    summary: string;
    key_points?: string[];
    sentiment?: {
      score: number;
      label: 'positive' | 'negative' | 'neutral';
      confidence: number;
    };
    metadata: {
      model_used: string;
      tokens_used: number;
      processing_time: number;
      cost: number;
    };
  }>;
  batch_metadata: {
    total_articles: number;
    successful_summaries: number;
    failed_summaries: number;
    total_cost: number;
    total_tokens: number;
    processing_time: number;
  };
}

// API Client Configuration
export interface OpenRouterClientConfig {
  apiKey: string;
  baseURL?: string;
  defaultModel?: string;
  timeout?: number;
  retryAttempts?: number;
  retryDelay?: number;
  rateLimiting?: {
    requestsPerMinute: number;
    tokensPerMinute: number;
  };
  costManagement?: {
    maxCostPerRequest: number;
    dailyCostLimit: number;
  };
}

// Rate Limiting and Cost Management
export interface RateLimitInfo {
  requests_remaining: number;
  requests_limit: number;
  tokens_remaining: number;
  tokens_limit: number;
  reset_time: Date;
}

export interface CostEstimate {
  estimated_prompt_tokens: number;
  estimated_completion_tokens: number;
  estimated_cost: number;
  model_pricing: {
    prompt_price_per_token: number;
    completion_price_per_token: number;
  };
}

// Batch Processing Types
export interface BatchJob {
  id: string;
  user_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  job_type: 'summarization' | 'chat' | 'analysis';
  input_data: any;
  output_data?: any;
  progress: {
    total_items: number;
    processed_items: number;
    failed_items: number;
    percentage: number;
  };
  metadata: {
    model_used?: string;
    estimated_cost?: number;
    actual_cost?: number;
    start_time?: Date;
    end_time?: Date;
    processing_time?: number;
  };
  created_at: Date;
  updated_at: Date;
}

// Model Selection and Optimization
export interface ModelSelectionCriteria {
  task_type: 'summarization' | 'chat' | 'analysis' | 'classification';
  content_length: number;
  quality_preference: 'speed' | 'quality' | 'cost';
  language?: string;
  budget_constraint?: number;
}

export interface ModelRecommendation {
  model: OpenRouterModel;
  score: number;
  reasoning: string;
  estimated_cost: number;
  estimated_time: number;
  fallback_models: string[];
}

// Error Handling and Monitoring
export interface ErrorLog {
  id: string;
  user_id?: string;
  error_type: 'api_error' | 'rate_limit' | 'cost_limit' | 'validation_error' | 'network_error';
  error_message: string;
  request_data?: any;
  response_data?: any;
  model_used?: string;
  timestamp: Date;
  retry_count: number;
  resolved: boolean;
}

// Service Health and Monitoring
export interface ServiceHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: {
    openrouter_api: boolean;
    database_connection: boolean;
    redis_connection: boolean;
    rate_limiter: boolean;
  };
  metrics: {
    active_users: number;
    requests_per_minute: number;
    average_response_time: number;
    error_rate: number;
    cost_per_hour: number;
  };
  last_updated: Date;
}

// WebSocket Real-time Updates
export interface RealtimeUpdate {
  type: 'job_progress' | 'cost_alert' | 'rate_limit_warning' | 'model_status';
  user_id: string;
  data: any;
  timestamp: Date;
}

export interface WebSocketMessage {
  event: string;
  data: RealtimeUpdate;
}