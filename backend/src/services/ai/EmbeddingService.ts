import OpenAI from 'openai';
import { Logger } from 'winston';
import { DatabaseService } from '../database/DatabaseService';
import { aiConfig, AIConfig } from '../../config/ai.config';
import * as tf from '@tensorflow/tfjs-node';
import { pipeline, Pipeline } from '@xenova/transformers';
import { createHash } from 'crypto';
import { promisify } from 'util';
import { setTimeout } from 'timers/promises';

export interface EmbeddingResult {
  embedding: number[];
  tokens: number;
  model: string;
  provider: 'openai' | 'huggingface' | 'local';
  cached: boolean;
}

export interface BatchEmbeddingResult {
  embeddings: EmbeddingResult[];
  totalTokens: number;
  processingTime: number;
  successCount: number;
  failureCount: number;
  cached: number;
}

export interface EmbeddingMetrics {
  dailyRequests: number;
  dailyTokens: number;
  avgProcessingTime: number;
  errorRate: number;
  cacheHitRate: number;
  providerBreakdown: {
    openai: number;
    huggingface: number;
    local: number;
  };
}

export class EmbeddingService {
  private openai: OpenAI | null = null;
  private localModel: Pipeline | null = null;
  private isInitialized: boolean = false;
  private rateLimiter: Map<string, number[]> = new Map();
  private modelCache: Map<string, number[]> = new Map();

  constructor(
    private config: AIConfig,
    private logger: Logger,
    private databaseService: DatabaseService
  ) {}

  async initialize(): Promise<void> {
    try {
      await this.initializeOpenAI();
      await this.initializeLocalModel();
      this.setupRateLimiting();
      this.isInitialized = true;
      this.logger.info('EmbeddingService initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize EmbeddingService:', error);
      throw error;
    }
  }

  private async initializeOpenAI(): Promise<void> {
    if (!this.config.openai.apiKey) {
      this.logger.warn('OpenAI API key not provided, OpenAI embeddings will be unavailable');
      return;
    }

    try {
      this.openai = new OpenAI({
        apiKey: this.config.openai.apiKey,
        organization: this.config.openai.organization,
        baseURL: this.config.openai.baseURL,
        maxRetries: 3,
        timeout: this.config.processing.timeout,
      });

      // Test the connection
      await this.openai.models.list();
      this.logger.info('OpenAI client initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize OpenAI client:', error);
      this.openai = null;
    }
  }

  private async initializeLocalModel(): Promise<void> {
    try {
      this.logger.info('Loading local embedding model...');
      this.localModel = await pipeline(
        'feature-extraction', 
        this.config.huggingface.models.embedding,
        { 
          device: 'cpu',
          dtype: 'fp32' 
        }
      );
      this.logger.info('Local embedding model loaded successfully');
    } catch (error) {
      this.logger.error('Failed to load local embedding model:', error);
      this.localModel = null;
    }
  }

  private setupRateLimiting(): void {
    // Clean up rate limiter every minute
    setInterval(() => {
      const now = Date.now();
      const oneMinuteAgo = now - 60000;
      
      for (const [key, timestamps] of this.rateLimiter.entries()) {
        const validTimestamps = timestamps.filter(ts => ts > oneMinuteAgo);
        if (validTimestamps.length === 0) {
          this.rateLimiter.delete(key);
        } else {
          this.rateLimiter.set(key, validTimestamps);
        }
      }
    }, 60000);
  }

