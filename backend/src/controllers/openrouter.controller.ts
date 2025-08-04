/**
 * OpenRouter API Controller
 * REST endpoints for OpenRouter integration
 */

import { Request, Response } from 'express';
import { validationResult } from 'express-validator';
import { logger } from '../utils/logger';
import { OpenRouterService } from '../services/openrouter/OpenRouterService';
import { SummarizationRequest } from '../types/openrouter';

// This would be injected via dependency injection in a real application
let openRouterService: OpenRouterService;

export const setOpenRouterService = (service: OpenRouterService) => {
  openRouterService = service;
};

/**
 * Initialize or update user settings
 * POST /api/openrouter/settings
 */
export const updateSettings = async (req: Request, res: Response): Promise<void> => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
      return;
    }

    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
      return;
    }

    const settings = await openRouterService.updateSettings(userId, req.body);

    res.json({
      success: true,
      message: 'Settings updated successfully',
      data: {
        // Don't return encrypted API key
        ...settings,
        api_key_encrypted: settings.api_key_encrypted ? '[CONFIGURED]' : null
      }
    });

    logger.info('OpenRouter settings updated', { userId });

  } catch (error) {
    logger.error('Failed to update OpenRouter settings', { 
      userId: req.user?.id, 
      error: error instanceof Error ? error.message : 'Unknown error'
    });

    res.status(500).json({
      success: false,
      message: 'Failed to update settings',
      error: process.env.NODE_ENV === 'development' ? error : undefined
    });
  }
};

/**
 * Get user settings
 * GET /api/openrouter/settings
 */
export const getSettings = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
      return;
    }

    const settings = await openRouterService.getSettings(userId);

    if (!settings) {
      // Initialize with defaults
      const defaultSettings = await openRouterService.initializeUser(userId);
      res.json({
        success: true,
        data: {
          ...defaultSettings,
          api_key_encrypted: null // Never return the actual key
        }
      });
      return;
    }

    res.json({
      success: true,
      data: {
        ...settings,
        api_key_encrypted: settings.api_key_encrypted ? '[CONFIGURED]' : null
      }
    });

  } catch (error) {
    logger.error('Failed to get OpenRouter settings', { 
      userId: req.user?.id, 
      error: error instanceof Error ? error.message : 'Unknown error'
    });

    res.status(500).json({
      success: false,
      message: 'Failed to retrieve settings',
      error: process.env.NODE_ENV === 'development' ? error : undefined
    });
  }
};

/**
 * Delete user settings and data
 * DELETE /api/openrouter/settings
 */
export const deleteSettings = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
      return;
    }

    const deleted = await openRouterService.deleteUser(userId);

    if (deleted) {
      res.json({
        success: true,
        message: 'Settings and data deleted successfully'
      });
    } else {
      res.status(404).json({
        success: false,
        message: 'No settings found to delete'
      });
    }

  } catch (error) {
    logger.error('Failed to delete OpenRouter settings', { 
      userId: req.user?.id, 
      error: error instanceof Error ? error.message : 'Unknown error'
    });

    res.status(500).json({
      success: false,
      message: 'Failed to delete settings',
      error: process.env.NODE_ENV === 'development' ? error : undefined
    });
  }
};

/**
 * Get available models
 * GET /api/openrouter/models
 */
export const getModels = async (req: Request, res: Response): Promise<void> => {
  try {
    const useCache = req.query.cache !== 'false';
    const models = await openRouterService.getAvailableModels(useCache);

    // Filter and sort models for better UX
    const filteredModels = models
      .filter(model => model.architecture.modality === 'text' || model.architecture.modality === 'multimodal')
      .sort((a, b) => {
        // Sort by popularity/quality indicators
        const aScore = (a.id.includes('gpt-4') ? 100 : 0) + 
                      (a.id.includes('claude') ? 90 : 0) + 
                      (a.id.includes('llama') ? 80 : 0);
        const bScore = (b.id.includes('gpt-4') ? 100 : 0) + 
                      (b.id.includes('claude') ? 90 : 0) + 
                      (b.id.includes('llama') ? 80 : 0);
        return bScore - aScore;
      });

    res.json({
      success: true,
      data: filteredModels,
      meta: {
        total: filteredModels.length,
        cached: useCache,
        last_updated: new Date()
      }
    });

  } catch (error) {
    logger.error('Failed to get OpenRouter models', { 
      error: error instanceof Error ? error.message : 'Unknown error'
    });

    res.status(500).json({
      success: false,
      message: 'Failed to retrieve models',
      error: process.env.NODE_ENV === 'development' ? error : undefined
    });
  }
};

