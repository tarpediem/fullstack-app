/**
 * OpenRouter API Routes
 * Defines all endpoints for OpenRouter integration
 */

import { Router } from 'express';
import { body, query, param } from 'express-validator';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../middleware/auth';
import {
  updateSettings,
  getSettings,
  deleteSettings,
  getModels,
  getModelInfo,
  summarizeArticles,
  getBatchJobStatus,
  getUsageStats,
  checkLimits,
  getHealthStatus,
  getActiveConnections,
  emergencyStop
} from '../controllers/openrouter.controller';

const router = Router();

// Rate limiting configurations
const settingsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 requests per window
  message: {
    success: false,
    message: 'Too many settings requests, please try again later'
  }
});

const summarizationLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // 5 summarization requests per minute
  message: {
    success: false,
    message: 'Too many summarization requests, please try again later'
  }
});

const modelsLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 30, // 30 requests per window
  message: {
    success: false,
    message: 'Too many model requests, please try again later'
  }
});

// Validation schemas
const settingsValidation = [
  body('api_key_encrypted')
    .optional()
    .isString()
    .isLength({ min: 10, max: 1000 })
    .withMessage('API key must be between 10 and 1000 characters'),
  
  body('preferred_models')
    .optional()
    .isObject()
    .withMessage('Preferred models must be an object'),
  
  body('preferred_models.summarization')
    .optional()
    .isString()
    .isLength({ min: 1, max: 100 })
    .withMessage('Summarization model must be a valid string'),
  
  body('preferred_models.chat')
    .optional()
    .isString()
    .isLength({ min: 1, max: 100 })
    .withMessage('Chat model must be a valid string'),
  
  body('preferred_models.fallback')
    .optional()
    .isString()
    .isLength({ min: 1, max: 100 })
    .withMessage('Fallback model must be a valid string'),
  
  body('usage_limits')
    .optional()
    .isObject()
    .withMessage('Usage limits must be an object'),
  
  body('usage_limits.daily_cost_limit')
    .optional()
    .isFloat({ min: 0, max: 1000 })
    .withMessage('Daily cost limit must be between 0 and 1000'),
  
  body('usage_limits.monthly_cost_limit')
    .optional()
    .isFloat({ min: 0, max: 10000 })
    .withMessage('Monthly cost limit must be between 0 and 10000'),
  
  body('usage_limits.requests_per_hour')
    .optional()
    .isInt({ min: 1, max: 10000 })
    .withMessage('Requests per hour must be between 1 and 10000'),
  
  body('usage_limits.tokens_per_hour')
    .optional()
    .isInt({ min: 100, max: 1000000 })
    .withMessage('Tokens per hour must be between 100 and 1000000'),
  
  body('preferences')
    .optional()
    .isObject()
    .withMessage('Preferences must be an object'),
  
  body('preferences.temperature')
    .optional()
    .isFloat({ min: 0, max: 2 })
    .withMessage('Temperature must be between 0 and 2'),
  
  body('preferences.max_tokens')
    .optional()
    .isInt({ min: 10, max: 100000 })
    .withMessage('Max tokens must be between 10 and 100000'),
  
  body('preferences.enable_streaming')
    .optional()
    .isBoolean()
    .withMessage('Enable streaming must be a boolean'),
  
  body('preferences.fallback_enabled')
    .optional()
    .isBoolean()
    .withMessage('Fallback enabled must be a boolean'),
  
  body('preferences.cost_optimization')
    .optional()
    .isBoolean()
    .withMessage('Cost optimization must be a boolean')
];

const summarizationValidation = [
  body('articles')
    .isArray({ min: 1, max: 100 })
    .withMessage('Articles must be an array with 1-100 items'),
  
  body('articles.*.id')
    .isString()
    .isLength({ min: 1, max: 100 })
    .withMessage('Article ID must be a string between 1-100 characters'),
  
  body('articles.*.title')
    .isString()
    .isLength({ min: 1, max: 500 })
    .withMessage('Article title must be between 1-500 characters'),
  
  body('articles.*.content')
    .isString()
    .isLength({ min: 10, max: 100000 })
    .withMessage('Article content must be between 10-100000 characters'),
  
  body('articles.*.url')
    .optional()
    .isURL()
    .withMessage('Article URL must be a valid URL'),
  
  body('articles.*.source')
    .optional()
    .isString()
    .isLength({ max: 100 })
    .withMessage('Article source must be max 100 characters'),
  
  body('options')
    .isObject()
    .withMessage('Options must be an object'),
  
  body('options.model')
    .optional()
    .isString()
    .isLength({ min: 1, max: 100 })
    .withMessage('Model must be a string between 1-100 characters'),
  
  body('options.summary_length')
    .optional()
    .isIn(['short', 'medium', 'long'])
    .withMessage('Summary length must be short, medium, or long'),
  
  body('options.summary_style')
    .optional()
    .isIn(['bullet_points', 'paragraph', 'structured'])
    .withMessage('Summary style must be bullet_points, paragraph, or structured'),
  
  body('options.language')
    .optional()
    .isString()
    .isLength({ min: 2, max: 10 })
    .withMessage('Language must be 2-10 characters'),
  
  body('options.include_key_points')
    .optional()
    .isBoolean()
    .withMessage('Include key points must be a boolean'),
  
  body('options.include_sentiment')
    .optional()
    .isBoolean()
    .withMessage('Include sentiment must be a boolean'),
  
  body('options.batch_processing')
    .optional()
    .isBoolean()
    .withMessage('Batch processing must be a boolean')
];

const usageStatsValidation = [
  query('period')
    .optional()
    .isIn(['daily', 'weekly', 'monthly'])
    .withMessage('Period must be daily, weekly, or monthly')
];

const modelParamValidation = [
  param('modelId')
    .isString()
    .isLength({ min: 1, max: 200 })
    .withMessage('Model ID must be between 1-200 characters')
];

const jobParamValidation = [
  param('jobId')
    .isString()
    .matches(/^batch_[a-zA-Z0-9_-]+$/)
    .withMessage('Invalid job ID format')
];

// Settings endpoints
router.post('/settings', 
  authenticate, 
  settingsLimiter, 
  settingsValidation, 
  updateSettings
);

router.get('/settings', 
  authenticate, 
  settingsLimiter, 
  getSettings
);

router.delete('/settings', 
  authenticate, 
  settingsLimiter, 
  deleteSettings
);

// Model endpoints
router.get('/models', 
  modelsLimiter, 
  getModels
);

router.get('/models/:modelId', 
  modelsLimiter, 
  modelParamValidation, 
  getModelInfo
);

// Summarization endpoints
router.post('/summarize', 
  authenticate, 
  summarizationLimiter, 
  summarizationValidation, 
  summarizeArticles
);

router.get('/jobs/:jobId', 
  authenticate, 
  jobParamValidation, 
  getBatchJobStatus
);

// Usage and monitoring endpoints
router.get('/usage', 
  authenticate, 
  usageStatsValidation, 
  getUsageStats
);

router.get('/limits', 
  authenticate, 
  checkLimits
);

router.get('/health', 
  getHealthStatus
);

// Admin endpoints (require admin role)
router.get('/admin/connections', 
  authenticate, 
  getActiveConnections
);

router.post('/admin/emergency-stop', 
  authenticate, 
  emergencyStop
);

export default router;