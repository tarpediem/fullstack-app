import { Request, Response, NextFunction } from 'express';
import { body, query, param, ValidationChain } from 'express-validator';
import DOMPurify from 'isomorphic-dompurify';
import { AppError } from './errorHandler';
import { logger } from '../utils/logger';

// URL patterns for validation
const URL_PATTERNS = {
  // Only allow http/https URLs
  HTTP_URL: /^https?:\/\/[^\s/$.?#].[^\s]*$/i,
  // More restrictive URL pattern for scraping
  SCRAPER_URL: /^https?:\/\/[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9]))*\.[a-zA-Z]{2,}(\/[^\s]*)?$/,
  // Domain pattern
  DOMAIN: /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9]))*\.[a-zA-Z]{2,}$/
};

// Dangerous patterns to block
const DANGEROUS_PATTERNS = [
  // SQL injection patterns
  /(\b(union|select|insert|update|delete|drop|create|alter|exec|execute)\b)|(')|(--)|(\/\*)|(\*\/)/gi,
  // XSS patterns
  /<script[\s\S]*?>[\s\S]*?<\/script>/gi,
  /<iframe[\s\S]*?>[\s\S]*?<\/iframe>/gi,
  /javascript:/gi,
  /vbscript:/gi,
  /on\w+\s*=/gi,
  // Command injection patterns
  /(\|)|(&)|(;)|(`)|(\$\()|(\$\{)/g,
  // Path traversal patterns
  /\.\.\//g,
  /\.\.\\/g,
  // LDAP injection patterns
  /(\()|(\))|(\*)|(\&)|(\|)/g
];

// Allowed HTML tags for rich text content
const ALLOWED_HTML_TAGS = [
  'p', 'br', 'strong', 'em', 'u', 'ol', 'ul', 'li', 
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code', 'pre'
];

// Safe domain whitelist for scraping
const SAFE_DOMAINS = [
  'reuters.com',
  'apnews.com',
  'bbc.com',
  'cnn.com',
  'npr.org',
  'techcrunch.com',
  'arstechnica.com',
  'theverge.com',
  'wired.com',
  'nature.com',
  'sciencemag.org',
  'arxiv.org',
  'github.com',
  'stackoverflow.com'
];

export class InputSanitizer {
  
  // Sanitize plain text input
  static sanitizeText(input: string, maxLength: number = 1000): string {
    if (!input || typeof input !== 'string') return '';
    
    // Remove dangerous patterns
    let sanitized = input;
    DANGEROUS_PATTERNS.forEach(pattern => {
      sanitized = sanitized.replace(pattern, '');
    });
    
    // Normalize whitespace and trim
    sanitized = sanitized.replace(/\s+/g, ' ').trim();
    
    // Truncate if too long
    if (sanitized.length > maxLength) {
      sanitized = sanitized.substring(0, maxLength).trim();
    }
    
    return sanitized;
  }

  // Sanitize HTML content
  static sanitizeHTML(input: string, allowedTags: string[] = ALLOWED_HTML_TAGS): string {
    if (!input || typeof input !== 'string') return '';
    
    // Use DOMPurify to sanitize HTML
    const clean = DOMPurify.sanitize(input, {
      ALLOWED_TAGS: allowedTags,
      ALLOWED_ATTR: ['href', 'target', 'rel'],
      FORBID_SCRIPTS: true,
      FORBID_TAGS: ['script', 'object', 'embed', 'form', 'input', 'button'],
      FORBID_ATTR: ['onclick', 'onload', 'onerror', 'onmouseover', 'onfocus']
    });
    
    return clean.trim();
  }

  // Sanitize URL input
  static sanitizeURL(input: string, allowedProtocols: string[] = ['http', 'https']): string {
    if (!input || typeof input !== 'string') return '';
    
    try {
      const url = new URL(input.trim());
      
      // Check protocol
      if (!allowedProtocols.includes(url.protocol.replace(':', ''))) {
        throw new Error('Invalid protocol');
      }
      
      // Validate URL format
      if (!URL_PATTERNS.HTTP_URL.test(url.href)) {
        throw new Error('Invalid URL format');
      }
      
      return url.href;
    } catch (error) {
      throw new AppError('Invalid URL format', 400);
    }
  }

  // Validate scraper URL with additional security checks
  static validateScraperURL(input: string): string {
    if (!input || typeof input !== 'string') {
      throw new AppError('URL is required', 400);
    }

    const url = this.sanitizeURL(input);
    const urlObj = new URL(url);

    // Check against allowed domains
    const domain = urlObj.hostname.toLowerCase();
    const isAllowedDomain = SAFE_DOMAINS.some(safeDomain => 
      domain === safeDomain || domain.endsWith('.' + safeDomain)
    );

    if (!isAllowedDomain) {
      logger.warn('Scraper URL blocked - not in whitelist', { url, domain });
      throw new AppError('URL domain not allowed for scraping', 403);
    }

    // Additional security checks
    if (this.isPrivateIP(urlObj.hostname)) {
      throw new AppError('Private IP addresses are not allowed', 403);
    }

    if (this.isLocalhost(urlObj.hostname)) {
      throw new AppError('Localhost URLs are not allowed', 403);
    }

    return url;
  }

  // Check if hostname is a private IP
  private static isPrivateIP(hostname: string): boolean {
    const privateIPPatterns = [
      /^10\./,                    // 10.0.0.0/8
      /^172\.(1[6-9]|2[0-9]|3[01])\./, // 172.16.0.0/12
      /^192\.168\./,              // 192.168.0.0/16
      /^127\./,                   // 127.0.0.0/8
      /^169\.254\./,              // 169.254.0.0/16
      /^::1$/,                    // IPv6 localhost
      /^fc00:/,                   // IPv6 private
      /^fe80:/                    // IPv6 link-local
    ];

    return privateIPPatterns.some(pattern => pattern.test(hostname));
  }

  // Check if hostname is localhost
  private static isLocalhost(hostname: string): boolean {
    const localhostPatterns = [
      'localhost',
      '127.0.0.1',
      '::1',
      '0.0.0.0'
    ];
    
    return localhostPatterns.includes(hostname.toLowerCase());
  }

  // Sanitize email
  static sanitizeEmail(input: string): string {
    if (!input || typeof input !== 'string') return '';
    
    const email = input.toLowerCase().trim();
    
    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      throw new AppError('Invalid email format', 400);
    }
    
    return email;
  }

  // Sanitize file path (for uploads, etc.)
  static sanitizeFilePath(input: string): string {
    if (!input || typeof input !== 'string') return '';
    
    // Remove path traversal attempts
    let sanitized = input.replace(/\.\.\//g, '').replace(/\.\.\\/g, '');
    
    // Remove dangerous characters
    sanitized = sanitized.replace(/[<>:"|?*]/g, '');
    
    // Normalize path separators
    sanitized = sanitized.replace(/\\/g, '/');
    
    return sanitized.trim();
  }
}

// Validation middleware factory
export const createValidationRules = {
  
  // Text field validation
  text: (field: string, options: {
    min?: number;
    max?: number;
    required?: boolean;
    sanitize?: boolean;
  } = {}) => {
    const {
      min = 1,
      max = 1000,
      required = false,
      sanitize = true
    } = options;

    let chain = body(field);
    
    if (required) {
      chain = chain.notEmpty().withMessage(`${field} is required`);
    } else {
      chain = chain.optional();
    }
    
    chain = chain
      .isLength({ min, max })
      .withMessage(`${field} must be between ${min} and ${max} characters`);
    
    if (sanitize) {
      chain = chain.customSanitizer((value) => 
        InputSanitizer.sanitizeText(value, max)
      );
    }
    
    return chain;
  },

  // Email validation
  email: (field: string = 'email', required: boolean = true) => {
    let chain = body(field);
    
    if (required) {
      chain = chain.notEmpty().withMessage('Email is required');
    } else {
      chain = chain.optional();
    }
    
    return chain
      .isEmail()
      .withMessage('Invalid email format')
      .normalizeEmail()
      .customSanitizer((value) => InputSanitizer.sanitizeEmail(value));
  },

  // URL validation
  url: (field: string, options: {
    required?: boolean;
    allowedProtocols?: string[];
    scraper?: boolean;
  } = {}) => {
    const {
      required = false,
      allowedProtocols = ['http', 'https'],
      scraper = false
    } = options;

    let chain = body(field);
    
    if (required) {
      chain = chain.notEmpty().withMessage(`${field} is required`);
    } else {
      chain = chain.optional();
    }
    
    return chain
      .isURL({ protocols: allowedProtocols })
      .withMessage(`Invalid ${field} format`)
      .customSanitizer((value) => {
        if (scraper) {
          return InputSanitizer.validateScraperURL(value);
        }
        return InputSanitizer.sanitizeURL(value, allowedProtocols);
      });
  },

  // HTML content validation
  html: (field: string, options: {
    max?: number;
    required?: boolean;
    allowedTags?: string[];
  } = {}) => {
    const {
      max = 10000,
      required = false,
      allowedTags = ALLOWED_HTML_TAGS
    } = options;

    let chain = body(field);
    
    if (required) {
      chain = chain.notEmpty().withMessage(`${field} is required`);
    } else {
      chain = chain.optional();
    }
    
    return chain
      .isLength({ max })
      .withMessage(`${field} must be less than ${max} characters`)
      .customSanitizer((value) => 
        InputSanitizer.sanitizeHTML(value, allowedTags)
      );
  },

  // Query parameter validation
  queryParam: (field: string, options: {
    type?: 'string' | 'number' | 'boolean';
    min?: number;
    max?: number;
    required?: boolean;
  } = {}) => {
    const {
      type = 'string',
      min,
      max,
      required = false
    } = options;

    let chain = query(field);
    
    if (required) {
      chain = chain.notEmpty().withMessage(`${field} is required`);
    } else {
      chain = chain.optional();
    }
    
    switch (type) {
      case 'number':
        chain = chain.isNumeric().withMessage(`${field} must be a number`);
        if (min !== undefined) {
          chain = chain.isFloat({ min }).withMessage(`${field} must be at least ${min}`);
        }
        if (max !== undefined) {
          chain = chain.isFloat({ max }).withMessage(`${field} must be at most ${max}`);
        }
        break;
      case 'boolean':
        chain = chain.isBoolean().withMessage(`${field} must be a boolean`);
        break;
      default:
        if (min !== undefined || max !== undefined) {
          chain = chain.isLength({ min, max });
        }
        break;
    }
    
    return chain;
  },

  // UUID validation
  uuid: (field: string, required: boolean = true) => {
    let chain = param(field);
    
    if (required) {
      chain = chain.notEmpty().withMessage(`${field} is required`);
    } else {
      chain = chain.optional();
    }
    
    return chain
      .isUUID()
      .withMessage(`Invalid ${field} format`);
  }
};

// Security scanning middleware
export const securityScan = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const scanObject = (obj: any, path: string = ''): void => {
    if (typeof obj === 'string') {
      // Check for dangerous patterns
      const isDangerous = DANGEROUS_PATTERNS.some(pattern => pattern.test(obj));
      if (isDangerous) {
        logger.warn('Security scan detected dangerous input', {
          path,
          input: obj.substring(0, 100) + '...',
          ip: req.ip,
          userAgent: req.headers['user-agent']
        });
        throw new AppError('Invalid input detected', 400);
      }
    } else if (typeof obj === 'object' && obj !== null) {
      for (const [key, value] of Object.entries(obj)) {
        scanObject(value, path ? `${path}.${key}` : key);
      }
    }
  };

  try {
    // Scan request body
    if (req.body) {
      scanObject(req.body, 'body');
    }
    
    // Scan query parameters
    if (req.query) {
      scanObject(req.query, 'query');
    }
    
    // Scan URL parameters
    if (req.params) {
      scanObject(req.params, 'params');
    }
    
    next();
  } catch (error) {
    next(error);
  }
};

// Rate limiting by IP for security-sensitive endpoints
export const createSecurityRateLimit = (options: {
  windowMs?: number;
  max?: number;
  message?: string;
} = {}) => {
  const {
    windowMs = 15 * 60 * 1000, // 15 minutes
    max = 100, // limit each IP to 100 requests per windowMs
    message = 'Too many requests from this IP'
  } = options;

  const attempts = new Map<string, { count: number; resetTime: number }>();

  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress;
    const now = Date.now();

    // Clean up old entries
    for (const [key, data] of attempts.entries()) {
      if (now > data.resetTime) {
        attempts.delete(key);
      }
    }

    // Check current IP
    const current = attempts.get(ip) || { count: 0, resetTime: now + windowMs };
    
    if (current.count >= max) {
      logger.warn('Rate limit exceeded', { ip, count: current.count });
      return res.status(429).json({
        error: message,
        retryAfter: Math.ceil((current.resetTime - now) / 1000)
      });
    }

    current.count++;
    attempts.set(ip, current);
    next();
  };
};