  /**
   * Generate embeddings for a single text input with automatic fallback
   */
  async generateEmbedding(
    text: string,
    options?: {
      model?: string;
      preferredProvider?: 'openai' | 'huggingface' | 'local';
      useCache?: boolean;
      retries?: number;
    }
  ): Promise<EmbeddingResult> {
    if (!this.isInitialized) {
      throw new Error('EmbeddingService not initialized');
    }

    if (!text || text.trim().length === 0) {
      throw new Error('Text input is required for embedding generation');
    }

    const cleanedText = this.cleanText(text);
    const cacheKey = this.generateCacheKey(cleanedText, options?.model);
    
    // Check cache first
    if (options?.useCache !== false) {
      const cached = await this.getCachedEmbedding(cacheKey);
      if (cached) {
        return {
          embedding: cached,
          tokens: this.estimateTokens(cleanedText),
          model: options?.model || this.config.openai.models.text,
          provider: 'openai', // We don't store provider in cache, assume OpenAI
          cached: true,
        };
      }
    }

    const providers = this.getProviderOrder(options?.preferredProvider);
    let lastError: Error | null = null;
    const maxRetries = options?.retries || this.config.processing.retryAttempts;

    for (const provider of providers) {
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const result = await this.generateEmbeddingWithProvider(
            cleanedText, 
            provider, 
            options?.model
          );

          // Cache successful result
          if (options?.useCache !== false) {
            await this.cacheEmbedding(cacheKey, result.embedding);
          }

          return result;

        } catch (error) {
          lastError = error as Error;
          this.logger.warn(
            `Embedding generation failed with ${provider} (attempt ${attempt + 1}/${maxRetries}):`,
            { error: error.message, textLength: cleanedText.length }
          );

          if (attempt < maxRetries - 1) {
            const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
            await setTimeout(delay);
          }
        }
      }
    }

    throw new Error(`All embedding providers failed. Last error: ${lastError?.message}`);
  }

  /**
   * Generate embeddings for multiple texts in batches
   */
  async generateBatchEmbeddings(
    texts: string[],
    options?: {
      model?: string;
      preferredProvider?: 'openai' | 'huggingface' | 'local';
      useCache?: boolean;
      batchSize?: number;
      maxConcurrency?: number;
    }
  ): Promise<BatchEmbeddingResult> {
    if (!this.isInitialized) {
      throw new Error('EmbeddingService not initialized');
    }

    if (!texts || texts.length === 0) {
      throw new Error('Text array is required for batch embedding generation');
    }

    const startTime = Date.now();
    const batchSize = options?.batchSize || this.config.processing.batchSize;
    const maxConcurrency = options?.maxConcurrency || this.config.processing.maxConcurrency;
    
    this.logger.info('Starting batch embedding generation', {
      totalTexts: texts.length,
      batchSize,
      maxConcurrency,
      preferredProvider: options?.preferredProvider,
    });

    const results: EmbeddingResult[] = [];
    let totalTokens = 0;
    let successCount = 0;
    let failureCount = 0;
    let cached = 0;

    // Process texts in batches with concurrency control
    const batches = this.createBatches(texts, batchSize);
    const semaphore = new Semaphore(maxConcurrency);

    const batchPromises = batches.map(async (batch, batchIndex) => {
      await semaphore.acquire();
      
      try {
        this.logger.debug(`Processing batch ${batchIndex + 1}/${batches.length}`, {
          batchSize: batch.length
        });

        const batchResults = await Promise.allSettled(
          batch.map(text => this.generateEmbedding(text, options))
        );

        const batchSuccess: EmbeddingResult[] = [];
        
        for (const result of batchResults) {
          if (result.status === 'fulfilled') {
            batchSuccess.push(result.value);
            totalTokens += result.value.tokens;
            successCount++;
            if (result.value.cached) cached++;
          } else {
            failureCount++;
            this.logger.error('Batch item failed:', result.reason);
          }
        }

        return batchSuccess;

      } finally {
        semaphore.release();
      }
    });

    const batchResults = await Promise.all(batchPromises);
    
    // Flatten results
    for (const batchResult of batchResults) {
      results.push(...batchResult);
    }

    const processingTime = Date.now() - startTime;

    this.logger.info('Batch embedding generation completed', {
      totalTexts: texts.length,
      successCount,
      failureCount,
      cached,
      totalTokens,
      processingTime,
      avgTimePerText: processingTime / texts.length,
    });

    // Track metrics
    await this.trackBatchMetrics({
      totalTexts: texts.length,
      successCount,
      failureCount,
      cached,
      processingTime,
      totalTokens,
    });

    return {
      embeddings: results,
      totalTokens,
      processingTime,
      successCount,
      failureCount,
      cached,
    };
  }

  /**
   * Generate embedding with specific provider
   */
  private async generateEmbeddingWithProvider(
    text: string,
    provider: 'openai' | 'huggingface' | 'local',
    model?: string
  ): Promise<EmbeddingResult> {
    const startTime = Date.now();

    switch (provider) {
      case 'openai':
        return await this.generateOpenAIEmbedding(text, model);
      
      case 'huggingface':
        return await this.generateHuggingFaceEmbedding(text, model);
      
      case 'local':
        return await this.generateLocalEmbedding(text, model);
      
      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  }

  private async generateOpenAIEmbedding(
    text: string,
    model?: string
  ): Promise<EmbeddingResult> {
    if (!this.openai) {
      throw new Error('OpenAI client not available');
    }

    if (!this.checkRateLimit('openai')) {
      throw new Error('OpenAI rate limit exceeded');
    }

    const modelToUse = model || this.config.openai.models.text;
    const truncatedText = this.truncateText(text, 8191); // OpenAI limit

    const response = await this.openai.embeddings.create({
      model: modelToUse,
      input: truncatedText,
      encoding_format: 'float',
    });

    this.recordRateLimit('openai');

    return {
      embedding: response.data[0].embedding,
      tokens: response.usage.total_tokens,
      model: modelToUse,
      provider: 'openai',
      cached: false,
    };
  }

  private async generateHuggingFaceEmbedding(
    text: string,
    model?: string
  ): Promise<EmbeddingResult> {
    // For now, fallback to local model if HuggingFace API is not configured
    return await this.generateLocalEmbedding(text, model);
  }

  private async generateLocalEmbedding(
    text: string,
    model?: string
  ): Promise<EmbeddingResult> {
    if (!this.localModel) {
      throw new Error('Local model not available');
    }

    const truncatedText = this.truncateText(text, 512); // Local model limit
    const output = await this.localModel(truncatedText, {
      pooling: 'mean',
      normalize: true,
    });

    // Convert tensor to array
    let embedding: number[];
    if (Array.isArray(output)) {
      embedding = output.flat();
    } else if (output.data) {
      embedding = Array.from(output.data);
    } else {
      throw new Error('Unexpected model output format');
    }

    return {
      embedding,
      tokens: this.estimateTokens(truncatedText),
      model: model || this.config.huggingface.models.embedding,
      provider: 'local',
      cached: false,
    };
  }

  /**
   * Save embeddings to database with optimized batch operations
   */
  async saveEmbeddings(
    contentId: string,
    contentType: 'article' | 'arxiv_paper',
    titleEmbedding: number[],
    contentEmbedding?: number[]
  ): Promise<void> {
    try {
      let updateQuery: string;
      let values: any[];
      
      if (contentType === 'article') {
        if (contentEmbedding) {
          updateQuery = `
            UPDATE articles 
            SET 
              title_embedding = $1::vector,
              content_embedding = $2::vector,
              updated_at = NOW()
            WHERE id = $3
          `;
          values = [
            JSON.stringify(titleEmbedding),
            JSON.stringify(contentEmbedding),
            contentId
          ];
        } else {
          updateQuery = `
            UPDATE articles 
            SET 
              title_embedding = $1::vector,
              content_embedding = $1::vector,
              updated_at = NOW()
            WHERE id = $2
          `;
          values = [JSON.stringify(titleEmbedding), contentId];
        }
      } else {
        if (contentEmbedding) {
          updateQuery = `
            UPDATE arxiv_papers 
            SET 
              title_embedding = $1::vector,
              summary_embedding = $2::vector,
              updated_at = NOW()
            WHERE id = $3
          `;
          values = [
            JSON.stringify(titleEmbedding),
            JSON.stringify(contentEmbedding),
            contentId
          ];
        } else {
          updateQuery = `
            UPDATE arxiv_papers 
            SET 
              title_embedding = $1::vector,
              summary_embedding = $1::vector,
              updated_at = NOW()
            WHERE id = $2
          `;
          values = [JSON.stringify(titleEmbedding), contentId];
        }
      }

      await this.databaseService.query(updateQuery, values);

      this.logger.debug('Embeddings saved to database', {
        contentId,
        contentType,
        titleDimensions: titleEmbedding.length,
        contentDimensions: contentEmbedding?.length,
      });

    } catch (error) {
      this.logger.error('Failed to save embeddings to database', {
        contentId,
        contentType,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Generate and save user preference embeddings
   */
  async generateUserPreferenceEmbedding(
    userId: string,
    preferences: {
      categories: string[];
      tags: string[];
      interests: string[];
      readingHistory?: string[];
    }
  ): Promise<void> {
    try {
      // Create comprehensive preference text
      const preferenceTexts = [
        ...preferences.categories.map(cat => `interested in ${cat}`),
        ...preferences.tags.map(tag => `likes ${tag}`),
        ...preferences.interests,
        ...(preferences.readingHistory || []),
      ];

      const combinedText = preferenceTexts.join('. ');

      if (combinedText.trim().length === 0) {
        this.logger.warn('No preference text available for user', { userId });
        return;
      }

      const result = await this.generateEmbedding(combinedText);

      // Save to user preferences table
      const updateQuery = `
        UPDATE user_preferences 
        SET 
          preference_embedding = $1::vector,
          updated_at = NOW()
        WHERE user_id = $2
      `;

      await this.databaseService.query(updateQuery, [
        JSON.stringify(result.embedding),
        userId,
      ]);

      this.logger.info('User preference embedding generated and saved', {
        userId,
        dimensions: result.embedding.length,
        provider: result.provider,
        cached: result.cached,
      });

    } catch (error) {
      this.logger.error('Failed to generate user preference embedding', {
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Find similar content using vector similarity with advanced filtering
   */
  async findSimilarContent(
    contentId: string,
    contentType: 'article' | 'arxiv_paper',
    options?: {
      limit?: number;
      similarityThreshold?: number;
      excludeCategories?: string[];
      includeCategories?: string[];
      maxAge?: number; // days
      minQualityScore?: number;
    }
  ): Promise<Array<{ 
    id: string; 
    similarity: number; 
    title: string; 
    category?: string;
    publishedAt?: Date;
    qualityScore?: number;
  }>> {
    try {
      const limit = options?.limit || 10;
      const threshold = options?.similarityThreshold || this.config.semantic.similarityThreshold;
      
      let query: string;
      let queryParams: any[] = [contentId, limit, threshold];
      let paramIndex = 4;

      if (contentType === 'article') {
        query = `
          WITH target_embedding AS (
            SELECT content_embedding 
            FROM articles 
            WHERE id = $1 AND content_embedding IS NOT NULL
          )
          SELECT 
            a.id,
            a.title,
            a.category,
            a.published_at,
            a.quality_score,
            1 - (a.content_embedding <=> t.content_embedding) as similarity
          FROM articles a
          CROSS JOIN target_embedding t
          WHERE a.id != $1 
            AND a.deleted_at IS NULL 
            AND a.status = 'published'
            AND a.content_embedding IS NOT NULL
            AND 1 - (a.content_embedding <=> t.content_embedding) >= $3
        `;
      } else {
        query = `
          WITH target_embedding AS (
            SELECT summary_embedding 
            FROM arxiv_papers 
            WHERE id = $1 AND summary_embedding IS NOT NULL
          )
          SELECT 
            p.id,
            p.title,
            p.primary_category as category,
            p.published_at,
            p.relevance_score as quality_score,
            1 - (p.summary_embedding <=> t.summary_embedding) as similarity
          FROM arxiv_papers p
          CROSS JOIN target_embedding t
          WHERE p.id != $1 
            AND p.summary_embedding IS NOT NULL
            AND 1 - (p.summary_embedding <=> t.summary_embedding) >= $3
        `;
      }

      // Add category filters
      if (options?.excludeCategories?.length) {
        query += ` AND ${contentType === 'article' ? 'a' : 'p'}.category != ANY($${paramIndex})`;
        queryParams.push(options.excludeCategories);
        paramIndex++;
      }

      if (options?.includeCategories?.length) {
        query += ` AND ${contentType === 'article' ? 'a' : 'p'}.category = ANY($${paramIndex})`;
        queryParams.push(options.includeCategories);
        paramIndex++;
      }

      // Add age filter
      if (options?.maxAge) {
        query += ` AND ${contentType === 'article' ? 'a' : 'p'}.published_at >= NOW() - INTERVAL '${options.maxAge} days'`;
      }

      // Add quality filter
      if (options?.minQualityScore) {
        const scoreField = contentType === 'article' ? 'quality_score' : 'relevance_score';
        query += ` AND ${contentType === 'article' ? 'a' : 'p'}.${scoreField} >= $${paramIndex}`;
        queryParams.push(options.minQualityScore);
        paramIndex++;
      }

      query += ` ORDER BY ${contentType === 'article' ? 'a' : 'p'}.${contentType === 'article' ? 'content_embedding' : 'summary_embedding'} <=> t.${contentType === 'article' ? 'content_embedding' : 'summary_embedding'} LIMIT $2`;

      const results = await this.databaseService.query(query, queryParams);

      this.logger.debug('Similar content found', {
        contentId,
        contentType,
        resultsCount: results.length,
        threshold,
        avgSimilarity: results.length > 0 ? 
          results.reduce((sum, r) => sum + parseFloat(r.similarity), 0) / results.length : 0,
      });

      return results.map(row => ({
        id: row.id,
        similarity: parseFloat(row.similarity),
        title: row.title,
        category: row.category,
        publishedAt: row.published_at,
        qualityScore: row.quality_score,
      }));

    } catch (error) {
      this.logger.error('Failed to find similar content', {
        contentId,
        contentType,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get embedding statistics and metrics
   */
  async getEmbeddingMetrics(): Promise<EmbeddingMetrics> {
    try {
      const today = new Date().toISOString().split('T')[0];
      const keys = {
        requests: `embedding_metrics:${today}:requests`,
        tokens: `embedding_metrics:${today}:tokens`,
        processingTime: `embedding_metrics:${today}:processing_time`,
        errors: `embedding_errors:${today}`,
        cacheHits: `embedding_cache:${today}:hits`,
        cacheMisses: `embedding_cache:${today}:misses`,
        openaiRequests: `embedding_provider:${today}:openai`,
        huggingfaceRequests: `embedding_provider:${today}:huggingface`,
        localRequests: `embedding_provider:${today}:local`,
      };

      const [
        requests, tokens, processingTime, errors,
        cacheHits, cacheMisses,
        openaiRequests, huggingfaceRequests, localRequests
      ] = await Promise.all([
        this.databaseService.cacheGet(keys.requests) || 0,
        this.databaseService.cacheGet(keys.tokens) || 0,
        this.databaseService.cacheGet(keys.processingTime) || 0,
        this.databaseService.cacheGet(keys.errors) || 0,
        this.databaseService.cacheGet(keys.cacheHits) || 0,
        this.databaseService.cacheGet(keys.cacheMisses) || 0,
        this.databaseService.cacheGet(keys.openaiRequests) || 0,
        this.databaseService.cacheGet(keys.huggingfaceRequests) || 0,
        this.databaseService.cacheGet(keys.localRequests) || 0,
      ]);

      const totalRequests = Number(requests);
      const totalCacheRequests = Number(cacheHits) + Number(cacheMisses);

      return {
        dailyRequests: totalRequests,
        dailyTokens: Number(tokens),
        avgProcessingTime: totalRequests > 0 ? Number(processingTime) / totalRequests : 0,
        errorRate: totalRequests > 0 ? Number(errors) / totalRequests : 0,
        cacheHitRate: totalCacheRequests > 0 ? Number(cacheHits) / totalCacheRequests : 0,
        providerBreakdown: {
          openai: Number(openaiRequests),
          huggingface: Number(huggingfaceRequests),
          local: Number(localRequests),
        },
      };
    } catch (error) {
      this.logger.error('Failed to get embedding metrics:', error);
      return {
        dailyRequests: 0,
        dailyTokens: 0,
        avgProcessingTime: 0,
        errorRate: 0,
        cacheHitRate: 0,
        providerBreakdown: { openai: 0, huggingface: 0, local: 0 },
      };
    }
  }

  // Utility methods
  private cleanText(text: string): string {
    return text
      .replace(/\s+/g, ' ') // Replace multiple whitespace with single space
      .replace(/[^\w\s.,!?;:-]/g, '') // Remove special characters except basic punctuation
      .trim();
  }

  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }
    
    // Truncate at word boundary
    const truncated = text.substring(0, maxLength);
    const lastSpace = truncated.lastIndexOf(' ');
    
    return lastSpace > maxLength * 0.8 ? truncated.substring(0, lastSpace) : truncated;
  }

  private estimateTokens(text: string): number {
    // Rough estimation: 1 token ≈ 4 characters for English text
    return Math.ceil(text.length / 4);
  }

  private generateCacheKey(text: string, model?: string): string {
    const hash = createHash('sha256')
      .update(`${text}:${model || 'default'}`)
      .digest('hex');
    return `embedding:${hash}`;
  }

  private async getCachedEmbedding(key: string): Promise<number[] | null> {
    try {
      await this.databaseService.incrementCounter('embedding_cache:requests', 1, 86400);
      const cached = await this.databaseService.cacheGet<number[]>(key);
      
      if (cached) {
        await this.databaseService.incrementCounter('embedding_cache:hits', 1, 86400);
        return cached;
      } else {
        await this.databaseService.incrementCounter('embedding_cache:misses', 1, 86400);
        return null;
      }
    } catch (error) {
      this.logger.error('Cache retrieval error:', error);
      return null;
    }
  }

  private async cacheEmbedding(key: string, embedding: number[]): Promise<void> {
    try {
      // Cache for 24 hours
      await this.databaseService.cacheSet(key, embedding, 86400);
    } catch (error) {
      this.logger.error('Cache storage error:', error);
    }
  }

  private getProviderOrder(preferred?: 'openai' | 'huggingface' | 'local'): ('openai' | 'huggingface' | 'local')[] {
    const allProviders: ('openai' | 'huggingface' | 'local')[] = ['openai', 'local', 'huggingface'];
    
    if (!preferred) {
      return allProviders;
    }

    return [preferred, ...allProviders.filter(p => p !== preferred)];
  }

  private checkRateLimit(provider: string): boolean {
    const now = Date.now();
    const key = `${provider}:${Math.floor(now / 60000)}`; // Per minute bucket
    const timestamps = this.rateLimiter.get(key) || [];
    
    const limit = provider === 'openai' ? this.config.openai.rateLimit.requestsPerMinute : 1000;
    
    return timestamps.length < limit;
  }

  private recordRateLimit(provider: string): void {
    const now = Date.now();
    const key = `${provider}:${Math.floor(now / 60000)}`;
    const timestamps = this.rateLimiter.get(key) || [];
    timestamps.push(now);
    this.rateLimiter.set(key, timestamps);
  }

  private createBatches<T>(array: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < array.length; i += batchSize) {
      batches.push(array.slice(i, i + batchSize));
    }
    return batches;
  }

  private async trackBatchMetrics(metrics: {
    totalTexts: number;
    successCount: number;
    failureCount: number;
    cached: number;
    processingTime: number;
    totalTokens: number;
  }): Promise<void> {
    try {
      const today = new Date().toISOString().split('T')[0];
      
      await Promise.all([
        this.databaseService.incrementCounter(`embedding_batch:${today}:requests`, 1, 86400),
        this.databaseService.incrementCounter(`embedding_batch:${today}:texts`, metrics.totalTexts, 86400),
        this.databaseService.incrementCounter(`embedding_batch:${today}:success`, metrics.successCount, 86400),
        this.databaseService.incrementCounter(`embedding_batch:${today}:failures`, metrics.failureCount, 86400),
        this.databaseService.incrementCounter(`embedding_batch:${today}:cached`, metrics.cached, 86400),
        this.databaseService.incrementCounter(`embedding_batch:${today}:processing_time`, metrics.processingTime, 86400),
        this.databaseService.incrementCounter(`embedding_batch:${today}:tokens`, metrics.totalTokens, 86400),
      ]);
    } catch (error) {
      this.logger.error('Failed to track batch metrics:', error);
    }
  }
}

// Semaphore for concurrency control
class Semaphore {
  private current = 0;
  private waiting: (() => void)[] = [];

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    return new Promise((resolve) => {
      if (this.current < this.max) {
        this.current++;
        resolve();
      } else {
        this.waiting.push(resolve);
      }
    });
  }

  release(): void {
    this.current--;
    if (this.waiting.length > 0) {
      this.current++;
      const resolve = this.waiting.shift()!;
      resolve();
    }
  }
}