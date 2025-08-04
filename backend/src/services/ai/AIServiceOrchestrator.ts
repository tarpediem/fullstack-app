import { Logger } from 'winston';
import { DatabaseService } from '../database/DatabaseService';
import { EmbeddingService } from './EmbeddingService';
import { SemanticSearchService } from './SemanticSearchService';
import { ContentCategorizationService } from './ContentCategorizationService';
import { ContentAnalysisService } from './ContentAnalysisService';
import { RecommendationEngine } from './RecommendationEngine';
import { TrendingTopicsService } from './TrendingTopicsService';
import { AIJobQueueService } from './AIJobQueueService';
import { aiConfig } from '../../config/ai.config';

/**
 * AIServiceOrchestrator - Coordinates all AI/ML services for the AI-news platform
 * 
 * This service provides high-level methods that combine multiple AI services
 * to deliver comprehensive functionality for content processing, search,
 * recommendations, and analytics.
 */
export class AIServiceOrchestrator {
  private isInitialized: boolean = false;

  constructor(
    private logger: Logger,
    private databaseService: DatabaseService,
    private embeddingService: EmbeddingService,
    private searchService: SemanticSearchService,
    private categorizationService: ContentCategorizationService,
    private analysisService: ContentAnalysisService,
    private recommendationEngine: RecommendationEngine,
    private trendingService: TrendingTopicsService,
    private jobQueue: AIJobQueueService
  ) {}

  async initialize(): Promise<void> {
    try {
      // Initialize all services in parallel where possible
      await Promise.all([
        this.embeddingService.initialize(),
        this.categorizationService.initialize(),
        this.analysisService.initialize(),
        this.trendingService.initialize(),
      ]);

      // Services that depend on others
      await this.searchService.initialize();
      await this.recommendationEngine.initialize();
      await this.jobQueue.initialize();

      this.isInitialized = true;
      this.logger.info('AIServiceOrchestrator initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize AIServiceOrchestrator:', error);
      throw error;
    }
  }

  /**
   * Process a newly scraped article through the complete AI pipeline
   */
  async processNewArticle(article: {
    id: string;
    title: string;
    content: string;
    sourceId: string;
    originalUrl: string;
    publishedAt: Date;
  }): Promise<{
    success: boolean;
    processing: {
      embedding: boolean;
      categorization: boolean;
      analysis: boolean;
      duplicateCheck: boolean;
    };
    estimatedCompletionTime: number;
  }> {
    if (!this.isInitialized) {
      throw new Error('AIServiceOrchestrator not initialized');
    }

    try {
      this.logger.info('Starting complete AI processing for article', {
        articleId: article.id,
        title: article.title.substring(0, 100),
      });

      // Queue all processing jobs with high priority for new content
      const jobs = await Promise.all([
        this.jobQueue.addEmbeddingJob({
          contentId: article.id,
          contentType: 'article',
          title: article.title,
          content: article.content,
          priority: 2, // High priority for new content
        }),
        this.jobQueue.addCategorizationJob({
          contentId: article.id,
          contentType: 'article',
          title: article.title,
          content: article.content,
          priority: 2,
        }),
        this.jobQueue.addAnalysisJob({
          contentId: article.id,
          contentType: 'article',
          title: article.title,
          content: article.content,
          priority: 2,
          options: { analysisDepth: 'standard' },
        }),
        this.jobQueue.addDuplicateDetectionJob({
          contentId: article.id,
          contentType: 'article',
          title: article.title,
          content: article.content,
          priority: 2,
        }),
      ]);

      // Estimate completion time based on queue lengths
      const queueStats = await this.jobQueue.getQueueStats();
      const estimatedCompletionTime = this.estimateProcessingTime(queueStats);

      return {
        success: true,
        processing: {
          embedding: true,
          categorization: true,
          analysis: true,
          duplicateCheck: true,
        },
        estimatedCompletionTime,
      };

    } catch (error) {
      this.logger.error('Failed to process new article:', error);
      return {
        success: false,
        processing: {
          embedding: false,
          categorization: false,
          analysis: false,
          duplicateCheck: false,
        },
        estimatedCompletionTime: 0,
      };
    }
  }

