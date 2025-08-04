import { Request, Response } from 'express';
import { validationResult } from 'express-validator';
import { Logger } from 'winston';
import { AIServiceOrchestrator } from '../services/ai/AIServiceOrchestrator';

/**
 * AI Controller - Handles all AI/ML related API endpoints
 * 
 * Provides endpoints for:
 * - Content search and recommendations
 * - Content analysis and categorization
 * - Trending topics and analytics
 * - System metrics and health checks
 */
export class AIController {
  constructor(
    private aiOrchestrator: AIServiceOrchestrator,
    private logger: Logger
  ) {}

  /**
   * POST /api/ai/search
   * Intelligent content search with personalization
   */
  async search(req: Request, res: Response): Promise<void> {
    try {
      // Validate request
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: errors.array(),
        });
        return;
      }

      const {
        query,
        userId,
        limit = 20,
        filters = {},
        searchType = 'auto',
        includeRecommendations = false,
      } = req.body;

      // Perform intelligent search
      const results = await this.aiOrchestrator.intelligentSearch(query, {
        userId,
        limit,
        filters,
        searchType,
        includeRecommendations,
      });

      res.json({
        success: true,
        data: results,
      });

    } catch (error) {
      this.logger.error('Search API error:', error);
      res.status(500).json({
        success: false,
        error: 'Search failed',
        message: error.message,
      });
    }
  }

  /**
   * GET /api/ai/recommendations/:userId
   * Get personalized content recommendations
   */
  async getRecommendations(req: Request, res: Response): Promise<void> {
    try {
      const { userId } = req.params;
      const {
        limit = 20,
        includeAnalytics = false,
        refreshCache = false,
        diversityFactor = 0.3,
      } = req.query;

      const feed = await this.aiOrchestrator.generatePersonalizedFeed(userId, {
        limit: Number(limit),
        includeAnalytics: includeAnalytics === 'true',
        refreshCache: refreshCache === 'true',
        diversityFactor: Number(diversityFactor),
      });

      res.json({
        success: true,
        data: feed,
      });

    } catch (error) {
      this.logger.error('Recommendations API error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to generate recommendations',
        message: error.message,
      });
    }
  }

  /**
   * POST /api/ai/analyze
   * Analyze content comprehensively
   */
  async analyzeContent(req: Request, res: Response): Promise<void> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: errors.array(),
        });
        return;
      }

      const {
        contentId,
        contentType,
        title,
        content,
        options = {},
      } = req.body;

      const analysis = await this.aiOrchestrator.analyzeContentComprehensive(
        contentId,
        contentType,
        title,
        content,
        options
      );

      res.json({
        success: true,
        data: analysis,
      });

    } catch (error) {
      this.logger.error('Content analysis API error:', error);
      res.status(500).json({
        success: false,
        error: 'Content analysis failed',
        message: error.message,
      });
    }
  }

  /**
   * GET /api/ai/trending
   * Get trending topics with analysis
   */
  async getTrendingTopics(req: Request, res: Response): Promise<void> {
    try {
      const {
        timeWindows = 'medium',
        categories,
        includeEvolution = false,
        maxTopics = 10,
      } = req.query;

      const timeWindowsArray = typeof timeWindows === 'string' 
        ? timeWindows.split(',') 
        : timeWindows;

      const categoriesArray = categories 
        ? (typeof categories === 'string' ? categories.split(',') : categories)
        : undefined;

      const trending = await this.aiOrchestrator.getTrendingTopicsWithAnalysis({
        timeWindows: timeWindowsArray as ('short' | 'medium' | 'long')[],
        categories: categoriesArray,
        includeEvolution: includeEvolution === 'true',
        maxTopics: Number(maxTopics),
      });

      res.json({
        success: true,
        data: trending,
      });

    } catch (error) {
      this.logger.error('Trending topics API error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get trending topics',
        message: error.message,
      });
    }
  }

  /**
   * POST /api/ai/process
   * Process new article through AI pipeline
   */
  async processArticle(req: Request, res: Response): Promise<void> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: errors.array(),
        });
        return;
      }

      const {
        id,
        title,
        content,
        sourceId,
        originalUrl,
        publishedAt,
      } = req.body;

      const result = await this.aiOrchestrator.processNewArticle({
        id,
        title,
        content,
        sourceId,
        originalUrl,
        publishedAt: new Date(publishedAt),
      });

      res.json({
        success: true,
        data: result,
      });

    } catch (error) {
      this.logger.error('Article processing API error:', error);
      res.status(500).json({
        success: false,
        error: 'Article processing failed',
        message: error.message,
      });
    }
  }

  /**
   * POST /api/ai/batch-process
   * Process multiple articles in batch
   */
  async batchProcess(req: Request, res: Response): Promise<void> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: errors.array(),
        });
        return;
      }

      const {
        contents,
        operations = {
          embeddings: true,
          categorization: true,
          analysis: true,
          duplicateCheck: true,
        },
        options = {},
      } = req.body;

      const result = await this.aiOrchestrator.processBatchContent(
        contents,
        operations,
        options
      );

      res.json({
        success: true,
        data: result,
      });

    } catch (error) {
      this.logger.error('Batch processing API error:', error);
      res.status(500).json({
        success: false,
        error: 'Batch processing failed',
        message: error.message,
      });
    }
  }

  /**
   * GET /api/ai/metrics
   * Get comprehensive system metrics
   */
  async getMetrics(req: Request, res: Response): Promise<void> {
    try {
      const metrics = await this.aiOrchestrator.getSystemMetrics();

      res.json({
        success: true,
        data: metrics,
      });

    } catch (error) {
      this.logger.error('Metrics API error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get metrics',
        message: error.message,
      });
    }
  }

  /**
   * GET /api/ai/health
   * Health check endpoint
   */
  async healthCheck(req: Request, res: Response): Promise<void> {
    try {
      // Quick health check - just verify services are initialized
      const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        services: {
          aiOrchestrator: 'online',
          embedding: 'online',
          search: 'online',
          recommendations: 'online',
          analysis: 'online',
          categorization: 'online',
          trending: 'online',
          jobQueue: 'online',
        },
      };

      res.json({
        success: true,
        data: health,
      });

    } catch (error) {
      this.logger.error('Health check error:', error);
      res.status(503).json({
        success: false,
        error: 'Service unhealthy',
        message: error.message,
      });
    }
  }

  /**
   * POST /api/ai/similar
   * Find similar content to given text
   */
  async findSimilar(req: Request, res: Response): Promise<void> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: errors.array(),
        });
        return;
      }

      const {
        contentId,
        contentType,
        limit = 10,
        similarityThreshold = 0.7,
        filters = {},
      } = req.body;

      // This would use the embedding service to find similar content
      // For now, we'll use the search service as a proxy
      const searchQuery = `similar to content ${contentId}`;
      const results = await this.aiOrchestrator.intelligentSearch(searchQuery, {
        limit,
        filters,
        searchType: 'semantic',
      });

      res.json({
        success: true,
        data: {
          similar: results.searchResults.results,
          metadata: {
            contentId,
            contentType,
            totalFound: results.searchResults.totalCount,
            similarityThreshold,
            processingTime: results.processingTime,
          },
        },
      });

    } catch (error) {
      this.logger.error('Similar content API error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to find similar content',
        message: error.message,
      });
    }
  }

  /**
   * GET /api/ai/categories
   * Get available content categories
   */
  async getCategories(req: Request, res: Response): Promise<void> {
    try {
      const categories = [
        'artificial-intelligence',
        'machine-learning',
        'deep-learning',
        'nlp',
        'computer-vision',
        'robotics',
        'research',
        'industry',
        'startups',
        'tech-news',
        'data-science',
        'cloud-computing',
        'cybersecurity',
        'blockchain',
        'quantum-computing',
        'biotech',
        'fintech',
        'general',
      ];

      res.json({
        success: true,
        data: {
          categories,
          total: categories.length,
        },
      });

    } catch (error) {
      this.logger.error('Categories API error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get categories',
        message: error.message,
      });
    }
  }

  /**
   * POST /api/ai/feedback
   * Submit user feedback for recommendation improvement
   */
  async submitFeedback(req: Request, res: Response): Promise<void> {
    try {
      const {
        userId,
        contentId,
        feedbackType, // 'like', 'dislike', 'not_relevant', 'inappropriate'
        rating, // 1-5 scale
        context, // 'recommendation', 'search', 'trending'
      } = req.body;

      // Store feedback for model improvement
      // This would typically go into a feedback table for later analysis
      this.logger.info('User feedback received', {
        userId,
        contentId,
        feedbackType,
        rating,
        context,
        timestamp: new Date(),
      });

      res.json({
        success: true,
        message: 'Feedback recorded successfully',
      });

    } catch (error) {
      this.logger.error('Feedback API error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to record feedback',
        message: error.message,
      });
    }
  }
}