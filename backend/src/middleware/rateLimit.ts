import { Request, Response, NextFunction } from 'express';
import { createClient, RedisClientType } from 'redis';
import { logger } from '../utils/logger';

// Rate limit configuration interface
interface RateLimitConfig {
  windowMs: number;
  max: number;
  keyGenerator: (req: Request) => string;
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
  message: string | object;
  headers?: boolean;
  standardHeaders?: boolean;
  legacyHeaders?: boolean;
  onLimitReached?: (req: Request, res: Response) => void;
}

// Redis client for distributed rate limiting
class RedisRateLimiter {
  private client: RedisClientType | null = null;
  private fallbackStore: Map<string, { count: number; resetTime: number }> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.initializeRedis();
    this.startCleanupInterval();
  }

  private async initializeRedis(): Promise<void> {
    try {
      this.client = createClient({
        url: process.env.REDIS_URL || 'redis://localhost:6379',
        retry_delay: 1000,
        max_attempts: 3
      });

      this.client.on('error', (err) => {
        logger.error('Redis connection error, falling back to memory store:', err);
        this.client = null;
      });

      this.client.on('connect', () => {
        logger.info('Redis rate limiter connected');
      });

      this.client.on('reconnecting', () => {
        logger.info('Redis rate limiter reconnecting');
      });

      await this.client.connect();
    } catch (error) {
      logger.warn('Failed to initialize Redis, using memory store:', error.message);
      this.client = null;
    }
  }

  // Start cleanup interval for memory store
  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, data] of this.fallbackStore.entries()) {
        if (now > data.resetTime) {
          this.fallbackStore.delete(key);
        }
      }
    }, 60000); // Clean up every minute
  }

  // Increment counter for a key
  async increment(key: string, windowMs: number): Promise<{ count: number; resetTime: number }> {
    const now = Date.now();
    const resetTime = now + windowMs;

    try {
      if (this.client && this.client.isOpen) {
        // Use Redis for distributed rate limiting
        const pipeline = this.client.multi();
        pipeline.incr(key);
        pipeline.expire(key, Math.ceil(windowMs / 1000));
        pipeline.ttl(key);
        
        const results = await pipeline.exec();
        const count = results[0] as number;
        const ttl = results[2] as number;
        
        return {
          count,
          resetTime: ttl > 0 ? now + (ttl * 1000) : resetTime
        };
      }
    } catch (error) {
      logger.warn('Redis increment failed, using memory store:', error.message);
    }

    // Fallback to memory store
    const existing = this.fallbackStore.get(key) || { count: 0, resetTime };
    
    // Reset if window has expired
    if (now > existing.resetTime) {
      existing.count = 1;
      existing.resetTime = resetTime;
    } else {
      existing.count++;
    }
    
    this.fallbackStore.set(key, existing);
    return existing;
  }

  // Get current count for a key
  async get(key: string): Promise<{ count: number; resetTime: number } | null> {
    try {
      if (this.client && this.client.isOpen) {
        const count = await this.client.get(key);
        const ttl = await this.client.ttl(key);
        
        if (count !== null) {
          return {
            count: parseInt(count),
            resetTime: Date.now() + (ttl * 1000)
          };
        }
      }
    } catch (error) {
      logger.warn('Redis get failed, using memory store:', error.message);
    }

    // Fallback to memory store
    const data = this.fallbackStore.get(key);
    if (data && Date.now() <= data.resetTime) {
      return data;
    }

    return null;
  }

  // Reset counter for a key
  async reset(key: string): Promise<void> {
    try {
      if (this.client && this.client.isOpen) {
        await this.client.del(key);
      }
    } catch (error) {
      logger.warn('Redis reset failed:', error.message);
    }

    // Also remove from memory store
    this.fallbackStore.delete(key);
  }

  // Close connections
  async close(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    try {
      if (this.client && this.client.isOpen) {
        await this.client.quit();
      }
    } catch (error) {
      logger.warn('Error closing Redis connection:', error.message);
    }
  }
}

// Global rate limiter instance
const rateLimiter = new RedisRateLimiter();

