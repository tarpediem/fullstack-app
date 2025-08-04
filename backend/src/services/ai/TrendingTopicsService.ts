import { Logger } from 'winston';
import { DatabaseService } from '../database/DatabaseService';
import { EmbeddingService } from './EmbeddingService';
import { aiConfig, AIConfig } from '../../config/ai.config';
import * as natural from 'natural';
import { extract as extractKeywords } from 'keyword-extractor';

export interface TrendingTopic {
  topic: string;
  keywords: string[];
  mentions: number;
  score: number;
  trend: 'rising' | 'stable' | 'declining';
  timeWindow: 'short' | 'medium' | 'long';
  relatedArticles: Array<{
    id: string;
    title: string;
    publishedAt: Date;
    source: string;
    relevanceScore: number;
  }>;
  categories: string[];
  sentiment: {
    polarity: number;
    subjectivity: number;
  };
  demographics?: {
    regions: string[];
    ageGroups: string[];
  };
}

export interface TrendingTopicsResult {
  topics: TrendingTopic[];
  timeWindows: {
    short: { start: Date; end: Date };
    medium: { start: Date; end: Date };
    long: { start: Date; end: Date };
  };
  metadata: {
    totalArticlesAnalyzed: number;
    uniqueTopicsDetected: number;
    avgTrendScore: number;
    processingTime: number;
    lastUpdated: Date;
  };
}

export interface TopicEvolution {
  topic: string;
  timeline: Array<{
    timestamp: Date;
    mentions: number;
    score: number;
    sentiment: number;
  }>;
  peakMoments: Array<{
    timestamp: Date;
    trigger: string;
    impact: number;
  }>;
  forecast: {
    nextHour: number;
    nextDay: number;
    nextWeek: number;
    confidence: number;
  };
}

export class TrendingTopicsService {
  private topicCache: Map<string, TrendingTopic[]> = new Map();
  private topicHistory: Map<string, Array<{ timestamp: Date; mentions: number; score: number }>> = new Map();
  private keywordExtractor: any;
  private isInitialized: boolean = false;

  constructor(
    private config: AIConfig,
    private logger: Logger,
    private databaseService: DatabaseService,
    private embeddingService: EmbeddingService
  ) {}

  async initialize(): Promise<void> {
    try {
      this.setupCache();
      this.setupPeriodicUpdates();
      await this.loadHistoricalData();
      this.isInitialized = true;
      this.logger.info('TrendingTopicsService initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize TrendingTopicsService:', error);
      throw error;
    }
  }

  private setupCache(): void {
    // Clean cache every hour
    setInterval(() => {
      const now = Date.now();
      const maxAge = 60 * 60 * 1000; // 1 hour
      
      for (const [key, topics] of this.topicCache.entries()) {
        // Check if cache entry is old (this is simplified - would need proper timestamp tracking)
        if (Math.random() < 0.1) { // Randomly clean 10% of entries each time
          this.topicCache.delete(key);
        }
      }
    }, 60 * 60 * 1000);
  }

  private setupPeriodicUpdates(): void {
    // Update trending topics every 15 minutes
    setInterval(async () => {
      await this.updateTrendingTopics();
    }, 15 * 60 * 1000);

    // Clean old history data daily
    setInterval(async () => {
      await this.cleanOldHistoryData();
    }, 24 * 60 * 60 * 1000);
  }

  private async loadHistoricalData(): Promise<void> {
    try {
      // Load the last 7 days of trending data for context
      const query = `
        SELECT topic, timestamp, mentions, score
        FROM trending_topics_history
        WHERE timestamp >= NOW() - INTERVAL '7 days'
        ORDER BY timestamp DESC
        LIMIT 10000
      `;

      const history = await this.databaseService.query(query);
      
      for (const record of history) {
        const topic = record.topic;
        if (!this.topicHistory.has(topic)) {
          this.topicHistory.set(topic, []);
        }
        this.topicHistory.get(topic)!.push({
          timestamp: record.timestamp,
          mentions: record.mentions,
          score: record.score,
        });
      }

      this.logger.info(`Loaded historical data for ${this.topicHistory.size} topics`);
    } catch (error) {
      this.logger.error('Failed to load historical trending data:', error);
    }
  }