/**
 * Get specific model information
 * GET /api/openrouter/models/:modelId
 */
export const getModelInfo = async (req: Request, res: Response): Promise<void> => {
  try {
    const { modelId } = req.params;
    
    // URL decode the model ID (it may contain slashes)
    const decodedModelId = decodeURIComponent(modelId);
    
    const model = await openRouterService.getModelInfo(decodedModelId);

    res.json({
      success: true,
      data: model
    });

  } catch (error) {
    logger.error('Failed to get model info', { 
      modelId: req.params.modelId,
      error: error instanceof Error ? error.message : 'Unknown error'
    });

    if (error instanceof Error && error.message.includes('404')) {
      res.status(404).json({
        success: false,
        message: 'Model not found'
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve model information',
        error: process.env.NODE_ENV === 'development' ? error : undefined
      });
    }
  }
};

/**
 * Summarize articles
 * POST /api/openrouter/summarize
 */
export const summarizeArticles = async (req: Request, res: Response): Promise<void> => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
      return;
    }

    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
      return;
    }

    const summarizationRequest: SummarizationRequest = req.body;

    // Check if this should be a batch job (large number of articles)
    const shouldUseBatch = summarizationRequest.articles.length > 10 || 
                          summarizationRequest.options.batch_processing;

    if (shouldUseBatch) {
      const batchJob = await openRouterService.createBatchSummarizationJob(
        userId,
        summarizationRequest
      );

      res.status(202).json({
        success: true,
        message: 'Batch summarization job created',
        data: {
          job_id: batchJob.id,
          status: batchJob.status,
          estimated_completion: new Date(Date.now() + 300000), // 5 minutes estimate
          progress: batchJob.progress
        }
      });
    } else {
      const result = await openRouterService.summarizeArticles(
        userId,
        summarizationRequest
      );

      res.json({
        success: true,
        message: 'Articles summarized successfully',
        data: result
      });
    }

    logger.info('Summarization request processed', {
      userId,
      articleCount: summarizationRequest.articles.length,
      batchJob: shouldUseBatch
    });

  } catch (error) {
    logger.error('Summarization failed', { 
      userId: req.user?.id,
      error: error instanceof Error ? error.message : 'Unknown error'
    });

    if (error instanceof Error) {
      if (error.message.includes('limits exceeded')) {
        res.status(429).json({
          success: false,
          message: 'Usage limits exceeded',
          error: error.message
        });
      } else if (error.message.includes('API key')) {
        res.status(400).json({
          success: false,
          message: 'OpenRouter API key not configured',
          error: 'Please configure your OpenRouter API key in settings'
        });
      } else {
        res.status(500).json({
          success: false,
          message: 'Summarization failed',
          error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
      }
    } else {
      res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  }
};

/**
 * Get batch job status
 * GET /api/openrouter/jobs/:jobId
 */
export const getBatchJobStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const { jobId } = req.params;
    const job = await openRouterService.getBatchJobStatus(jobId);

    if (!job) {
      res.status(404).json({
        success: false,
        message: 'Batch job not found'
      });
      return;
    }

    // Only allow users to see their own jobs
    if (job.user_id !== req.user?.id) {
      res.status(403).json({
        success: false,
        message: 'Access denied'
      });
      return;
    }

    res.json({
      success: true,
      data: job
    });

  } catch (error) {
    logger.error('Failed to get batch job status', { 
      jobId: req.params.jobId,
      error: error instanceof Error ? error.message : 'Unknown error'
    });

    res.status(500).json({
      success: false,
      message: 'Failed to retrieve job status',
      error: process.env.NODE_ENV === 'development' ? error : undefined
    });
  }
};

