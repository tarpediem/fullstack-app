import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { logger } from '../utils/logger';

// Content Security Policy configuration
interface CSPConfig {
  defaultSrc: string[];
  scriptSrc: string[];
  styleSrc: string[];
  imgSrc: string[];
  connectSrc: string[];
  fontSrc: string[];
  objectSrc: string[];
  mediaSrc: string[];
  frameSrc: string[];
  childSrc: string[];
  workerSrc: string[];
  manifestSrc: string[];
  baseUri: string[];
  formAction: string[];
  upgradeInsecureRequests: boolean;
  blockAllMixedContent: boolean;
  reportUri?: string;
  reportTo?: string;
}

// Security headers configuration
interface SecurityHeadersConfig {
  hsts: {
    maxAge: number;
    includeSubDomains: boolean;
    preload: boolean;
  };
  xFrameOptions: 'DENY' | 'SAMEORIGIN' | string;
  xContentTypeOptions: boolean;
  xXSSProtection: '0' | '1' | '1; mode=block';
  referrerPolicy: string;
  permissionsPolicy: Record<string, string[]>;
  expectCT?: {
    maxAge: number;
    enforce: boolean;
    reportUri?: string;
  };
}

// Environment-specific CSP configuration
const createCSPConfig = (): CSPConfig => {
  const isProduction = process.env.NODE_ENV === 'production';
  const isDevelopment = process.env.NODE_ENV === 'development';

  return {
    defaultSrc: ["'self'"],
    scriptSrc: [
      "'self'",
      // Add nonce for inline scripts
      "'nonce-{NONCE}'",
      // Remove unsafe-inline in production
      ...(isDevelopment ? ["'unsafe-inline'"] : []),
      // Add trusted CDNs
      'https://cdn.jsdelivr.net',
      'https://unpkg.com'
    ],
    styleSrc: [
      "'self'",
      "'unsafe-inline'", // Often needed for CSS-in-JS
      'https://fonts.googleapis.com',
      'https://cdn.jsdelivr.net'
    ],
    imgSrc: [
      "'self'",
      'data:',
      'https:',
      'blob:',
      // Add specific domains for images
      'https://avatars.githubusercontent.com',
      'https://lh3.googleusercontent.com'
    ],
    connectSrc: [
      "'self'",
      // API endpoints
      process.env.API_BASE_URL || 'http://localhost:5000',
      // OAuth providers
      'https://accounts.google.com',
      'https://api.github.com',
      'https://github.com',
      // WebSocket connections
      'ws://localhost:*',
      'wss://localhost:*',
      ...(isProduction ? [] : ['ws:', 'wss:'])
    ],
    fontSrc: [
      "'self'",
      'data:',
      'https://fonts.gstatic.com',
      'https://cdn.jsdelivr.net'
    ],
    objectSrc: ["'none'"],
    mediaSrc: ["'self'"],
    frameSrc: ["'none'"],
    childSrc: ["'none'"],
    workerSrc: ["'self'", 'blob:'],
    manifestSrc: ["'self'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    upgradeInsecureRequests: isProduction,
    blockAllMixedContent: isProduction,
    reportUri: process.env.CSP_REPORT_URI,
    reportTo: process.env.CSP_REPORT_TO
  };
};

// Security headers configuration
const createSecurityHeadersConfig = (): SecurityHeadersConfig => {
  const isProduction = process.env.NODE_ENV === 'production';

  return {
    hsts: {
      maxAge: 31536000, // 1 year
      includeSubDomains: true,
      preload: true
    },
    xFrameOptions: 'DENY',
    xContentTypeOptions: true,
    xXSSProtection: '1; mode=block',
    referrerPolicy: 'strict-origin-when-cross-origin',
    permissionsPolicy: {
      camera: [],
      microphone: [],
      geolocation: [],
      payment: [],
      usb: [],
      magnetometer: [],
      gyroscope: [],
      speaker: ["'self'"],
      vibrate: [],
      fullscreen: ["'self'"],
      "sync-xhr": []
    },
    ...(isProduction && {
      expectCT: {
        maxAge: 86400, // 24 hours
        enforce: true,
        reportUri: process.env.EXPECT_CT_REPORT_URI
      }
    })
  };
};

// Generate nonce for CSP
const generateNonce = (): string => {
  return crypto.randomBytes(16).toString('base64');
};

// Build CSP directive string
const buildCSPDirective = (config: CSPConfig, nonce: string): string => {
  const directives: string[] = [];

  // Helper function to format directive
  const formatDirective = (name: string, values: string[]): string => {
    if (values.length === 0) return '';
    const formattedValues = values.map(value => 
      value.includes('{NONCE}') ? value.replace('{NONCE}', nonce) : value
    );
    return `${name} ${formattedValues.join(' ')}`;
  };

  // Add all directives
  directives.push(formatDirective('default-src', config.defaultSrc));
  directives.push(formatDirective('script-src', config.scriptSrc));
  directives.push(formatDirective('style-src', config.styleSrc));
  directives.push(formatDirective('img-src', config.imgSrc));
  directives.push(formatDirective('connect-src', config.connectSrc));
  directives.push(formatDirective('font-src', config.fontSrc));
  directives.push(formatDirective('object-src', config.objectSrc));
  directives.push(formatDirective('media-src', config.mediaSrc));
  directives.push(formatDirective('frame-src', config.frameSrc));
  directives.push(formatDirective('child-src', config.childSrc));
  directives.push(formatDirective('worker-src', config.workerSrc));
  directives.push(formatDirective('manifest-src', config.manifestSrc));
  directives.push(formatDirective('base-uri', config.baseUri));
  directives.push(formatDirective('form-action', config.formAction));

  if (config.upgradeInsecureRequests) {
    directives.push('upgrade-insecure-requests');
  }

  if (config.blockAllMixedContent) {
    directives.push('block-all-mixed-content');
  }

  if (config.reportUri) {
    directives.push(`report-uri ${config.reportUri}`);
  }

  if (config.reportTo) {
    directives.push(`report-to ${config.reportTo}`);
  }

  return directives.filter(d => d).join('; ');
};

// Build permissions policy string
const buildPermissionsPolicy = (permissions: Record<string, string[]>): string => {
  return Object.entries(permissions)
    .map(([feature, allowlist]) => {
      if (allowlist.length === 0) {
        return `${feature}=()`;
      }
      return `${feature}=(${allowlist.join(' ')})`;
    })
    .join(', ');
};

// CSP middleware
export const cspMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const config = createCSPConfig();
  const nonce = generateNonce();
  
  // Make nonce available to templates/responses
  res.locals.nonce = nonce;
  
  const cspDirective = buildCSPDirective(config, nonce);
  res.setHeader('Content-Security-Policy', cspDirective);
  
  // Also set report-only header for monitoring
  if (process.env.CSP_REPORT_ONLY === 'true') {
    res.setHeader('Content-Security-Policy-Report-Only', cspDirective);
  }
  
  next();
};