  /**
   * Detect trending topics across different time windows
   */
  async detectTrendingTopics(
    options?: {
      timeWindows?: ('short' | 'medium' | 'long')[];
      minMentions?: number;
      maxTopics?: number;
      categories?: string[];
      useCache?: boolean;
    }
  ): Promise<TrendingTopicsResult> {
    if (!this.isInitialized) {
      throw new Error('TrendingTopicsService not initialized');
    }

    const startTime = Date.now();
    const timeWindows = options?.timeWindows || ['short', 'medium', 'long'];
    const cacheKey = this.generateCacheKey(options || {});

    // Check cache
    if (options?.useCache !== false && this.topicCache.has(cacheKey)) {
      const cached = this.topicCache.get(cacheKey)!;
      this.logger.debug('Returning cached trending topics');
      return this.buildTrendingTopicsResult(cached, Date.now() - startTime);
    }

    try {
      this.logger.info('Detecting trending topics', {
        timeWindows,
        minMentions: options?.minMentions || this.config.trending.minMentions,
      });

      const allTopics = new Map<string, TrendingTopic>();

      // Process each time window
      for (const window of timeWindows) {
        const windowTopics = await this.detectTopicsInTimeWindow(window, options);
        
        for (const topic of windowTopics) {
          const key = topic.topic.toLowerCase();
          if (allTopics.has(key)) {
            // Merge topics from different windows
            const existing = allTopics.get(key)!;
            existing.mentions += topic.mentions;
            existing.score = Math.max(existing.score, topic.score);
            existing.relatedArticles.push(...topic.relatedArticles);
            
            // Update time window to the most significant one
            if (topic.score > existing.score) {
              existing.timeWindow = topic.timeWindow;
            }
          } else {
            allTopics.set(key, topic);
          }
        }
      }

      // Sort and limit results
      const sortedTopics = Array.from(allTopics.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, options?.maxTopics || 20);

      // Cache results
      if (options?.useCache !== false) {
        this.topicCache.set(cacheKey, sortedTopics);
      }

      // Save to database
      await this.saveTrendingTopics(sortedTopics);

      const result = this.buildTrendingTopicsResult(sortedTopics, Date.now() - startTime);

      this.logger.info('Trending topics detection completed', {
        topicsFound: sortedTopics.length,
        processingTime: result.metadata.processingTime,
      });

      return result;

    } catch (error) {
      this.logger.error('Trending topics detection failed:', error);
      throw error;
    }
  }

  private async detectTopicsInTimeWindow(
    window: 'short' | 'medium' | 'long',
    options?: {
      minMentions?: number;
      categories?: string[];
    }
  ): Promise<TrendingTopic[]> {
    const timeConfig = this.config.trending.timeWindows;
    const windowMinutes = window === 'short' ? timeConfig.shortTerm : 
                         window === 'medium' ? timeConfig.mediumTerm * 60 :
                         timeConfig.longTerm * 24 * 60;

    // Get articles from the time window
    const articles = await this.getArticlesInTimeWindow(windowMinutes, options?.categories);
    
    if (articles.length === 0) {
      return [];
    }

    // Extract topics from articles
    const topicData = await this.extractTopicsFromArticles(articles);
    
    // Calculate trending scores
    const trends = await this.calculateTrendingScores(topicData, window);
    
    // Filter by minimum mentions
    const minMentions = options?.minMentions || this.config.trending.minMentions;
    const validTrends = trends.filter(trend => trend.mentions >= minMentions);

    // Convert to TrendingTopic format
    const trendingTopics = await Promise.all(
      validTrends.map(trend => this.buildTrendingTopic(trend, window, articles))
    );

    return trendingTopics;
  }

