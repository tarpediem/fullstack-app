import { Logger } from 'winston';
import { DatabaseService } from '../database/DatabaseService';
import { EmbeddingService } from './EmbeddingService';
import { aiConfig, AIConfig } from '../../config/ai.config';
import * as tf from '@tensorflow/tfjs-node';

export interface UserProfile {
  userId: string;
  preferences: {
    categories: string[];
    tags: string[];
    sources: string[];
    authors: string[];
    interests: string[];
  };
  readingHistory: {
    articleId: string;
    rating?: number;
    readTime?: number;
    timestamp: Date;
    category: string;
    tags: string[];
  }[];
  demographics?: {
    location?: string;
    profession?: string;
    experience?: string;
  };
  behaviorMetrics: {
    avgReadTime: number;
    preferredContentLength: 'short' | 'medium' | 'long';
    activeHours: number[];
    deviceType: 'mobile' | 'desktop' | 'tablet';
    engagementScore: number;
  };
}

export interface RecommendationItem {
  id: string;
  title: string;
  description: string;
  url: string;
  imageUrl?: string;
  publishedAt: Date;
  source: {
    id: string;
    name: string;
    url: string;
  };
  author?: string;
  category: string;
  tags: string[];
  contentType: 'article' | 'arxiv_paper';
  scores: {
    relevance: number;
    contentBased: number;
    collaborative: number;
    trending: number;
    recency: number;
    quality: number;
    diversity: number;
    final: number;
  };
  reasoning: string[];
  metadata: {
    wordCount?: number;
    readingTime?: number;
    difficulty?: 'beginner' | 'intermediate' | 'advanced';
    sentiment?: number;
  };
}

export interface RecommendationResult {
  userId: string;
  recommendations: RecommendationItem[];
  totalCount: number;
  algorithms: {
    contentBased: number;
    collaborative: number;
    trending: number;
    diversity: number;
  };
  userProfile: {
    preferenceStrength: number;
    diversityIndex: number;
    noveltySeeker: boolean;
    expertiseLevel: 'beginner' | 'intermediate' | 'advanced';
  };
  processingTime: number;
  refreshTime: Date;
}

export interface CollaborativeFiltering {
  userSimilarities: Map<string, number>;
  itemSimilarities: Map<string, Map<string, number>>;
  predictions: Map<string, number>;
}

export class RecommendationEngine {
  private userProfiles: Map<string, UserProfile> = new Map();
  private itemEmbeddings: Map<string, number[]> = new Map();
  private userSimilarityMatrix: Map<string, Map<string, number>> = new Map();
  private itemSimilarityMatrix: Map<string, Map<string, number>> = new Map();
  private popularityScores: Map<string, number> = new Map();
  private trendingScores: Map<string, number> = new Map();
  private isInitialized: boolean = false;

  constructor(
    private config: AIConfig,
    private logger: Logger,
    private databaseService: DatabaseService,
    private embeddingService: EmbeddingService
  ) {}

  async initialize(): Promise<void> {
    try {
      await this.loadUserProfiles();
      await this.loadItemEmbeddings();
      await this.computeSimilarityMatrices();
      await this.loadPopularityScores();
      this.setupPeriodicUpdates();
      this.isInitialized = true;
      this.logger.info('RecommendationEngine initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize RecommendationEngine:', error);
      throw error;
    }
  }

  private async loadUserProfiles(): Promise<void> {
    try {
      const query = `
        SELECT 
          u.id as user_id,
          up.preferred_categories,
          up.preferred_tags,
          up.preferred_sources,
          up.interests,
          up.preference_embedding,
          u.created_at
        FROM users u
        LEFT JOIN user_preferences up ON u.id = up.user_id
        WHERE u.is_active = true
        LIMIT 10000
      `;

      const users = await this.databaseService.query(query);
      
      for (const user of users) {
        const readingHistory = await this.loadUserReadingHistory(user.user_id);
        const behaviorMetrics = await this.calculateBehaviorMetrics(user.user_id);
        
        const profile: UserProfile = {
          userId: user.user_id,
          preferences: {
            categories: user.preferred_categories || [],
            tags: user.preferred_tags || [],
            sources: user.preferred_sources || [],
            authors: [],
            interests: user.interests || [],
          },
          readingHistory,
          behaviorMetrics,
        };

        this.userProfiles.set(user.user_id, profile);
      }

      this.logger.info(`Loaded ${this.userProfiles.size} user profiles`);
    } catch (error) {
      this.logger.error('Failed to load user profiles:', error);
    }
  }

  private async loadUserReadingHistory(userId: string): Promise<UserProfile['readingHistory']> {
    const query = `
      SELECT 
        urh.article_id,
        urh.arxiv_paper_id,
        urh.rating,
        urh.read_time,
        urh.created_at as timestamp,
        COALESCE(a.category, ap.primary_category) as category,
        COALESCE(a.tags, ap.tags) as tags
      FROM user_reading_history urh
      LEFT JOIN articles a ON urh.article_id = a.id
      LEFT JOIN arxiv_papers ap ON urh.arxiv_paper_id = ap.id
      WHERE urh.user_id = $1
      ORDER BY urh.created_at DESC
      LIMIT 1000
    `;

    const history = await this.databaseService.query(query, [userId]);
    
    return history.map(row => ({
      articleId: row.article_id || row.arxiv_paper_id,
      rating: row.rating,
      readTime: row.read_time,
      timestamp: row.timestamp,
      category: row.category,
      tags: row.tags || [],
    }));
  }

