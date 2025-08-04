import { Request, Response, NextFunction } from 'express';
import { body } from 'express-validator';
import { AuthService } from '../services/auth.service';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';

const authService = new AuthService();

// Validation rules
export const registerValidation = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Valid email is required'),
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long'),
  body('firstName')
    .optional()
    .isLength({ min: 1, max: 100 })
    .trim()
    .withMessage('First name must be 1-100 characters'),
  body('lastName')
    .optional()
    .isLength({ min: 1, max: 100 })
    .trim()
    .withMessage('Last name must be 1-100 characters'),
  body('username')
    .optional()
    .isLength({ min: 3, max: 50 })
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage('Username must be 3-50 characters and contain only letters, numbers, and underscores')
];

export const loginValidation = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Valid email is required'),
  body('password')
    .notEmpty()
    .withMessage('Password is required'),
  body('rememberMe')
    .optional()
    .isBoolean()
    .withMessage('Remember me must be a boolean')
];

export const refreshTokenValidation = [
  body('refreshToken')
    .notEmpty()
    .withMessage('Refresh token is required')
];

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

export const register = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { email, password, firstName, lastName, username } = req.body;
    const deviceInfo = getDeviceInfo(req);

    const result = await authService.register(
      { email, password, firstName, lastName, username },
      deviceInfo.ipAddress
    );

    // Set refresh token as httpOnly cookie
    res.cookie('refreshToken', result.tokens.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    res.status(201).json({
      success: true,
      message: 'User registered successfully. Please check your email to verify your account.',
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
        }
      }
    });

  } catch (error) {
    logger.error('Registration error:', { error: error.message, email: req.body.email });
    next(error);
  }
};

export const login = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { email, password, rememberMe = false } = req.body;
    const deviceInfo = getDeviceInfo(req);

    const result = await authService.login(
      { email, password, rememberMe },
      deviceInfo,
      deviceInfo.ipAddress
    );

    // Set refresh token as httpOnly cookie
    const cookieMaxAge = rememberMe ? 30 * 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000; // 30 days or 7 days
    res.cookie('refreshToken', result.tokens.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: cookieMaxAge
    });

    res.json({
      success: true,
      message: 'Login successful',
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
          avatarUrl: result.user.avatar_url,
          lastLoginAt: result.user.last_login_at,
          loginCount: result.user.login_count
        },
        tokens: {
          accessToken: result.tokens.accessToken,
          tokenType: result.tokens.tokenType,
          expiresIn: result.tokens.expiresIn
        }
      }
    });

  } catch (error) {
    logger.error('Login error:', { error: error.message, email: req.body.email });
    next(error);
  }
};

export const refreshToken = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    // Try to get refresh token from cookie first, then from body
    const refreshToken = req.cookies.refreshToken || req.body.refreshToken;
    
    if (!refreshToken) {
      throw new AppError('Refresh token is required', 401);
    }

    const deviceInfo = getDeviceInfo(req);
    const tokens = await authService.refreshToken(refreshToken, deviceInfo);

    // Update refresh token cookie
    res.cookie('refreshToken', tokens.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    res.json({
      success: true,
      message: 'Token refreshed successfully',
      data: {
        tokens: {
          accessToken: tokens.accessToken,
          tokenType: tokens.tokenType,
          expiresIn: tokens.expiresIn
        }
      }
    });

  } catch (error) {
    logger.error('Token refresh error:', { error: error.message });
    next(error);
  }
};

export const logout = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const refreshToken = req.cookies.refreshToken || req.body.refreshToken;
    
    if (refreshToken) {
      await authService.logout(refreshToken);
    }

    // Clear refresh token cookie
    res.clearCookie('refreshToken');

    res.json({
      success: true,
      message: 'Logout successful'
    });

  } catch (error) {
    logger.error('Logout error:', { error: error.message });
    next(error);
  }
};

export const logoutAll = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user?.userId;
    
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    await authService.logoutAll(userId);

    // Clear refresh token cookie
    res.clearCookie('refreshToken');

    res.json({
      success: true,
      message: 'Logged out from all devices successfully'
    });

  } catch (error) {
    logger.error('Logout all error:', { error: error.message, userId: req.user?.userId });
    next(error);
  }
};

export const verifyEmail = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { token } = req.params;
    
    if (!token) {
      throw new AppError('Verification token is required', 400);
    }

    await authService.verifyEmail(token);

    res.json({
      success: true,
      message: 'Email verified successfully'
    });

  } catch (error) {
    logger.error('Email verification error:', { error: error.message, token: req.params.token });
    next(error);
  }
};

export const getProfile = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user?.userId;
    
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    const user = await authService.getUserById(userId);
    
    if (!user) {
      throw new AppError('User not found', 404);
    }

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          firstName: user.first_name,
          lastName: user.last_name,
          role: user.role,
          status: user.status,
          emailVerified: user.email_verified,
          avatarUrl: user.avatar_url,
          createdAt: user.created_at,
          lastLoginAt: user.last_login_at,
          loginCount: user.login_count
        }
      }
    });

  } catch (error) {
    logger.error('Get profile error:', { error: error.message, userId: req.user?.userId });
    next(error);
  }
};

export const updateProfile = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user?.userId;
    const { firstName, lastName, username, avatarUrl } = req.body;
    
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    const updatedUser = await authService.updateProfile(userId, {
      first_name: firstName,
      last_name: lastName,
      username,
      avatar_url: avatarUrl
    });

    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: {
        user: {
          id: updatedUser.id,
          email: updatedUser.email,
          username: updatedUser.username,
          firstName: updatedUser.first_name,
          lastName: updatedUser.last_name,
          role: updatedUser.role,
          status: updatedUser.status,
          emailVerified: updatedUser.email_verified,
          avatarUrl: updatedUser.avatar_url
        }
      }
    });

  } catch (error) {
    logger.error('Profile update error:', { error: error.message, userId: req.user?.userId });
    next(error);
  }
};

export const changePassword = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user?.userId;
    const { currentPassword, newPassword } = req.body;
    
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    if (!currentPassword || !newPassword) {
      throw new AppError('Current password and new password are required', 400);
    }

    await authService.changePassword(userId, currentPassword, newPassword);

    res.json({
      success: true,
      message: 'Password changed successfully. Please login again with your new password.'
    });

  } catch (error) {
    logger.error('Password change error:', { error: error.message, userId: req.user?.userId });
    next(error);
  }
};