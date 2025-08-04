/**
 * Content Summarization Service
 * Advanced service for summarizing news articles using OpenRouter models
 */

import { EventEmitter } from 'events';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { logger } from '../../utils/logger';
import { OpenRouterClient } from './OpenRouterClient';
import { SettingsService } from './SettingsService';
import {
  SummarizationRequest,
  SummarizationResponse,
  OpenRouterChatRequest,
  ModelSelectionCriteria,
  ModelRecommendation,
  BatchJob
} from '../../types/openrouter';

export class SummarizationService extends EventEmitter {
  private openRouterClient: OpenRouterClient;
  private settingsService: SettingsService;
  private db: Pool;
  private redis: Redis;
  private processingJobs = new Map<string, BatchJob>();

  constructor(
    openRouterClient: OpenRouterClient,
    settingsService: SettingsService,
    db: Pool,
    redis: Redis
  ) {
    super();
    this.openRouterClient = openRouterClient;
    this.settingsService = settingsService;
    this.db = db;
    this.redis = redis;

    // Listen to OpenRouter client events
    this.openRouterClient.on('rateLimitWarning', (info) => {
      this.emit('rateLimitWarning', info);
    });

    this.openRouterClient.on('costAlert', (info) => {
      this.emit('costAlert', info);
    });
  }

  /**
   * Summarize articles with intelligent model selection and optimization
   */
  async summarizeArticles(
    userId: string,
    request: SummarizationRequest
  ): Promise<SummarizationResponse> {
    const startTime = Date.now();
    logger.info('Starting article summarization', {
      userId,
      articleCount: request.articles.length,
      options: request.options
    });

    try {
      // Check user limits and settings
      const [settings, limitsCheck] = await Promise.all([
        this.settingsService.getSettings(userId),
        this.settingsService.checkUsageLimits(userId)
      ]);

      if (!limitsCheck.within_limits) {
        throw new Error('Usage limits exceeded. Please check your usage or upgrade your plan.');
      }

      if (!settings?.api_key_encrypted) {
        throw new Error('OpenRouter API key not configured');
      }

      // Select optimal model
      const selectedModel = await this.selectOptimalModel(userId, request);
      logger.info('Selected model for summarization', { userId, model: selectedModel });

      // Process articles (batch or individual)
      const response = request.options.batch_processing
        ? await this.processBatch(userId, request, selectedModel)
        : await this.processSequential(userId, request, selectedModel);

      const totalTime = Date.now() - startTime;
      logger.info('Summarization completed', {
        userId,
        totalTime,
        successfulSummaries: response.batch_metadata.successful_summaries,
        totalCost: response.batch_metadata.total_cost
      });

      return response;
    } catch (error) {
      logger.error('Summarization failed', { userId, error });
      throw error;
    }
  }

  /**
   * Create a batch job for large-scale summarization
   */
  async createBatchJob(
    userId: string,
    request: SummarizationRequest
  ): Promise<BatchJob> {
    const jobId = `batch_${userId}_${Date.now()}`;
    
    const job: BatchJob = {
      id: jobId,
      user_id: userId,
      status: 'pending',
      job_type: 'summarization',
      input_data: request,
      progress: {
        total_items: request.articles.length,
        processed_items: 0,
        failed_items: 0,
        percentage: 0
      },
      metadata: {
        estimated_cost: await this.estimateBatchCost(userId, request)
      },
      created_at: new Date(),
      updated_at: new Date()
    };

    // Store job in database
    await this.saveBatchJob(job);
    
    // Add to processing queue
    this.processingJobs.set(jobId, job);

    // Start processing asynchronously
    this.processBatchJobAsync(job);

    return job;
  }

  /**
   * Get batch job status
   */
  async getBatchJobStatus(jobId: string): Promise<BatchJob | null> {
    // Check in-memory first
    if (this.processingJobs.has(jobId)) {
      return this.processingJobs.get(jobId)!;
    }

    // Check database
    try {
      const query = 'SELECT * FROM batch_jobs WHERE id = $1';
      const result = await this.db.query(query, [jobId]);
      
      if (result.rows.length === 0) {
        return null;
      }

      return this.formatBatchJob(result.rows[0]);
    } catch (error) {
      logger.error('Failed to get batch job status', { jobId, error });
      return null;
    }
  }

