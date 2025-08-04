import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query, withTransaction } from '../config/database';
import { securityConfig, securityUtils } from '../config/security';
import { logger } from '../utils/logger';
import { AppError } from '../middleware/errorHandler';

export interface User {
  id: string;
  email: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  role: 'admin' | 'premium' | 'standard' | 'guest';
  status: 'active' | 'suspended' | 'pending' | 'deactivated';
  email_verified: boolean;
  avatar_url?: string;
  created_at: Date;
  last_login_at?: Date;
  login_count: number;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
}

export interface LoginCredentials {
  email: string;
  password: string;
  rememberMe?: boolean;
}

export interface RegisterData {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
  username?: string;
}

export interface RefreshTokenData {
  id: string;
  user_id: string;
  token_hash: string;
  device_info?: any;
  ip_address?: string;
  user_agent?: string;
  expires_at: Date;
  created_at: Date;
  last_used_at: Date;
  revoked_at?: Date;
}

export class AuthService {
  
  // Generate JWT tokens
  private generateTokens(user: User, deviceInfo?: any): AuthTokens {
    const payload = {
      userId: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
      emailVerified: user.email_verified
    };

    const accessToken = jwt.sign(
      payload,
      securityConfig.jwt.secret,
      {
        expiresIn: securityConfig.jwt.accessTokenExpiry,
        issuer: securityConfig.jwt.issuer,
        audience: securityConfig.jwt.audience,
        subject: user.id
      }
    );

    const refreshToken = jwt.sign(
      { userId: user.id, type: 'refresh' },
      process.env.JWT_REFRESH_SECRET || securityConfig.jwt.secret,
      {
        expiresIn: securityConfig.jwt.refreshTokenExpiry,
        issuer: securityConfig.jwt.issuer,
        audience: securityConfig.jwt.audience,
        subject: user.id
      }
    );

    return {
      accessToken,
      refreshToken,
      expiresIn: this.getTokenExpiryTime(securityConfig.jwt.accessTokenExpiry),
      tokenType: 'Bearer'
    };
  }

  // Calculate token expiry time in seconds
  private getTokenExpiryTime(expiry: string): number {
    const unit = expiry.slice(-1);
    const value = parseInt(expiry.slice(0, -1));
    
    switch (unit) {
      case 's': return value;
      case 'm': return value * 60;
      case 'h': return value * 3600;
      case 'd': return value * 86400;
      default: return 900; // 15 minutes default
    }
  }

  // Register new user
  async register(userData: RegisterData, ipAddress?: string): Promise<{ user: User; tokens: AuthTokens }> {
    const { email, password, firstName, lastName, username } = userData;

    // Validate password strength
    const passwordValidation = securityUtils.validatePassword(password);
    if (!passwordValidation.valid) {
      throw new AppError(`Password validation failed: ${passwordValidation.errors.join(', ')}`, 400);
    }

    // Check if user already exists
    const existingUser = await query(
      'SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL',
      [email.toLowerCase()]
    );

    if (existingUser.rows.length > 0) {
      throw new AppError('User already exists with this email', 409);
    }

    // Check username uniqueness if provided
    if (username) {
      const existingUsername = await query(
        'SELECT id FROM users WHERE username = $1 AND deleted_at IS NULL',
        [username]
      );

      if (existingUsername.rows.length > 0) {
        throw new AppError('Username already taken', 409);
      }
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, securityConfig.bcrypt.saltRounds);

    // Create user in transaction
    const result = await withTransaction(async (client) => {
      // Insert user
      const userResult = await client.query(`
        INSERT INTO users (
          email, password_hash, first_name, last_name, username,
          role, status, email_verified, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
        RETURNING id, email, username, first_name, last_name, role, status, 
                  email_verified, avatar_url, created_at, last_login_at, login_count
      `, [
        email.toLowerCase(),
        passwordHash,
        firstName || null,
        lastName || null,
        username || null,
        'standard',
        'pending', // Require email verification
        false
      ]);

      const user = userResult.rows[0];

      // Generate email verification token
      const verificationToken = securityUtils.generateToken(32);
      const tokenHash = securityUtils.hashData(verificationToken);
      
      await client.query(`
        INSERT INTO email_verification_tokens (
          user_id, token_hash, email, expires_at, created_at
        ) VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours', NOW())
      `, [user.id, tokenHash, email.toLowerCase()]);

      // Log registration event
      logger.info('User registered successfully', {
        userId: user.id,
        email: user.email,
        ipAddress,
        timestamp: new Date()
      });

      return { user, verificationToken };
    });

    // Generate tokens
    const tokens = this.generateTokens(result.user);

    // Store refresh token
    await this.storeRefreshToken(
      result.user.id,
      tokens.refreshToken,
      { ipAddress, userAgent: 'registration' }
    );

    return {
      user: result.user,
      tokens
    };
  }

