import crypto from 'crypto';

export interface SecurityConfig {
  jwt: {
    secret: string;
    accessTokenExpiry: string;
    refreshTokenExpiry: string;
    issuer: string;
    audience: string;
  };
  bcrypt: {
    saltRounds: number;
  };
  rateLimit: {
    windowMs: number;
    maxRequests: number;
    skipSuccessfulRequests: boolean;
  };
  cors: {
    origins: string[];
    credentials: boolean;
  };
  oauth: {
    google: {
      clientId: string;
      clientSecret: string;
      callbackUrl: string;
    };
    github: {
      clientId: string;
      clientSecret: string;
      callbackUrl: string;
    };
  };
  encryption: {
    algorithm: string;
    keyLength: number;
  };
  session: {
    maxSessions: number;
    extendOnActivity: boolean;
  };
}

// Validate required environment variables
const requiredEnvVars = [
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'ENCRYPTION_KEY'
];

const validateEnvironment = (): void => {
  const missing = requiredEnvVars.filter(envVar => !process.env[envVar]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
};

// Generate secure random string if not provided
const generateSecureSecret = (length: number = 64): string => {
  return crypto.randomBytes(length).toString('hex');
};

// Validate JWT secret strength
const validateJWTSecret = (secret: string): void => {
  if (secret.length < 32) {
    throw new Error('JWT secret must be at least 32 characters long');
  }
  if (secret === 'your-secret-key' || secret === 'your_super_secret_jwt_key_here') {
    throw new Error('JWT secret cannot be the default value');
  }
};

// Initialize security configuration
export const createSecurityConfig = (): SecurityConfig => {
  // In development, warn about missing env vars but provide defaults
  if (process.env.NODE_ENV !== 'production') {
    requiredEnvVars.forEach(envVar => {
      if (!process.env[envVar]) {
        console.warn(`⚠️  ${envVar} not set, using generated default (NOT FOR PRODUCTION)`);
      }
    });
  } else {
    validateEnvironment();
  }

  const jwtSecret = process.env.JWT_SECRET || generateSecureSecret();
  const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET || generateSecureSecret();
  
  validateJWTSecret(jwtSecret);
  validateJWTSecret(jwtRefreshSecret);

  const config: SecurityConfig = {
    jwt: {
      secret: jwtSecret,
      accessTokenExpiry: process.env.JWT_ACCESS_EXPIRY || '15m',
      refreshTokenExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
      issuer: process.env.JWT_ISSUER || 'ai-news-api',
      audience: process.env.JWT_AUDIENCE || 'ai-news-app',
    },
    bcrypt: {
      saltRounds: parseInt(process.env.BCRYPT_ROUNDS || '12'),
    },
    rateLimit: {
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'), // 15 minutes
      maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'),
      skipSuccessfulRequests: false,
    },
    cors: {
      origins: process.env.CORS_ORIGINS?.split(',') || [
        'http://localhost:3000',
        'http://localhost:5173',
        'https://localhost:3000',
        'https://localhost:5173'
      ],
      credentials: true,
    },
    oauth: {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID || '',
        clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
        callbackUrl: process.env.GOOGLE_CALLBACK_URL || '/auth/google/callback',
      },
      github: {
        clientId: process.env.GITHUB_CLIENT_ID || '',
        clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
        callbackUrl: process.env.GITHUB_CALLBACK_URL || '/auth/github/callback',
      },
    },
    encryption: {
      algorithm: 'aes-256-gcm',
      keyLength: 32,
    },
    session: {
      maxSessions: parseInt(process.env.MAX_USER_SESSIONS || '5'),
      extendOnActivity: true,
    },
  };

  return config;
};

export const securityConfig = createSecurityConfig();

// Utility functions for security operations
export const securityUtils = {
  // Generate secure random token
  generateToken: (length: number = 32): string => {
    return crypto.randomBytes(length).toString('hex');
  },

  // Hash sensitive data
  hashData: (data: string, salt?: string): string => {
    const actualSalt = salt || crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(data, actualSalt, 100000, 64, 'sha512');
    return `${actualSalt}:${hash.toString('hex')}`;
  },

  // Verify hashed data
  verifyHash: (data: string, hash: string): boolean => {
    const [salt, originalHash] = hash.split(':');
    const hashVerify = crypto.pbkdf2Sync(data, salt, 100000, 64, 'sha512');
    return originalHash === hashVerify.toString('hex');
  },

  // Encrypt sensitive data
  encrypt: (text: string, key?: string): string => {
    const actualKey = key || process.env.ENCRYPTION_KEY || generateSecureSecret(32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipher(securityConfig.encryption.algorithm, actualKey);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    return `${iv.toString('hex')}:${encrypted}`;
  },

  // Decrypt sensitive data
  decrypt: (encryptedData: string, key?: string): string => {
    const actualKey = key || process.env.ENCRYPTION_KEY || generateSecureSecret(32);
    const [ivHex, encrypted] = encryptedData.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    
    const decipher = crypto.createDecipher(securityConfig.encryption.algorithm, actualKey);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  },

  // Generate API key
  generateApiKey: (): string => {
    const timestamp = Date.now().toString(36);
    const random = crypto.randomBytes(32).toString('hex');
    return `ak_${timestamp}_${random}`;
  },

  // Validate password strength
  validatePassword: (password: string): { valid: boolean; errors: string[] } => {
    const errors: string[] = [];
    
    if (password.length < 8) {
      errors.push('Password must be at least 8 characters long');
    }
    if (!/[a-z]/.test(password)) {
      errors.push('Password must contain at least one lowercase letter');
    }
    if (!/[A-Z]/.test(password)) {
      errors.push('Password must contain at least one uppercase letter');
    }
    if (!/\d/.test(password)) {
      errors.push('Password must contain at least one number');
    }
    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
      errors.push('Password must contain at least one special character');
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  },

  // Generate secure session ID
  generateSessionId: (): string => {
    return crypto.randomUUID();
  },

  // Constant time comparison to prevent timing attacks
  safeCompare: (a: string, b: string): boolean => {
    if (a.length !== b.length) {
      return false;
    }
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }
};