  private async getArticlesInTimeWindow(
    windowMinutes: number,
    categories?: string[]
  ): Promise<Array<{
    id: string;
    title: string;
    content: string;
    publishedAt: Date;
    category: string;
    source: string;
    viewCount: number;
    shareCount: number;
  }>> {
    let query = `
      SELECT 
        a.id,
        a.title,
        COALESCE(a.content, a.description) as content,
        a.published_at,
        a.category,
        s.name as source,
        a.view_count,
        a.share_count
      FROM articles a
      JOIN news_sources s ON a.source_id = s.id
      WHERE a.deleted_at IS NULL 
        AND a.status = 'published'
        AND a.published_at >= NOW() - INTERVAL '${windowMinutes} minutes'
    `;

    const params: any[] = [];
    let paramIndex = 1;

    if (categories && categories.length > 0) {
      query += ` AND a.category = ANY($${paramIndex})`;
      params.push(categories);
      paramIndex++;
    }

    query += ` ORDER BY a.published_at DESC LIMIT 1000`;

    const results = await this.databaseService.query(query, params);
    
    return results.map(row => ({
      id: row.id,
      title: row.title,
      content: row.content || '',
      publishedAt: row.published_at,
      category: row.category,
      source: row.source,
      viewCount: row.view_count || 0,
      shareCount: row.share_count || 0,
    }));
  }

  private async extractTopicsFromArticles(
    articles: Array<{
      id: string;
      title: string;
      content: string;
      publishedAt: Date;
      category: string;
      source: string;
      viewCount: number;
      shareCount: number;
    }>
  ): Promise<Map<string, {
    topic: string;
    keywords: string[];
    articles: typeof articles;
    totalEngagement: number;
  }>> {
    const topicMap = new Map<string, {
      topic: string;
      keywords: string[];
      articles: typeof articles;
      totalEngagement: number;
    }>();

    for (const article of articles) {
      const fullText = `${article.title} ${article.content}`;
      
      // Extract keywords and potential topics
      const keywords = this.extractRelevantKeywords(fullText);
      const topics = this.identifyTopics(keywords, fullText);
      const engagement = article.viewCount + (article.shareCount * 5);

      for (const topic of topics) {
        const normalizedTopic = this.normalizeTopicName(topic);
        
        if (topicMap.has(normalizedTopic)) {
          const existing = topicMap.get(normalizedTopic)!;
          existing.articles.push(article);
          existing.totalEngagement += engagement;
          
          // Merge keywords
          const combinedKeywords = [...new Set([...existing.keywords, ...keywords])];
          existing.keywords = combinedKeywords.slice(0, 10); // Limit keywords
        } else {
          topicMap.set(normalizedTopic, {
            topic: normalizedTopic,
            keywords: keywords.slice(0, 5),
            articles: [article],
            totalEngagement: engagement,
          });
        }
      }
    }

    return topicMap;
  }

  private extractRelevantKeywords(text: string): string[] {
    try {
      const keywords = extractKeywords(text, {
        language: 'english',
        remove_digits: false,
        return_changed_case: true,
        remove_duplicates: true,
      });

      // Filter for AI/tech relevant keywords
      const relevantKeywords = keywords.filter(keyword => 
        keyword.length >= 3 && 
        !this.isCommonWord(keyword) &&
        this.isRelevantToAI(keyword)
      );

      return relevantKeywords.slice(0, 15);
    } catch (error) {
      this.logger.error('Keyword extraction failed:', error);
      return [];
    }
  }