/**
 * Get usage statistics
 * GET /api/openrouter/usage
 */
export const getUsageStats = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
      return;
    }

    const period = (req.query.period as 'daily' | 'weekly' | 'monthly') || 'daily';
    const stats = await openRouterService.getUserUsageStats(userId, period);

    res.json({
      success: true,
      data: stats
    });

  } catch (error) {
    logger.error('Failed to get usage stats', { 
      userId: req.user?.id,
      error: error instanceof Error ? error.message : 'Unknown error'
    });

    res.status(500).json({
      success: false,
      message: 'Failed to retrieve usage statistics',
      error: process.env.NODE_ENV === 'development' ? error : undefined
    });
  }
};

/**
 * Check usage limits
 * GET /api/openrouter/limits
 */
export const checkLimits = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
      return;
    }

    const limits = await openRouterService.checkUserLimits(userId);

    res.json({
      success: true,
      data: limits
    });

  } catch (error) {
    logger.error('Failed to check usage limits', { 
      userId: req.user?.id,
      error: error instanceof Error ? error.message : 'Unknown error'
    });

    res.status(500).json({
      success: false,
      message: 'Failed to check usage limits',
      error: process.env.NODE_ENV === 'development' ? error : undefined
    });
  }
};

/**
 * Get service health status
 * GET /api/openrouter/health
 */
export const getHealthStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const health = openRouterService.getHealthStatus();

    const statusCode = health.status === 'healthy' ? 200 : 
                      health.status === 'degraded' ? 206 : 503;

    res.status(statusCode).json({
      success: health.status === 'healthy',
      data: health
    });

  } catch (error) {
    logger.error('Failed to get health status', { 
      error: error instanceof Error ? error.message : 'Unknown error'
    });

    res.status(500).json({
      success: false,
      message: 'Failed to retrieve health status',
      error: process.env.NODE_ENV === 'development' ? error : undefined
    });
  }
};

/**
 * Get active connections info (admin only)
 * GET /api/openrouter/admin/connections
 */
export const getActiveConnections = async (req: Request, res: Response): Promise<void> => {
  try {
    // Check if user is admin
    if (req.user?.role !== 'admin') {
      res.status(403).json({
        success: false,
        message: 'Admin access required'
      });
      return;
    }

    const connections = openRouterService.getActiveClients();

    res.json({
      success: true,
      data: {
        total_connections: connections.length,
        connections: connections.map(conn => ({
          ...conn,
          // Don't expose sensitive rate limit details
          rateLimitInfo: conn.rateLimitInfo ? {
            requests_remaining: conn.rateLimitInfo.requests_remaining,
            requests_limit: conn.rateLimitInfo.requests_limit
          } : null
        }))
      }
    });

  } catch (error) {
    logger.error('Failed to get active connections', { 
      error: error instanceof Error ? error.message : 'Unknown error'
    });

    res.status(500).json({
      success: false,
      message: 'Failed to retrieve connection information',
      error: process.env.NODE_ENV === 'development' ? error : undefined
    });
  }
};

/**
 * Emergency stop all processing (admin only)
 * POST /api/openrouter/admin/emergency-stop
 */
export const emergencyStop = async (req: Request, res: Response): Promise<void> => {
  try {
    // Check if user is admin
    if (req.user?.role !== 'admin') {
      res.status(403).json({
        success: false,
        message: 'Admin access required'
      });
      return;
    }

    openRouterService.emergencyStop();

    res.json({
      success: true,
      message: 'Emergency stop initiated - all queues cleared',
      timestamp: new Date()
    });

    logger.warn('Emergency stop initiated by admin', { adminId: req.user.id });

  } catch (error) {
    logger.error('Emergency stop failed', { 
      error: error instanceof Error ? error.message : 'Unknown error'
    });

    res.status(500).json({
      success: false,
      message: 'Failed to execute emergency stop',
      error: process.env.NODE_ENV === 'development' ? error : undefined
    });
  }
};