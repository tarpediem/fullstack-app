import { Request, Response, NextFunction } from 'express';
import { OAuthService } from '../services/oauth.service';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';

const oauthService = new OAuthService();

// Helper function to extract device info
const getDeviceInfo = (req: Request) => {
  const userAgent = req.headers['user-agent'] || '';
  const forwarded = req.headers['x-forwarded-for'];
  const ipAddress = (forwarded ? forwarded.toString().split(',')[0] : req.socket.remoteAddress) || '';

  return {
    userAgent,
    ipAddress: ipAddress.trim(),
    deviceType: getMobileDeviceType(userAgent),
    browser: getBrowser(userAgent),
    os: getOS(userAgent)
  };
};

const getMobileDeviceType = (userAgent: string): string => {
  if (/mobile/i.test(userAgent)) return 'mobile';
  if (/tablet/i.test(userAgent)) return 'tablet';
  return 'desktop';
};

const getBrowser = (userAgent: string): string => {
  if (userAgent.includes('Chrome')) return 'Chrome';
  if (userAgent.includes('Firefox')) return 'Firefox';
  if (userAgent.includes('Safari')) return 'Safari';
  if (userAgent.includes('Edge')) return 'Edge';
  return 'Unknown';
};

const getOS = (userAgent: string): string => {
  if (userAgent.includes('Windows')) return 'Windows';
  if (userAgent.includes('Mac')) return 'macOS';
  if (userAgent.includes('Linux')) return 'Linux';
  if (userAgent.includes('Android')) return 'Android';
  if (userAgent.includes('iOS')) return 'iOS';
  return 'Unknown';
};

// Get available OAuth providers
export const getProviders = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const providers = oauthService.getAvailableProviders();
    
    res.json({
      success: true,
      data: {
        providers: providers.map(provider => ({
          id: provider.id,
          name: provider.name,
          authUrl: `/api/auth/oauth/${provider.id}` // Will redirect to actual OAuth URL
        }))
      }
    });
  } catch (error) {
    next(error);
  }
};

// Initiate OAuth flow
export const initiateOAuth = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { provider } = req.params;
    const { redirectUrl } = req.query;

    if (!provider) {
      throw new AppError('OAuth provider is required', 400);
    }

    const authUrl = oauthService.getAuthorizationUrl(
      provider,
      redirectUrl as string
    );

    // For API responses, return the URL
    if (req.headers.accept?.includes('application/json')) {
      return res.json({
        success: true,
        data: {
          authUrl,
          provider
        }
      });
    }

    // For browser requests, redirect directly
    res.redirect(authUrl);
    
  } catch (error) {
    logger.error('OAuth initiation error:', {
      provider: req.params.provider,
      error: error.message,
      ip: req.ip
    });
    next(error);
  }
};

// Handle OAuth callback
export const handleCallback = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { provider } = req.params;
    const { code, state, error: oauthError } = req.query;

    // Check for OAuth provider errors
    if (oauthError) {
      logger.warn('OAuth provider error:', {
        provider,
        error: oauthError,
        description: req.query.error_description
      });
      
      const redirectUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/error?error=${encodeURIComponent(oauthError as string)}`;
      return res.redirect(redirectUrl);
    }

    if (!code || !state) {
      throw new AppError('Missing OAuth code or state parameter', 400);
    }

    const deviceInfo = getDeviceInfo(req);
    
    const result = await oauthService.handleCallback(
      provider,
      code as string,
      state as string,
      deviceInfo,
      deviceInfo.ipAddress
    );

    // Set refresh token as httpOnly cookie
    res.cookie('refreshToken', result.tokens.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    // Determine redirect URL
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const redirectUrl = result.redirectUrl || `${frontendUrl}/dashboard`;
    
    // Add auth success parameters
    const urlParams = new URLSearchParams({
      token: result.tokens.accessToken,
      isNewUser: result.isNewUser.toString(),
      provider
    });

    const finalRedirectUrl = `${redirectUrl}?${urlParams.toString()}`;

    // For API responses
    if (req.headers.accept?.includes('application/json')) {
      return res.json({
        success: true,
        message: `OAuth login with ${provider} successful`,
        data: {
          user: {
            id: result.user.id,
            email: result.user.email,
            username: result.user.username,
            firstName: result.user.first_name,
            lastName: result.user.last_name,
            role: result.user.role,
            status: result.user.status,
            emailVerified: result.user.email_verified,
            avatarUrl: result.user.avatar_url
          },
          tokens: {
            accessToken: result.tokens.accessToken,
            tokenType: result.tokens.tokenType,
            expiresIn: result.tokens.expiresIn
          },
          isNewUser: result.isNewUser,
          provider
        }
      });
    }

    // For browser requests, redirect to frontend
    res.redirect(finalRedirectUrl);

  } catch (error) {
    logger.error('OAuth callback error:', {
      provider: req.params.provider,
      error: error.message,
      ip: req.ip
    });

    // Redirect to error page for browser requests
    if (!req.headers.accept?.includes('application/json')) {
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      const errorUrl = `${frontendUrl}/auth/error?error=${encodeURIComponent(error.message)}`;
      return res.redirect(errorUrl);
    }

    next(error);
  }
};

// Unlink OAuth provider (requires authentication)
export const unlinkProvider = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { provider } = req.params;
    const userId = req.user?.userId;

    if (!userId) {
      throw new AppError('Authentication required', 401);
    }

    if (!provider) {
      throw new AppError('OAuth provider is required', 400);
    }

    await oauthService.unlinkProvider(userId, provider);

    res.json({
      success: true,
      message: `${provider} provider unlinked successfully`
    });

  } catch (error) {
    logger.error('OAuth unlink error:', {
      provider: req.params.provider,
      userId: req.user?.userId,
      error: error.message
    });
    next(error);
  }
};

// Get user's linked providers (requires authentication)
export const getLinkedProviders = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      throw new AppError('Authentication required', 401);
    }

    const linkedProviders = await oauthService.getUserProviders(userId);
    const availableProviders = oauthService.getAvailableProviders();

    const providersWithStatus = availableProviders.map(provider => ({
      id: provider.id,
      name: provider.name,
      linked: linkedProviders.some(linked => linked.provider === provider.id),
      linkedAt: linkedProviders.find(linked => linked.provider === provider.id)?.linked_at
    }));

    res.json({
      success: true,
      data: {
        providers: providersWithStatus
      }
    });

  } catch (error) {
    logger.error('Get linked providers error:', {
      userId: req.user?.userId,
      error: error.message
    });
    next(error);
  }
};