  private isCommonWord(word: string): boolean {
    const commonWords = new Set([
      'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
      'will', 'said', 'use', 'each', 'which', 'their', 'time', 'work', 'new',
      'way', 'may', 'say', 'come', 'its', 'only', 'think', 'know', 'take',
      'year', 'your', 'good', 'some', 'could', 'them', 'see', 'other', 'than',
      'then', 'now', 'look', 'only', 'come', 'over', 'also', 'back', 'after',
      'use', 'two', 'how', 'our', 'work', 'first', 'well', 'way', 'even',
      'want', 'because', 'any', 'these', 'give', 'day', 'most', 'us'
    ]);
    
    return commonWords.has(word.toLowerCase());
  }

  private isRelevantToAI(word: string): boolean {
    const aiRelevantTerms = [
      'ai', 'artificial', 'intelligence', 'machine', 'learning', 'deep', 'neural',
      'network', 'algorithm', 'data', 'model', 'training', 'technology', 'tech',
      'software', 'hardware', 'computing', 'computer', 'digital', 'innovation',
      'research', 'development', 'breakthrough', 'discovery', 'science', 'startup',
      'company', 'platform', 'system', 'analysis', 'automation', 'robotics',
      'nlp', 'vision', 'processing', 'cloud', 'quantum', 'blockchain', 'cyber',
      'security', 'privacy', 'ethics', 'governance', 'regulation', 'policy'
    ];

    const lowerWord = word.toLowerCase();
    return aiRelevantTerms.some(term => 
      lowerWord.includes(term) || term.includes(lowerWord)
    ) || word.length >= 8; // Include longer technical terms
  }

  private identifyTopics(keywords: string[], fullText: string): string[] {
    const topics: string[] = [];
    
    // Predefined topic patterns
    const topicPatterns = {
      'Artificial Intelligence': ['artificial intelligence', 'ai development', 'ai research', 'ai breakthrough'],
      'Machine Learning': ['machine learning', 'ml model', 'supervised learning', 'unsupervised learning'],
      'Deep Learning': ['deep learning', 'neural network', 'deep neural', 'convolutional', 'transformer'],
      'Natural Language Processing': ['nlp', 'natural language', 'text processing', 'language model'],
      'Computer Vision': ['computer vision', 'image recognition', 'object detection', 'visual ai'],
      'Robotics': ['robotics', 'robot', 'automation', 'autonomous system'],
      'AI Ethics': ['ai ethics', 'ai bias', 'ai fairness', 'responsible ai', 'ai governance'],
      'AI Startups': ['ai startup', 'ai company', 'funding', 'investment', 'venture capital'],
      'AI Research': ['research', 'study', 'paper', 'findings', 'discovery', 'breakthrough'],
      'AI Industry': ['industry', 'business', 'enterprise', 'commercial', 'market'],
      'Cybersecurity AI': ['cybersecurity', 'security ai', 'threat detection', 'fraud detection'],
      'Healthcare AI': ['healthcare ai', 'medical ai', 'diagnostic ai', 'drug discovery'],
      'Autonomous Vehicles': ['autonomous vehicle', 'self-driving', 'auto pilot', 'vehicle ai'],
      'AI Regulation': ['ai regulation', 'ai policy', 'ai law', 'ai compliance', 'ai governance'],
      'Quantum Computing': ['quantum computing', 'quantum ai', 'quantum algorithm', 'quantum machine'],
    };

    const lowerText = fullText.toLowerCase();
    
    for (const [topic, patterns] of Object.entries(topicPatterns)) {
      for (const pattern of patterns) {
        if (lowerText.includes(pattern)) {
          topics.push(topic);
          break; // Only add once per topic
        }
      }
    }

    // If no predefined topics found, create topics from significant keywords
    if (topics.length === 0) {
      const significantKeywords = keywords.filter(keyword => keyword.length >= 6);
      for (const keyword of significantKeywords.slice(0, 3)) {
        topics.push(this.capitalizeWords(keyword));
      }
    }

    return topics;
  }

