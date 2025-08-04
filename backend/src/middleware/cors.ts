import { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { logger } from '../utils/logger';

// Environment-specific CORS configuration
interface CorsConfig {
  origins: string[];
  credentials: boolean;
  optionsSuccessStatus: number;
  methods: string[];
  allowedHeaders: string[];
  exposedHeaders: string[];
  maxAge: number;
  preflightContinue: boolean;
}

// Default allowed origins for different environments
const getDefaultOrigins = (): string[] => {
  const env = process.env.NODE_ENV || 'development';
  
  switch (env) {
    case 'production':
      return [
        process.env.FRONTEND_URL || 'https://yourdomain.com',
        'https://api.yourdomain.com',
        'https://www.yourdomain.com'
      ].filter(Boolean);
    
    case 'staging':
      return [
        'https://staging.yourdomain.com',
        'https://staging-api.yourdomain.com',
        'http://localhost:3000',
        'http://localhost:5173'
      ];
    
    default: // development
      return [
        'http://localhost:3000',
        'http://localhost:5173',
        'http://localhost:8080',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:5173',
        'http://127.0.0.1:8080'
      ];
  }
};

// Parse origins from environment variable
const parseOrigins = (originsString: string | undefined): string[] => {
  if (!originsString) return getDefaultOrigins();
  
  return originsString
    .split(',')
    .map(origin => origin.trim())
    .filter(origin => origin.length > 0);
};

// Validate origin format
const isValidOrigin = (origin: string): boolean => {
  try {
    const url = new URL(origin);
    
    // Only allow http and https protocols
    if (!['http:', 'https:'].includes(url.protocol)) {
      return false;
    }
    
    // Validate hostname (no wildcard subdomains for security)
    const hostname = url.hostname;
    if (hostname.includes('*')) {
      return false; // No wildcard support for security
    }
    
    // Block obvious malicious patterns
    if (hostname.includes('localhost') && process.env.NODE_ENV === 'production') {
      return false;
    }
    
    return true;
  } catch (error) {
    return false;
  }
};

// Create CORS configuration
const createCorsConfig = (): CorsConfig => {
  const rawOrigins = parseOrigins(process.env.CORS_ORIGINS);
  
  // Validate and filter origins
  const validOrigins = rawOrigins.filter(origin => {
    const isValid = isValidOrigin(origin);
    if (!isValid) {
      logger.warn('Invalid CORS origin filtered out', { origin });
    }
    return isValid;
  });

  if (validOrigins.length === 0) {
    logger.error('No valid CORS origins configured, using defaults');
    validOrigins.push(...getDefaultOrigins());
  }

  logger.info('CORS configured with origins', { origins: validOrigins });

  return {
    origins: validOrigins,
    credentials: true, // Allow cookies and authentication headers
    optionsSuccessStatus: 204, // For legacy browser support
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Origin',
      'X-Requested-With',
      'Content-Type',
      'Accept',
      'Authorization',
      'X-CSRF-Token',
      'X-API-Key',
      'Cache-Control',
      'Pragma'
    ],
    exposedHeaders: [
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'X-Total-Count',
      'X-Page-Count'
    ],
    maxAge: 86400, // 24 hours preflight cache
    preflightContinue: false
  };
};

// CORS configuration
const corsConfig = createCorsConfig();

// Dynamic origin validation function
const corsOriginHandler = (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
  // Allow requests with no origin (mobile apps, Postman, etc.)
  if (!origin) {
    if (process.env.NODE_ENV === 'production') {
      logger.warn('Request with no origin allowed', { 
        userAgent: 'unknown',
        environment: process.env.NODE_ENV 
      });
    }
    return callback(null, true);
  }

  // Check if origin is in allowed list
  if (corsConfig.origins.includes(origin)) {
    return callback(null, true);
  }

  // In development, be more permissive with localhost variants
  if (process.env.NODE_ENV !== 'production') {
    try {
      const url = new URL(origin);
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
        logger.info('Development: localhost origin allowed', { origin });
        return callback(null, true);
      }
    } catch (error) {
      // Invalid URL, will be rejected below
    }
  }

  // Log blocked origins for monitoring
  logger.warn('CORS origin blocked', { 
    origin, 
    allowedOrigins: corsConfig.origins,
    environment: process.env.NODE_ENV 
  });

  const error = new Error(`CORS policy violation: Origin '${origin}' not allowed`);
  callback(error, false);
};