  /**
   * Process articles sequentially with fallback handling
   */
  private async processSequential(
    userId: string,
    request: SummarizationRequest,
    primaryModel: string
  ): Promise<SummarizationResponse> {
    const summaries: SummarizationResponse['summaries'] = [];
    const startTime = Date.now();
    let totalCost = 0;
    let totalTokens = 0;
    let successfulSummaries = 0;
    let failedSummaries = 0;

    const settings = await this.settingsService.getSettings(userId);
    const fallbackModel = settings?.preferred_models?.fallback || 'meta-llama/llama-3.1-8b-instruct:free';

    for (const article of request.articles) {
      const articleStartTime = Date.now();
      let currentModel = primaryModel;
      let attempts = 0;
      const maxAttempts = settings?.preferences?.fallback_enabled ? 2 : 1;

      while (attempts < maxAttempts) {
        try {
          const prompt = this.buildSummarizationPrompt(article, request.options);
          const chatRequest: OpenRouterChatRequest = {
            model: currentModel,
            messages: [
              {
                role: 'system',
                content: this.getSystemPrompt(request.options)
              },
              {
                role: 'user',
                content: prompt
              }
            ],
            max_tokens: this.getMaxTokensForLength(request.options.summary_length),
            temperature: settings?.preferences?.temperature || 0.7
          };

          const response = await this.openRouterClient.createChatCompletion(chatRequest);
          const processingTime = Date.now() - articleStartTime;

          // Extract summary from response
          const summaryContent = response.choices[0]?.message?.content || '';
          const summary = this.parseSummarizationResponse(summaryContent, request.options);

          // Calculate cost
          const cost = this.calculateCost(response.usage, currentModel);
          totalCost += cost;
          totalTokens += response.usage.total_tokens;

          // Record usage
          await this.settingsService.recordUsage({
            user_id: userId,
            model: currentModel,
            prompt_tokens: response.usage.prompt_tokens,
            completion_tokens: response.usage.completion_tokens,
            total_tokens: response.usage.total_tokens,
            cost,
            request_type: 'summarization',
            metadata: {
              article_id: article.id,
              processing_time: processingTime,
              attempt: attempts + 1
            }
          });

          summaries.push({
            article_id: article.id,
            summary: summary.summary,
            key_points: summary.key_points,
            sentiment: summary.sentiment,
            metadata: {
              model_used: currentModel,
              tokens_used: response.usage.total_tokens,
              processing_time: processingTime,
              cost
            }
          });

          successfulSummaries++;
          break;

        } catch (error) {
          attempts++;
          logger.warn('Summarization attempt failed', {
            userId,
            articleId: article.id,
            model: currentModel,
            attempt: attempts,
            error: error instanceof Error ? error.message : 'Unknown error'
          });

          if (attempts < maxAttempts && settings?.preferences?.fallback_enabled) {
            currentModel = fallbackModel;
            logger.info('Switching to fallback model', { 
              userId, 
              articleId: article.id, 
              fallbackModel 
            });
          } else {
            failedSummaries++;
            break;
          }
        }
      }
    }

    const totalProcessingTime = Date.now() - startTime;

    return {
      summaries,
      batch_metadata: {
        total_articles: request.articles.length,
        successful_summaries: successfulSummaries,
        failed_summaries: failedSummaries,
        total_cost: totalCost,
        total_tokens: totalTokens,
        processing_time: totalProcessingTime
      }
    };
  }