  /**
   * Perform intelligent content search with personalization
   */
  async intelligentSearch(
    query: string,
    options: {
      userId?: string;
      limit?: number;
      filters?: {
        categories?: string[];
        sources?: string[];
        dateRange?: { start: Date; end: Date };
        qualityThreshold?: number;
      };
      searchType?: 'semantic' | 'fulltext' | 'hybrid' | 'auto';
      includeRecommendations?: boolean;
    } = {}
  ) {
    if (!this.isInitialized) {
      throw new Error('AIServiceOrchestrator not initialized');
    }

    try {
      const startTime = Date.now();

      // Get user preferences if userId provided
      let userPreferences: any = null;
      if (options.userId) {
        try {
          const userQuery = `
            SELECT preferred_categories, preferred_tags, preferred_sources
            FROM user_preferences 
            WHERE user_id = $1
          `;
          const userResult = await this.databaseService.query(userQuery, [options.userId]);
          if (userResult.length > 0) {
            userPreferences = userResult[0];
          }
        } catch (error) {
          this.logger.warn('Failed to load user preferences:', error);
        }
      }

      // Enhance filters with user preferences
      const enhancedFilters = {
        ...options.filters,
        categories: options.filters?.categories || userPreferences?.preferred_categories,
        sources: options.filters?.sources || userPreferences?.preferred_sources,
      };

      // Perform the search
      const searchResults = await this.searchService.search({
        text: query,
        filters: enhancedFilters,
        options: {
          limit: options.limit || 20,
          searchType: options.searchType || 'auto',
          includeContent: false,
          sortBy: 'relevance',
        },
      });

      // Get recommendations if requested and user is provided
      let recommendations: any[] = [];
      if (options.includeRecommendations && options.userId) {
        try {
          const recResult = await this.recommendationEngine.generateRecommendations(
            options.userId,
            { limit: 5, excludeRead: true }
          );
          recommendations = recResult.recommendations.slice(0, 5);
        } catch (error) {
          this.logger.warn('Failed to generate recommendations:', error);
        }
      }

      const processingTime = Date.now() - startTime;

      return {
        searchResults,
        recommendations,
        processingTime,
        metadata: {
          userPersonalized: !!options.userId,
          totalResults: searchResults.totalCount,
          searchType: searchResults.query.searchType,
          processingTime,
        },
      };

    } catch (error) {
      this.logger.error('Intelligent search failed:', error);
      throw error;
    }
  }

  /**
   * Generate personalized content feed for a user
   */
  async generatePersonalizedFeed(
    userId: string,
    options: {
      limit?: number;
      includeAnalytics?: boolean;
      refreshCache?: boolean;
      diversityFactor?: number;
    } = {}
  ) {
    if (!this.isInitialized) {
      throw new Error('AIServiceOrchestrator not initialized');
    }

    try {
      const startTime = Date.now();

      // Check cache unless refresh is requested
      const cacheKey = `personalized_feed:${userId}`;
      if (!options.refreshCache) {
        const cached = await this.databaseService.cacheGet(cacheKey);
        if (cached) {
          this.logger.debug('Returning cached personalized feed', { userId });
          return cached;
        }
      }

      // Generate recommendations
      const recommendations = await this.recommendationEngine.generateRecommendations(userId, {
        limit: options.limit || 30,
        diversityFactor: options.diversityFactor || 0.3,
        excludeRead: true,
        maxAge: 7, // days
      });

      // Get trending topics for diversity
      const trending = await this.trendingService.detectTrendingTopics({
        timeWindows: ['short', 'medium'],
        maxTopics: 5,
      });

      // Combine recommendations with some trending content
      const trendingArticles = trending.topics
        .slice(0, 3)
        .flatMap(topic => topic.relatedArticles.slice(0, 2))
        .slice(0, 5);

      const feed = {
        recommendations: recommendations.recommendations,
        trending: trendingArticles,
        metadata: {
          userProfile: recommendations.userProfile,
          algorithms: recommendations.algorithms,
          trendingTopics: trending.topics.length,
          totalCount: recommendations.recommendations.length + trendingArticles.length,
          processingTime: Date.now() - startTime,
          refreshTime: new Date(),
        },
      };

      // Cache for 1 hour
      await this.databaseService.cacheSet(cacheKey, feed, 3600);

      // Include analytics if requested
      if (options.includeAnalytics) {
        const analytics = await this.getUserAnalytics(userId);
        feed.metadata = { ...feed.metadata, ...analytics };
      }

      return feed;

    } catch (error) {
      this.logger.error('Failed to generate personalized feed:', error);
      throw error;
    }
  }

