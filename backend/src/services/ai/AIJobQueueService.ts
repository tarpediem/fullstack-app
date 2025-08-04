import { Queue, Worker, Job, QueueOptions, WorkerOptions } from 'bullmq';
import { RedisOptions } from 'ioredis';
import { Logger } from 'winston';
import { DatabaseService } from '../database/DatabaseService';
import { EmbeddingService } from './EmbeddingService';
import { ContentCategorizationService } from './ContentCategorizationService';
import { ContentAnalysisService } from './ContentAnalysisService';
import { RecommendationEngine } from './RecommendationEngine';
import { TrendingTopicsService } from './TrendingTopicsService';
import { aiConfig, AIConfig } from '../../config/ai.config';

// Job Data Interfaces
export interface EmbeddingJobData {
  contentId: string;
  contentType: 'article' | 'arxiv_paper' | 'user_preference';
  title?: string;
  content: string;
  priority?: number;
  retryAttempts?: number;
  userId?: string; // For user preference embeddings
}

export interface CategorizationJobData {
  contentId: string;
  contentType: 'article' | 'arxiv_paper';
  title: string;
  content: string;
  existingCategory?: string;
  priority?: number;
  options?: {
    method?: 'ai' | 'keyword' | 'embedding' | 'hybrid' | 'auto';
    useCache?: boolean;
  };
}

export interface ContentAnalysisJobData {
  contentId: string;
  contentType: 'article' | 'arxiv_paper';
  title: string;
  content: string;
  priority?: number;
  options?: {
    includeSummary?: boolean;
    includeSentiment?: boolean;
    includeQuality?: boolean;
    analysisDepth?: 'basic' | 'standard' | 'comprehensive';
  };
}

export interface RecommendationJobData {
  userId: string;
  priority?: number;
  options?: {
    limit?: number;
    excludeRead?: boolean;
    categories?: string[];
    contentTypes?: ('article' | 'arxiv_paper')[];
    refreshCache?: boolean;
  };
}

export interface TrendingTopicsJobData {
  priority?: number;
  options?: {
    timeWindows?: ('short' | 'medium' | 'long')[];
    minMentions?: number;
    maxTopics?: number;
    categories?: string[];
    refreshCache?: boolean;
  };
}

export interface DuplicateDetectionJobData {
  contentId: string;
  contentType: 'article' | 'arxiv_paper';
  title: string;
  content: string;
  priority?: number;
}

export interface BatchProcessingJobData {
  operation: 'embedding' | 'categorization' | 'analysis' | 'duplicate_detection';
  items: Array<{
    contentId: string;
    contentType: 'article' | 'arxiv_paper';
    title: string;
    content: string;
  }>;
  priority?: number;
  batchSize?: number;
  options?: any;
}

// Job Result Interfaces
export interface JobResult {
  success: boolean;
  data?: any;
  error?: string;
  processingTime: number;
  timestamp: Date;
}

export interface AIJobQueueConfig {
  redis: RedisOptions;
  queues: {
    [queueName: string]: {
      concurrency: number;
      maxRetries: number;
      retryDelay: number;
      rateLimiting?: {
        max: number;
        duration: number;
      };
    };
  };
  processing: {
    batchSize: number;
    maxConcurrency: number;
    timeout: number;
    enablePriority: boolean;
  };
}

export class AIJobQueueService {
  // Queue instances
  private embeddingQueue: Queue<EmbeddingJobData>;
  private categorizationQueue: Queue<CategorizationJobData>;
  private analysisQueue: Queue<ContentAnalysisJobData>;
  private recommendationQueue: Queue<RecommendationJobData>;
  private trendingQueue: Queue<TrendingTopicsJobData>;
  private duplicateQueue: Queue<DuplicateDetectionJobData>;
  private batchQueue: Queue<BatchProcessingJobData>;

  // Worker instances
  private embeddingWorker: Worker<EmbeddingJobData>;
  private categorizationWorker: Worker<CategorizationJobData>;
  private analysisWorker: Worker<ContentAnalysisJobData>;
  private recommendationWorker: Worker<RecommendationJobData>;
  private trendingWorker: Worker<TrendingTopicsJobData>;
  private duplicateWorker: Worker<DuplicateDetectionJobData>;
  private batchWorker: Worker<BatchProcessingJobData>;