  /**
   * Process articles in batches for better efficiency
   */
  private async processBatch(
    userId: string,
    request: SummarizationRequest,
    model: string
  ): Promise<SummarizationResponse> {
    const batchSize = 5; // Adjust based on model context limits
    const batches = this.chunkArray(request.articles, batchSize);
    const allSummaries: SummarizationResponse['summaries'] = [];
    
    let totalCost = 0;
    let totalTokens = 0;
    let successfulSummaries = 0;
    let failedSummaries = 0;
    const startTime = Date.now();

    for (const batch of batches) {
      try {
        const batchPrompt = this.buildBatchSummarizationPrompt(batch, request.options);
        const settings = await this.settingsService.getSettings(userId);

        const chatRequest: OpenRouterChatRequest = {
          model,
          messages: [
            {
              role: 'system',
              content: this.getBatchSystemPrompt(request.options)
            },
            {
              role: 'user',
              content: batchPrompt
            }
          ],
          max_tokens: this.getMaxTokensForLength(request.options.summary_length) * batch.length,
          temperature: settings?.preferences?.temperature || 0.7
        };

        const response = await this.openRouterClient.createChatCompletion(chatRequest);
        const batchSummaries = this.parseBatchSummarizationResponse(
          response.choices[0]?.message?.content || '',
          batch,
          request.options
        );

        const cost = this.calculateCost(response.usage, model);
        totalCost += cost;
        totalTokens += response.usage.total_tokens;

        // Record batch usage
        await this.settingsService.recordUsage({
          user_id: userId,
          model,
          prompt_tokens: response.usage.prompt_tokens,
          completion_tokens: response.usage.completion_tokens,
          total_tokens: response.usage.total_tokens,
          cost,
          request_type: 'summarization',
          metadata: {
            batch_size: batch.length,
            article_ids: batch.map(a => a.id)
          }
        });

        allSummaries.push(...batchSummaries);
        successfulSummaries += batchSummaries.length;

      } catch (error) {
        logger.error('Batch processing failed', { userId, batchSize: batch.length, error });
        failedSummaries += batch.length;
      }
    }

    return {
      summaries: allSummaries,
      batch_metadata: {
        total_articles: request.articles.length,
        successful_summaries: successfulSummaries,
        failed_summaries: failedSummaries,
        total_cost: totalCost,
        total_tokens: totalTokens,
        processing_time: Date.now() - startTime
      }
    };
  }

  /**
   * Select optimal model based on content and user preferences
   */
  private async selectOptimalModel(
    userId: string,
    request: SummarizationRequest
  ): Promise<string> {
    const settings = await this.settingsService.getSettings(userId);
    
    // Start with user's preferred model
    if (settings?.preferred_models?.summarization) {
      return settings.preferred_models.summarization;
    }

    // Analyze content to recommend model
    const avgContentLength = request.articles.reduce((sum, article) => 
      sum + article.content.length, 0) / request.articles.length;

    const criteria: ModelSelectionCriteria = {
      task_type: 'summarization',
      content_length: avgContentLength,
      quality_preference: settings?.preferences?.cost_optimization ? 'cost' : 'quality',
      budget_constraint: settings?.usage_limits?.daily_cost_limit
    };

    const recommendation = await this.recommendModel(criteria);
    return recommendation?.model?.id || 'anthropic/claude-3-haiku';
  }

  /**
   * Recommend model based on criteria
   */
  private async recommendModel(criteria: ModelSelectionCriteria): Promise<ModelRecommendation | null> {
    try {
      const models = await this.openRouterClient.getModels();
      const suitableModels = models.filter(model => 
        model.architecture.modality === 'text' || model.architecture.modality === 'multimodal'
      );

      // Score models based on criteria
      const scoredModels = suitableModels.map(model => {
        let score = 0;

        // Context length score
        if (model.context_length >= criteria.content_length * 2) score += 30;
        else if (model.context_length >= criteria.content_length) score += 20;

        // Cost score (inverse - lower cost = higher score)
        const avgCost = (model.pricing.prompt + model.pricing.completion) / 2;
        if (avgCost < 0.00001) score += 25;
        else if (avgCost < 0.0001) score += 20;
        else if (avgCost < 0.001) score += 15;

        // Quality indicators (based on model name patterns)
        if (model.id.includes('claude-3') || model.id.includes('gpt-4')) score += 20;
        else if (model.id.includes('claude') || model.id.includes('gpt')) score += 15;

        // Task-specific bonuses
        if (criteria.task_type === 'summarization') {
          if (model.id.includes('haiku') || model.id.includes('mini')) score += 10;
        }

        return { model, score };
      });

      // Sort by score and return top recommendation
      scoredModels.sort((a, b) => b.score - a.score);
      const topModel = scoredModels[0];

      if (!topModel) return null;

      return {
        model: topModel.model,
        score: topModel.score,
        reasoning: this.generateRecommendationReasoning(topModel.model, criteria),
        estimated_cost: this.estimateModelCost(topModel.model, criteria),
        estimated_time: this.estimateProcessingTime(topModel.model, criteria),
        fallback_models: scoredModels.slice(1, 4).map(m => m.model.id)
      };
    } catch (error) {
      logger.error('Failed to recommend model', { criteria, error });
      return null;
    }
  }

