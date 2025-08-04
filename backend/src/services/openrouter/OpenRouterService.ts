/**
 * OpenRouter Service Orchestrator
 * Main service that coordinates all OpenRouter functionality
 */

import { EventEmitter } from 'events';
import { Pool } from 'pg';
import Redis from 'ioredis';
import cron from 'node-cron';
import { logger } from '../../utils/logger';
import { OpenRouterClient } from './OpenRouterClient';
import { SettingsService } from './SettingsService';
import { SummarizationService } from './SummarizationService';
import {
  OpenRouterSettings,
  SummarizationRequest,
  SummarizationResponse,
  BatchJob,
  ServiceHealth,
  OpenRouterModel,
  UsageRecord
} from '../../types/openrouter';

export class OpenRouterService extends EventEmitter {
  private db: Pool;
  private redis: Redis;
  private settingsService: SettingsService;
  private summarizationService: SummarizationService;
  private clients = new Map<string, OpenRouterClient>();
  private healthStatus: ServiceHealth;
  private cronJobs: cron.ScheduledTask[] = [];

  constructor(db: Pool, redis: Redis) {
    super();
    this.db = db;
    this.redis = redis;
    this.settingsService = new SettingsService(db, redis);
    
    // Initialize health status
    this.healthStatus = {
      status: 'healthy',
      checks: {
        openrouter_api: false,
        database_connection: false,
        redis_connection: false,
        rate_limiter: false
      },
      metrics: {
        active_users: 0,
        requests_per_minute: 0,
        average_response_time: 0,
        error_rate: 0,
        cost_per_hour: 0
      },
      last_updated: new Date()
    };

    this.initializeServices();
    this.setupHealthChecks();
    this.setupCronJobs();
  }

  private initializeServices(): void {
    // Create a default client for health checks and model fetching
    const defaultClient = new OpenRouterClient({
      apiKey: process.env.OPENROUTER_API_KEY || 'default',
      timeout: 30000,
      retryAttempts: 3
    });

    this.clients.set('default', defaultClient);

    // Initialize summarization service with default client
    this.summarizationService = new SummarizationService(
      defaultClient,
      this.settingsService,
      this.db,
      this.redis
    );

    // Forward events from services
    this.summarizationService.on('rateLimitWarning', (info) => {
      this.emit('rateLimitWarning', info);
    });

    this.summarizationService.on('costAlert', (info) => {
      this.emit('costAlert', info);
    });

    logger.info('OpenRouter services initialized');
  }

  /**
   * Get or create OpenRouter client for a specific user
   */
  private async getUserClient(userId: string): Promise<OpenRouterClient> {
    // Check if client already exists
    if (this.clients.has(userId)) {
      return this.clients.get(userId)!;
    }

    // Get user's API key
    const apiKey = await this.settingsService.getApiKey(userId);
    if (!apiKey) {
      throw new Error('No OpenRouter API key configured for user');
    }

    // Get user settings for client configuration
    const settings = await this.settingsService.getSettings(userId);
    
    const client = new OpenRouterClient({
      apiKey,
      timeout: 30000,
      retryAttempts: 3,
      rateLimiting: {
        requestsPerMinute: settings?.usage_limits?.requests_per_hour || 60,
        tokensPerMinute: settings?.usage_limits?.tokens_per_hour || 100000
      },
      costManagement: {
        maxCostPerRequest: 1.0,
        dailyCostLimit: settings?.usage_limits?.daily_cost_limit || 10.0
      }
    });

    // Set up event forwarding
    client.on('rateLimitWarning', (info) => {
      this.emit('rateLimitWarning', { userId, ...info });
    });

    client.on('costAlert', (info) => {
      this.emit('costAlert', { userId, ...info });
    });

    client.on('error', (error) => {
      logger.error('OpenRouter client error', { userId, error });
    });

    this.clients.set(userId, client);
    
    // Clean up client after inactivity (1 hour)
    setTimeout(() => {
      this.clients.delete(userId);
    }, 3600000);

    return client;
  }

  /**
   * Initialize user settings with defaults
   */
  async initializeUser(userId: string, apiKey?: string): Promise<OpenRouterSettings> {
    try {
      const existingSettings = await this.settingsService.getSettings(userId);
      
      if (existingSettings && !apiKey) {
        return existingSettings;
      }

      // Create default settings
      const defaultSettings = await this.settingsService.createDefaultSettings(userId);

      // Update with API key if provided
      if (apiKey) {
        return await this.settingsService.saveSettings(userId, {
          ...defaultSettings,
          api_key_encrypted: apiKey
        });
      }

      logger.info('User initialized with OpenRouter', { userId });
      return defaultSettings;
    } catch (error) {
      logger.error('Failed to initialize user', { userId, error });
      throw new Error('Failed to initialize user settings');
    }
  }

