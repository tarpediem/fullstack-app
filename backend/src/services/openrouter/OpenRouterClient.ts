/**
 * OpenRouter API Client
 * Comprehensive client for OpenRouter API integration with advanced features
 */

import axios, { AxiosInstance, AxiosResponse, AxiosError } from 'axios';
import { EventEmitter } from 'events';
import { logger } from '../../utils/logger';
import {
  OpenRouterModel,
  OpenRouterChatRequest,
  OpenRouterChatResponse,
  OpenRouterError,
  OpenRouterClientConfig,
  RateLimitInfo,
  CostEstimate,
  ErrorLog
} from '../../types/openrouter';

export class OpenRouterClient extends EventEmitter {
  private client: AxiosInstance;
  private config: OpenRouterClientConfig;
  private rateLimitInfo: RateLimitInfo | null = null;
  private requestQueue: Array<{ resolve: Function; reject: Function; request: () => Promise<any> }> = [];
  private isProcessingQueue = false;
  private dailyCostUsed = 0;
  private lastResetDate = new Date().toDateString();

  constructor(config: OpenRouterClientConfig) {
    super();
    this.config = {
      baseURL: 'https://openrouter.ai/api/v1',
      timeout: 30000,
      retryAttempts: 3,
      retryDelay: 1000,
      rateLimiting: {
        requestsPerMinute: 60,
        tokensPerMinute: 100000
      },
      costManagement: {
        maxCostPerRequest: 1.0,
        dailyCostLimit: 10.0
      },
      ...config
    };

    this.client = axios.create({
      baseURL: this.config.baseURL,
      timeout: this.config.timeout,
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'HTTP-Referer': process.env.OPENROUTER_REFERER || 'http://localhost:3000',
        'X-Title': process.env.OPENROUTER_TITLE || 'AI News Aggregator',
        'Content-Type': 'application/json'
      }
    });