  private async calculateBehaviorMetrics(userId: string): Promise<UserProfile['behaviorMetrics']> {
    const query = `
      SELECT 
        AVG(read_time) as avg_read_time,
        EXTRACT(HOUR FROM created_at) as hour,
        COUNT(*) as count
      FROM user_reading_history
      WHERE user_id = $1 AND read_time IS NOT NULL
      GROUP BY EXTRACT(HOUR FROM created_at)
      ORDER BY count DESC
    `;

    const metrics = await this.databaseService.query(query, [userId]);
    
    const avgReadTime = metrics.length > 0 ? 
      metrics.reduce((sum, m) => sum + parseFloat(m.avg_read_time || '0'), 0) / metrics.length : 0;
    
    const activeHours = metrics.slice(0, 8).map(m => parseInt(m.hour));
    
    return {
      avgReadTime,
      preferredContentLength: avgReadTime < 120 ? 'short' : avgReadTime < 300 ? 'medium' : 'long',
      activeHours,
      deviceType: 'desktop', // Would be determined from user agent analysis
      engagementScore: Math.min(avgReadTime / 180, 1), // Normalized engagement score
    };
  }

  private async loadItemEmbeddings(): Promise<void> {
    try {
      // Load article embeddings
      const articleQuery = `
        SELECT id, content_embedding
        FROM articles
        WHERE content_embedding IS NOT NULL 
          AND deleted_at IS NULL 
          AND status = 'published'
        LIMIT 50000
      `;

      const articles = await this.databaseService.query(articleQuery);
      
      for (const article of articles) {
        if (article.content_embedding) {
          this.itemEmbeddings.set(article.id, JSON.parse(article.content_embedding));
        }
      }

      // Load ArXiv paper embeddings
      const paperQuery = `
        SELECT id, summary_embedding
        FROM arxiv_papers
        WHERE summary_embedding IS NOT NULL
        LIMIT 20000
      `;

      const papers = await this.databaseService.query(paperQuery);
      
      for (const paper of papers) {
        if (paper.summary_embedding) {
          this.itemEmbeddings.set(paper.id, JSON.parse(paper.summary_embedding));
        }
      }

      this.logger.info(`Loaded ${this.itemEmbeddings.size} item embeddings`);
    } catch (error) {
      this.logger.error('Failed to load item embeddings:', error);
    }
  }

  private async computeSimilarityMatrices(): Promise<void> {
    try {
      // Compute user similarity matrix (using collaborative filtering)
      await this.computeUserSimilarities();
      
      // Compute item similarity matrix (using content-based filtering)
      await this.computeItemSimilarities();
      
      this.logger.info('Similarity matrices computed successfully');
    } catch (error) {
      this.logger.error('Failed to compute similarity matrices:', error);
    }
  }

  private async computeUserSimilarities(): Promise<void> {
    const userIds = Array.from(this.userProfiles.keys());
    const batchSize = 100;

    for (let i = 0; i < userIds.length; i += batchSize) {
      const batch = userIds.slice(i, i + batchSize);
      
      for (const userId1 of batch) {
        const similarities = new Map<string, number>();
        
        for (const userId2 of userIds) {
          if (userId1 !== userId2) {
            const similarity = this.calculateUserSimilarity(userId1, userId2);
            if (similarity > 0.1) { // Only store meaningful similarities
              similarities.set(userId2, similarity);
            }
          }
        }
        
        this.userSimilarityMatrix.set(userId1, similarities);
      }

      // Progress logging
      if (i % (batchSize * 10) === 0) {
        this.logger.debug(`User similarity computation progress: ${i}/${userIds.length}`);
      }
    }
  }

  private calculateUserSimilarity(userId1: string, userId2: string): number {
    const profile1 = this.userProfiles.get(userId1);
    const profile2 = this.userProfiles.get(userId2);
    
    if (!profile1 || !profile2) return 0;

    // Calculate similarity based on multiple factors
    const categoryOverlap = this.calculateArrayOverlap(
      profile1.preferences.categories,
      profile2.preferences.categories
    );
    
    const tagOverlap = this.calculateArrayOverlap(
      profile1.preferences.tags,
      profile2.preferences.tags
    );

    const behaviorSimilarity = this.calculateBehaviorSimilarity(
      profile1.behaviorMetrics,
      profile2.behaviorMetrics
    );

    // Weight different factors
    return (categoryOverlap * 0.4 + tagOverlap * 0.3 + behaviorSimilarity * 0.3);
  }

  private calculateArrayOverlap(arr1: string[], arr2: string[]): number {
    if (arr1.length === 0 || arr2.length === 0) return 0;
    
    const set1 = new Set(arr1);
    const set2 = new Set(arr2);
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    
    return intersection.size / union.size; // Jaccard similarity
  }