// Create rate limiting middleware
export const createRateLimit = (config: RateLimitConfig) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = config.keyGenerator(req);
      const data = await rateLimiter.increment(key, config.windowMs);

      // Set rate limit headers
      if (config.headers !== false) {
        if (config.standardHeaders !== false) {
          res.set({
            'RateLimit-Limit': config.max.toString(),
            'RateLimit-Remaining': Math.max(0, config.max - data.count).toString(),
            'RateLimit-Reset': new Date(data.resetTime).toISOString()
          });
        }

        if (config.legacyHeaders !== false) {
          res.set({
            'X-RateLimit-Limit': config.max.toString(),
            'X-RateLimit-Remaining': Math.max(0, config.max - data.count).toString(),
            'X-RateLimit-Reset': Math.ceil(data.resetTime / 1000).toString()
          });
        }
      }

      // Check if limit exceeded
      if (data.count > config.max) {
        // Skip if configured to skip failed requests
        if (config.skipFailedRequests) {
          const originalSend = res.send;
          res.send = function(body) {
            if (res.statusCode >= 400) {
              // Don't count this request
              rateLimiter.reset(key).catch(err => 
                logger.warn('Failed to reset rate limit counter:', err)
              );
            }
            return originalSend.call(this, body);
          };
        }

        // Call onLimitReached callback
        if (config.onLimitReached) {
          config.onLimitReached(req, res);
        }

        logger.warn('Rate limit exceeded', {
          key,
          count: data.count,
          limit: config.max,
          ip: req.ip,
          userAgent: req.headers['user-agent'],
          path: req.path
        });

        return res.status(429).json({
          error: typeof config.message === 'string' ? config.message : config.message,
          retryAfter: Math.ceil((data.resetTime - Date.now()) / 1000)
        });
      }

      // Skip counting successful requests if configured
      if (config.skipSuccessfulRequests) {
        const originalSend = res.send;
        res.send = function(body) {
          if (res.statusCode < 400) {
            // Don't count this request
            rateLimiter.reset(key).catch(err => 
              logger.warn('Failed to reset rate limit counter:', err)
            );
          }
          return originalSend.call(this, body);
        };
      }

      next();
    } catch (error) {
      logger.error('Rate limiting error:', error);
      // Continue without rate limiting on error
      next();
    }
  };
};

// Predefined rate limiters
export const globalRateLimit = createRateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // 1000 requests per window
  keyGenerator: (req) => `global:${req.ip}`,
  message: 'Too many requests from this IP, please try again later',
  standardHeaders: true,
  legacyHeaders: false
});

export const authRateLimit = createRateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 authentication attempts per window
  keyGenerator: (req) => `auth:${req.ip}`,
  message: 'Too many authentication attempts, please try again later',
  skipSuccessfulRequests: true,
  onLimitReached: (req, res) => {
    logger.warn('Authentication rate limit exceeded', {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      path: req.path,
      email: req.body?.email
    });
  }
});

export const apiRateLimit = createRateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 API requests per window
  keyGenerator: (req) => `api:${req.ip}`,
  message: 'API rate limit exceeded, please try again later'
});

export const scraperRateLimit = createRateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 10, // 10 scraping requests per window
  keyGenerator: (req) => `scraper:${req.ip}`,
  message: 'Too many scraping requests, please slow down'
});

// Advanced DDoS protection middleware
interface DDoSConfig {
  burstWindow: number; // Short window for burst detection
  burstLimit: number; // Max requests in burst window
  sustainedWindow: number; // Longer window for sustained attack detection
  sustainedLimit: number; // Max requests in sustained window
  blockDuration: number; // How long to block IPs
}

class DDoSProtection {
  private blockedIPs: Map<string, number> = new Map();
  private config: DDoSConfig;
  private cleanupInterval: NodeJS.Timeout;