// Security headers middleware
export const securityHeadersMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const config = createSecurityHeadersConfig();
  const isProduction = process.env.NODE_ENV === 'production';

  // HSTS header
  if (isProduction && req.secure) {
    let hstsValue = `max-age=${config.hsts.maxAge}`;
    if (config.hsts.includeSubDomains) hstsValue += '; includeSubDomains';
    if (config.hsts.preload) hstsValue += '; preload';
    res.setHeader('Strict-Transport-Security', hstsValue);
  }

  // X-Frame-Options
  res.setHeader('X-Frame-Options', config.xFrameOptions);

  // X-Content-Type-Options
  if (config.xContentTypeOptions) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }

  // X-XSS-Protection
  res.setHeader('X-XSS-Protection', config.xXSSProtection);

  // Referrer-Policy
  res.setHeader('Referrer-Policy', config.referrerPolicy);

  // Permissions-Policy
  const permissionsPolicy = buildPermissionsPolicy(config.permissionsPolicy);
  res.setHeader('Permissions-Policy', permissionsPolicy);

  // Expect-CT (for production with HTTPS)
  if (config.expectCT && isProduction && req.secure) {
    let expectCTValue = `max-age=${config.expectCT.maxAge}`;
    if (config.expectCT.enforce) expectCTValue += ', enforce';
    if (config.expectCT.reportUri) expectCTValue += `, report-uri="${config.expectCT.reportUri}"`;
    res.setHeader('Expect-CT', expectCTValue);
  }

  // Additional security headers
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('X-Download-Options', 'noopen');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');

  next();
};