  private calculateBehaviorSimilarity(behavior1: UserProfile['behaviorMetrics'], behavior2: UserProfile['behaviorMetrics']): number {
    // Reading time similarity
    const readTimeDiff = Math.abs(behavior1.avgReadTime - behavior2.avgReadTime);
    const readTimeSimilarity = Math.exp(-readTimeDiff / 120); // Decay function

    // Content length preference similarity
    const lengthSimilarity = behavior1.preferredContentLength === behavior2.preferredContentLength ? 1 : 0;

    // Active hours overlap
    const hourOverlap = this.calculateArrayOverlap(
      behavior1.activeHours.map(h => h.toString()),
      behavior2.activeHours.map(h => h.toString())
    );

    return (readTimeSimilarity * 0.4 + lengthSimilarity * 0.3 + hourOverlap * 0.3);
  }

  private async computeItemSimilarities(): Promise<void> {
    const itemIds = Array.from(this.itemEmbeddings.keys());
    const batchSize = 50;

    for (let i = 0; i < Math.min(itemIds.length, 1000); i += batchSize) {
      const batch = itemIds.slice(i, i + batchSize);
      
      for (const itemId1 of batch) {
        const similarities = new Map<string, number>();
        const embedding1 = this.itemEmbeddings.get(itemId1);
        
        if (!embedding1) continue;
        
        for (const itemId2 of itemIds.slice(0, 1000)) { // Limit for performance
          if (itemId1 !== itemId2) {
            const embedding2 = this.itemEmbeddings.get(itemId2);
            if (embedding2) {
              const similarity = this.cosineSimilarity(embedding1, embedding2);
              if (similarity > 0.7) { // Only store high similarities
                similarities.set(itemId2, similarity);
              }
            }
          }
        }
        
        this.itemSimilarityMatrix.set(itemId1, similarities);
      }
    }
  }

  private cosineSimilarity(vec1: number[], vec2: number[]): number {
    if (vec1.length !== vec2.length) return 0;
    
    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;
    
    for (let i = 0; i < vec1.length; i++) {
      dotProduct += vec1[i] * vec2[i];
      norm1 += vec1[i] * vec1[i];
      norm2 += vec2[i] * vec2[i];
    }
    
    return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
  }

  private async loadPopularityScores(): Promise<void> {
    try {
      const query = `
        SELECT 
          id,
          view_count,
          share_count,
          comment_count,
          like_count,
          published_at
        FROM articles
        WHERE deleted_at IS NULL AND status = 'published'
        UNION ALL
        SELECT 
          id,
          view_count,
          0 as share_count,
          0 as comment_count,
          bookmark_count as like_count,
          published_at
        FROM arxiv_papers
      `;

      const items = await this.databaseService.query(query);
      
      for (const item of items) {
        const score = this.calculatePopularityScore(item);
        this.popularityScores.set(item.id, score);
      }

      this.logger.info(`Loaded popularity scores for ${this.popularityScores.size} items`);
    } catch (error) {
      this.logger.error('Failed to load popularity scores:', error);
    }
  }

  private calculatePopularityScore(item: any): number {
    const views = item.view_count || 0;
    const shares = item.share_count || 0;
    const comments = item.comment_count || 0;
    const likes = item.like_count || 0;
    
    // Weighted popularity score
    const rawScore = views * 1 + shares * 5 + comments * 3 + likes * 2;
    
    // Time decay factor
    const daysSincePublished = (Date.now() - new Date(item.published_at).getTime()) / (1000 * 60 * 60 * 24);
    const decayFactor = Math.exp(-daysSincePublished / 30); // 30-day half-life
    
    return rawScore * decayFactor;
  }

  private setupPeriodicUpdates(): void {
    // Update user profiles every hour
    setInterval(async () => {
      await this.updateUserProfiles();
    }, 60 * 60 * 1000);

    // Update popularity scores every 15 minutes
    setInterval(async () => {
      await this.loadPopularityScores();
    }, 15 * 60 * 1000);

    // Recompute similarities daily
    setInterval(async () => {
      await this.computeSimilarityMatrices();
    }, 24 * 60 * 60 * 1000);
  }

  private async updateUserProfiles(): Promise<void> {
    try {
      // Update only recently active users
      const recentUsers = await this.databaseService.query(`
        SELECT DISTINCT user_id
        FROM user_reading_history
        WHERE created_at >= NOW() - INTERVAL '24 hours'
      `);

      for (const user of recentUsers) {
        const readingHistory = await this.loadUserReadingHistory(user.user_id);
        const behaviorMetrics = await this.calculateBehaviorMetrics(user.user_id);
        
        const existingProfile = this.userProfiles.get(user.user_id);
        if (existingProfile) {
          existingProfile.readingHistory = readingHistory;
          existingProfile.behaviorMetrics = behaviorMetrics;
        }
      }

      this.logger.debug(`Updated ${recentUsers.length} user profiles`);
    } catch (error) {
      this.logger.error('Failed to update user profiles:', error);
    }
  }