  private normalizeTopicName(topic: string): string {
    return topic
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private capitalizeWords(text: string): string {
    return text.replace(/\b\w/g, char => char.toUpperCase());
  }

  private async calculateTrendingScores(
    topicData: Map<string, {
      topic: string;
      keywords: string[];
      articles: any[];
      totalEngagement: number;
    }>,
    timeWindow: 'short' | 'medium' | 'long'
  ): Promise<Array<{
    topic: string;
    keywords: string[];
    mentions: number;
    score: number;
    articles: any[];
    trend: 'rising' | 'stable' | 'declining';
  }>> {
    const trends: Array<{
      topic: string;
      keywords: string[];
      mentions: number;
      score: number;
      articles: any[];
      trend: 'rising' | 'stable' | 'declining';
    }> = [];

    for (const [topicKey, data] of topicData.entries()) {
      const mentions = data.articles.length;
      const engagement = data.totalEngagement;
      
      // Calculate base score
      let score = mentions * 10 + engagement * 0.1;
      
      // Apply time-based multipliers
      const timeMultiplier = timeWindow === 'short' ? 2.0 : 
                           timeWindow === 'medium' ? 1.5 : 1.0;
      score *= timeMultiplier;
      
      // Calculate trend direction
      const trend = await this.calculateTrendDirection(topicKey, mentions, timeWindow);
      
      // Apply trend multiplier
      const trendMultiplier = trend === 'rising' ? 1.5 : 
                             trend === 'declining' ? 0.7 : 1.0;
      score *= trendMultiplier;
      
      // Apply recency boost
      const recentArticles = data.articles.filter(article => {
        const hoursSincePublished = (Date.now() - article.publishedAt.getTime()) / (1000 * 60 * 60);
        return hoursSincePublished <= 2; // Last 2 hours
      });
      
      if (recentArticles.length > 0) {
        score *= (1 + recentArticles.length * 0.1);
      }

      trends.push({
        topic: data.topic,
        keywords: data.keywords,
        mentions,
        score,
        articles: data.articles,
        trend,
      });
    }

    return trends.sort((a, b) => b.score - a.score);
  }

  private async calculateTrendDirection(
    topic: string,
    currentMentions: number,
    timeWindow: 'short' | 'medium' | 'long'
  ): Promise<'rising' | 'stable' | 'declining'> {
    try {
      const history = this.topicHistory.get(topic);
      if (!history || history.length < 2) {
        return 'stable'; // Not enough data
      }

      // Get comparison period based on time window
      const hoursBack = timeWindow === 'short' ? 1 : 
                       timeWindow === 'medium' ? 6 : 24;
      
      const cutoffTime = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
      const recentHistory = history.filter(h => h.timestamp >= cutoffTime);
      
      if (recentHistory.length < 2) {
        return 'stable';
      }

      // Calculate average mentions in previous period
      const previousPeriodHistory = history.filter(h => 
        h.timestamp < cutoffTime && 
        h.timestamp >= new Date(cutoffTime.getTime() - hoursBack * 60 * 60 * 1000)
      );
      
      if (previousPeriodHistory.length === 0) {
        return 'rising'; // New topic
      }

      const avgPreviousMentions = previousPeriodHistory.reduce((sum, h) => sum + h.mentions, 0) / previousPeriodHistory.length;
      const avgCurrentMentions = recentHistory.reduce((sum, h) => sum + h.mentions, 0) / recentHistory.length;
      
      const changeRatio = avgCurrentMentions / Math.max(avgPreviousMentions, 1);
      
      if (changeRatio > this.config.trending.trendingThreshold) {
        return 'rising';
      } else if (changeRatio < (1 / this.config.trending.trendingThreshold)) {
        return 'declining';
      } else {
        return 'stable';
      }

    } catch (error) {
      this.logger.error('Trend direction calculation failed:', error);
      return 'stable';
    }
  }

  private async buildTrendingTopic(
    trendData: {
      topic: string;
      keywords: string[];
      mentions: number;
      score: number;
      articles: any[];
      trend: 'rising' | 'stable' | 'declining';
    },
    timeWindow: 'short' | 'medium' | 'long',
    allArticles: any[]
  ): Promise<TrendingTopic> {
    // Get related articles with relevance scores
    const relatedArticles = trendData.articles
      .map(article => ({
        id: article.id,
        title: article.title,
        publishedAt: article.publishedAt,
        source: article.source,
        relevanceScore: this.calculateRelevanceScore(article, trendData.keywords),
      }))
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, 10);

    // Extract categories from related articles
    const categories = [...new Set(trendData.articles.map(a => a.category))];

    // Calculate sentiment from articles
    const sentiment = this.calculateTopicSentiment(trendData.articles);

    return {
      topic: trendData.topic,
      keywords: trendData.keywords,
      mentions: trendData.mentions,
      score: trendData.score,
      trend: trendData.trend,
      timeWindow,
      relatedArticles,
      categories,
      sentiment,
    };
  }

