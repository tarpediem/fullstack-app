import { Router } from 'express';
import {
  register,
  login,
  refreshToken,
  logout,
  logoutAll,
  verifyEmail,
  getProfile,
  updateProfile,
  changePassword,
  registerValidation,
  loginValidation,
  refreshTokenValidation
} from '../controllers/auth.controller';
import {
  authenticate,
  authorize,
  requireEmailVerified,
  logAuthEvent,
  secureAuthResponse
} from '../middleware/auth';
import { validateRequest } from '../middleware/validateRequest';
import { body } from 'express-validator';

const router = Router();

// Apply security headers to all auth routes
router.use(secureAuthResponse);

// Public routes
router.post('/register', registerValidation, validateRequest, register);
router.post('/login', loginValidation, validateRequest, logAuthEvent, login);
router.post('/refresh-token', refreshTokenValidation, validateRequest, refreshToken);
router.get('/verify-email/:token', verifyEmail);

// Protected routes (require authentication)
router.use(authenticate); // All routes below require authentication

router.post('/logout', logout);
router.post('/logout-all', logoutAll);
router.get('/profile', getProfile);

// Profile update validation
const updateProfileValidation = [
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
    .withMessage('Username must be 3-50 characters and contain only letters, numbers, and underscores'),
  body('avatarUrl')
    .optional()
    .isURL()
    .withMessage('Avatar URL must be a valid URL')
];

// Password change validation
const changePasswordValidation = [
  body('currentPassword')
    .notEmpty()
    .withMessage('Current password is required'),
  body('newPassword')
    .isLength({ min: 8 })
    .withMessage('New password must be at least 8 characters long')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/)
    .withMessage('New password must contain at least one lowercase letter, one uppercase letter, one number, and one special character')
];

router.patch('/profile', updateProfileValidation, validateRequest, updateProfile);
router.patch('/change-password', changePasswordValidation, validateRequest, changePassword);

// Admin only routes
router.get('/admin/users', authorize('admin'), (req, res) => {
  res.json({ message: 'Admin users endpoint - not implemented yet' });
});

export default router;