/**
 * OpenRouter Settings Management Service
 * Handles secure storage and management of OpenRouter settings and preferences
 */

import { Pool } from 'pg';
import CryptoJS from 'crypto-js';
import Redis from 'ioredis';
import { logger } from '../../utils/logger';
import { OpenRouterSettings, UsageRecord } from '../../types/openrouter';

export class SettingsService {
  private db: Pool;
  private redis: Redis;
  private encryptionKey: string;

  constructor(db: Pool, redis: Redis) {
    this.db = db;
    this.redis = redis;
    this.encryptionKey = process.env.ENCRYPTION_KEY || 'default-key-change-in-production';
    
    if (this.encryptionKey === 'default-key-change-in-production') {
      logger.warn('Using default encryption key - change in production!');
    }
  }

  /**
   * Encrypt sensitive data
   */
  private encrypt(text: string): string {
    try {
      return CryptoJS.AES.encrypt(text, this.encryptionKey).toString();
    } catch (error) {
      logger.error('Encryption failed', error);
      throw new Error('Failed to encrypt data');
    }
  }

  /**
   * Decrypt sensitive data
   */
  private decrypt(encryptedText: string): string {
    try {
      const bytes = CryptoJS.AES.decrypt(encryptedText, this.encryptionKey);
      return bytes.toString(CryptoJS.enc.Utf8);
    } catch (error) {
      logger.error('Decryption failed', error);
      throw new Error('Failed to decrypt data');
    }
  }

  /**
   * Store or update OpenRouter settings for a user
   */
  async saveSettings(userId: string, settings: Partial<OpenRouterSettings>): Promise<OpenRouterSettings> {
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');

      // Encrypt API key if provided
      let apiKeyEncrypted = settings.api_key_encrypted;
      if (settings.api_key_encrypted && !settings.api_key_encrypted.startsWith('U2FsdGVkX1')) {
        // Assume it's plain text and needs encryption
        apiKeyEncrypted = this.encrypt(settings.api_key_encrypted);
      }

      const query = `
        INSERT INTO openrouter_settings (
          user_id, api_key_encrypted, preferred_models, usage_limits, 
          preferences, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
        ON CONFLICT (user_id) 
        DO UPDATE SET
          api_key_encrypted = COALESCE($2, openrouter_settings.api_key_encrypted),
          preferred_models = COALESCE($3, openrouter_settings.preferred_models),
          usage_limits = COALESCE($4, openrouter_settings.usage_limits),
          preferences = COALESCE($5, openrouter_settings.preferences),
          updated_at = NOW()
        RETURNING *
      `;

      const result = await client.query(query, [
        userId,
        apiKeyEncrypted,
        settings.preferred_models ? JSON.stringify(settings.preferred_models) : null,
        settings.usage_limits ? JSON.stringify(settings.usage_limits) : null,
        settings.preferences ? JSON.stringify(settings.preferences) : null
      ]);

      await client.query('COMMIT');

      // Cache the settings (without API key)
      const settingsToCache = { ...result.rows[0] };
      delete settingsToCache.api_key_encrypted;
      await this.redis.setex(`openrouter_settings:${userId}`, 3600, JSON.stringify(settingsToCache));

      logger.info('OpenRouter settings saved', { userId });

      return this.formatSettings(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to save OpenRouter settings', { userId, error });
      throw new Error('Failed to save settings');
    } finally {
      client.release();
    }
  }

  /**
   * Retrieve OpenRouter settings for a user
   */
  async getSettings(userId: string, includeApiKey = false): Promise<OpenRouterSettings | null> {
    try {
      // Try cache first (without API key)
      if (!includeApiKey) {
        const cached = await this.redis.get(`openrouter_settings:${userId}`);
        if (cached) {
          return JSON.parse(cached);
        }
      }

      const query = 'SELECT * FROM openrouter_settings WHERE user_id = $1';
      const result = await this.db.query(query, [userId]);

      if (result.rows.length === 0) {
        return null;
      }

      const settings = this.formatSettings(result.rows[0]);

      // Cache settings without API key
      if (!includeApiKey) {
        const settingsToCache = { ...settings };
        delete (settingsToCache as any).api_key_encrypted;
        await this.redis.setex(`openrouter_settings:${userId}`, 3600, JSON.stringify(settingsToCache));
      }

      return settings;
    } catch (error) {
      logger.error('Failed to retrieve OpenRouter settings', { userId, error });
      throw new Error('Failed to retrieve settings');
    }
  }

  /**
   * Get decrypted API key for a user
   */
  async getApiKey(userId: string): Promise<string | null> {
    try {
      const query = 'SELECT api_key_encrypted FROM openrouter_settings WHERE user_id = $1';
      const result = await this.db.query(query, [userId]);

      if (result.rows.length === 0 || !result.rows[0].api_key_encrypted) {
        return null;
      }

      return this.decrypt(result.rows[0].api_key_encrypted);
    } catch (error) {
      logger.error('Failed to retrieve API key', { userId, error });
      throw new Error('Failed to retrieve API key');
    }
  }