  private calculateRelevanceScore(article: any, topicKeywords: string[]): number {
    const fullText = `${article.title} ${article.content}`.toLowerCase();
    let score = 0;

    for (const keyword of topicKeywords) {
      const regex = new RegExp(`\\b${keyword.toLowerCase()}\\b`, 'g');
      const matches = fullText.match(regex);
      if (matches) {
        // Title matches count more
        const titleMatches = article.title.toLowerCase().match(regex);
        score += matches.length + (titleMatches ? titleMatches.length * 2 : 0);
      }
    }

    // Normalize by text length
    return score / Math.max(fullText.split(' ').length / 100, 1);
  }

  private calculateTopicSentiment(articles: any[]): { polarity: number; subjectivity: number } {
    // Simplified sentiment calculation
    // In a real implementation, you'd use proper sentiment analysis
    
    let totalPolarity = 0;
    let totalSubjectivity = 0;
    let count = 0;

    for (const article of articles) {
      // Simple sentiment based on keywords
      const text = `${article.title} ${article.content}`.toLowerCase();
      
      // Positive indicators
      const positiveWords = ['breakthrough', 'success', 'achievement', 'innovation', 'improve', 'advance', 'better', 'effective', 'powerful'];
      const negativeWords = ['concern', 'risk', 'problem', 'issue', 'fail', 'threat', 'danger', 'criticism', 'controversy'];
      
      let polarity = 0;
      let subjectivity = 0.5; // Default neutral subjectivity

      for (const word of positiveWords) {
        if (text.includes(word)) polarity += 0.1;
      }
      
      for (const word of negativeWords) {
        if (text.includes(word)) polarity -= 0.1;
      }

      // Simple subjectivity based on emotional words
      const emotionalWords = [...positiveWords, ...negativeWords, 'amazing', 'terrible', 'incredible', 'awful'];
      const emotionalCount = emotionalWords.filter(word => text.includes(word)).length;
      subjectivity = Math.min(1, 0.3 + emotionalCount * 0.1);

      totalPolarity += polarity;
      totalSubjectivity += subjectivity;
      count++;
    }

    return {
      polarity: count > 0 ? totalPolarity / count : 0,
      subjectivity: count > 0 ? totalSubjectivity / count : 0.5,
    };
  }

  private buildTrendingTopicsResult(topics: TrendingTopic[], processingTime: number): TrendingTopicsResult {
    const now = new Date();
    const timeWindows = {
      short: {
        start: new Date(now.getTime() - this.config.trending.timeWindows.shortTerm * 60 * 1000),
        end: now,
      },
      medium: {
        start: new Date(now.getTime() - this.config.trending.timeWindows.mediumTerm * 60 * 60 * 1000),
        end: now,
      },
      long: {
        start: new Date(now.getTime() - this.config.trending.timeWindows.longTerm * 24 * 60 * 60 * 1000),
        end: now,
      },
    };

    const totalArticles = topics.reduce((sum, topic) => sum + topic.relatedArticles.length, 0);
    const avgScore = topics.length > 0 ? topics.reduce((sum, topic) => sum + topic.score, 0) / topics.length : 0;

    return {
      topics,
      timeWindows,
      metadata: {
        totalArticlesAnalyzed: totalArticles,
        uniqueTopicsDetected: topics.length,
        avgTrendScore: avgScore,
        processingTime,
        lastUpdated: now,
      },
    };
  }

