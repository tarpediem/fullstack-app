/**
 * Redis Configuration
 * Handles Redis connection and configuration for caching and rate limiting
 */

import Redis from 'ioredis';
import { logger } from '../utils/logger';

// Redis configuration
const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD,
  db: parseInt(process.env.REDIS_DB || '0'),
  retryDelayOnFailover: 100,
  maxRetriesPerRequest: 3,
  lazyConnect: true,
  showFriendlyErrorStack: process.env.NODE_ENV !== 'production',
  connectTimeout: 10000,
  commandTimeout: 5000,
};

// Create Redis instance
export const redis = new Redis(redisConfig);

// Connection event handlers
redis.on('connect', () => {
  logger.info('Redis connected', { 
    host: redisConfig.host, 
    port: redisConfig.port,
    db: redisConfig.db 
  });
});

redis.on('ready', () => {
  logger.info('Redis ready for commands');
});

redis.on('error', (error) => {
  logger.error('Redis connection error:', error);
});

redis.on('close', () => {
  logger.warn('Redis connection closed');
});

redis.on('reconnecting', () => {
  logger.info('Redis reconnecting...');
});

// Test Redis connection
export const testRedisConnection = async (): Promise<boolean> => {
  try {
    const pong = await redis.ping();
    if (pong === 'PONG') {
      logger.info('Redis connection successful');
      return true;
    } else {
      logger.error('Redis ping failed:', pong);
      return false;
    }
  } catch (error) {
    logger.error('Redis connection test failed:', error);
    return false;
  }
};

// Helper functions for common Redis operations
export const redisHelpers = {
  /**
   * Set a key with expiration
   */
  setex: async (key: string, ttl: number, value: string): Promise<void> => {
    try {
      await redis.setex(key, ttl, value);
    } catch (error) {
      logger.error('Redis setex error:', { key, ttl, error });
      throw error;
    }
  },

  /**
   * Get a key value
   */
  get: async (key: string): Promise<string | null> => {
    try {
      return await redis.get(key);
    } catch (error) {
      logger.error('Redis get error:', { key, error });
      throw error;
    }
  },

  /**
   * Delete keys
   */
  del: async (...keys: string[]): Promise<number> => {
    try {
      return await redis.del(...keys);
    } catch (error) {
      logger.error('Redis del error:', { keys, error });
      throw error;
    }
  },

  /**
   * Increment a counter
   */
  incr: async (key: string): Promise<number> => {
    try {
      return await redis.incr(key);
    } catch (error) {
      logger.error('Redis incr error:', { key, error });
      throw error;
    }
  },

  /**
   * Set if not exists
   */
  setnx: async (key: string, value: string): Promise<number> => {
    try {
      return await redis.setnx(key, value);
    } catch (error) {
      logger.error('Redis setnx error:', { key, error });
      throw error;
    }
  },

  /**
   * Hash operations
   */
  hset: async (key: string, field: string, value: string): Promise<number> => {
    try {
      return await redis.hset(key, field, value);
    } catch (error) {
      logger.error('Redis hset error:', { key, field, error });
      throw error;
    }
  },

  hget: async (key: string, field: string): Promise<string | null> => {
    try {
      return await redis.hget(key, field);
    } catch (error) {
      logger.error('Redis hget error:', { key, field, error });
      throw error;
    }
  },

  hgetall: async (key: string): Promise<Record<string, string>> => {
    try {
      return await redis.hgetall(key);
    } catch (error) {
      logger.error('Redis hgetall error:', { key, error });
      throw error;
    }
  },

  /**
   * List operations
   */
  lpush: async (key: string, ...values: string[]): Promise<number> => {
    try {
      return await redis.lpush(key, ...values);
    } catch (error) {
      logger.error('Redis lpush error:', { key, error });
      throw error;
    }
  },

  rpop: async (key: string): Promise<string | null> => {
    try {
      return await redis.rpop(key);
    } catch (error) {
      logger.error('Redis rpop error:', { key, error });
      throw error;
    }
  },

  /**
   * Set operations
   */
  sadd: async (key: string, ...members: string[]): Promise<number> => {
    try {
      return await redis.sadd(key, ...members);
    } catch (error) {
      logger.error('Redis sadd error:', { key, error });
      throw error;
    }
  },

  smembers: async (key: string): Promise<string[]> => {
    try {
      return await redis.smembers(key);
    } catch (error) {
      logger.error('Redis smembers error:', { key, error });
      throw error;
    }
  },

  /**
   * Pub/Sub operations
   */
  publish: async (channel: string, message: string): Promise<number> => {
    try {
      return await redis.publish(channel, message);
    } catch (error) {
      logger.error('Redis publish error:', { channel, error });
      throw error;
    }
  }
};

// Graceful shutdown
export const closeRedisConnection = async (): Promise<void> => {
  try {
    await redis.quit();
    logger.info('Redis connection closed gracefully');
  } catch (error) {
    logger.error('Error closing Redis connection:', error);
  }
};

export default redis;