  /**
   * Delete OpenRouter settings for a user
   */
  async deleteSettings(userId: string): Promise<boolean> {
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');

      // Delete settings
      await client.query('DELETE FROM openrouter_settings WHERE user_id = $1', [userId]);

      // Delete related usage records (optional - you might want to keep for billing)
      await client.query(
        'DELETE FROM openrouter_usage WHERE user_id = $1 AND timestamp < NOW() - INTERVAL \'30 days\'',
        [userId]
      );

      await client.query('COMMIT');

      // Clear cache
      await this.redis.del(`openrouter_settings:${userId}`);
      await this.redis.del(`usage_stats:${userId}:*`);

      logger.info('OpenRouter settings deleted', { userId });
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to delete OpenRouter settings', { userId, error });
      return false;
    } finally {
      client.release();
    }
  }

  /**
   * Record usage for billing and monitoring
   */
  async recordUsage(usage: Omit<UsageRecord, 'id' | 'timestamp'>): Promise<UsageRecord> {
    try {
      const query = `
        INSERT INTO openrouter_usage (
          user_id, model, prompt_tokens, completion_tokens, total_tokens,
          cost, request_type, metadata, timestamp
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        RETURNING *
      `;

      const result = await this.db.query(query, [
        usage.user_id,
        usage.model,
        usage.prompt_tokens,
        usage.completion_tokens,
        usage.total_tokens,
        usage.cost,
        usage.request_type,
        usage.metadata ? JSON.stringify(usage.metadata) : null
      ]);

      const usageRecord = result.rows[0];

      // Update cached usage stats
      await this.updateUsageCache(usage.user_id, usage.cost);

      logger.debug('Usage recorded', { 
        userId: usage.user_id, 
        model: usage.model, 
        cost: usage.cost 
      });

      return usageRecord;
    } catch (error) {
      logger.error('Failed to record usage', { usage, error });
      throw new Error('Failed to record usage');
    }
  }

  /**
   * Get usage statistics for a user
   */
  async getUsageStats(
    userId: string, 
    period: 'daily' | 'weekly' | 'monthly' = 'daily'
  ): Promise<{
    total_requests: number;
    total_tokens: number;
    total_cost: number;
    by_model: Record<string, { requests: number; tokens: number; cost: number }>;
    period_start: Date;
    period_end: Date;
  }> {
    try {
      const cacheKey = `usage_stats:${userId}:${period}`;
      const cached = await this.redis.get(cacheKey);
      
      if (cached) {
        return JSON.parse(cached);
      }

      let interval = '1 day';
      if (period === 'weekly') interval = '7 days';
      if (period === 'monthly') interval = '30 days';

      const query = `
        SELECT 
          COUNT(*) as total_requests,
          SUM(total_tokens) as total_tokens,
          SUM(cost) as total_cost,
          model,
          COUNT(*) as model_requests,
          SUM(total_tokens) as model_tokens,
          SUM(cost) as model_cost
        FROM openrouter_usage 
        WHERE user_id = $1 
          AND timestamp >= NOW() - INTERVAL '${interval}'
        GROUP BY model
      `;

      const result = await this.db.query(query, [userId]);

      const stats = {
        total_requests: 0,
        total_tokens: 0,
        total_cost: 0,
        by_model: {} as Record<string, { requests: number; tokens: number; cost: number }>,
        period_start: new Date(Date.now() - this.getPeriodMs(period)),
        period_end: new Date()
      };

      result.rows.forEach(row => {
        stats.total_requests += parseInt(row.total_requests || '0');
        stats.total_tokens += parseInt(row.total_tokens || '0');
        stats.total_cost += parseFloat(row.total_cost || '0');

        if (row.model) {
          stats.by_model[row.model] = {
            requests: parseInt(row.model_requests || '0'),
            tokens: parseInt(row.model_tokens || '0'),
            cost: parseFloat(row.model_cost || '0')
          };
        }
      });

      // Cache for 5 minutes
      await this.redis.setex(cacheKey, 300, JSON.stringify(stats));

      return stats;
    } catch (error) {
      logger.error('Failed to get usage stats', { userId, period, error });
      throw new Error('Failed to get usage statistics');
    }
  }

  /**
   * Check if user has exceeded usage limits
   */
  async checkUsageLimits(userId: string): Promise<{
    within_limits: boolean;
    daily_cost_exceeded: boolean;
    monthly_cost_exceeded: boolean;
    hourly_requests_exceeded: boolean;
    hourly_tokens_exceeded: boolean;
    current_usage: any;
  }> {
    try {
      const settings = await this.getSettings(userId);
      if (!settings?.usage_limits) {
        return {
          within_limits: true,
          daily_cost_exceeded: false,
          monthly_cost_exceeded: false,
          hourly_requests_exceeded: false,
          hourly_tokens_exceeded: false,
          current_usage: null
        };
      }

      const [dailyStats, monthlyStats, hourlyStats] = await Promise.all([
        this.getUsageStats(userId, 'daily'),
        this.getUsageStats(userId, 'monthly'),
        this.getHourlyUsage(userId)
      ]);

      const limits = settings.usage_limits;
      const dailyCostExceeded = dailyStats.total_cost >= limits.daily_cost_limit;
      const monthlyCostExceeded = monthlyStats.total_cost >= limits.monthly_cost_limit;
      const hourlyRequestsExceeded = hourlyStats.requests >= limits.requests_per_hour;
      const hourlyTokensExceeded = hourlyStats.tokens >= limits.tokens_per_hour;

      return {
        within_limits: !dailyCostExceeded && !monthlyCostExceeded && 
                      !hourlyRequestsExceeded && !hourlyTokensExceeded,
        daily_cost_exceeded: dailyCostExceeded,
        monthly_cost_exceeded: monthlyCostExceeded,
        hourly_requests_exceeded: hourlyRequestsExceeded,
        hourly_tokens_exceeded: hourlyTokensExceeded,
        current_usage: {
          daily: dailyStats,
          monthly: monthlyStats,
          hourly: hourlyStats
        }
      };
    } catch (error) {
      logger.error('Failed to check usage limits', { userId, error });
      throw new Error('Failed to check usage limits');
    }
  }

  /**
   * Update default settings for new users
   */
  async createDefaultSettings(userId: string): Promise<OpenRouterSettings> {
    const defaultSettings: Partial<OpenRouterSettings> = {
      preferred_models: {
        summarization: 'anthropic/claude-3-haiku',
        chat: 'openai/gpt-4o-mini',
        fallback: 'meta-llama/llama-3.1-8b-instruct:free'
      },
      usage_limits: {
        daily_cost_limit: 1.0,
        monthly_cost_limit: 10.0,
        requests_per_hour: 100,
        tokens_per_hour: 50000
      },
      preferences: {
        temperature: 0.7,
        max_tokens: 1000,
        enable_streaming: false,
        fallback_enabled: true,
        cost_optimization: true
      }
    };

    return this.saveSettings(userId, defaultSettings);
  }

  /**
   * Format database row to OpenRouterSettings interface
   */
  private formatSettings(row: any): OpenRouterSettings {
    return {
      user_id: row.user_id,
      api_key_encrypted: row.api_key_encrypted,
      preferred_models: typeof row.preferred_models === 'string' 
        ? JSON.parse(row.preferred_models) 
        : row.preferred_models,
      usage_limits: typeof row.usage_limits === 'string'
        ? JSON.parse(row.usage_limits)
        : row.usage_limits,
      preferences: typeof row.preferences === 'string'
        ? JSON.parse(row.preferences)
        : row.preferences,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  /**
   * Update usage cache for quick access
   */
  private async updateUsageCache(userId: string, cost: number): Promise<void> {
    try {
      const today = new Date().toISOString().split('T')[0];
      const cacheKey = `daily_usage:${userId}:${today}`;
      
      await this.redis.pipeline()
        .incrbyfloat(cacheKey, cost)
        .expire(cacheKey, 86400) // 24 hours
        .exec();
    } catch (error) {
      logger.warn('Failed to update usage cache', { userId, error });
    }
  }

  /**
   * Get hourly usage for rate limiting
   */
  private async getHourlyUsage(userId: string): Promise<{ requests: number; tokens: number }> {
    try {
      const query = `
        SELECT COUNT(*) as requests, SUM(total_tokens) as tokens
        FROM openrouter_usage 
        WHERE user_id = $1 AND timestamp >= NOW() - INTERVAL '1 hour'
      `;

      const result = await this.db.query(query, [userId]);
      const row = result.rows[0];

      return {
        requests: parseInt(row.requests || '0'),
        tokens: parseInt(row.tokens || '0')
      };
    } catch (error) {
      logger.error('Failed to get hourly usage', { userId, error });
      return { requests: 0, tokens: 0 };
    }
  }

  /**
   * Get period in milliseconds
   */
  private getPeriodMs(period: 'daily' | 'weekly' | 'monthly'): number {
    switch (period) {
      case 'daily': return 24 * 60 * 60 * 1000;
      case 'weekly': return 7 * 24 * 60 * 60 * 1000;
      case 'monthly': return 30 * 24 * 60 * 60 * 1000;
      default: return 24 * 60 * 60 * 1000;
    }
  }
}