    this.setupInterceptors();
    this.startQueueProcessor();
  }

  private setupInterceptors(): void {
    // Request interceptor for logging and validation
    this.client.interceptors.request.use(
      (config) => {
        logger.debug('OpenRouter API Request', {
          url: config.url,
          method: config.method,
          headers: { ...config.headers, Authorization: '[REDACTED]' }
        });
        return config;
      },
      (error) => {
        logger.error('OpenRouter Request Error', error);
        return Promise.reject(error);
      }
    );

    // Response interceptor for rate limiting and error handling
    this.client.interceptors.response.use(
      (response: AxiosResponse) => {
        this.updateRateLimitInfo(response.headers);
        this.updateCostTracking(response.data);
        
        logger.debug('OpenRouter API Response', {
          status: response.status,
          usage: response.data?.usage,
          model: response.data?.model
        });

        return response;
      },
      async (error: AxiosError) => {
        await this.handleApiError(error);
        return Promise.reject(error);
      }
    );
  }

  private updateRateLimitInfo(headers: any): void {
    if (headers['x-ratelimit-limit-requests']) {
      this.rateLimitInfo = {
        requests_remaining: parseInt(headers['x-ratelimit-remaining-requests'] || '0'),
        requests_limit: parseInt(headers['x-ratelimit-limit-requests'] || '0'),
        tokens_remaining: parseInt(headers['x-ratelimit-remaining-tokens'] || '0'),
        tokens_limit: parseInt(headers['x-ratelimit-limit-tokens'] || '0'),
        reset_time: new Date(headers['x-ratelimit-reset-requests'] || Date.now())
      };

      // Emit rate limit warnings
      if (this.rateLimitInfo.requests_remaining < 10) {
        this.emit('rateLimitWarning', this.rateLimitInfo);
      }
    }
  }

  private updateCostTracking(responseData: any): void {
    if (responseData?.usage) {
      const currentDate = new Date().toDateString();
      if (currentDate !== this.lastResetDate) {
        this.dailyCostUsed = 0;
        this.lastResetDate = currentDate;
      }

      // This would need actual cost calculation based on model pricing
      // For now, using a rough estimate
      const estimatedCost = (responseData.usage.total_tokens || 0) * 0.00001;
      this.dailyCostUsed += estimatedCost;

      if (this.dailyCostUsed > this.config.costManagement!.dailyCostLimit * 0.9) {
        this.emit('costAlert', {
          dailyCostUsed: this.dailyCostUsed,
          limit: this.config.costManagement!.dailyCostLimit
        });
      }
    }
  }

  private async handleApiError(error: AxiosError): Promise<void> {
    const errorLog: Partial<ErrorLog> = {
      error_type: 'api_error',
      error_message: error.message,
      timestamp: new Date(),
      retry_count: 0,
      resolved: false
    };

    if (error.response?.status === 429) {
      errorLog.error_type = 'rate_limit';
      logger.warn('OpenRouter rate limit exceeded', {
        status: error.response.status,
        headers: error.response.headers
      });
    } else if (error.response?.status === 402) {
      errorLog.error_type = 'cost_limit';
      logger.error('OpenRouter insufficient credits', {
        status: error.response.status,
        data: error.response.data
      });
    } else if (error.code === 'ECONNABORTED') {
      errorLog.error_type = 'network_error';
      logger.error('OpenRouter request timeout', { timeout: this.config.timeout });
    }

    this.emit('error', errorLog);
  }

  private startQueueProcessor(): void {
    setInterval(() => {
      if (!this.isProcessingQueue && this.requestQueue.length > 0) {
        this.processQueue();
      }
    }, 1000);
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.requestQueue.length === 0) return;

    this.isProcessingQueue = true;

    try {
      while (this.requestQueue.length > 0) {
        // Check rate limits before processing
        if (this.rateLimitInfo && this.rateLimitInfo.requests_remaining <= 1) {
          const waitTime = this.rateLimitInfo.reset_time.getTime() - Date.now();
          if (waitTime > 0) {
            logger.info(`Rate limit reached, waiting ${waitTime}ms`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
          }
        }

        const { resolve, reject, request } = this.requestQueue.shift()!;
        
        try {
          const result = await request();
          resolve(result);
        } catch (error) {
          reject(error);
        }

        // Add delay between requests to respect rate limits
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  private async executeWithRetry<T>(
    request: () => Promise<T>,
    maxRetries: number = this.config.retryAttempts!
  ): Promise<T> {
    let lastError: Error;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await request();
      } catch (error) {
        lastError = error as Error;
        
        if (attempt === maxRetries) break;

        // Don't retry on certain errors
        if (error instanceof AxiosError) {
          if (error.response?.status === 400 || error.response?.status === 401) {
            break;
          }
        }

        const delay = this.config.retryDelay! * Math.pow(2, attempt - 1);
        logger.warn(`OpenRouter request failed, retrying in ${delay}ms`, {
          attempt,
          error: error instanceof Error ? error.message : 'Unknown error'
        });

        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError!;
  }

  /**
   * Get all available models from OpenRouter
   */
  async getModels(): Promise<OpenRouterModel[]> {
    return this.executeWithRetry(async () => {
      const response = await this.client.get<{ data: OpenRouterModel[] }>('/models');
      return response.data.data;
    });
  }

  /**
   * Get specific model information
   */
  async getModel(modelId: string): Promise<OpenRouterModel> {
    return this.executeWithRetry(async () => {
      const response = await this.client.get<OpenRouterModel>(`/models/${modelId}`);
      return response.data;
    });
  }

  /**
   * Create a chat completion
   */
  async createChatCompletion(request: OpenRouterChatRequest): Promise<OpenRouterChatResponse> {
    // Validate request
    await this.validateRequest(request);

    // Estimate cost
    const costEstimate = await this.estimateCost(request);
    if (costEstimate.estimated_cost > this.config.costManagement!.maxCostPerRequest) {
      throw new Error(`Estimated cost ($${costEstimate.estimated_cost.toFixed(4)}) exceeds maximum per request ($${this.config.costManagement!.maxCostPerRequest})`);
    }

    return new Promise((resolve, reject) => {
      this.requestQueue.push({
        resolve,
        reject,
        request: async () => {
          const response = await this.client.post<OpenRouterChatResponse>('/chat/completions', request);
          return response.data;
        }
      });
    });
  }

  /**
   * Create a streaming chat completion
   */
  async createStreamingChatCompletion(
    request: OpenRouterChatRequest,
    onChunk: (chunk: any) => void
  ): Promise<void> {
    await this.validateRequest(request);

    const streamRequest = { ...request, stream: true };

    return this.executeWithRetry(async () => {
      const response = await this.client.post('/chat/completions', streamRequest, {
        responseType: 'stream'
      });

      return new Promise<void>((resolve, reject) => {
        response.data.on('data', (chunk: Buffer) => {
          const lines = chunk.toString().split('\n');
          
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') {
                resolve();
                return;
              }
              
              try {
                const parsed = JSON.parse(data);
                onChunk(parsed);
              } catch (error) {
                // Ignore parsing errors for incomplete chunks
              }
            }
          }
        });

        response.data.on('error', reject);
        response.data.on('end', resolve);
      });
    });
  }

  /**
   * Estimate cost for a request
   */
  async estimateCost(request: OpenRouterChatRequest): Promise<CostEstimate> {
    try {
      const model = await this.getModel(request.model);
      
      // Rough token estimation (more sophisticated tokenization would be better)
      const promptText = request.messages.map(m => m.content).join(' ');
      const estimatedPromptTokens = Math.ceil(promptText.length / 3.5); // Rough estimate
      const estimatedCompletionTokens = request.max_tokens || 1000;

      const promptCost = estimatedPromptTokens * model.pricing.prompt;
      const completionCost = estimatedCompletionTokens * model.pricing.completion;

      return {
        estimated_prompt_tokens: estimatedPromptTokens,
        estimated_completion_tokens: estimatedCompletionTokens,
        estimated_cost: promptCost + completionCost,
        model_pricing: {
          prompt_price_per_token: model.pricing.prompt,
          completion_price_per_token: model.pricing.completion
        }
      };
    } catch (error) {
      logger.warn('Failed to estimate cost', { error, model: request.model });
      return {
        estimated_prompt_tokens: 1000,
        estimated_completion_tokens: request.max_tokens || 1000,
        estimated_cost: 0.01,
        model_pricing: {
          prompt_price_per_token: 0.000001,
          completion_price_per_token: 0.000002
        }
      };
    }
  }

  /**
   * Validate request parameters
   */
  private async validateRequest(request: OpenRouterChatRequest): Promise<void> {
    if (!request.model) {
      throw new Error('Model is required');
    }

    if (!request.messages || request.messages.length === 0) {
      throw new Error('Messages are required');
    }

    if (request.max_tokens && request.max_tokens > 100000) {
      throw new Error('Max tokens cannot exceed 100,000');
    }

    if (request.temperature && (request.temperature < 0 || request.temperature > 2)) {
      throw new Error('Temperature must be between 0 and 2');
    }

    // Check daily cost limit
    const costEstimate = await this.estimateCost(request);
    if (this.dailyCostUsed + costEstimate.estimated_cost > this.config.costManagement!.dailyCostLimit) {
      throw new Error(`Request would exceed daily cost limit ($${this.config.costManagement!.dailyCostLimit})`);
    }
  }

  /**
   * Get current rate limit status
   */
  getRateLimitInfo(): RateLimitInfo | null {
    return this.rateLimitInfo;
  }

  /**
   * Get daily cost usage
   */
  getDailyCostUsage(): { used: number; limit: number; remaining: number } {
    return {
      used: this.dailyCostUsed,
      limit: this.config.costManagement!.dailyCostLimit,
      remaining: this.config.costManagement!.dailyCostLimit - this.dailyCostUsed
    };
  }

  /**
   * Check service health
   */
  async checkHealth(): Promise<boolean> {
    try {
      await this.client.get('/models', { timeout: 5000 });
      return true;
    } catch (error) {
      logger.error('OpenRouter health check failed', error);
      return false;
    }
  }

  /**
   * Clear request queue (useful for testing or emergency stops)
   */
  clearQueue(): void {
    const queueLength = this.requestQueue.length;
    this.requestQueue.forEach(({ reject }) => {
      reject(new Error('Request cancelled due to queue clear'));
    });
    this.requestQueue = [];
    logger.info(`Cleared ${queueLength} requests from queue`);
  }

  /**
   * Get queue status
   */
  getQueueStatus(): { length: number; isProcessing: boolean } {
    return {
      length: this.requestQueue.length,
      isProcessing: this.isProcessingQueue
    };
  }
}