// Create CORS middleware
export const corsMiddleware = cors({
  origin: corsOriginHandler,
  credentials: corsConfig.credentials,
  optionsSuccessStatus: corsConfig.optionsSuccessStatus,
  methods: corsConfig.methods,
  allowedHeaders: corsConfig.allowedHeaders,
  exposedHeaders: corsConfig.exposedHeaders,
  maxAge: corsConfig.maxAge,
  preflightContinue: corsConfig.preflightContinue
});

// Enhanced CORS middleware with additional security checks
export const enhancedCorsMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // Apply standard CORS middleware first
  corsMiddleware(req, res, (err) => {
    if (err) {
      logger.error('CORS error', { 
        error: err.message, 
        origin: req.headers.origin,
        method: req.method,
        path: req.path,
        ip: req.ip,
        userAgent: req.headers['user-agent']
      });
      
      return res.status(403).json({
        error: 'CORS policy violation',
        message: 'Origin not allowed by CORS policy'
      });
    }

    // Additional security headers for CORS responses
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'X-XSS-Protection': '1; mode=block'
    });

    // Log successful CORS requests in development
    if (process.env.NODE_ENV === 'development' && req.headers.origin) {
      logger.debug('CORS request allowed', {
        origin: req.headers.origin,
        method: req.method,
        path: req.path
      });
    }

    next();
  });
};

// Middleware to validate and sanitize Referer header
export const validateReferer = (req: Request, res: Response, next: NextFunction) => {
  const referer = req.headers.referer || req.headers.referrer;
  
  if (referer) {
    try {
      const refererUrl = new URL(referer);
      const isAllowedReferer = corsConfig.origins.some(origin => {
        try {
          const allowedUrl = new URL(origin);
          return refererUrl.origin === allowedUrl.origin;
        } catch {
          return false;
        }
      });

      if (!isAllowedReferer) {
        logger.warn('Suspicious referer detected', {
          referer,
          origin: req.headers.origin,
          allowedOrigins: corsConfig.origins,
          ip: req.ip,
          path: req.path
        });

        // Don't block, but log for monitoring
        // In high-security environments, you might want to block here
      }
    } catch (error) {
      logger.warn('Invalid referer header', { referer, error: error.message });
    }
  }

  next();
};

// CORS configuration for different API endpoints
export const createApiCorsMiddleware = (options: {
  additionalOrigins?: string[];
  publicEndpoint?: boolean;
  allowCredentials?: boolean;
} = {}) => {
  const {
    additionalOrigins = [],
    publicEndpoint = false,
    allowCredentials = true
  } = options;

  let allowedOrigins = [...corsConfig.origins, ...additionalOrigins];

  // For public endpoints, be more permissive
  if (publicEndpoint && process.env.NODE_ENV !== 'production') {
    allowedOrigins.push('*');
  }

  return cors({
    origin: publicEndpoint && allowedOrigins.includes('*') ? true : (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'), false);
      }
    },
    credentials: allowCredentials,
    methods: corsConfig.methods,
    allowedHeaders: corsConfig.allowedHeaders,
    exposedHeaders: corsConfig.exposedHeaders,
    maxAge: corsConfig.maxAge
  });
};

// CORS middleware specifically for WebSocket connections
export const websocketCorsMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  
  if (!origin) {
    return next();
  }

  const isAllowed = corsConfig.origins.includes(origin);
  
  if (!isAllowed) {
    logger.warn('WebSocket CORS origin blocked', { origin });
    return res.status(403).json({
      error: 'WebSocket connection not allowed from this origin'
    });
  }

  next();
};

// Utility function to check if origin is allowed
export const isOriginAllowed = (origin: string): boolean => {
  if (!origin) return true; // Allow requests with no origin
  return corsConfig.origins.includes(origin);
};

// Utility function to get current CORS configuration
export const getCorsConfig = () => ({
  ...corsConfig,
  // Don't expose the actual origins list for security
  originsCount: corsConfig.origins.length,
  environment: process.env.NODE_ENV
});

// Middleware to add CORS headers manually (for non-Express scenarios)
export const addCorsHeaders = (res: Response, origin?: string) => {
  if (origin && corsConfig.origins.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
  }
  
  res.set({
    'Access-Control-Allow-Methods': corsConfig.methods.join(', '),
    'Access-Control-Allow-Headers': corsConfig.allowedHeaders.join(', '),
    'Access-Control-Expose-Headers': corsConfig.exposedHeaders.join(', '),
    'Access-Control-Allow-Credentials': corsConfig.credentials.toString(),
    'Access-Control-Max-Age': corsConfig.maxAge.toString()
  });
};