  // Login user
  async login(credentials: LoginCredentials, deviceInfo?: any, ipAddress?: string): Promise<{ user: User; tokens: AuthTokens }> {
    const { email, password, rememberMe } = credentials;

    // Get user with password hash
    const userResult = await query(`
      SELECT id, email, username, first_name, last_name, password_hash,
             role, status, email_verified, avatar_url, created_at, 
             last_login_at, login_count
      FROM users 
      WHERE email = $1 AND deleted_at IS NULL
    `, [email.toLowerCase()]);

    if (userResult.rows.length === 0) {
      throw new AppError('Invalid credentials', 401);
    }

    const user = userResult.rows[0];

    // Check account status
    if (user.status === 'suspended') {
      throw new AppError('Account is suspended', 403);
    }

    if (user.status === 'deactivated') {
      throw new AppError('Account is deactivated', 403);
    }

    // Verify password
    if (!user.password_hash) {
      throw new AppError('Please login using OAuth provider', 400);
    }

    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      // Log failed login attempt
      logger.warn('Failed login attempt', {
        email: user.email,
        ipAddress,
        timestamp: new Date()
      });
      throw new AppError('Invalid credentials', 401);
    }

    // Update login information
    await query(`
      UPDATE users 
      SET last_login_at = NOW(), login_count = login_count + 1, updated_at = NOW()
      WHERE id = $1
    `, [user.id]);

    // Clean up expired refresh tokens for this user
    await this.cleanupExpiredTokens(user.id);

    // Check session limits
    await this.enforceSessionLimits(user.id);

    // Generate tokens
    const tokens = this.generateTokens(user, deviceInfo);

    // Store refresh token
    await this.storeRefreshToken(
      user.id,
      tokens.refreshToken,
      { ...deviceInfo, ipAddress, rememberMe }
    );

    // Log successful login
    logger.info('User login successful', {
      userId: user.id,
      email: user.email,
      ipAddress,
      deviceInfo: deviceInfo?.deviceType || 'unknown',
      timestamp: new Date()
    });

    // Remove password hash from response
    delete user.password_hash;