  /**
   * Update user settings
   */
  async updateSettings(
    userId: string,
    settings: Partial<OpenRouterSettings>
  ): Promise<OpenRouterSettings> {
    try {
      const updatedSettings = await this.settingsService.saveSettings(userId, settings);
      
      // Invalidate cached client if API key changed
      if (settings.api_key_encrypted) {
        this.clients.delete(userId);
      }

      logger.info('OpenRouter settings updated', { userId });
      return updatedSettings;
    } catch (error) {
      logger.error('Failed to update settings', { userId, error });
      throw error;
    }
  }

  /**
   * Get user settings
   */
  async getSettings(userId: string): Promise<OpenRouterSettings | null> {
    return this.settingsService.getSettings(userId);
  }

  /**
   * Delete user data
   */
  async deleteUser(userId: string): Promise<boolean> {
    try {
      // Remove client from cache
      this.clients.delete(userId);
      
      // Delete settings and usage data
      const deleted = await this.settingsService.deleteSettings(userId);
      
      if (deleted) {
        logger.info('User data deleted', { userId });
      }
      
      return deleted;
    } catch (error) {
      logger.error('Failed to delete user', { userId, error });
      return false;
    }
  }

  /**
   * Summarize articles for a user
   */
  async summarizeArticles(
    userId: string,
    request: SummarizationRequest
  ): Promise<SummarizationResponse> {
    try {
      // Ensure user has valid client
      await this.getUserClient(userId);
      
      return await this.summarizationService.summarizeArticles(userId, request);
    } catch (error) {
      logger.error('Summarization failed', { userId, error });
      throw error;
    }
  }

  /**
   * Create batch summarization job
   */
  async createBatchSummarizationJob(
    userId: string,
    request: SummarizationRequest
  ): Promise<BatchJob> {
    try {
      await this.getUserClient(userId);
      return await this.summarizationService.createBatchJob(userId, request);
    } catch (error) {
      logger.error('Failed to create batch job', { userId, error });
      throw error;
    }
  }

  /**
   * Get batch job status
   */
  async getBatchJobStatus(jobId: string): Promise<BatchJob | null> {
    return this.summarizationService.getBatchJobStatus(jobId);
  }

  /**
   * Get available models
   */
  async getAvailableModels(useCache = true): Promise<OpenRouterModel[]> {
    try {
      const cacheKey = 'openrouter:models';
      
      if (useCache) {
        const cached = await this.redis.get(cacheKey);
        if (cached) {
          return JSON.parse(cached);
        }
      }

      const defaultClient = this.clients.get('default')!;
      const models = await defaultClient.getModels();
      
      // Cache for 1 hour
      await this.redis.setex(cacheKey, 3600, JSON.stringify(models));
      
      return models;
    } catch (error) {
      logger.error('Failed to get available models', error);
      throw new Error('Failed to retrieve available models');
    }
  }

  /**
   * Get model information
   */
  async getModelInfo(modelId: string): Promise<OpenRouterModel> {
    try {
      const cacheKey = `openrouter:model:${modelId}`;
      const cached = await this.redis.get(cacheKey);
      
      if (cached) {
        return JSON.parse(cached);
      }

      const defaultClient = this.clients.get('default')!;
      const model = await defaultClient.getModel(modelId);
      
      // Cache for 1 hour
      await this.redis.setex(cacheKey, 3600, JSON.stringify(model));
      
      return model;
    } catch (error) {
      logger.error('Failed to get model info', { modelId, error });
      throw new Error('Failed to retrieve model information');
    }
  }

  /**
   * Get usage statistics for a user
   */
  async getUserUsageStats(
    userId: string,
    period: 'daily' | 'weekly' | 'monthly' = 'daily'
  ): Promise<any> {
    return this.settingsService.getUsageStats(userId, period);
  }

  /**
   * Check usage limits for a user
   */
  async checkUserLimits(userId: string): Promise<any> {
    return this.settingsService.checkUsageLimits(userId);
  }

  /**
   * Get service health status
   */
  getHealthStatus(): ServiceHealth {
    return { ...this.healthStatus };
  }

