import { Router } from 'express';
import {
  getProviders,
  initiateOAuth,
  handleCallback,
  unlinkProvider,
  getLinkedProviders
} from '../controllers/oauth.controller';
import { authenticate } from '../middleware/auth';
import { param } from 'express-validator';
import { validateRequest } from '../middleware/validateRequest';

const router = Router();

// Provider validation middleware
const validateProvider = [
  param('provider')
    .isIn(['google', 'github'])
    .withMessage('Invalid OAuth provider. Supported providers: google, github')
];

// Public OAuth routes
router.get('/providers', getProviders);
router.get('/:provider', validateProvider, validateRequest, initiateOAuth);
router.get('/:provider/callback', validateProvider, validateRequest, handleCallback);

// Protected OAuth routes (require authentication)
router.use(authenticate);

router.get('/user/providers', getLinkedProviders);
router.delete('/:provider/unlink', validateProvider, validateRequest, unlinkProvider);

export default router;