    return {
      user: user as User,
      tokens
    };
  }

  // Refresh access token
  async refreshToken(refreshToken: string, deviceInfo?: any): Promise<AuthTokens> {
    try {
      // Verify refresh token
      const decoded = jwt.verify(
        refreshToken,
        process.env.JWT_REFRESH_SECRET || securityConfig.jwt.secret
      ) as any;

      if (decoded.type !== 'refresh') {
        throw new AppError('Invalid token type', 401);
      }

      // Check if refresh token exists and is not revoked
      const tokenHash = securityUtils.hashData(refreshToken);
      const tokenResult = await query(`
        SELECT rt.*, u.email, u.role, u.status, u.email_verified
        FROM user_refresh_tokens rt
        JOIN users u ON rt.user_id = u.id
        WHERE rt.user_id = $1 AND rt.token_hash = $2 
          AND rt.expires_at > NOW() AND rt.revoked_at IS NULL
          AND u.deleted_at IS NULL
      `, [decoded.userId, tokenHash]);

      if (tokenResult.rows.length === 0) {
        throw new AppError('Invalid or expired refresh token', 401);
      }

      const tokenData = tokenResult.rows[0];
      const user: User = {
        id: tokenData.user_id,
        email: tokenData.email,
        role: tokenData.role,
        status: tokenData.status,
        email_verified: tokenData.email_verified,
        created_at: tokenData.created_at,
        login_count: 0
      };

      // Check account status
      if (user.status !== 'active') {
        throw new AppError('Account is not active', 403);
      }

      // Generate new tokens
      const tokens = this.generateTokens(user, deviceInfo);

      // Update last used timestamp
      await query(`
        UPDATE user_refresh_tokens 
        SET last_used_at = NOW()
        WHERE id = $1
      `, [tokenData.id]);

      // Store new refresh token and revoke old one
      await withTransaction(async (client) => {
        // Revoke current token
        await client.query(`
          UPDATE user_refresh_tokens 
          SET revoked_at = NOW()
          WHERE id = $1
        `, [tokenData.id]);

        // Store new refresh token
        const newTokenHash = securityUtils.hashData(tokens.refreshToken);
        await client.query(`
          INSERT INTO user_refresh_tokens (
            user_id, token_hash, device_info, ip_address, user_agent,
            expires_at, created_at, last_used_at
          ) VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '${securityConfig.jwt.refreshTokenExpiry}', NOW(), NOW())
        `, [
          user.id,
          newTokenHash,
          deviceInfo ? JSON.stringify(deviceInfo) : null,
          deviceInfo?.ipAddress || null,
          deviceInfo?.userAgent || null
        ]);
      });

      return tokens;

    } catch (error) {
      if (error instanceof jwt.JsonWebTokenError) {
        throw new AppError('Invalid refresh token', 401);
      }
      throw error;
    }
  }

  // Store refresh token securely
  private async storeRefreshToken(
    userId: string,
    refreshToken: string,
    deviceInfo?: any
  ): Promise<void> {
    const tokenHash = securityUtils.hashData(refreshToken);
    
    await query(`
      INSERT INTO user_refresh_tokens (
        user_id, token_hash, device_info, ip_address, user_agent,
        expires_at, created_at, last_used_at
      ) VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '${securityConfig.jwt.refreshTokenExpiry}', NOW(), NOW())
    `, [
      userId,
      tokenHash,
      deviceInfo ? JSON.stringify(deviceInfo) : null,
      deviceInfo?.ipAddress || null,
      deviceInfo?.userAgent || null
    ]);
  }

  // Logout user (revoke refresh token)
  async logout(refreshToken: string): Promise<void> {
    const tokenHash = securityUtils.hashData(refreshToken);
    
    await query(`
      UPDATE user_refresh_tokens 
      SET revoked_at = NOW()
      WHERE token_hash = $1 AND revoked_at IS NULL
    `, [tokenHash]);
  }

  // Logout from all devices
  async logoutAll(userId: string): Promise<void> {
    await query(`
      UPDATE user_refresh_tokens 
      SET revoked_at = NOW()
      WHERE user_id = $1 AND revoked_at IS NULL
    `, [userId]);

    logger.info('User logged out from all devices', { userId });
  }

  // Clean up expired tokens
  private async cleanupExpiredTokens(userId: string): Promise<void> {
    await query(`
      DELETE FROM user_refresh_tokens 
      WHERE user_id = $1 AND (expires_at < NOW() OR revoked_at IS NOT NULL)
    `, [userId]);
  }

  // Enforce session limits
  private async enforceSessionLimits(userId: string): Promise<void> {
    const activeTokens = await query(`
      SELECT id, created_at 
      FROM user_refresh_tokens 
      WHERE user_id = $1 AND expires_at > NOW() AND revoked_at IS NULL
      ORDER BY created_at ASC
    `, [userId]);

    if (activeTokens.rows.length >= securityConfig.session.maxSessions) {
      // Revoke oldest sessions
      const tokensToRevoke = activeTokens.rows.slice(0, activeTokens.rows.length - securityConfig.session.maxSessions + 1);
      const tokenIds = tokensToRevoke.map(token => token.id);

      await query(`
        UPDATE user_refresh_tokens 
        SET revoked_at = NOW()
        WHERE id = ANY($1)
      `, [tokenIds]);
    }
  }

  // Verify email address
  async verifyEmail(token: string): Promise<void> {
    const tokenHash = securityUtils.hashData(token);
    
    const tokenResult = await query(`
      SELECT user_id, email 
      FROM email_verification_tokens 
      WHERE token_hash = $1 AND expires_at > NOW() AND used_at IS NULL
    `, [tokenHash]);

    if (tokenResult.rows.length === 0) {
      throw new AppError('Invalid or expired verification token', 400);
    }

    const { user_id, email } = tokenResult.rows[0];

    await withTransaction(async (client) => {
      // Mark user as verified and active
      await client.query(`
        UPDATE users 
        SET email_verified = true, status = 'active', updated_at = NOW()
        WHERE id = $1
      `, [user_id]);

      // Mark token as used
      await client.query(`
        UPDATE email_verification_tokens 
        SET used_at = NOW()
        WHERE token_hash = $1
      `, [tokenHash]);
    });

    logger.info('Email verified successfully', { userId: user_id, email });
  }

  // Get user by ID
  async getUserById(userId: string): Promise<User | null> {
    const result = await query(`
      SELECT id, email, username, first_name, last_name, role, status,
             email_verified, avatar_url, created_at, last_login_at, login_count
      FROM users 
      WHERE id = $1 AND deleted_at IS NULL
    `, [userId]);

    return result.rows[0] || null;
  }

  // Update user profile
  async updateProfile(userId: string, updates: Partial<User>): Promise<User> {
    const allowedFields = ['first_name', 'last_name', 'username', 'avatar_url'];
    const updateFields = Object.keys(updates)
      .filter(key => allowedFields.includes(key) && updates[key] !== undefined);

    if (updateFields.length === 0) {
      throw new AppError('No valid fields to update', 400);
    }

    const setClause = updateFields
      .map((field, index) => `${field} = $${index + 2}`)
      .join(', ');
    
    const values = [userId, ...updateFields.map(field => updates[field])];

    const result = await query(`
      UPDATE users 
      SET ${setClause}, updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id, email, username, first_name, last_name, role, status,
                email_verified, avatar_url, created_at, last_login_at, login_count
    `, values);

    if (result.rows.length === 0) {
      throw new AppError('User not found', 404);
    }

    return result.rows[0];
  }

  // Change password
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    // Get current password hash
    const userResult = await query(`
      SELECT password_hash FROM users WHERE id = $1 AND deleted_at IS NULL
    `, [userId]);

    if (userResult.rows.length === 0) {
      throw new AppError('User not found', 404);
    }

    const { password_hash } = userResult.rows[0];

    // Verify current password
    if (!password_hash) {
      throw new AppError('Cannot change password for OAuth users', 400);
    }

    const isValidPassword = await bcrypt.compare(currentPassword, password_hash);
    if (!isValidPassword) {
      throw new AppError('Current password is incorrect', 400);
    }

    // Validate new password
    const passwordValidation = securityUtils.validatePassword(newPassword);
    if (!passwordValidation.valid) {
      throw new AppError(`Password validation failed: ${passwordValidation.errors.join(', ')}`, 400);
    }

    // Hash new password
    const newPasswordHash = await bcrypt.hash(newPassword, securityConfig.bcrypt.saltRounds);

    // Update password and revoke all refresh tokens
    await withTransaction(async (client) => {
      await client.query(`
        UPDATE users 
        SET password_hash = $1, updated_at = NOW()
        WHERE id = $2
      `, [newPasswordHash, userId]);

      await client.query(`
        UPDATE user_refresh_tokens 
        SET revoked_at = NOW()
        WHERE user_id = $1 AND revoked_at IS NULL
      `, [userId]);
    });

    logger.info('Password changed successfully', { userId });
  }
}