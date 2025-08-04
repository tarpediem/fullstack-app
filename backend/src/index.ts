import express, { Application } from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';

import { enhancedCorsMiddleware, validateReferer } from './middleware/cors';
import { errorHandler } from './middleware/errorHandler';
import { securityScan } from './middleware/sanitization';
import { testConnection, pool } from './config/database';
import { redis, testRedisConnection, closeRedisConnection } from './config/redis';
import { logger } from './utils/logger';
import { initializeOpenRouterServices, shutdownOpenRouterServices } from './services/openrouter';
import apiRoutes from './routes';
import authRoutes from './routes/auth.routes';
import oauthRoutes from './routes/oauth.routes';

// Load environment variables
dotenv.config();

const app: Application = express();
const PORT = process.env.PORT || 5000;

// Security configuration
const isProduction = process.env.NODE_ENV === 'production';

// Helmet security middleware with custom configuration
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"], // Adjust based on your needs
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https://api.github.com", "https://accounts.google.com"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false, // Disable if causing issues with OAuth
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true
  }
}));

// Enhanced CORS middleware
app.use(enhancedCorsMiddleware);

// Trust proxy for accurate IP addresses
app.set('trust proxy', 1);

// Compression middleware
app.use(compression());

// Cookie parser for secure cookie handling
app.use(cookieParser());

// Body parsing with security limits
app.use(express.json({ 
  limit: '10mb',
  verify: (req, res, buf) => {
    // Basic JSON bomb protection
    if (buf.length > 10 * 1024 * 1024) { // 10MB
      throw new Error('Request body too large');
    }
  }
}));

app.use(express.urlencoded({ 
  extended: true, 
  limit: '10mb',
  parameterLimit: 100 // Limit number of parameters
}));

// Global rate limiting
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Limit each IP to 1000 requests per windowMs
  message: {
    error: 'Too many requests from this IP, please try again later'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('Global rate limit exceeded', { 
      ip: req.ip, 
      userAgent: req.headers['user-agent'],
      path: req.path
    });
    res.status(429).json({
      error: 'Too many requests from this IP, please try again later'
    });
  }
});

app.use(globalLimiter);

// Security scanning middleware
app.use(securityScan);

// Referer validation
app.use(validateReferer);

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/oauth', oauthRoutes);
app.use('/api', apiRoutes);

// Health check endpoint with additional info
app.get('/health', async (req, res) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    environment: process.env.NODE_ENV || 'development',
    database: 'unknown'
  };

  try {
    const dbConnected = await testConnection();
    health.database = dbConnected ? 'connected' : 'disconnected';
  } catch (error) {
    health.database = 'error';
    health.status = 'degraded';
  }

  const statusCode = health.status === 'healthy' ? 200 : 503;
  res.status(statusCode).json(health);
});

// Security info endpoint (admin only in production)
app.get('/security-info', (req, res) => {
  if (isProduction && !req.user?.role === 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  res.json({
    environment: process.env.NODE_ENV,
    security: {
      helmet: true,
      cors: true,
      rateLimit: true,
      inputValidation: true,
      compression: true,
      securityScan: true
    },
    headers: {
      hsts: isProduction,
      csp: true,
      nosniff: true,
      xssProtection: true
    }
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Endpoint not found',
    path: req.originalUrl,
    method: req.method
  });
});

// Global error handler
app.use(errorHandler);

// Graceful shutdown handling
const gracefulShutdown = async (signal: string) => {
  logger.info(`${signal} received, shutting down gracefully`);
  
  server.close(async () => {
    logger.info('HTTP server closed');
    
    try {
      // Shutdown OpenRouter services
      await shutdownOpenRouterServices();
      
      // Close database pool
      await pool.end();
      logger.info('Database pool closed');
      
      // Close Redis connection
      await closeRedisConnection();
      
      logger.info('All services shut down successfully');
      process.exit(0);
    } catch (error) {
      logger.error('Error during shutdown:', error);
      process.exit(1);
    }
  });
  
  // Force close after 15 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 15000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start server
const server = app.listen(PORT, async () => {
  logger.info(`🚀 Secure AI News API server running on port ${PORT}`);
  logger.info(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`🔒 Security features: Helmet, CORS, Rate Limiting, Input Validation`);
  
  // Test database connection on startup
  try {
    const dbConnected = await testConnection();
    if (dbConnected) {
      logger.info('✅ Database connection successful');
    } else {
      logger.error('❌ Database connection failed');
    }
  } catch (error) {
    logger.error('❌ Database connection error:', error);
  }

  // Test Redis connection on startup
  try {
    const redisConnected = await testRedisConnection();
    if (redisConnected) {
      logger.info('✅ Redis connection successful');
    } else {
      logger.error('❌ Redis connection failed');
    }
  } catch (error) {
    logger.error('❌ Redis connection error:', error);
  }

  // Initialize OpenRouter services
  try {
    await initializeOpenRouterServices(pool, redis);
    logger.info('✅ OpenRouter services initialized successfully');
  } catch (error) {
    logger.error('❌ OpenRouter services initialization failed:', error);
    // Don't exit here - the app can still run without OpenRouter
  }
});

export default app;