  private isInitialized: boolean = false;
  private processingStats: Map<string, { processed: number; failed: number; totalTime: number }> = new Map();

  constructor(
    private config: AIJobQueueConfig,
    private logger: Logger,
    private databaseService: DatabaseService,
    private embeddingService: EmbeddingService,
    private categorizationService: ContentCategorizationService,
    private analysisService: ContentAnalysisService,
    private recommendationEngine: RecommendationEngine,
    private trendingService: TrendingTopicsService
  ) {}

  async initialize(): Promise<void> {
    try {
      this.initializeQueues();
      this.initializeWorkers();
      this.setupMetrics();
      this.setupHealthChecks();
      this.isInitialized = true;
      this.logger.info('AIJobQueueService initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize AIJobQueueService:', error);
      throw error;
    }
  }

  private initializeQueues(): void {
    const defaultQueueOptions: QueueOptions = {
      connection: this.config.redis,
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
      },
    };

    // Initialize all queues
    this.embeddingQueue = new Queue('ai-embeddings', {
      ...defaultQueueOptions,
      defaultJobOptions: {
        ...defaultQueueOptions.defaultJobOptions,
        attempts: this.config.queues['embeddings']?.maxRetries || 3,
      },
    });

    this.categorizationQueue = new Queue('ai-categorization', {
      ...defaultQueueOptions,
      defaultJobOptions: {
        ...defaultQueueOptions.defaultJobOptions,
        attempts: this.config.queues['categorization']?.maxRetries || 3,
      },
    });

    this.analysisQueue = new Queue('ai-analysis', {
      ...defaultQueueOptions,
      defaultJobOptions: {
        ...defaultQueueOptions.defaultJobOptions,
        attempts: this.config.queues['analysis']?.maxRetries || 2,
      },
    });

    this.recommendationQueue = new Queue('ai-recommendations', {
      ...defaultQueueOptions,
      defaultJobOptions: {
        ...defaultQueueOptions.defaultJobOptions,
        attempts: this.config.queues['recommendations']?.maxRetries || 2,
      },
    });

    this.trendingQueue = new Queue('ai-trending', {
      ...defaultQueueOptions,
      defaultJobOptions: {
        ...defaultQueueOptions.defaultJobOptions,
        attempts: this.config.queues['trending']?.maxRetries || 2,
      },
    });

    this.duplicateQueue = new Queue('ai-duplicates', {
      ...defaultQueueOptions,
      defaultJobOptions: {
        ...defaultQueueOptions.defaultJobOptions,
        attempts: this.config.queues['duplicates']?.maxRetries || 2,
      },
    });

    this.batchQueue = new Queue('ai-batch', {
      ...defaultQueueOptions,
      defaultJobOptions: {
        ...defaultQueueOptions.defaultJobOptions,
        attempts: 1, // Batch jobs shouldn't retry, handle internally
      },
    });