  /**
   * Build summarization prompt for individual article
   */
  private buildSummarizationPrompt(
    article: SummarizationRequest['articles'][0],
    options: SummarizationRequest['options']
  ): string {
    const lengthInstruction = this.getLengthInstruction(options.summary_length);
    const styleInstruction = this.getStyleInstruction(options.summary_style);
    const additionalRequirements = [];

    if (options.include_key_points) {
      additionalRequirements.push('- Extract 3-5 key points');
    }

    if (options.include_sentiment) {
      additionalRequirements.push('- Analyze sentiment (positive/negative/neutral with confidence score)');
    }

    return `
Article Title: ${article.title}
Source: ${article.source || 'Unknown'}
URL: ${article.url || 'N/A'}

Content:
${article.content}

Instructions:
- Create a ${lengthInstruction} summary
- Use ${styleInstruction} format
${additionalRequirements.join('\n')}
- Language: ${options.language || 'English'}
- Maintain factual accuracy
- Preserve key information and context

Please provide a well-structured response.`;
  }

  /**
   * Build batch summarization prompt
   */
  private buildBatchSummarizationPrompt(
    articles: SummarizationRequest['articles'],
    options: SummarizationRequest['options']
  ): string {
    const articlesText = articles.map((article, index) => `
ARTICLE ${index + 1}:
ID: ${article.id}
Title: ${article.title}
Source: ${article.source || 'Unknown'}
Content: ${article.content}
---`).join('\n');

    const lengthInstruction = this.getLengthInstruction(options.summary_length);
    const styleInstruction = this.getStyleInstruction(options.summary_style);

    return `
Please summarize the following ${articles.length} articles. For each article, provide:
- A ${lengthInstruction} summary in ${styleInstruction} format
- Include the article ID in your response
${options.include_key_points ? '- 3-5 key points' : ''}
${options.include_sentiment ? '- Sentiment analysis' : ''}

${articlesText}

Format your response clearly for each article with the article ID.`;
  }

  /**
   * System prompts for different summarization modes
   */
  private getSystemPrompt(options: SummarizationRequest['options']): string {
    return `You are an expert content summarizer specializing in news articles. 
Your task is to create accurate, informative, and well-structured summaries that preserve the essential information while being concise and readable.

Guidelines:
- Maintain objectivity and factual accuracy
- Preserve important names, dates, and figures
- Avoid speculation or adding information not present in the original
- Use clear, professional language
- Structure your response according to the specified format
${options.include_sentiment ? '- When analyzing sentiment, be objective and provide confidence scores' : ''}`;
  }

  private getBatchSystemPrompt(options: SummarizationRequest['options']): string {
    return `You are an expert content summarizer processing multiple news articles. 
Create individual summaries for each article while maintaining consistency in style and quality.

For each article:
- Start with "ARTICLE ID: [id]"
- Provide the requested summary format
- Maintain the same quality standards across all articles
- Ensure each summary is independent and complete`;
  }

  /**
   * Parse individual summarization response
   */
  private parseSummarizationResponse(
    content: string,
    options: SummarizationRequest['options']
  ): {
    summary: string;
    key_points?: string[];
    sentiment?: { score: number; label: 'positive' | 'negative' | 'neutral'; confidence: number };
  } {
    // This would need more sophisticated parsing based on the actual model responses
    // For now, return a basic structure
    return {
      summary: content.trim(),
      key_points: options.include_key_points ? this.extractKeyPoints(content) : undefined,
      sentiment: options.include_sentiment ? this.extractSentiment(content) : undefined
    };
  }