  /**
   * Generate personalized recommendations for a user
   */
  async generateRecommendations(
    userId: string,
    options?: {
      limit?: number;
      excludeRead?: boolean;
      categories?: string[];
      contentTypes?: ('article' | 'arxiv_paper')[];
      minQuality?: number;
      maxAge?: number; // days
      diversityFactor?: number;
    }
  ): Promise<RecommendationResult> {
    if (!this.isInitialized) {
      throw new Error('RecommendationEngine not initialized');
    }

    const startTime = Date.now();
    const limit = options?.limit || this.config.recommendations.maxRecommendations;
    
    this.logger.info('Generating recommendations', { userId, limit });

    try {
      // Get user profile
      let userProfile = this.userProfiles.get(userId);
      if (!userProfile) {
        userProfile = await this.createUserProfile(userId);
      }

      // Generate recommendations using multiple algorithms
      const [contentBasedRecs, collaborativeRecs, trendingRecs] = await Promise.all([
        this.generateContentBasedRecommendations(userId, limit * 2),
        this.generateCollaborativeRecommendations(userId, limit * 2),
        this.generateTrendingRecommendations(userId, limit),
      ]);

      // Combine and rank recommendations
      const combinedRecs = this.combineRecommendations(
        contentBasedRecs,
        collaborativeRecs,
        trendingRecs,
        userProfile
      );

      // Apply filters
      let filteredRecs = this.applyFilters(combinedRecs, options || {});

      // Apply diversity
      filteredRecs = this.applyDiversification(
        filteredRecs,
        options?.diversityFactor || this.config.recommendations.diversityFactor,
        userProfile
      );

      // Final ranking and selection
      const finalRecs = filteredRecs.slice(0, limit);

      // Analyze user profile characteristics
      const userProfileAnalysis = this.analyzeUserProfile(userProfile);
      
      const processingTime = Date.now() - startTime;

      const result: RecommendationResult = {
        userId,
        recommendations: finalRecs,
        totalCount: filteredRecs.length,
        algorithms: this.calculateAlgorithmBreakdown(finalRecs),
        userProfile: userProfileAnalysis,
        processingTime,
        refreshTime: new Date(),
      };

      // Cache recommendations
      await this.cacheRecommendations(userId, result);

      // Track metrics
      await this.trackRecommendationMetrics(result);

      this.logger.info('Recommendations generated successfully', {
        userId,
        count: finalRecs.length,
        processingTime,
      });

      return result;

    } catch (error) {
      this.logger.error('Failed to generate recommendations:', error);
      
      // Return fallback recommendations
      return this.generateFallbackRecommendations(userId, limit);
    }
  }

  private async createUserProfile(userId: string): Promise<UserProfile> {
    // Create a basic profile for new users
    const profile: UserProfile = {
      userId,
      preferences: {
        categories: ['artificial-intelligence', 'machine-learning'],
        tags: [],
        sources: [],
        authors: [],
        interests: [],
      },
      readingHistory: [],
      behaviorMetrics: {
        avgReadTime: 180,
        preferredContentLength: 'medium',
        activeHours: [9, 14, 20],
        deviceType: 'desktop',
        engagementScore: 0.5,
      },
    };

    this.userProfiles.set(userId, profile);
    return profile;
  }

  private async generateContentBasedRecommendations(
    userId: string,
    limit: number
  ): Promise<RecommendationItem[]> {
    const userProfile = this.userProfiles.get(userId);
    if (!userProfile) return [];

    try {
      // Get user preference embedding
      const userEmbedding = await this.getUserPreferenceEmbedding(userId);
      
      if (!userEmbedding) {
        return await this.generateCategoryBasedRecommendations(userId, limit);
      }

      // Find similar content using vector similarity
      const candidateItems = await this.findSimilarContent(userEmbedding, limit * 3);
      
      // Score and rank items
      const recommendations = candidateItems.map(item => {
        const contentScore = this.calculateContentBasedScore(item, userProfile);
        const qualityScore = item.scores.quality || 0.5;
        const recencyScore = this.calculateRecencyScore(item.publishedAt);
        
        return {
          ...item,
          scores: {
            ...item.scores,
            contentBased: contentScore,
            quality: qualityScore,
            recency: recencyScore,
            final: contentScore * 0.6 + qualityScore * 0.3 + recencyScore * 0.1,
          },
          reasoning: [
            `Content similarity: ${(contentScore * 100).toFixed(1)}%`,
            `Matches your interests in ${userProfile.preferences.categories.join(', ')}`,
          ],
        };
      });

      return recommendations.sort((a, b) => b.scores.final - a.scores.final).slice(0, limit);

    } catch (error) {
      this.logger.error('Content-based recommendations failed:', error);
      return [];
    }
  }

  private async getUserPreferenceEmbedding(userId: string): Promise<number[] | null> {
    try {
      const query = `
        SELECT preference_embedding
        FROM user_preferences
        WHERE user_id = $1 AND preference_embedding IS NOT NULL
      `;
      
      const result = await this.databaseService.query(query, [userId]);
      
      if (result.length > 0 && result[0].preference_embedding) {
        return JSON.parse(result[0].preference_embedding);
      }

      return null;
    } catch (error) {
      this.logger.error('Failed to get user preference embedding:', error);
      return null;
    }
  }