    this.logger.info('AI job queues initialized');
  }

  private initializeWorkers(): void {
    const defaultWorkerOptions: WorkerOptions = {
      connection: this.config.redis,
      maxStalledCount: 1,
      stalledInterval: 30000,
    };

    // Embedding worker
    this.embeddingWorker = new Worker<EmbeddingJobData>(
      'ai-embeddings',
      async (job: Job<EmbeddingJobData>) => await this.processEmbeddingJob(job),
      {
        ...defaultWorkerOptions,
        concurrency: this.config.queues['embeddings']?.concurrency || 3,
      }
    );

    // Categorization worker
    this.categorizationWorker = new Worker<CategorizationJobData>(
      'ai-categorization',
      async (job: Job<CategorizationJobData>) => await this.processCategorizationJob(job),
      {
        ...defaultWorkerOptions,
        concurrency: this.config.queues['categorization']?.concurrency || 2,
      }
    );

    // Content analysis worker
    this.analysisWorker = new Worker<ContentAnalysisJobData>(
      'ai-analysis',
      async (job: Job<ContentAnalysisJobData>) => await this.processAnalysisJob(job),
      {
        ...defaultWorkerOptions,
        concurrency: this.config.queues['analysis']?.concurrency || 2,
      }
    );

    // Recommendation worker
    this.recommendationWorker = new Worker<RecommendationJobData>(
      'ai-recommendations',
      async (job: Job<RecommendationJobData>) => await this.processRecommendationJob(job),
      {
        ...defaultWorkerOptions,
        concurrency: this.config.queues['recommendations']?.concurrency || 1,
      }
    );

    // Trending topics worker
    this.trendingWorker = new Worker<TrendingTopicsJobData>(
      'ai-trending',
      async (job: Job<TrendingTopicsJobData>) => await this.processTrendingJob(job),
      {
        ...defaultWorkerOptions,
        concurrency: this.config.queues['trending']?.concurrency || 1,
      }
    );

    // Duplicate detection worker
    this.duplicateWorker = new Worker<DuplicateDetectionJobData>(
      'ai-duplicates',
      async (job: Job<DuplicateDetectionJobData>) => await this.processDuplicateJob(job),
      {
        ...defaultWorkerOptions,
        concurrency: this.config.queues['duplicates']?.concurrency || 2,
      }
    );

    // Batch processing worker
    this.batchWorker = new Worker<BatchProcessingJobData>(
      'ai-batch',
      async (job: Job<BatchProcessingJobData>) => await this.processBatchJob(job),
      {
        ...defaultWorkerOptions,
        concurrency: this.config.queues['batch']?.concurrency || 1,
      }
    );

    this.setupWorkerEventListeners();
    this.logger.info('AI job workers initialized');
  }

  private setupWorkerEventListeners(): void {
    const workers = [
      { name: 'embedding', worker: this.embeddingWorker },
      { name: 'categorization', worker: this.categorizationWorker },
      { name: 'analysis', worker: this.analysisWorker },
      { name: 'recommendation', worker: this.recommendationWorker },
      { name: 'trending', worker: this.trendingWorker },
      { name: 'duplicate', worker: this.duplicateWorker },
      { name: 'batch', worker: this.batchWorker },
    ];

    for (const { name, worker } of workers) {
      worker.on('completed', (job) => {
        this.logger.debug(`${name} job completed: ${job.id}`, {
          processingTime: Date.now() - job.processedOn!,
          attempts: job.attemptsMade,
        });
        this.updateStats(name, 'completed', Date.now() - job.processedOn!);
      });

      worker.on('failed', (job, err) => {
        this.logger.error(`${name} job failed: ${job?.id}`, {
          error: err.message,
          attempts: job?.attemptsMade,
          data: job?.data,
        });
        this.updateStats(name, 'failed', 0);
      });

      worker.on('stalled', (jobId) => {
        this.logger.warn(`${name} job stalled: ${jobId}`);
      });
    }
  }

  private setupMetrics(): void {
    // Initialize stats for all job types
    const jobTypes = ['embedding', 'categorization', 'analysis', 'recommendation', 'trending', 'duplicate', 'batch'];
    for (const type of jobTypes) {
      this.processingStats.set(type, { processed: 0, failed: 0, totalTime: 0 });
    }

    // Reset daily stats
    setInterval(() => {
      for (const stats of this.processingStats.values()) {
        stats.processed = 0;
        stats.failed = 0;
        stats.totalTime = 0;
      }
    }, 24 * 60 * 60 * 1000);

    this.logger.info('Job metrics system initialized');
  }

  private setupHealthChecks(): void {
    // Periodic health check for all queues
    setInterval(async () => {
      await this.performHealthCheck();
    }, 5 * 60 * 1000); // Every 5 minutes
  }

  // Job Processing Methods

  private async processEmbeddingJob(job: Job<EmbeddingJobData>): Promise<JobResult> {
    const startTime = Date.now();
    
    try {
      await job.updateProgress(10);
      
      const { contentId, contentType, title, content, userId } = job.data;
      
      this.logger.info(`Processing embedding job for ${contentType}: ${contentId}`);

      if (contentType === 'user_preference' && userId) {
        // Generate user preference embedding
        const preferences = JSON.parse(content); // Assuming content contains preference data
        await this.embeddingService.generateUserPreferenceEmbedding(userId, preferences);
        
        await job.updateProgress(100);
        return {
          success: true,
          data: { userId, contentType: 'user_preference' },
          processingTime: Date.now() - startTime,
          timestamp: new Date(),
        };
      } else {
        // Generate content embeddings
        const fullText = title ? `${title}. ${content}` : content;
        
        await job.updateProgress(30);
        const embedding = await this.embeddingService.generateEmbedding(fullText);
        
        await job.updateProgress(70);
        
        // Save embeddings to database
        const titleEmbedding = title ? await this.embeddingService.generateEmbedding(title) : embedding;
        const contentEmbedding = embedding;
        
        await this.embeddingService.saveEmbeddings(
          contentId,
          contentType as 'article' | 'arxiv_paper',
          titleEmbedding.embedding,
          contentEmbedding.embedding
        );
        
        await job.updateProgress(100);
        
        return {
          success: true,
          data: {
            contentId,
            contentType,
            dimensions: embedding.embedding.length,
            provider: embedding.provider,
            cached: embedding.cached,
          },
          processingTime: Date.now() - startTime,
          timestamp: new Date(),
        };
      }

    } catch (error) {
      this.logger.error(`Embedding job failed for ${job.data.contentId}:`, error);
      
      return {
        success: false,
        error: error.message,
        processingTime: Date.now() - startTime,
        timestamp: new Date(),
      };
    }
  }

  private async processCategorizationJob(job: Job<CategorizationJobData>): Promise<JobResult> {
    const startTime = Date.now();
    
    try {
      await job.updateProgress(10);
      
      const { contentId, contentType, title, content, existingCategory, options } = job.data;
      
      this.logger.info(`Processing categorization job for ${contentType}: ${contentId}`);

      await job.updateProgress(30);
      
      const result = await this.categorizationService.categorizeContent(
        content,
        title,
        existingCategory,
        options
      );
      
      await job.updateProgress(70);
      
      // Save categorization result
      await this.categorizationService.saveCategorization(
        contentId,
        contentType,
        result
      );
      
      await job.updateProgress(100);
      
      return {
        success: true,
        data: {
          contentId,
          contentType,
          primaryCategory: result.primaryCategory,
          additionalCategories: result.additionalCategories.length,
          confidence: result.confidence,
          method: result.method,
          tags: result.tags.length,
        },
        processingTime: Date.now() - startTime,
        timestamp: new Date(),
      };

    } catch (error) {
      this.logger.error(`Categorization job failed for ${job.data.contentId}:`, error);
      
      return {
        success: false,
        error: error.message,
        processingTime: Date.now() - startTime,
        timestamp: new Date(),
      };
    }
  }

  private async processAnalysisJob(job: Job<ContentAnalysisJobData>): Promise<JobResult> {
    const startTime = Date.now();
    
    try {
      await job.updateProgress(10);
      
      const { contentId, contentType, title, content, options } = job.data;
      
      this.logger.info(`Processing analysis job for ${contentType}: ${contentId}`);

      await job.updateProgress(30);
      
      const result = await this.analysisService.analyzeContent(
        contentId,
        contentType,
        title,
        content,
        options
      );
      
      await job.updateProgress(100);
      
      return {
        success: true,
        data: {
          contentId,
          contentType,
          qualityScore: result.analysis.quality.overall,
          sentiment: result.analysis.sentiment.polarity,
          readabilityLevel: result.analysis.quality.readability.level,
          wordCount: result.analysis.metadata.wordCount,
          readingTime: result.analysis.metadata.readingTime,
          summary: result.analysis.summary ? {
            short: result.analysis.summary.short.length,
            keyPoints: result.analysis.summary.keyPoints.length,
          } : undefined,
        },
        processingTime: Date.now() - startTime,
        timestamp: new Date(),
      };

    } catch (error) {
      this.logger.error(`Analysis job failed for ${job.data.contentId}:`, error);
      
      return {
        success: false,
        error: error.message,
        processingTime: Date.now() - startTime,
        timestamp: new Date(),
      };
    }
  }

  private async processRecommendationJob(job: Job<RecommendationJobData>): Promise<JobResult> {
    const startTime = Date.now();
    
    try {
      await job.updateProgress(10);
      
      const { userId, options } = job.data;
      
      this.logger.info(`Processing recommendation job for user: ${userId}`);

      await job.updateProgress(30);
      
      const result = await this.recommendationEngine.generateRecommendations(userId, options);
      
      await job.updateProgress(100);
      
      return {
        success: true,
        data: {
          userId,
          recommendationCount: result.recommendations.length,
          totalCount: result.totalCount,
          algorithms: result.algorithms,
          userProfile: result.userProfile,
          refreshTime: result.refreshTime,
        },
        processingTime: Date.now() - startTime,
        timestamp: new Date(),
      };

    } catch (error) {
      this.logger.error(`Recommendation job failed for user ${job.data.userId}:`, error);
      
      return {
        success: false,
        error: error.message,
        processingTime: Date.now() - startTime,
        timestamp: new Date(),
      };
    }
  }

  private async processTrendingJob(job: Job<TrendingTopicsJobData>): Promise<JobResult> {
    const startTime = Date.now();
    
    try {
      await job.updateProgress(10);
      
      const { options } = job.data;
      
      this.logger.info('Processing trending topics job');

      await job.updateProgress(30);
      
      const result = await this.trendingService.detectTrendingTopics(options);
      
      await job.updateProgress(100);
      
      return {
        success: true,
        data: {
          topicsCount: result.topics.length,
          totalArticlesAnalyzed: result.metadata.totalArticlesAnalyzed,
          avgTrendScore: result.metadata.avgTrendScore,
          timeWindows: Object.keys(result.timeWindows),
        },
        processingTime: Date.now() - startTime,
        timestamp: new Date(),
      };

    } catch (error) {
      this.logger.error('Trending topics job failed:', error);
      
      return {
        success: false,
        error: error.message,
        processingTime: Date.now() - startTime,
        timestamp: new Date(),
      };
    }
  }

  private async processDuplicateJob(job: Job<DuplicateDetectionJobData>): Promise<JobResult> {
    const startTime = Date.now();
    
    try {
      await job.updateProgress(10);
      
      const { contentId, contentType, title, content } = job.data;
      
      this.logger.info(`Processing duplicate detection job for ${contentType}: ${contentId}`);

      await job.updateProgress(30);
      
      // Simplified duplicate detection using content hash and embedding similarity
      const contentHash = require('crypto').createHash('sha256').update(content).digest('hex');
      
      // Check for exact duplicates by hash
      const exactDuplicates = await this.findExactDuplicates(contentHash, contentType);
      
      await job.updateProgress(60);
      
      let similarContent: any[] = [];
      if (exactDuplicates.length === 0) {
        // Check for similar content using embeddings
        try {
          similarContent = await this.embeddingService.findSimilarContent(
            contentId,
            contentType as 'article' | 'arxiv_paper',
            { limit: 5, similarityThreshold: 0.9 }
          );
        } catch (error) {
          this.logger.warn('Similar content detection failed:', error);
        }
      }
      
      await job.updateProgress(90);
      
      // Update database with duplicate information
      if (exactDuplicates.length > 0 || similarContent.length > 0) {
        await this.markAsDuplicate(contentId, contentType, exactDuplicates[0]?.id || similarContent[0]?.id);
      }
      
      await job.updateProgress(100);
      
      return {
        success: true,
        data: {
          contentId,
          contentType,
          exactDuplicates: exactDuplicates.length,
          similarContent: similarContent.length,
          isDuplicate: exactDuplicates.length > 0,
          isSimilar: similarContent.length > 0,
          contentHash,
        },
        processingTime: Date.now() - startTime,
        timestamp: new Date(),
      };

    } catch (error) {
      this.logger.error(`Duplicate detection job failed for ${job.data.contentId}:`, error);
      
      return {
        success: false,
        error: error.message,
        processingTime: Date.now() - startTime,
        timestamp: new Date(),
      };
    }
  }

  private async processBatchJob(job: Job<BatchProcessingJobData>): Promise<JobResult> {
    const startTime = Date.now();
    
    try {
      await job.updateProgress(5);
      
      const { operation, items, batchSize, options } = job.data;
      
      this.logger.info(`Processing batch ${operation} job with ${items.length} items`);

      const actualBatchSize = batchSize || this.config.processing.batchSize;
      const results = [];
      let processed = 0;

      // Process items in batches
      for (let i = 0; i < items.length; i += actualBatchSize) {
        const batch = items.slice(i, i + actualBatchSize);
        
        try {
          let batchResults;
          
          switch (operation) {
            case 'embedding':
              batchResults = await this.processBatchEmbeddings(batch);
              break;
            case 'categorization':
              batchResults = await this.processBatchCategorization(batch, options);
              break;
            case 'analysis':
              batchResults = await this.processBatchAnalysis(batch, options);
              break;
            case 'duplicate_detection':
              batchResults = await this.processBatchDuplicateDetection(batch);
              break;
            default:
              throw new Error(`Unknown batch operation: ${operation}`);
          }
          
          results.push(...batchResults);
          processed += batch.length;
          
          // Update progress
          const progress = Math.min(95, (processed / items.length) * 90 + 5);
          await job.updateProgress(progress);
          
        } catch (error) {
          this.logger.error(`Batch processing failed for batch ${i / actualBatchSize + 1}:`, error);
          // Continue with next batch
        }
      }
      
      await job.updateProgress(100);
      
      const successful = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;
      
      return {
        success: true,
        data: {
          operation,
          totalItems: items.length,
          processed: results.length,
          successful,
          failed,
          results: results.slice(0, 10), // Include first 10 results as sample
        },
        processingTime: Date.now() - startTime,
        timestamp: new Date(),
      };

    } catch (error) {
      this.logger.error('Batch processing job failed:', error);
      
      return {
        success: false,
        error: error.message,
        processingTime: Date.now() - startTime,
        timestamp: new Date(),
      };
    }
  }

  // Batch Processing Helper Methods

  private async processBatchEmbeddings(items: BatchProcessingJobData['items']): Promise<JobResult[]> {
    const texts = items.map(item => item.title ? `${item.title}. ${item.content}` : item.content);
    
    try {
      const batchResult = await this.embeddingService.generateBatchEmbeddings(texts);
      
      const results = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const embedding = batchResult.embeddings[i];
        
        if (embedding) {
          try {
            await this.embeddingService.saveEmbeddings(
              item.contentId,
              item.contentType as 'article' | 'arxiv_paper',
              embedding.embedding,
              embedding.embedding
            );
            
            results.push({
              success: true,
              data: { contentId: item.contentId, dimensions: embedding.embedding.length },
              processingTime: 0,
              timestamp: new Date(),
            });
          } catch (error) {
            results.push({
              success: false,
              error: error.message,
              processingTime: 0,
              timestamp: new Date(),
            });
          }
        } else {
          results.push({
            success: false,
            error: 'No embedding generated',
            processingTime: 0,
            timestamp: new Date(),
          });
        }
      }
      
      return results;
    } catch (error) {
      return items.map(item => ({
        success: false,
        error: error.message,
        processingTime: 0,
        timestamp: new Date(),
      }));
    }
  }

  private async processBatchCategorization(items: BatchProcessingJobData['items'], options?: any): Promise<JobResult[]> {
    try {
      const contents = items.map(item => ({
        id: item.contentId,
        content: item.content,
        title: item.title,
      }));
      
      const batchResult = await this.categorizationService.batchCategorizeContent(contents, options);
      
      return batchResult.map(result => ({
        success: true,
        data: {
          contentId: result.id,
          primaryCategory: result.result.primaryCategory,
          confidence: result.result.confidence,
          method: result.result.method,
        },
        processingTime: result.result.processingTime,
        timestamp: new Date(),
      }));
    } catch (error) {
      return items.map(item => ({
        success: false,
        error: error.message,
        processingTime: 0,
        timestamp: new Date(),
      }));
    }
  }

  private async processBatchAnalysis(items: BatchProcessingJobData['items'], options?: any): Promise<JobResult[]> {
    try {
      const contents = items.map(item => ({
        contentId: item.contentId,
        contentType: item.contentType as 'article' | 'arxiv_paper',
        title: item.title,
        content: item.content,
      }));
      
      const batchResult = await this.analysisService.batchAnalyzeContent(contents, options);
      
      return batchResult.results.map(result => ({
        success: true,
        data: {
          contentId: result.contentId,
          qualityScore: result.analysis.quality.overall,
          sentiment: result.analysis.sentiment.polarity,
          readingTime: result.analysis.metadata.readingTime,
        },
        processingTime: result.processingTime,
        timestamp: new Date(),
      }));
    } catch (error) {
      return items.map(item => ({
        success: false,
        error: error.message,
        processingTime: 0,
        timestamp: new Date(),
      }));
    }
  }

  private async processBatchDuplicateDetection(items: BatchProcessingJobData['items']): Promise<JobResult[]> {
    const results = [];
    
    for (const item of items) {
      try {
        const contentHash = require('crypto').createHash('sha256').update(item.content).digest('hex');
        const exactDuplicates = await this.findExactDuplicates(contentHash, item.contentType);
        
        results.push({
          success: true,
          data: {
            contentId: item.contentId,
            exactDuplicates: exactDuplicates.length,
            isDuplicate: exactDuplicates.length > 0,
            contentHash,
          },
          processingTime: 0,
          timestamp: new Date(),
        });
      } catch (error) {
        results.push({
          success: false,
          error: error.message,
          processingTime: 0,
          timestamp: new Date(),
        });
      }
    }
    
    return results;
  }

  // Public Job Queue Methods

  async addEmbeddingJob(data: EmbeddingJobData, options?: { delay?: number; priority?: number }): Promise<Job<EmbeddingJobData>> {
    const job = await this.embeddingQueue.add('generate_embedding', data, {
      delay: options?.delay || 0,
      priority: options?.priority || data.priority || 1,
      jobId: `embed_${data.contentId}_${Date.now()}`,
    });

    this.logger.info(`Embedding job queued: ${job.id}`, {
      contentId: data.contentId,
      contentType: data.contentType,
    });

    return job;
  }

  async addCategorizationJob(data: CategorizationJobData, options?: { delay?: number; priority?: number }): Promise<Job<CategorizationJobData>> {
    const job = await this.categorizationQueue.add('categorize_content', data, {
      delay: options?.delay || 0,
      priority: options?.priority || data.priority || 1,
      jobId: `categorize_${data.contentId}_${Date.now()}`,
    });

    this.logger.info(`Categorization job queued: ${job.id}`, {
      contentId: data.contentId,
      contentType: data.contentType,
    });

    return job;
  }

  async addAnalysisJob(data: ContentAnalysisJobData, options?: { delay?: number; priority?: number }): Promise<Job<ContentAnalysisJobData>> {
    const job = await this.analysisQueue.add('analyze_content', data, {
      delay: options?.delay || 0,
      priority: options?.priority || data.priority || 1,
      jobId: `analyze_${data.contentId}_${Date.now()}`,
    });

    this.logger.info(`Analysis job queued: ${job.id}`, {
      contentId: data.contentId,
      contentType: data.contentType,
    });

    return job;
  }

  async addRecommendationJob(data: RecommendationJobData, options?: { delay?: number; priority?: number }): Promise<Job<RecommendationJobData>> {
    const job = await this.recommendationQueue.add('generate_recommendations', data, {
      delay: options?.delay || 0,
      priority: options?.priority || data.priority || 1,
      jobId: `recommend_${data.userId}_${Date.now()}`,
    });

    this.logger.info(`Recommendation job queued: ${job.id}`, {
      userId: data.userId,
    });

    return job;
  }

  async addTrendingJob(data: TrendingTopicsJobData, options?: { delay?: number; priority?: number }): Promise<Job<TrendingTopicsJobData>> {
    const job = await this.trendingQueue.add('detect_trending', data, {
      delay: options?.delay || 0,
      priority: options?.priority || data.priority || 1,
      jobId: `trending_${Date.now()}`,
    });

    this.logger.info(`Trending topics job queued: ${job.id}`);

    return job;
  }

  async addDuplicateDetectionJob(data: DuplicateDetectionJobData, options?: { delay?: number; priority?: number }): Promise<Job<DuplicateDetectionJobData>> {
    const job = await this.duplicateQueue.add('detect_duplicates', data, {
      delay: options?.delay || 0,
      priority: options?.priority || data.priority || 1,
      jobId: `duplicate_${data.contentId}_${Date.now()}`,
    });

    this.logger.info(`Duplicate detection job queued: ${job.id}`, {
      contentId: data.contentId,
      contentType: data.contentType,
    });

    return job;
  }

  async addBatchJob(data: BatchProcessingJobData, options?: { delay?: number; priority?: number }): Promise<Job<BatchProcessingJobData>> {
    const job = await this.batchQueue.add('batch_process', data, {
      delay: options?.delay || 0,
      priority: options?.priority || data.priority || 1,
      jobId: `batch_${data.operation}_${Date.now()}`,
    });

    this.logger.info(`Batch processing job queued: ${job.id}`, {
      operation: data.operation,
      itemCount: data.items.length,
    });

    return job;
  }

  // Batch convenience methods
  async processNewArticleComplete(
    contentId: string,
    contentType: 'article' | 'arxiv_paper',
    title: string,
    content: string,
    priority?: number
  ): Promise<void> {
    const jobPriority = priority || 1;
    
    // Add all AI processing jobs for a new article
    await Promise.all([
      this.addEmbeddingJob({ contentId, contentType, title, content, priority: jobPriority }),
      this.addCategorizationJob({ contentId, contentType, title, content, priority: jobPriority }),
      this.addAnalysisJob({ contentId, contentType, title, content, priority: jobPriority }),
      this.addDuplicateDetectionJob({ contentId, contentType, title, content, priority: jobPriority }),
    ]);
    
    this.logger.info(`Complete AI processing pipeline initiated for ${contentType}: ${contentId}`);
  }

  // Utility and monitoring methods

  private async findExactDuplicates(contentHash: string, contentType: string): Promise<Array<{ id: string }>> {
    const table = contentType === 'article' ? 'articles' : 'arxiv_papers';
    const query = `
      SELECT id FROM ${table}
      WHERE content_hash = $1 AND deleted_at IS NULL
      LIMIT 5
    `;
    
    return await this.databaseService.query(query, [contentHash]);
  }

  private async markAsDuplicate(contentId: string, contentType: string, duplicateOfId: string): Promise<void> {
    const table = contentType === 'article' ? 'articles' : 'arxiv_papers';
    const query = `
      UPDATE ${table}
      SET duplicate_of = $1, updated_at = NOW()
      WHERE id = $2
    `;
    
    await this.databaseService.query(query, [duplicateOfId, contentId]);
  }

  private updateStats(jobType: string, status: 'completed' | 'failed', processingTime: number): void {
    const stats = this.processingStats.get(jobType);
    if (stats) {
      if (status === 'completed') {
        stats.processed++;
        stats.totalTime += processingTime;
      } else {
        stats.failed++;
      }
    }
  }

  async getQueueStats(): Promise<{ [queueName: string]: any }> {
    const queues = [
      { name: 'embeddings', queue: this.embeddingQueue },
      { name: 'categorization', queue: this.categorizationQueue },
      { name: 'analysis', queue: this.analysisQueue },
      { name: 'recommendations', queue: this.recommendationQueue },
      { name: 'trending', queue: this.trendingQueue },
      { name: 'duplicates', queue: this.duplicateQueue },
      { name: 'batch', queue: this.batchQueue },
    ];

    const stats: { [queueName: string]: any } = {};

    for (const { name, queue } of queues) {
      const [waiting, active, completed, failed] = await Promise.all([
        queue.getWaiting(),
        queue.getActive(),
        queue.getCompleted(),
        queue.getFailed(),
      ]);

      const processingStats = this.processingStats.get(name) || { processed: 0, failed: 0, totalTime: 0 };

      stats[name] = {
        waiting: waiting.length,
        active: active.length,
        completed: completed.length,
        failed: failed.length,
        dailyProcessed: processingStats.processed,
        dailyFailed: processingStats.failed,
        avgProcessingTime: processingStats.processed > 0 ? 
          processingStats.totalTime / processingStats.processed : 0,
      };
    }

    return stats;
  }

  private async performHealthCheck(): Promise<void> {
    try {
      const stats = await this.getQueueStats();
      
      // Check for queues with too many failed jobs
      for (const [queueName, queueStats] of Object.entries(stats)) {
        if (queueStats.failed > 100) {
          this.logger.warn(`Queue ${queueName} has high failure rate: ${queueStats.failed} failed jobs`);
        }
        
        if (queueStats.waiting > 1000) {
          this.logger.warn(`Queue ${queueName} has high backlog: ${queueStats.waiting} waiting jobs`);
        }
      }
      
      this.logger.debug('AI job queue health check completed', { stats });
    } catch (error) {
      this.logger.error('Health check failed:', error);
    }
  }

  async close(): Promise<void> {
    try {
      const workers = [
        this.embeddingWorker,
        this.categorizationWorker,
        this.analysisWorker,
        this.recommendationWorker,
        this.trendingWorker,
        this.duplicateWorker,
        this.batchWorker,
      ];

      const queues = [
        this.embeddingQueue,
        this.categorizationQueue,
        this.analysisQueue,
        this.recommendationQueue,
        this.trendingQueue,
        this.duplicateQueue,
        this.batchQueue,
      ];

      // Close all workers and queues
      await Promise.all([
        ...workers.map(worker => worker.close()),
        ...queues.map(queue => queue.close()),
      ]);

      this.isInitialized = false;
      this.logger.info('AI job queue service closed');
    } catch (error) {
      this.logger.error('Error closing AI job queue service:', error);
    }
  }
}