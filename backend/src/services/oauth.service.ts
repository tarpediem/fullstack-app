import axios from 'axios';
import jwt from 'jsonwebtoken';
import { query, withTransaction } from '../config/database';
import { securityConfig, securityUtils } from '../config/security';
import { AuthService } from './auth.service';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';

export interface OAuthProvider {
  id: string;
  name: string;
  getAuthUrl(state: string): string;
  exchangeCodeForToken(code: string): Promise<string>;
  getUserInfo(accessToken: string): Promise<OAuthUserInfo>;
}

export interface OAuthUserInfo {
  id: string;
  email: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  avatarUrl?: string;
  emailVerified?: boolean;
}

export interface OAuthState {
  provider: string;
  redirectUrl?: string;
  timestamp: number;
  nonce: string;
}

export class GoogleOAuthProvider implements OAuthProvider {
  id = 'google';
  name = 'Google';

  private readonly clientId = securityConfig.oauth.google.clientId;
  private readonly clientSecret = securityConfig.oauth.google.clientSecret;
  private readonly callbackUrl = securityConfig.oauth.google.callbackUrl;

  getAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.callbackUrl,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      access_type: 'offline',
      prompt: 'consent'
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async exchangeCodeForToken(code: string): Promise<string> {
    try {
      const response = await axios.post('https://oauth2.googleapis.com/token', {
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: this.callbackUrl
      });

      return response.data.access_token;
    } catch (error) {
      logger.error('Google OAuth token exchange failed:', error.response?.data || error.message);
      throw new AppError('Failed to exchange code for token', 400);
    }
  }

  async getUserInfo(accessToken: string): Promise<OAuthUserInfo> {
    try {
      const response = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      });

      const data = response.data;
      return {
        id: data.id,
        email: data.email,
        name: data.name,
        firstName: data.given_name,
        lastName: data.family_name,
        avatarUrl: data.picture,
        emailVerified: data.verified_email
      };
    } catch (error) {
      logger.error('Google OAuth user info request failed:', error.response?.data || error.message);
      throw new AppError('Failed to get user information', 400);
    }
  }
}

export class GitHubOAuthProvider implements OAuthProvider {
  id = 'github';
  name = 'GitHub';

  private readonly clientId = securityConfig.oauth.github.clientId;
  private readonly clientSecret = securityConfig.oauth.github.clientSecret;
  private readonly callbackUrl = securityConfig.oauth.github.callbackUrl;

  getAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.callbackUrl,
      scope: 'user:email',
      state,
      allow_signup: 'true'
    });

    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  async exchangeCodeForToken(code: string): Promise<string> {
    try {
      const response = await axios.post(
        'https://github.com/login/oauth/access_token',
        {
          client_id: this.clientId,
          client_secret: this.clientSecret,
          code
        },
        {
          headers: {
            Accept: 'application/json',
            'User-Agent': 'AI-News-App'
          }
        }
      );

      return response.data.access_token;
    } catch (error) {
      logger.error('GitHub OAuth token exchange failed:', error.response?.data || error.message);
      throw new AppError('Failed to exchange code for token', 400);
    }
  }

  async getUserInfo(accessToken: string): Promise<OAuthUserInfo> {
    try {
      // Get user info
      const userResponse = await axios.get('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': 'AI-News-App'
        }
      });

      // Get user emails
      const emailResponse = await axios.get('https://api.github.com/user/emails', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': 'AI-News-App'
        }
      });

      const userData = userResponse.data;
      const emails = emailResponse.data;
      const primaryEmail = emails.find(email => email.primary) || emails[0];

      const nameParts = (userData.name || '').split(' ');
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';

      return {
        id: userData.id.toString(),
        email: primaryEmail.email,
        name: userData.name,
        firstName,
        lastName,
        avatarUrl: userData.avatar_url,
        emailVerified: primaryEmail.verified
      };
    } catch (error) {
      logger.error('GitHub OAuth user info request failed:', error.response?.data || error.message);
      throw new AppError('Failed to get user information', 400);
    }
  }
}

