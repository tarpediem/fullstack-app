import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AppError } from './errorHandler';
import { securityConfig } from '../config/security';
import { logger } from '../utils/logger';

export interface JwtPayload {
  userId: string;
  email: string;
  role: 'admin' | 'premium' | 'standard' | 'guest';
  status: 'active' | 'suspended' | 'pending' | 'deactivated';
  emailVerified: boolean;
  iat?: number;
  exp?: number;
  iss?: string;
  aud?: string;
  sub?: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

// Main authentication middleware
export const authenticate = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const token = extractToken(req);

    if (!token) {
      throw new AppError('Authentication required', 401);
    }

    const decoded = jwt.verify(token, securityConfig.jwt.secret) as JwtPayload;
    
    // Validate token claims
    validateTokenClaims(decoded);
    
    // Check user status
    if (decoded.status !== 'active') {
      throw new AppError('Account is not active', 403);
    }

    req.user = decoded;
    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      logger.warn('Invalid JWT token', { 
        error: error.message,
        ip: req.ip,
        userAgent: req.headers['user-agent']
      });
      throw new AppError('Invalid or malformed token', 401);
    } else if (error instanceof jwt.TokenExpiredError) {
      logger.warn('Expired JWT token', { 
        ip: req.ip,
        userAgent: req.headers['user-agent']
      });
      throw new AppError('Token has expired', 401);
    } else if (error instanceof jwt.NotBeforeError) {
      throw new AppError('Token not active yet', 401);
    }
    throw error;
  }
};

// Optional authentication - doesn't throw if no token
export const optionalAuth = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const token = extractToken(req);

    if (token) {
      const decoded = jwt.verify(token, securityConfig.jwt.secret) as JwtPayload;
      validateTokenClaims(decoded);
      
      if (decoded.status === 'active') {
        req.user = decoded;
      }
    }
    
    next();
  } catch (error) {
    // Log warning but don't throw error for optional auth
    logger.warn('Optional auth failed', { 
      error: error.message,
      ip: req.ip 
    });
    next();
  }
};

// Role-based authorization middleware
export const authorize = (...roles: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      throw new AppError('Authentication required', 401);
    }

    if (!roles.includes(req.user.role)) {
      logger.warn('Unauthorized access attempt', {
        userId: req.user.userId,
        userRole: req.user.role,
        requiredRoles: roles,
        path: req.path,
        method: req.method
      });
      throw new AppError('Insufficient permissions', 403);
    }

    next();
  };
};

// Email verification requirement
export const requireEmailVerified = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (!req.user) {
    throw new AppError('Authentication required', 401);
  }

  if (!req.user.emailVerified) {
    throw new AppError('Email verification required', 403);
  }

  next();
};

// Account status check
export const requireActiveAccount = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (!req.user) {
    throw new AppError('Authentication required', 401);
  }

  if (req.user.status !== 'active') {
    throw new AppError('Account is not active', 403);
  }

  next();
};

// Helper function to extract token from various sources
const extractToken = (req: Request): string | null => {
  // Try Authorization header first (Bearer token)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  // Try query parameter (for WebSocket connections, etc.)
  if (req.query.token && typeof req.query.token === 'string') {
    return req.query.token;
  }

  // Try cookies (for browser requests)
  if (req.cookies && req.cookies.accessToken) {
    return req.cookies.accessToken;
  }

  return null;
};

// Validate JWT token claims
const validateTokenClaims = (payload: JwtPayload): void => {
  // Check required fields
  if (!payload.userId || !payload.email || !payload.role) {
    throw new AppError('Invalid token payload', 401);
  }

  // Check issuer if configured
  if (securityConfig.jwt.issuer && payload.iss !== securityConfig.jwt.issuer) {
    throw new AppError('Invalid token issuer', 401);
  }

  // Check audience if configured
  if (securityConfig.jwt.audience && payload.aud !== securityConfig.jwt.audience) {
    throw new AppError('Invalid token audience', 401);
  }

  // Validate role
  const validRoles = ['admin', 'premium', 'standard', 'guest'];
  if (!validRoles.includes(payload.role)) {
    throw new AppError('Invalid user role', 401);
  }

  // Validate status
  const validStatuses = ['active', 'suspended', 'pending', 'deactivated'];
  if (!validStatuses.includes(payload.status)) {
    throw new AppError('Invalid account status', 401);
  }
};

// Middleware to log authentication events
export const logAuthEvent = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const originalSend = res.send;
  res.send = function(data) {
    // Log successful authentication
    if (req.user && (res.statusCode >= 200 && res.statusCode < 300)) {
      logger.info('Authentication successful', {
        userId: req.user.userId,
        email: req.user.email,
        role: req.user.role,
        path: req.path,
        method: req.method,
        ip: req.ip,
        userAgent: req.headers['user-agent']
      });
    }
    
    return originalSend.call(this, data);
  };
  
  next();
};

// Rate limiting for authentication endpoints
export const authRateLimit = {
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: 5, // 5 attempts per window
  skipSuccessfulRequests: true,
  message: {
    error: 'Too many authentication attempts, please try again later'
  }
};

// Security headers for authentication responses
export const secureAuthResponse = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // Prevent caching of authentication responses
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Surrogate-Control': 'no-store'
  });
  
  next();
};