  /**
   * Force health check update
   */
  async updateHealthStatus(): Promise<ServiceHealth> {
    const startTime = Date.now();
    
    try {
      // Check database connection
      await this.db.query('SELECT 1');
      this.healthStatus.checks.database_connection = true;
    } catch (error) {
      this.healthStatus.checks.database_connection = false;
      logger.error('Database health check failed', error);
    }

    try {
      // Check Redis connection
      await this.redis.ping();
      this.healthStatus.checks.redis_connection = true;
    } catch (error) {
      this.healthStatus.checks.redis_connection = false;
      logger.error('Redis health check failed', error);
    }

    try {
      // Check OpenRouter API
      const defaultClient = this.clients.get('default')!;
      this.healthStatus.checks.openrouter_api = await defaultClient.checkHealth();
    } catch (error) {
      this.healthStatus.checks.openrouter_api = false;
      logger.error('OpenRouter API health check failed', error);
    }

    // Update metrics
    await this.updateMetrics();

    // Determine overall status
    const healthyChecks = Object.values(this.healthStatus.checks).filter(Boolean).length;
    const totalChecks = Object.keys(this.healthStatus.checks).length;
    
    if (healthyChecks === totalChecks) {
      this.healthStatus.status = 'healthy';
    } else if (healthyChecks >= totalChecks / 2) {
      this.healthStatus.status = 'degraded';
    } else {
      this.healthStatus.status = 'unhealthy';
    }

    this.healthStatus.last_updated = new Date();
    
    const checkTime = Date.now() - startTime;
    logger.debug('Health check completed', { 
      status: this.healthStatus.status, 
      duration: checkTime 
    });

    return this.healthStatus;
  }

  /**
   * Get active user clients
   */
  getActiveClients(): { userId: string; queueLength: number; rateLimitInfo: any }[] {
    return Array.from(this.clients.entries())
      .filter(([userId]) => userId !== 'default')
      .map(([userId, client]) => ({
        userId,
        queueLength: client.getQueueStatus().length,
        rateLimitInfo: client.getRateLimitInfo()
      }));
  }

  /**
   * Emergency stop all processing
   */
  emergencyStop(): void {
    logger.warn('Emergency stop initiated - clearing all queues');
    
    this.clients.forEach((client, userId) => {
      if (userId !== 'default') {
        client.clearQueue();
      }
    });

    this.emit('emergencyStop');
  }

  /**
   * Setup health monitoring
   */
  private setupHealthChecks(): void {
    // Run health check every 5 minutes
    const healthCheckJob = cron.schedule('*/5 * * * *', async () => {
      try {
        await this.updateHealthStatus();
      } catch (error) {
        logger.error('Scheduled health check failed', error);
      }
    });

    this.cronJobs.push(healthCheckJob);
    logger.info('Health check monitoring setup complete');
  }

  /**
   * Setup cron jobs for maintenance
   */
  private setupCronJobs(): void {
    // Clean up old usage records (runs daily at 2 AM)
    const cleanupJob = cron.schedule('0 2 * * *', async () => {
      try {
        await this.cleanupOldRecords();
      } catch (error) {
        logger.error('Cleanup job failed', error);
      }
    });

    // Update model cache (runs every 6 hours)
    const modelCacheJob = cron.schedule('0 */6 * * *', async () => {
      try {
        await this.getAvailableModels(false); // Force refresh
        logger.info('Model cache updated');
      } catch (error) {
        logger.error('Model cache update failed', error);
      }
    });

    this.cronJobs.push(cleanupJob, modelCacheJob);
    logger.info('Maintenance cron jobs setup complete');
  }

  /**
   * Update service metrics
   */
  private async updateMetrics(): Promise<void> {
    try {
      // Get active users count
      this.healthStatus.metrics.active_users = this.clients.size - 1; // Exclude default client

      // Get requests per minute from Redis (if tracking)
      const rpm = await this.redis.zcard('rate_limit:global') || 0;
      this.healthStatus.metrics.requests_per_minute = rpm;

      // These would need actual implementation based on your monitoring setup
      this.healthStatus.metrics.average_response_time = 500; // placeholder
      this.healthStatus.metrics.error_rate = 0.01; // placeholder
      this.healthStatus.metrics.cost_per_hour = 0.05; // placeholder

    } catch (error) {
      logger.error('Failed to update metrics', error);
    }
  }

  /**
   * Clean up old records for maintenance
   */
  private async cleanupOldRecords(): Promise<void> {
    const client = await this.db.connect();
    
    try {
      // Delete usage records older than 90 days
      const usageResult = await client.query(
        'DELETE FROM openrouter_usage WHERE timestamp < NOW() - INTERVAL \'90 days\''
      );

      // Delete completed batch jobs older than 30 days
      const jobsResult = await client.query(
        'DELETE FROM batch_jobs WHERE status = $1 AND updated_at < NOW() - INTERVAL \'30 days\'',
        ['completed']
      );

      logger.info('Cleanup completed', {
        usageRecordsDeleted: usageResult.rowCount,
        batchJobsDeleted: jobsResult.rowCount
      });

    } catch (error) {
      logger.error('Cleanup failed', error);
    } finally {
      client.release();
    }
  }

  /**
   * Shutdown service gracefully
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down OpenRouter service...');

    // Stop cron jobs
    this.cronJobs.forEach(job => job.destroy());

    // Clear all client queues
    this.clients.forEach(client => client.clearQueue());

    // Clear clients
    this.clients.clear();

    logger.info('OpenRouter service shutdown complete');
  }
}