  private async findSimilarContent(
    userEmbedding: number[],
    limit: number
  ): Promise<RecommendationItem[]> {
    const query = `
      WITH user_embedding AS (SELECT $1::vector as embedding),
      articles_similarity AS (
        SELECT 
          a.id,
          a.title,
          a.description,
          a.original_url as url,
          a.image_url,
          a.published_at,
          a.author,
          a.category,
          a.tags,
          a.quality_score,
          a.view_count,
          a.word_count,
          a.reading_time,
          a.sentiment_score,
          s.id as source_id,
          s.name as source_name,
          s.url as source_url,
          'article' as content_type,
          1 - (a.content_embedding <=> u.embedding) as similarity
        FROM articles a
        JOIN news_sources s ON a.source_id = s.id
        CROSS JOIN user_embedding u
        WHERE a.deleted_at IS NULL 
          AND a.status = 'published'
          AND a.content_embedding IS NOT NULL
          AND 1 - (a.content_embedding <=> u.embedding) >= 0.5
      ),
      papers_similarity AS (
        SELECT 
          p.id,
          p.title,
          p.summary as description,
          p.abs_url as url,
          NULL as image_url,
          p.published_at,
          array_to_string(p.authors, ', ') as author,
          p.primary_category as category,
          p.tags,
          p.relevance_score as quality_score,
          p.view_count,
          p.word_count,
          NULL as reading_time,
          NULL as sentiment_score,
          NULL as source_id,
          'ArXiv' as source_name,
          'https://arxiv.org' as source_url,
          'arxiv_paper' as content_type,
          1 - (p.summary_embedding <=> u.embedding) as similarity
        FROM arxiv_papers p
        CROSS JOIN user_embedding u
        WHERE p.summary_embedding IS NOT NULL
          AND 1 - (p.summary_embedding <=> u.embedding) >= 0.5
      )
      SELECT * FROM articles_similarity
      UNION ALL
      SELECT * FROM papers_similarity
      ORDER BY similarity DESC
      LIMIT $2
    `;

    const results = await this.databaseService.query(query, [
      JSON.stringify(userEmbedding),
      limit,
    ]);

    return results.map(row => this.transformToRecommendationItem(row));
  }

  private async generateCategoryBasedRecommendations(
    userId: string,
    limit: number
  ): Promise<RecommendationItem[]> {
    const userProfile = this.userProfiles.get(userId);
    if (!userProfile || userProfile.preferences.categories.length === 0) {
      return [];
    }

    const query = `
      WITH articles_candidates AS (
        SELECT 
          a.id,
          a.title,
          a.description,
          a.original_url as url,
          a.image_url,
          a.published_at,
          a.author,
          a.category,
          a.tags,
          a.quality_score,
          a.view_count,
          a.word_count,
          a.reading_time,
          a.sentiment_score,
          s.id as source_id,
          s.name as source_name,
          s.url as source_url,
          'article' as content_type
        FROM articles a
        JOIN news_sources s ON a.source_id = s.id
        WHERE a.deleted_at IS NULL 
          AND a.status = 'published'
          AND a.category = ANY($1)
          AND a.published_at >= NOW() - INTERVAL '7 days'
      ),
      papers_candidates AS (
        SELECT 
          p.id,
          p.title,
          p.summary as description,
          p.abs_url as url,
          NULL as image_url,
          p.published_at,
          array_to_string(p.authors, ', ') as author,
          p.primary_category as category,
          p.tags,
          p.relevance_score as quality_score,
          p.view_count,
          p.word_count,
          NULL as reading_time,
          NULL as sentiment_score,
          NULL as source_id,
          'ArXiv' as source_name,
          'https://arxiv.org' as source_url,
          'arxiv_paper' as content_type
        FROM arxiv_papers p
        WHERE p.primary_category = ANY($1)
          AND p.published_at >= NOW() - INTERVAL '7 days'
      )
      SELECT * FROM articles_candidates
      UNION ALL
      SELECT * FROM papers_candidates
      ORDER BY quality_score DESC, published_at DESC
      LIMIT $2
    `;

    const results = await this.databaseService.query(query, [
      userProfile.preferences.categories,
      limit,
    ]);

    return results.map(row => this.transformToRecommendationItem(row));
  }

  private async generateCollaborativeRecommendations(
    userId: string,
    limit: number
  ): Promise<RecommendationItem[]> {
    try {
      const userSimilarities = this.userSimilarityMatrix.get(userId);
      if (!userSimilarities || userSimilarities.size === 0) {
        return [];
      }

      // Get top similar users
      const similarUsers = Array.from(userSimilarities.entries())
        .sort(([,a], [,b]) => b - a)
        .slice(0, 10)
        .map(([similarUserId, similarity]) => ({ userId: similarUserId, similarity }));

      // Get items liked by similar users
      const candidateItems = new Map<string, { score: number; reasons: string[] }>();

      for (const similarUser of similarUsers) {
        const similarUserProfile = this.userProfiles.get(similarUser.userId);
        if (!similarUserProfile) continue;

        const recentReads = similarUserProfile.readingHistory
          .filter(item => item.rating && item.rating >= 4)
          .slice(0, 20);

        for (const read of recentReads) {
          const score = (read.rating || 3) * similarUser.similarity * 0.1;
          
          if (candidateItems.has(read.articleId)) {
            const existing = candidateItems.get(read.articleId)!;
            existing.score += score;
            existing.reasons.push(`Liked by similar user (${(similarUser.similarity * 100).toFixed(0)}% similarity)`);
          } else {
            candidateItems.set(read.articleId, {
              score,
              reasons: [`Liked by similar user (${(similarUser.similarity * 100).toFixed(0)}% similarity)`],
            });
          }
        }
      }

      // Get item details for top candidates
      const topCandidates = Array.from(candidateItems.entries())
        .sort(([,a], [,b]) => b.score - a.score)
        .slice(0, limit * 2);

      const itemDetails = await this.getItemDetails(topCandidates.map(([id]) => id));
      
      return itemDetails.map(item => ({
        ...item,
        scores: {
          ...item.scores,
          collaborative: candidateItems.get(item.id)?.score || 0,
        },
        reasoning: candidateItems.get(item.id)?.reasons || [],
      }));

    } catch (error) {
      this.logger.error('Collaborative filtering failed:', error);
      return [];
    }
  }