  constructor(config: DDoSConfig) {
    this.config = config;
    
    // Clean up expired blocks every minute
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [ip, blockUntil] of this.blockedIPs.entries()) {
        if (now > blockUntil) {
          this.blockedIPs.delete(ip);
          logger.info('Unblocked IP after DDoS protection timeout', { ip });
        }
      }
    }, 60000);
  }

  async checkRequest(req: Request): Promise<{ blocked: boolean; reason?: string }> {
    const ip = req.ip;
    const now = Date.now();

    // Check if IP is currently blocked
    const blockUntil = this.blockedIPs.get(ip);
    if (blockUntil && now < blockUntil) {
      return { 
        blocked: true, 
        reason: `IP blocked due to DDoS protection until ${new Date(blockUntil).toISOString()}` 
      };
    }

    // Check burst rate
    const burstKey = `ddos:burst:${ip}`;
    const burstData = await rateLimiter.get(burstKey);
    if (burstData && burstData.count > this.config.burstLimit) {
      this.blockIP(ip, 'burst rate exceeded');
      return { blocked: true, reason: 'Burst rate limit exceeded' };
    }

    // Check sustained rate
    const sustainedKey = `ddos:sustained:${ip}`;
    const sustainedData = await rateLimiter.get(sustainedKey);
    if (sustainedData && sustainedData.count > this.config.sustainedLimit) {
      this.blockIP(ip, 'sustained rate exceeded');
      return { blocked: true, reason: 'Sustained rate limit exceeded' };
    }

    // Increment counters
    await rateLimiter.increment(burstKey, this.config.burstWindow);
    await rateLimiter.increment(sustainedKey, this.config.sustainedWindow);

    return { blocked: false };
  }

  private blockIP(ip: string, reason: string): void {
    const blockUntil = Date.now() + this.config.blockDuration;
    this.blockedIPs.set(ip, blockUntil);
    
    logger.warn('IP blocked by DDoS protection', {
      ip,
      reason,
      blockUntil: new Date(blockUntil).toISOString(),
      duration: this.config.blockDuration / 1000 / 60 // minutes
    });
  }

  unblockIP(ip: string): void {
    this.blockedIPs.delete(ip);
    logger.info('IP manually unblocked', { ip });
  }

  getBlockedIPs(): Array<{ ip: string; blockUntil: Date; reason: string }> {
    return Array.from(this.blockedIPs.entries()).map(([ip, blockUntil]) => ({
      ip,
      blockUntil: new Date(blockUntil),
      reason: 'DDoS protection'
    }));
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

// Global DDoS protection instance
const ddosProtection = new DDoSProtection({
  burstWindow: 1 * 60 * 1000, // 1 minute
  burstLimit: 100, // 100 requests per minute
  sustainedWindow: 10 * 60 * 1000, // 10 minutes
  sustainedLimit: 1000, // 1000 requests per 10 minutes
  blockDuration: 30 * 60 * 1000 // Block for 30 minutes
});

// DDoS protection middleware
export const ddosProtectionMiddleware = async (
  req: Request, 
  res: Response, 
  next: NextFunction
) => {
  try {
    const result = await ddosProtection.checkRequest(req);
    
    if (result.blocked) {
      logger.warn('Request blocked by DDoS protection', {
        ip: req.ip,
        reason: result.reason,
        userAgent: req.headers['user-agent'],
        path: req.path
      });

      return res.status(429).json({
        error: 'Request blocked by DDoS protection',
        reason: result.reason,
        retryAfter: 1800 // 30 minutes
      });
    }

    next();
  } catch (error) {
    logger.error('DDoS protection error:', error);
    // Continue without DDoS protection on error
    next();
  }
};

// User-specific rate limiting (requires authentication)
export const createUserRateLimit = (config: Omit<RateLimitConfig, 'keyGenerator'>) => {
  return createRateLimit({
    ...config,
    keyGenerator: (req) => {
      const userId = req.user?.userId;
      return userId ? `user:${userId}` : `ip:${req.ip}`;
    }
  });
};

// Endpoint-specific rate limiting
export const createEndpointRateLimit = (
  endpoint: string, 
  config: Omit<RateLimitConfig, 'keyGenerator'>
) => {
  return createRateLimit({
    ...config,
    keyGenerator: (req) => `endpoint:${endpoint}:${req.ip}`
  });
};

// Cleanup function for graceful shutdown
export const cleanup = async (): Promise<void> => {
  ddosProtection.destroy();
  await rateLimiter.close();
};

// Admin functions for rate limit management
export const adminFunctions = {
  // Reset rate limit for a specific key
  resetRateLimit: async (key: string): Promise<void> => {
    await rateLimiter.reset(key);
    logger.info('Rate limit reset by admin', { key });
  },

  // Unblock IP from DDoS protection
  unblockIP: (ip: string): void => {
    ddosProtection.unblockIP(ip);
  },

  // Get blocked IPs
  getBlockedIPs: () => {
    return ddosProtection.getBlockedIPs();
  },

  // Get rate limit stats (would need additional implementation)
  getRateLimitStats: async (key: string) => {
    return await rateLimiter.get(key);
  }
};