  /**
   * Parse batch summarization response
   */
  private parseBatchSummarizationResponse(
    content: string,
    articles: SummarizationRequest['articles'],
    options: SummarizationRequest['options']
  ): SummarizationResponse['summaries'] {
    // This would need sophisticated parsing to extract individual summaries
    // For now, return basic structure
    return articles.map((article, index) => ({
      article_id: article.id,
      summary: `Summary for ${article.title}`, // This would be extracted from content
      key_points: options.include_key_points ? [] : undefined,
      sentiment: options.include_sentiment ? {
        score: 0,
        label: 'neutral' as const,
        confidence: 0.5
      } : undefined,
      metadata: {
        model_used: 'batch-processing',
        tokens_used: 0,
        processing_time: 0,
        cost: 0
      }
    }));
  }

  /**
   * Helper methods for prompt building
   */
  private getLengthInstruction(length?: 'short' | 'medium' | 'long'): string {
    switch (length) {
      case 'short': return '2-3 sentence';
      case 'long': return '150-200 word';
      default: return '50-100 word';
    }
  }

  private getStyleInstruction(style?: 'bullet_points' | 'paragraph' | 'structured'): string {
    switch (style) {
      case 'bullet_points': return 'bullet point';
      case 'structured': return 'structured with headings';
      default: return 'paragraph';
    }
  }

  private getMaxTokensForLength(length?: 'short' | 'medium' | 'long'): number {
    switch (length) {
      case 'short': return 100;
      case 'long': return 300;
      default: return 200;
    }
  }

  /**
   * Utility methods
   */
  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  private calculateCost(usage: any, model: string): number {
    // This would need actual model pricing data
    return (usage.total_tokens || 0) * 0.00001; // Rough estimate
  }

  private extractKeyPoints(content: string): string[] {
    // Implement key point extraction logic
    return [];
  }

  private extractSentiment(content: string): { score: number; label: 'positive' | 'negative' | 'neutral'; confidence: number } {
    // Implement sentiment extraction logic
    return { score: 0, label: 'neutral', confidence: 0.5 };
  }

  private generateRecommendationReasoning(model: any, criteria: ModelSelectionCriteria): string {
    return `Selected based on ${criteria.quality_preference} optimization for ${criteria.task_type} tasks`;
  }

  private estimateModelCost(model: any, criteria: ModelSelectionCriteria): number {
    return criteria.content_length * 0.00001;
  }

  private estimateProcessingTime(model: any, criteria: ModelSelectionCriteria): number {
    return criteria.content_length * 0.01;
  }

  private async estimateBatchCost(userId: string, request: SummarizationRequest): Promise<number> {
    const avgLength = request.articles.reduce((sum, a) => sum + a.content.length, 0) / request.articles.length;
    return request.articles.length * avgLength * 0.00001;
  }

  private async saveBatchJob(job: BatchJob): Promise<void> {
    const query = `
      INSERT INTO batch_jobs (id, user_id, status, job_type, input_data, progress, metadata, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `;
    
    await this.db.query(query, [
      job.id, job.user_id, job.status, job.job_type,
      JSON.stringify(job.input_data), JSON.stringify(job.progress),
      JSON.stringify(job.metadata), job.created_at, job.updated_at
    ]);
  }

  private formatBatchJob(row: any): BatchJob {
    return {
      id: row.id,
      user_id: row.user_id,
      status: row.status,
      job_type: row.job_type,
      input_data: JSON.parse(row.input_data),
      output_data: row.output_data ? JSON.parse(row.output_data) : undefined,
      progress: JSON.parse(row.progress),
      metadata: JSON.parse(row.metadata),
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  private async processBatchJobAsync(job: BatchJob): Promise<void> {
    // This would implement the actual batch processing logic
    // For now, just update status
    job.status = 'processing';
    this.processingJobs.set(job.id, job);
    
    // Simulate processing
    setTimeout(() => {
      job.status = 'completed';
      job.progress.percentage = 100;
      this.processingJobs.delete(job.id);
    }, 10000);
  }
}