  private async generateTrendingRecommendations(
    userId: string,
    limit: number
  ): Promise<RecommendationItem[]> {
    const query = `
      WITH trending_articles AS (
        SELECT 
          a.id,
          a.title,
          a.description,
          a.original_url as url,
          a.image_url,
          a.published_at,
          a.author,
          a.category,
          a.tags,
          a.quality_score,
          a.view_count,
          a.word_count,
          a.reading_time,
          a.sentiment_score,
          s.id as source_id,
          s.name as source_name,
          s.url as source_url,
          'article' as content_type,
          (a.view_count * 0.6 + a.share_count * 0.3 + a.comment_count * 0.1) * 
          EXP(-EXTRACT(EPOCH FROM (NOW() - a.published_at)) / 86400.0) as trending_score
        FROM articles a
        JOIN news_sources s ON a.source_id = s.id
        WHERE a.deleted_at IS NULL 
          AND a.status = 'published'
          AND a.published_at >= NOW() - INTERVAL '24 hours'
          AND (a.view_count > 100 OR a.share_count > 10)
      )
      SELECT *
      FROM trending_articles
      ORDER BY trending_score DESC
      LIMIT $1
    `;

    const results = await this.databaseService.query(query, [limit]);
    
    return results.map(row => ({
      ...this.transformToRecommendationItem(row),
      scores: {
        ...this.transformToRecommendationItem(row).scores,
        trending: row.trending_score,
      },
      reasoning: ['Currently trending', `${row.view_count} views in the last 24 hours`],
    }));
  }

  private combineRecommendations(
    contentBased: RecommendationItem[],
    collaborative: RecommendationItem[],
    trending: RecommendationItem[],
    userProfile: UserProfile
  ): RecommendationItem[] {
    const itemMap = new Map<string, RecommendationItem>();
    const weights = {
      content: this.config.recommendations.personalityWeight,
      collaborative: 0.3,
      trending: this.config.recommendations.popularityWeight,
    };

    // Add content-based recommendations
    for (const item of contentBased) {
      itemMap.set(item.id, {
        ...item,
        scores: {
          ...item.scores,
          final: item.scores.contentBased * weights.content,
        },
      });
    }

    // Add collaborative recommendations
    for (const item of collaborative) {
      if (itemMap.has(item.id)) {
        const existing = itemMap.get(item.id)!;
        existing.scores.collaborative = item.scores.collaborative;
        existing.scores.final += item.scores.collaborative * weights.collaborative;
        existing.reasoning.push(...item.reasoning);
      } else {
        itemMap.set(item.id, {
          ...item,
          scores: {
            ...item.scores,
            final: item.scores.collaborative * weights.collaborative,
          },
        });
      }
    }

    // Add trending recommendations
    for (const item of trending) {
      if (itemMap.has(item.id)) {
        const existing = itemMap.get(item.id)!;
        existing.scores.trending = item.scores.trending;
        existing.scores.final += item.scores.trending * weights.trending;
        existing.reasoning.push(...item.reasoning);
      } else {
        itemMap.set(item.id, {
          ...item,
          scores: {
            ...item.scores,
            final: item.scores.trending * weights.trending,
          },
        });
      }
    }

    return Array.from(itemMap.values()).sort((a, b) => b.scores.final - a.scores.final);
  }

  private applyFilters(
    recommendations: RecommendationItem[],
    options: {
      excludeRead?: boolean;
      categories?: string[];
      contentTypes?: ('article' | 'arxiv_paper')[];
      minQuality?: number;
      maxAge?: number;
    }
  ): RecommendationItem[] {
    return recommendations.filter(item => {
      // Category filter
      if (options.categories && !options.categories.includes(item.category)) {
        return false;
      }

      // Content type filter
      if (options.contentTypes && !options.contentTypes.includes(item.contentType)) {
        return false;
      }

      // Quality filter
      if (options.minQuality && item.scores.quality < options.minQuality) {
        return false;
      }

      // Age filter
      if (options.maxAge) {
        const daysSincePublished = (Date.now() - item.publishedAt.getTime()) / (1000 * 60 * 60 * 24);
        if (daysSincePublished > options.maxAge) {
          return false;
        }
      }

      return true;
    });
  }

