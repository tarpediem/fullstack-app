import { Router } from 'express';
import { body, query, param } from 'express-validator';
import { AIController } from '../controllers/ai.controller';
import { authMiddleware } from '../middleware/auth';
import { rateLimitMiddleware } from '../middleware/rateLimit';

/**
 * AI Routes - Define all AI/ML related API endpoints
 * 
 * Provides comprehensive API for:
 * - Content search and discovery
 * - Personalized recommendations
 * - Content analysis and categorization
 * - Trending topics and analytics
 * - System monitoring and health checks
 */
export function createAIRoutes(aiController: AIController): Router {
  const router = Router();

  // Apply rate limiting to all AI routes
  router.use(rateLimitMiddleware({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: 'Too many AI requests from this IP, please try again later.',
  }));

  /**
   * POST /api/ai/search
   * Intelligent content search with personalization
   */
  router.post('/search',
    [
      body('query')
        .notEmpty()
        .withMessage('Search query is required')
        .isLength({ min: 1, max: 500 })
        .withMessage('Query must be between 1 and 500 characters'),
      body('userId')
        .optional()
        .isUUID()
        .withMessage('User ID must be a valid UUID'),
      body('limit')
        .optional()
        .isInt({ min: 1, max: 100 })
        .withMessage('Limit must be between 1 and 100'),
      body('searchType')
        .optional()
        .isIn(['semantic', 'fulltext', 'hybrid', 'auto'])
        .withMessage('Invalid search type'),
      body('filters.categories')
        .optional()
        .isArray()
        .withMessage('Categories must be an array'),
      body('filters.qualityThreshold')
        .optional()
        .isInt({ min: 0, max: 100 })
        .withMessage('Quality threshold must be between 0 and 100'),
    ],
    aiController.search.bind(aiController)
  );

  /**
   * GET /api/ai/recommendations/:userId
   * Get personalized content recommendations
   */
  router.get('/recommendations/:userId',
    authMiddleware, // Require authentication for personalized recommendations
    [
      param('userId')
        .isUUID()
        .withMessage('User ID must be a valid UUID'),
      query('limit')
        .optional()
        .isInt({ min: 1, max: 50 })
        .withMessage('Limit must be between 1 and 50'),
      query('diversityFactor')
        .optional()
        .isFloat({ min: 0, max: 1 })
        .withMessage('Diversity factor must be between 0 and 1'),
    ],
    aiController.getRecommendations.bind(aiController)
  );

  /**
   * POST /api/ai/analyze
   * Analyze content comprehensively
   */
  router.post('/analyze',
    authMiddleware, // Require authentication for content analysis
    [
      body('contentId')
        .notEmpty()
        .withMessage('Content ID is required'),
      body('contentType')
        .isIn(['article', 'arxiv_paper'])
        .withMessage('Content type must be article or arxiv_paper'),
      body('title')
        .notEmpty()
        .withMessage('Title is required')
        .isLength({ max: 500 })
        .withMessage('Title must be less than 500 characters'),
      body('content')
        .notEmpty()
        .withMessage('Content is required')
        .isLength({ min: 100, max: 100000 })
        .withMessage('Content must be between 100 and 100,000 characters'),
    ],
    aiController.analyzeContent.bind(aiController)
  );

  /**
   * GET /api/ai/trending
   * Get trending topics with analysis
   */
  router.get('/trending',
    [
      query('timeWindows')
        .optional()
        .custom((value) => {
          if (typeof value === 'string') {
            const windows = value.split(',');
            const validWindows = ['short', 'medium', 'long'];
            return windows.every(w => validWindows.includes(w.trim()));
          }
          return Array.isArray(value) && value.every(w => ['short', 'medium', 'long'].includes(w));
        })
        .withMessage('Time windows must be comma-separated values of: short, medium, long'),
      query('maxTopics')
        .optional()
        .isInt({ min: 1, max: 50 })
        .withMessage('Max topics must be between 1 and 50'),
    ],
    aiController.getTrendingTopics.bind(aiController)
  );

  /**
   * POST /api/ai/process
   * Process new article through AI pipeline
   */
  router.post('/process',
    authMiddleware, // Require authentication for content processing
    [
      body('id')
        .notEmpty()
        .withMessage('Article ID is required'),
      body('title')
        .notEmpty()
        .withMessage('Title is required')
        .isLength({ max: 500 })
        .withMessage('Title must be less than 500 characters'),
      body('content')
        .notEmpty()
        .withMessage('Content is required')
        .isLength({ min: 100 })
        .withMessage('Content must be at least 100 characters'),
      body('sourceId')
        .notEmpty()
        .withMessage('Source ID is required'),
      body('originalUrl')
        .isURL()
        .withMessage('Original URL must be a valid URL'),
      body('publishedAt')
        .isISO8601()
        .withMessage('Published date must be a valid ISO 8601 date'),
    ],
    aiController.processArticle.bind(aiController)
  );

  /**
   * POST /api/ai/batch-process
   * Process multiple articles in batch
   */
  router.post('/batch-process',
    authMiddleware, // Require authentication for batch processing
    rateLimitMiddleware({
      windowMs: 60 * 60 * 1000, // 1 hour
      max: 10, // Limit batch processing to 10 requests per hour
      message: 'Batch processing rate limit exceeded.',
    }),
    [
      body('contents')
        .isArray({ min: 1, max: 100 })
        .withMessage('Contents must be an array with 1-100 items'),
      body('contents.*.id')
        .notEmpty()
        .withMessage('Each content item must have an ID'),
      body('contents.*.title')
        .notEmpty()
        .withMessage('Each content item must have a title'),
      body('contents.*.content')
        .notEmpty()
        .withMessage('Each content item must have content'),
      body('contents.*.contentType')
        .isIn(['article', 'arxiv_paper'])
        .withMessage('Content type must be article or arxiv_paper'),
    ],
    aiController.batchProcess.bind(aiController)
  );

  /**
   * GET /api/ai/metrics
   * Get comprehensive system metrics
   */
  router.get('/metrics',
    authMiddleware, // Require authentication for system metrics
    aiController.getMetrics.bind(aiController)
  );

  /**
   * GET /api/ai/health
   * Health check endpoint
   */
  router.get('/health',
    aiController.healthCheck.bind(aiController)
  );

  /**
   * POST /api/ai/similar
   * Find similar content
   */
  router.post('/similar',
    [
      body('contentId')
        .notEmpty()
        .withMessage('Content ID is required'),
      body('contentType')
        .isIn(['article', 'arxiv_paper'])
        .withMessage('Content type must be article or arxiv_paper'),
      body('limit')
        .optional()
        .isInt({ min: 1, max: 20 })
        .withMessage('Limit must be between 1 and 20'),
      body('similarityThreshold')
        .optional()
        .isFloat({ min: 0, max: 1 })
        .withMessage('Similarity threshold must be between 0 and 1'),
    ],
    aiController.findSimilar.bind(aiController)
  );

  /**
   * GET /api/ai/categories
   * Get available content categories
   */
  router.get('/categories',
    aiController.getCategories.bind(aiController)
  );

  /**
   * POST /api/ai/feedback
   * Submit user feedback for recommendation improvement
   */
  router.post('/feedback',
    authMiddleware, // Require authentication for feedback
    [
      body('userId')
        .isUUID()
        .withMessage('User ID must be a valid UUID'),
      body('contentId')
        .notEmpty()
        .withMessage('Content ID is required'),
      body('feedbackType')
        .isIn(['like', 'dislike', 'not_relevant', 'inappropriate'])
        .withMessage('Invalid feedback type'),
      body('rating')
        .optional()
        .isInt({ min: 1, max: 5 })
        .withMessage('Rating must be between 1 and 5'),
      body('context')
        .optional()
        .isIn(['recommendation', 'search', 'trending'])
        .withMessage('Invalid context'),
    ],
    aiController.submitFeedback.bind(aiController)
  );

  return router;
}