// HTTPS enforcement middleware
export const httpsRedirectMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const isProduction = process.env.NODE_ENV === 'production';
  
  if (isProduction && !req.secure && req.get('X-Forwarded-Proto') !== 'https') {
    const httpsUrl = `https://${req.get('Host')}${req.url}`;
    logger.info('Redirecting to HTTPS', { originalUrl: req.url, httpsUrl });
    return res.redirect(301, httpsUrl);
  }
  
  next();
};

// Anti-clickjacking middleware
export const antiClickjackingMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // More granular frame options based on route
  if (req.path.startsWith('/embed')) {
    // Allow embedding for specific routes
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  } else if (req.path.startsWith('/api')) {
    // API endpoints don't need frame protection
    res.removeHeader('X-Frame-Options');
  } else {
    // Default: deny all framing
    res.setHeader('X-Frame-Options', 'DENY');
  }
  
  next();
};

// Cache control middleware
export const cacheControlMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // Set cache control based on route and content type
  if (req.path.startsWith('/api/auth') || req.path.includes('login') || req.path.includes('register')) {
    // Never cache authentication endpoints
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  } else if (req.path.startsWith('/api')) {
    // Short cache for API responses
    res.setHeader('Cache-Control', 'private, max-age=300'); // 5 minutes
  } else if (req.path.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg)$/)) {
    // Long cache for static assets
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // 1 year
  } else {
    // Default cache policy
    res.setHeader('Cache-Control', 'private, max-age=3600'); // 1 hour
  }
  
  next();
};

// Security monitoring middleware
export const securityMonitoringMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // Monitor for suspicious patterns
  const suspiciousPatterns = [
    /\.\.\//g, // Path traversal
    /<script/gi, // XSS attempts
    /union.*select/gi, // SQL injection
    /javascript:/gi, // JavaScript protocol
    /vbscript:/gi, // VBScript protocol
    /on\w+\s*=/gi // Event handlers
  ];

  const checkForSuspiciousContent = (obj: any, path: string = '') => {
    if (typeof obj === 'string') {
      for (const pattern of suspiciousPatterns) {
        if (pattern.test(obj)) {
          logger.warn('Suspicious content detected', {
            path,
            content: obj.substring(0, 100),
            pattern: pattern.toString(),
            ip: req.ip,
            userAgent: req.headers['user-agent'],
            referer: req.headers.referer
          });
          break;
        }
      }
    } else if (typeof obj === 'object' && obj !== null) {
      for (const [key, value] of Object.entries(obj)) {
        checkForSuspiciousContent(value, path ? `${path}.${key}` : key);
      }
    }
  };

  // Check request body and query parameters
  if (req.body) checkForSuspiciousContent(req.body, 'body');
  if (req.query) checkForSuspiciousContent(req.query, 'query');

  // Monitor unusual headers
  const suspiciousHeaders = ['x-forwarded-host', 'x-real-ip', 'x-originating-ip'];
  for (const header of suspiciousHeaders) {
    if (req.headers[header]) {
      logger.info('Potentially spoofed header detected', {
        header,
        value: req.headers[header],
        ip: req.ip,
        path: req.path
      });
    }
  }

  next();
};

// Combined security middleware
export const securityMiddleware = [
  httpsRedirectMiddleware,
  securityHeadersMiddleware,
  cspMiddleware,
  antiClickjackingMiddleware,
  cacheControlMiddleware,
  securityMonitoringMiddleware
];

// Utility functions for managing CSP
export const cspUtils = {
  // Add a source to CSP directive
  addCSPSource: (directive: string, source: string) => {
    // This would be used to dynamically add sources
    logger.info('CSP source added', { directive, source });
  },

  // Report CSP violations
  reportCSPViolation: (req: Request, res: Response) => {
    const violation = req.body;
    logger.warn('CSP violation reported', {
      violation,
      ip: req.ip,
      userAgent: req.headers['user-agent']
    });
    res.status(204).send();
  },

  // Get current CSP configuration
  getCurrentCSPConfig: () => createCSPConfig()
};