  private applyDiversification(
    recommendations: RecommendationItem[],
    diversityFactor: number,
    userProfile: UserProfile
  ): RecommendationItem[] {
    if (diversityFactor <= 0) return recommendations;

    const diversified: RecommendationItem[] = [];
    const seenCategories = new Set<string>();
    const seenSources = new Set<string>();

    for (const item of recommendations) {
      let diversityScore = 1.0;

      // Category diversity
      if (seenCategories.has(item.category)) {
        diversityScore *= (1 - diversityFactor * 0.3);
      } else {
        seenCategories.add(item.category);
      }

      // Source diversity
      if (seenSources.has(item.source.name)) {
        diversityScore *= (1 - diversityFactor * 0.2);
      } else {
        seenSources.add(item.source.name);
      }

      // Apply diversity score
      item.scores.diversity = diversityScore;
      item.scores.final *= diversityScore;

      diversified.push(item);
    }

    return diversified.sort((a, b) => b.scores.final - a.scores.final);
  }

  private calculateContentBasedScore(item: RecommendationItem, userProfile: UserProfile): number {
    let score = 0;

    // Category preference
    if (userProfile.preferences.categories.includes(item.category)) {
      score += 0.4;
    }

    // Tag overlap
    const tagOverlap = this.calculateArrayOverlap(userProfile.preferences.tags, item.tags);
    score += tagOverlap * 0.3;

    // Source preference
    if (userProfile.preferences.sources.includes(item.source.id)) {
      score += 0.2;
    }

    // Reading time preference
    const readingTimeMatch = this.calculateReadingTimeMatch(
      item.metadata.readingTime || 3,
      userProfile.behaviorMetrics.preferredContentLength
    );
    score += readingTimeMatch * 0.1;

    return Math.min(score, 1);
  }

  private calculateReadingTimeMatch(itemReadingTime: number, preferredLength: string): number {
    const ranges = {
      short: [0, 3],
      medium: [3, 8],
      long: [8, Infinity],
    };

    const [min, max] = ranges[preferredLength] || ranges.medium;
    return itemReadingTime >= min && itemReadingTime <= max ? 1 : 0.5;
  }

  private calculateRecencyScore(publishedAt: Date): number {
    const daysSincePublished = (Date.now() - publishedAt.getTime()) / (1000 * 60 * 60 * 24);
    return Math.exp(-daysSincePublished / 7); // 7-day half-life
  }

  private analyzeUserProfile(userProfile: UserProfile): RecommendationResult['userProfile'] {
    const historyLength = userProfile.readingHistory.length;
    const categoryDiversity = new Set(userProfile.readingHistory.map(h => h.category)).size;
    
    const preferenceStrength = Math.min(historyLength / 100, 1);
    const diversityIndex = historyLength > 0 ? categoryDiversity / Math.min(historyLength, 10) : 0;
    const noveltySeeker = diversityIndex > 0.6;
    
    let expertiseLevel: 'beginner' | 'intermediate' | 'advanced' = 'beginner';
    if (userProfile.behaviorMetrics.avgReadTime > 300) {
      expertiseLevel = 'advanced';
    } else if (userProfile.behaviorMetrics.avgReadTime > 180) {
      expertiseLevel = 'intermediate';
    }

    return {
      preferenceStrength,
      diversityIndex,
      noveltySeeker,
      expertiseLevel,
    };
  }

  private calculateAlgorithmBreakdown(recommendations: RecommendationItem[]): RecommendationResult['algorithms'] {
    const breakdown = {
      contentBased: 0,
      collaborative: 0,
      trending: 0,
      diversity: 0,
    };

    for (const rec of recommendations) {
      breakdown.contentBased += rec.scores.contentBased || 0;
      breakdown.collaborative += rec.scores.collaborative || 0;
      breakdown.trending += rec.scores.trending || 0;
      breakdown.diversity += rec.scores.diversity || 0;
    }

    const total = Object.values(breakdown).reduce((sum, val) => sum + val, 0);
    
    if (total > 0) {
      for (const key in breakdown) {
        breakdown[key as keyof typeof breakdown] = breakdown[key as keyof typeof breakdown] / total;
      }
    }

    return breakdown;
  }

  private async getItemDetails(itemIds: string[]): Promise<RecommendationItem[]> {
    if (itemIds.length === 0) return [];

    const query = `
      WITH articles_details AS (
        SELECT 
          a.id,
          a.title,
          a.description,
          a.original_url as url,
          a.image_url,
          a.published_at,
          a.author,
          a.category,
          a.tags,
          a.quality_score,
          a.view_count,
          a.word_count,
          a.reading_time,
          a.sentiment_score,
          s.id as source_id,
          s.name as source_name,
          s.url as source_url,
          'article' as content_type
        FROM articles a
        JOIN news_sources s ON a.source_id = s.id
        WHERE a.id = ANY($1) AND a.deleted_at IS NULL
      ),
      papers_details AS (
        SELECT 
          p.id,
          p.title,
          p.summary as description,
          p.abs_url as url,
          NULL as image_url,
          p.published_at,
          array_to_string(p.authors, ', ') as author,
          p.primary_category as category,
          p.tags,
          p.relevance_score as quality_score,
          p.view_count,
          p.word_count,
          NULL as reading_time,
          NULL as sentiment_score,
          NULL as source_id,
          'ArXiv' as source_name,
          'https://arxiv.org' as source_url,
          'arxiv_paper' as content_type
        FROM arxiv_papers p
        WHERE p.id = ANY($1)
      )
      SELECT * FROM articles_details
      UNION ALL
      SELECT * FROM papers_details
    `;

    const results = await this.databaseService.query(query, [itemIds]);
    return results.map(row => this.transformToRecommendationItem(row));
  }