export class OAuthService {
  private providers: Map<string, OAuthProvider> = new Map();
  private authService = new AuthService();

  constructor() {
    // Register providers
    if (securityConfig.oauth.google.clientId) {
      this.providers.set('google', new GoogleOAuthProvider());
    }
    if (securityConfig.oauth.github.clientId) {
      this.providers.set('github', new GitHubOAuthProvider());
    }
  }

  // Get available OAuth providers
  getAvailableProviders(): { id: string; name: string }[] {
    return Array.from(this.providers.values()).map(provider => ({
      id: provider.id,
      name: provider.name
    }));
  }

  // Generate OAuth authorization URL
  getAuthorizationUrl(providerId: string, redirectUrl?: string): string {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new AppError('OAuth provider not found', 404);
    }

    const state = this.generateState(providerId, redirectUrl);
    return provider.getAuthUrl(state);
  }

  // Handle OAuth callback
  async handleCallback(
    providerId: string,
    code: string,
    state: string,
    deviceInfo?: any,
    ipAddress?: string
  ) {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new AppError('OAuth provider not found', 404);
    }

    // Validate state
    const stateData = this.validateState(state, providerId);

    try {
      // Exchange code for access token
      const accessToken = await provider.exchangeCodeForToken(code);

      // Get user information
      const userInfo = await provider.getUserInfo(accessToken);

      // Find or create user
      const result = await this.findOrCreateUser(providerId, userInfo, ipAddress);

      // Generate JWT tokens
      const tokens = await this.authService.login(
        { email: result.user.email, password: '' }, // OAuth users don't have passwords
        deviceInfo,
        ipAddress
      );

      logger.info('OAuth login successful', {
        userId: result.user.id,
        provider: providerId,
        email: result.user.email,
        ipAddress
      });

      return {
        user: result.user,
        tokens: tokens.tokens,
        isNewUser: result.isNewUser,
        redirectUrl: stateData.redirectUrl
      };

    } catch (error) {
      logger.error('OAuth callback error:', {
        provider: providerId,
        error: error.message,
        ipAddress
      });
      throw error;
    }
  }

  // Find or create user from OAuth data
  private async findOrCreateUser(
    providerId: string,
    userInfo: OAuthUserInfo,
    ipAddress?: string
  ) {
    return await withTransaction(async (client) => {
      // Check if user already exists with this OAuth provider
      const existingAuthResult = await client.query(`
        SELECT u.* FROM users u
        JOIN user_auth_providers uap ON u.id = uap.user_id
        WHERE uap.provider = $1 AND uap.provider_user_id = $2
          AND u.deleted_at IS NULL
      `, [providerId, userInfo.id]);

      if (existingAuthResult.rows.length > 0) {
        // Update provider data and return existing user
        await client.query(`
          UPDATE user_auth_providers 
          SET provider_email = $1, provider_data = $2, updated_at = NOW()
          WHERE provider = $3 AND provider_user_id = $4
        `, [
          userInfo.email,
          JSON.stringify({
            name: userInfo.name,
            avatarUrl: userInfo.avatarUrl,
            emailVerified: userInfo.emailVerified
          }),
          providerId,
          userInfo.id
        ]);

        return { user: existingAuthResult.rows[0], isNewUser: false };
      }

      // Check if user exists with same email
      const emailUserResult = await client.query(`
        SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL
      `, [userInfo.email.toLowerCase()]);

      let user;
      let isNewUser = false;

      if (emailUserResult.rows.length > 0) {
        // Link OAuth provider to existing user
        user = emailUserResult.rows[0];
        
        await client.query(`
          INSERT INTO user_auth_providers (
            user_id, provider, provider_user_id, provider_email, 
            provider_data, is_primary, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
        `, [
          user.id,
          providerId,
          userInfo.id,
          userInfo.email,
          JSON.stringify({
            name: userInfo.name,
            avatarUrl: userInfo.avatarUrl,
            emailVerified: userInfo.emailVerified
          }),
          false // Not primary since user already exists
        ]);

      } else {
        // Create new user
        const userResult = await client.query(`
          INSERT INTO users (
            email, first_name, last_name, avatar_url,
            role, status, email_verified, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
          RETURNING *
        `, [
          userInfo.email.toLowerCase(),
          userInfo.firstName || '',
          userInfo.lastName || '',
          userInfo.avatarUrl || null,
          'standard',
          'active', // OAuth users are active by default
          userInfo.emailVerified || false
        ]);

        user = userResult.rows[0];
        isNewUser = true;

        // Add OAuth provider
        await client.query(`
          INSERT INTO user_auth_providers (
            user_id, provider, provider_user_id, provider_email,
            provider_data, is_primary, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
        `, [
          user.id,
          providerId,
          userInfo.id,
          userInfo.email,
          JSON.stringify({
            name: userInfo.name,
            avatarUrl: userInfo.avatarUrl,
            emailVerified: userInfo.emailVerified
          }),
          true // Primary provider for new user
        ]);
      }

      // Update login info
      await client.query(`
        UPDATE users 
        SET last_login_at = NOW(), login_count = login_count + 1, updated_at = NOW()
        WHERE id = $1
      `, [user.id]);

      return { user, isNewUser };
    });
  }

  // Generate secure state parameter
  private generateState(providerId: string, redirectUrl?: string): string {
    const stateData: OAuthState = {
      provider: providerId,
      redirectUrl,
      timestamp: Date.now(),
      nonce: securityUtils.generateToken(16)
    };

    // Encrypt state data
    const stateJson = JSON.stringify(stateData);
    return Buffer.from(stateJson).toString('base64url');
  }

  // Validate state parameter
  private validateState(state: string, expectedProvider: string): OAuthState {
    try {
      const stateJson = Buffer.from(state, 'base64url').toString('utf8');
      const stateData: OAuthState = JSON.parse(stateJson);

      // Validate provider
      if (stateData.provider !== expectedProvider) {
        throw new AppError('Invalid OAuth state: provider mismatch', 400);
      }

      // Check expiration (30 minutes)
      const maxAge = 30 * 60 * 1000; // 30 minutes
      if (Date.now() - stateData.timestamp > maxAge) {
        throw new AppError('OAuth state has expired', 400);
      }

      return stateData;
    } catch (error) {
      logger.warn('Invalid OAuth state received:', { state, error: error.message });
      throw new AppError('Invalid OAuth state', 400);
    }
  }

  // Unlink OAuth provider from user account
  async unlinkProvider(userId: string, providerId: string): Promise<void> {
    const result = await query(`
      DELETE FROM user_auth_providers 
      WHERE user_id = $1 AND provider = $2
      RETURNING id
    `, [userId, providerId]);

    if (result.rows.length === 0) {
      throw new AppError('OAuth provider not linked to this account', 404);
    }

    // Check if user still has password or other providers
    const authMethodsResult = await query(`
      SELECT 
        (CASE WHEN password_hash IS NOT NULL THEN 1 ELSE 0 END) as has_password,
        (SELECT COUNT(*) FROM user_auth_providers WHERE user_id = $1) as provider_count
      FROM users 
      WHERE id = $1
    `, [userId]);

    const authMethods = authMethodsResult.rows[0];
    if (!authMethods.has_password && authMethods.provider_count === 0) {
      throw new AppError('Cannot unlink last authentication method', 400);
    }

    logger.info('OAuth provider unlinked', { userId, provider: providerId });
  }

  // Get linked providers for user
  async getUserProviders(userId: string): Promise<Array<{ provider: string; linkedAt: Date }>> {
    const result = await query(`
      SELECT provider, created_at as linked_at
      FROM user_auth_providers 
      WHERE user_id = $1
      ORDER BY created_at DESC
    `, [userId]);

    return result.rows;
  }
}