  /**
   * Get topic evolution over time
   */
  async getTopicEvolution(
    topic: string,
    timeRange?: { start: Date; end: Date }
  ): Promise<TopicEvolution> {
    try {
      const normalizedTopic = this.normalizeTopicName(topic);
      const history = this.topicHistory.get(normalizedTopic) || [];
      
      // Filter by time range if provided
      const filteredHistory = timeRange ? 
        history.filter(h => h.timestamp >= timeRange.start && h.timestamp <= timeRange.end) :
        history;

      // Create timeline
      const timeline = filteredHistory.map(h => ({
        timestamp: h.timestamp,
        mentions: h.mentions,
        score: h.score,
        sentiment: 0, // Would calculate from stored data
      }));

      // Identify peak moments
      const peakMoments = this.identifyPeakMoments(timeline);

      // Generate simple forecast
      const forecast = this.generateForecast(timeline);

      return {
        topic: normalizedTopic,
        timeline,
        peakMoments,
        forecast,
      };

    } catch (error) {
      this.logger.error('Topic evolution analysis failed:', error);
      throw error;
    }
  }

  private identifyPeakMoments(timeline: TopicEvolution['timeline']): TopicEvolution['peakMoments'] {
    const peaks: TopicEvolution['peakMoments'] = [];
    
    for (let i = 1; i < timeline.length - 1; i++) {
      const current = timeline[i];
      const previous = timeline[i - 1];
      const next = timeline[i + 1];
      
      // Simple peak detection: current is higher than both neighbors
      if (current.score > previous.score && current.score > next.score) {
        const impact = current.score - Math.max(previous.score, next.score);
        
        if (impact > 10) { // Minimum impact threshold
          peaks.push({
            timestamp: current.timestamp,
            trigger: 'Unknown trigger', // Would analyze actual content
            impact,
          });
        }
      }
    }

    return peaks.sort((a, b) => b.impact - a.impact).slice(0, 5);
  }

  private generateForecast(timeline: TopicEvolution['timeline']): TopicEvolution['forecast'] {
    if (timeline.length < 3) {
      return {
        nextHour: 0,
        nextDay: 0,
        nextWeek: 0,
        confidence: 0,
      };
    }

    // Simple linear trend forecast
    const recent = timeline.slice(-24); // Last 24 data points
    const trend = this.calculateTrend(recent);
    const currentScore = timeline[timeline.length - 1]?.score || 0;

    return {
      nextHour: Math.max(0, currentScore + trend),
      nextDay: Math.max(0, currentScore + trend * 24),
      nextWeek: Math.max(0, currentScore + trend * 24 * 7),
      confidence: Math.min(0.8, recent.length / 24), // Confidence based on data availability
    };
  }

  private calculateTrend(data: TopicEvolution['timeline']): number {
    if (data.length < 2) return 0;

    // Simple linear regression slope
    const n = data.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;

    for (let i = 0; i < n; i++) {
      const x = i;
      const y = data[i].score;
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumXX += x * x;
    }

    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    return isFinite(slope) ? slope : 0;
  }

  // Utility and maintenance methods
  private async updateTrendingTopics(): Promise<void> {
    try {
      this.logger.debug('Updating trending topics...');
      
      // Clear cache to force refresh
      this.topicCache.clear();
      
      // Update for all time windows
      await this.detectTrendingTopics({
        timeWindows: ['short', 'medium', 'long'],
        useCache: false,
      });
      
    } catch (error) {
      this.logger.error('Failed to update trending topics:', error);
    }
  }