  /**
   * Analyze content and provide comprehensive insights
   */
  async analyzeContentComprehensive(
    contentId: string,
    contentType: 'article' | 'arxiv_paper',
    title: string,
    content: string,
    options: {
      includeSummary?: boolean;
      includeEntities?: boolean;
      includeSimilar?: boolean;
      includeQuality?: boolean;
    } = {}
  ) {
    if (!this.isInitialized) {
      throw new Error('AIServiceOrchestrator not initialized');
    }

    try {
      const startTime = Date.now();

      // Run multiple analyses in parallel
      const [analysis, categorization, similarContent] = await Promise.allSettled([
        // Content analysis
        this.analysisService.analyzeContent(contentId, contentType, title, content, {
          analysisDepth: 'comprehensive',
          includeSentiment: true,
          includeQuality: options.includeQuality !== false,
        }),

        // Categorization
        this.categorizationService.categorizeContent(content, title, undefined, {
          method: 'hybrid',
          includeTags: true,
        }),

        // Similar content (after embeddings are generated)
        options.includeSimilar ? 
          this.findSimilarContentAfterProcessing(contentId, contentType, title, content) :
          Promise.resolve([]),
      ]);

      const result = {
        contentId,
        contentType,
        analysis: analysis.status === 'fulfilled' ? analysis.value : null,
        categorization: categorization.status === 'fulfilled' ? categorization.value : null,
        similarContent: similarContent.status === 'fulfilled' ? similarContent.value : [],
        processingTime: Date.now() - startTime,
        timestamp: new Date(),
      };

      return result;

    } catch (error) {
      this.logger.error('Comprehensive content analysis failed:', error);
      throw error;
    }
  }

  /**
   * Get trending topics with analysis
   */
  async getTrendingTopicsWithAnalysis(options: {
    timeWindows?: ('short' | 'medium' | 'long')[];
    categories?: string[];
    includeEvolution?: boolean;
    maxTopics?: number;
  } = {}) {
    if (!this.isInitialized) {
      throw new Error('AIServiceOrchestrator not initialized');
    }

    try {
      const trending = await this.trendingService.detectTrendingTopics({
        timeWindows: options.timeWindows || ['medium'],
        categories: options.categories,
        maxTopics: options.maxTopics || 10,
      });

      // Add sentiment analysis for each topic
      const enrichedTopics = await Promise.all(
        trending.topics.map(async (topic) => {
          try {
            // Calculate average sentiment from related articles
            const sentiments = topic.relatedArticles.map(article => {
              // This would come from the analysis results
              return { polarity: 0, confidence: 0.5 }; // Placeholder
            });

            const avgSentiment = sentiments.length > 0 ? 
              sentiments.reduce((sum, s) => sum + s.polarity, 0) / sentiments.length : 0;

            return {
              ...topic,
              sentiment: {
                ...topic.sentiment,
                polarity: avgSentiment,
              },
            };
          } catch (error) {
            this.logger.warn('Failed to enrich topic sentiment:', error);
            return topic;
          }
        })
      );

      return {
        ...trending,
        topics: enrichedTopics,
      };

    } catch (error) {
      this.logger.error('Failed to get trending topics with analysis:', error);
      throw error;
    }
  }

  /**
   * Process batch content efficiently
   */
  async processBatchContent(
    contents: Array<{
      id: string;
      title: string;
      content: string;
      contentType: 'article' | 'arxiv_paper';
    }>,
    operations: {
      embeddings?: boolean;
      categorization?: boolean;
      analysis?: boolean;
      duplicateCheck?: boolean;
    } = {},
    options: {
      priority?: number;
      batchSize?: number;
    } = {}
  ) {
    if (!this.isInitialized) {
      throw new Error('AIServiceOrchestrator not initialized');
    }

    try {
      const startTime = Date.now();
      const jobs = [];

      // Queue batch jobs for each requested operation
      if (operations.embeddings !== false) {
        jobs.push(
          this.jobQueue.addBatchJob({
            operation: 'embedding',
            items: contents,
            priority: options.priority || 1,
            batchSize: options.batchSize || aiConfig.processing.batchSize,
          })
        );
      }

      if (operations.categorization !== false) {
        jobs.push(
          this.jobQueue.addBatchJob({
            operation: 'categorization',
            items: contents,
            priority: options.priority || 1,
            batchSize: options.batchSize || aiConfig.processing.batchSize,
          })
        );
      }

      if (operations.analysis !== false) {
        jobs.push(
          this.jobQueue.addBatchJob({
            operation: 'analysis',
            items: contents,
            priority: options.priority || 1,
            batchSize: options.batchSize || aiConfig.processing.batchSize,
          })
        );
      }

      if (operations.duplicateCheck !== false) {
        jobs.push(
          this.jobQueue.addBatchJob({
            operation: 'duplicate_detection',
            items: contents,
            priority: options.priority || 1,
            batchSize: options.batchSize || aiConfig.processing.batchSize,
          })
        );
      }

      const queuedJobs = await Promise.all(jobs);
      const queueStats = await this.jobQueue.getQueueStats();

      return {
        success: true,
        totalItems: contents.length,
        queuedJobs: queuedJobs.length,
        operations,
        estimatedCompletionTime: this.estimateProcessingTime(queueStats),
        processingTime: Date.now() - startTime,
      };

    } catch (error) {
      this.logger.error('Batch content processing failed:', error);
      throw error;
    }
  }

