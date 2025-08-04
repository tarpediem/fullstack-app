import { Router } from 'express';
import authRoutes from './auth.routes';
import userRoutes from './user.routes';
import openrouterRoutes from './openrouter.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/openrouter', openrouterRoutes);

export default router;