  private async saveTrendingTopics(topics: TrendingTopic[]): Promise<void> {
    try {
      for (const topic of topics) {
        // Save to history
        const normalizedTopic = this.normalizeTopicName(topic.topic);
        
        if (!this.topicHistory.has(normalizedTopic)) {
          this.topicHistory.set(normalizedTopic, []);
        }
        
        this.topicHistory.get(normalizedTopic)!.push({
          timestamp: new Date(),
          mentions: topic.mentions,
          score: topic.score,
        });

        // Save to database
        await this.databaseService.query(
          `INSERT INTO trending_topics_history (topic, mentions, score, timestamp, time_window, trend_direction)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [topic.topic, topic.mentions, topic.score, new Date(), topic.timeWindow, topic.trend]
        );
      }
    } catch (error) {
      this.logger.error('Failed to save trending topics:', error);
    }
  }

  private async cleanOldHistoryData(): Promise<void> {
    try {
      // Remove data older than 30 days
      await this.databaseService.query(
        `DELETE FROM trending_topics_history WHERE timestamp < NOW() - INTERVAL '30 days'`
      );

      // Clean in-memory history
      const cutoffTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      
      for (const [topic, history] of this.topicHistory.entries()) {
        const filteredHistory = history.filter(h => h.timestamp >= cutoffTime);
        
        if (filteredHistory.length === 0) {
          this.topicHistory.delete(topic);
        } else {
          this.topicHistory.set(topic, filteredHistory);
        }
      }

      this.logger.info('Old trending topics history cleaned');
    } catch (error) {
      this.logger.error('Failed to clean old history data:', error);
    }
  }

  private generateCacheKey(options: any): string {
    const crypto = require('crypto');
    return `trending:${crypto.createHash('md5').update(JSON.stringify(options)).digest('hex')}`;
  }

  /**
   * Get trending topics metrics
   */
  async getTrendingMetrics(): Promise<{
    totalTopicsTracked: number;
    avgMentionsPerTopic: number;
    mostTrendingTopic: string;
    trendingCategories: { [category: string]: number };
    timeWindowBreakdown: { [window: string]: number };
  }> {
    try {
      const recentTopics = await this.detectTrendingTopics({ maxTopics: 100, useCache: true });
      const topics = recentTopics.topics;

      if (topics.length === 0) {
        return {
          totalTopicsTracked: 0,
          avgMentionsPerTopic: 0,
          mostTrendingTopic: '',
          trendingCategories: {},
          timeWindowBreakdown: {},
        };
      }

      const totalMentions = topics.reduce((sum, topic) => sum + topic.mentions, 0);
      const avgMentions = totalMentions / topics.length;
      const mostTrending = topics[0]?.topic || '';

      // Category breakdown
      const categoryCount: { [category: string]: number } = {};
      for (const topic of topics) {
        for (const category of topic.categories) {
          categoryCount[category] = (categoryCount[category] || 0) + 1;
        }
      }

      // Time window breakdown
      const windowCount: { [window: string]: number } = {};
      for (const topic of topics) {
        windowCount[topic.timeWindow] = (windowCount[topic.timeWindow] || 0) + 1;
      }

      return {
        totalTopicsTracked: topics.length,
        avgMentionsPerTopic: avgMentions,
        mostTrendingTopic: mostTrending,
        trendingCategories: categoryCount,
        timeWindowBreakdown: windowCount,
      };
    } catch (error) {
      this.logger.error('Failed to get trending metrics:', error);
      return {
        totalTopicsTracked: 0,
        avgMentionsPerTopic: 0,
        mostTrendingTopic: '',
        trendingCategories: {},
        timeWindowBreakdown: {},
      };
    }
  }
}