  /**
   * Get comprehensive system metrics
   */
  async getSystemMetrics() {
    if (!this.isInitialized) {
      throw new Error('AIServiceOrchestrator not initialized');
    }

    try {
      const [
        embeddingMetrics,
        searchMetrics,
        categorizationMetrics,
        analysisMetrics,
        recommendationMetrics,
        queueStats,
      ] = await Promise.all([
        this.embeddingService.getEmbeddingMetrics(),
        this.searchService.getSearchMetrics(),
        this.categorizationService.getCategorizationMetrics(),
        this.analysisService.getAnalysisMetrics(),
        this.recommendationEngine.getRecommendationMetrics(),
        this.jobQueue.getQueueStats(),
      ]);

      return {
        services: {
          embedding: embeddingMetrics,
          search: searchMetrics,
          categorization: categorizationMetrics,
          analysis: analysisMetrics,
          recommendations: recommendationMetrics,
        },
        queues: queueStats,
        system: {
          totalDailyRequests: 
            embeddingMetrics.dailyRequests +
            searchMetrics.dailyQueries +
            recommendationMetrics.dailyRequests,
          avgResponseTime: [
            embeddingMetrics.avgProcessingTime,
            searchMetrics.avgSearchTime,
            recommendationMetrics.avgProcessingTime,
          ].reduce((sum, time) => sum + time, 0) / 3,
        },
        timestamp: new Date(),
      };

    } catch (error) {
      this.logger.error('Failed to get system metrics:', error);
      throw error;
    }
  }

  // Private helper methods

  private async findSimilarContentAfterProcessing(
    contentId: string,
    contentType: 'article' | 'arxiv_paper',
    title: string,
    content: string
  ) {
    try {
      // Generate embedding for similarity search
      const embedding = await this.embeddingService.generateEmbedding(`${title}\n\n${content}`);
      
      // Find similar content using the embedding
      return await this.embeddingService.findSimilarContent(contentId, contentType, {
        limit: 5,
        similarityThreshold: 0.75,
      });
    } catch (error) {
      this.logger.warn('Failed to find similar content:', error);
      return [];
    }
  }

  private estimateProcessingTime(queueStats: any): number {
    // Estimate based on queue lengths and average processing times
    const totalWaiting = Object.values(queueStats).reduce(
      (sum: number, stats: any) => sum + stats.waiting,
      0
    );
    
    // Rough estimate: 2 seconds per job on average
    return totalWaiting * 2;
  }

  private async getUserAnalytics(userId: string) {
    try {
      const query = `
        SELECT 
          COUNT(*) as total_reads,
          AVG(rating) as avg_rating,
          COUNT(DISTINCT category) as categories_explored,
          AVG(read_time) as avg_read_time
        FROM user_reading_history urh
        LEFT JOIN articles a ON urh.article_id = a.id
        WHERE urh.user_id = $1 
          AND urh.created_at >= NOW() - INTERVAL '30 days'
      `;
      
      const result = await this.databaseService.query(query, [userId]);
      return result[0] || {};
    } catch (error) {
      this.logger.warn('Failed to get user analytics:', error);
      return {};
    }
  }

  async close(): Promise<void> {
    try {
      await this.jobQueue.close();
      this.isInitialized = false;
      this.logger.info('AIServiceOrchestrator closed successfully');
    } catch (error) {
      this.logger.error('Error closing AIServiceOrchestrator:', error);
    }
  }
}