  private transformToRecommendationItem(row: any): RecommendationItem {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      url: row.url,
      imageUrl: row.image_url,
      publishedAt: row.published_at,
      source: {
        id: row.source_id || 'arxiv',
        name: row.source_name,
        url: row.source_url,
      },
      author: row.author,
      category: row.category,
      tags: row.tags || [],
      contentType: row.content_type,
      scores: {
        relevance: 0,
        contentBased: 0,
        collaborative: 0,
        trending: 0,
        recency: this.calculateRecencyScore(row.published_at),
        quality: (row.quality_score || 50) / 100,
        diversity: 1,
        final: 0,
      },
      reasoning: [],
      metadata: {
        wordCount: row.word_count,
        readingTime: row.reading_time,
        sentiment: row.sentiment_score,
      },
    };
  }

  private async generateFallbackRecommendations(userId: string, limit: number): Promise<RecommendationResult> {
    // Return popular recent articles as fallback
    const query = `
      SELECT 
        a.id,
        a.title,
        a.description,
        a.original_url as url,
        a.image_url,
        a.published_at,
        a.author,
        a.category,
        a.tags,
        a.quality_score,
        a.view_count,
        s.id as source_id,
        s.name as source_name,
        s.url as source_url,
        'article' as content_type
      FROM articles a
      JOIN news_sources s ON a.source_id = s.id
      WHERE a.deleted_at IS NULL 
        AND a.status = 'published'
        AND a.published_at >= NOW() - INTERVAL '24 hours'
      ORDER BY a.view_count DESC, a.quality_score DESC
      LIMIT $1
    `;

    const results = await this.databaseService.query(query, [limit]);
    
    const recommendations = results.map(row => ({
      ...this.transformToRecommendationItem(row),
      reasoning: ['Popular recent article'],
    }));

    return {
      userId,
      recommendations,
      totalCount: recommendations.length,
      algorithms: { contentBased: 0, collaborative: 0, trending: 1, diversity: 0 },
      userProfile: {
        preferenceStrength: 0,
        diversityIndex: 0,
        noveltySeeker: false,
        expertiseLevel: 'beginner' as const,
      },
      processingTime: 0,
      refreshTime: new Date(),
    };
  }

  private async cacheRecommendations(userId: string, result: RecommendationResult): Promise<void> {
    try {
      const cacheKey = `recommendations:${userId}`;
      await this.databaseService.cacheSet(cacheKey, result, 3600); // 1 hour cache
    } catch (error) {
      this.logger.error('Failed to cache recommendations:', error);
    }
  }

  private async trackRecommendationMetrics(result: RecommendationResult): Promise<void> {
    try {
      const today = new Date().toISOString().split('T')[0];
      
      await Promise.all([
        this.databaseService.incrementCounter(`recommendation_metrics:${today}:requests`, 1, 86400),
        this.databaseService.incrementCounter(`recommendation_metrics:${today}:processing_time`, result.processingTime, 86400),
        this.databaseService.incrementCounter(`recommendation_metrics:${today}:total_recommendations`, result.recommendations.length, 86400),
      ]);
    } catch (error) {
      this.logger.error('Failed to track recommendation metrics:', error);
    }
  }

  /**
   * Get recommendation metrics and performance stats
   */
  async getRecommendationMetrics(): Promise<{
    dailyRequests: number;
    avgProcessingTime: number;
    avgRecommendationsPerUser: number;
    algorithmBreakdown: { [algorithm: string]: number };
    userEngagement: {
      clickThroughRate: number;
      avgTimeSpent: number;
    };
  }> {
    try {
      const today = new Date().toISOString().split('T')[0];
      
      const [
        dailyRequests,
        totalProcessingTime,
        totalRecommendations,
      ] = await Promise.all([
        this.databaseService.cacheGet(`recommendation_metrics:${today}:requests`) || 0,
        this.databaseService.cacheGet(`recommendation_metrics:${today}:processing_time`) || 0,
        this.databaseService.cacheGet(`recommendation_metrics:${today}:total_recommendations`) || 0,
      ]);

      const requests = Number(dailyRequests);

      return {
        dailyRequests: requests,
        avgProcessingTime: requests > 0 ? Number(totalProcessingTime) / requests : 0,
        avgRecommendationsPerUser: requests > 0 ? Number(totalRecommendations) / requests : 0,
        algorithmBreakdown: {
          contentBased: 0.4, // Would calculate from actual data
          collaborative: 0.3,
          trending: 0.2,
          diversity: 0.1,
        },
        userEngagement: {
          clickThroughRate: 0.15, // Would calculate from click tracking
          avgTimeSpent: 180, // Would calculate from user analytics
        },
      };
    } catch (error) {
      this.logger.error('Failed to get recommendation metrics:', error);
      return {
        dailyRequests: 0,
        avgProcessingTime: 0,
        avgRecommendationsPerUser: 0,
        algorithmBreakdown: {},
        userEngagement: { clickThroughRate: 0, avgTimeSpent: 0 },
      };
    }
  }
}