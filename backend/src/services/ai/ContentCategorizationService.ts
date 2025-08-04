import OpenAI from 'openai';
import { Logger } from 'winston';
import { DatabaseService } from '../database/DatabaseService';
import { EmbeddingService } from './EmbeddingService';
import { aiConfig, AIConfig } from '../../config/ai.config';
import { extract as extractKeywords } from 'keyword-extractor';
import * as natural from 'natural';

export interface CategoryPrediction {
  category: string;
  confidence: number;
  reasoning?: string;
}

export interface CategorizationResult {
  primaryCategory: string;
  additionalCategories: CategoryPrediction[];
  confidence: number;
  method: 'ai' | 'keyword' | 'embedding' | 'hybrid';
  tags: string[];
  keywords: string[];
  processingTime: number;
  manualOverride?: boolean;
}

export interface CategoryRule {
  id: string;
  category: string;
  keywords: string[];
  patterns: string[];
  weight: number;
  enabled: boolean;
}

export interface TrainingData {
  content: string;
  category: string;
  source?: string;
  confidence?: number;
}

const AI_NEWS_CATEGORIES = [
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
  'general'
] as const;

type NewsCategory = typeof AI_NEWS_CATEGORIES[number];

export class ContentCategorizationService {
  private openai: OpenAI | null = null;
  private categoryRules: Map<string, CategoryRule[]> = new Map();
  private categoryCache: Map<string, CategorizationResult> = new Map();
  private isInitialized: boolean = false;
  private classifier: any = null; // For local ML models

  constructor(
    private config: AIConfig,
    private logger: Logger,
    private databaseService: DatabaseService,
    private embeddingService: EmbeddingService
  ) {}

  async initialize(): Promise<void> {
    try {
      await this.initializeOpenAI();
      await this.loadCategoryRules();
      await this.initializeLocalClassifier();
      this.setupCache();
      this.isInitialized = true;
      this.logger.info('ContentCategorizationService initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize ContentCategorizationService:', error);
      throw error;
    }
  }

  private async initializeOpenAI(): Promise<void> {
    if (!this.config.openai.apiKey) {
      this.logger.warn('OpenAI API key not provided, AI categorization will be unavailable');
      return;
    }

    try {
      this.openai = new OpenAI({
        apiKey: this.config.openai.apiKey,
        organization: this.config.openai.organization,
      });
      this.logger.info('OpenAI client initialized for categorization');
    } catch (error) {
      this.logger.error('Failed to initialize OpenAI client for categorization:', error);
      this.openai = null;
    }
  }

  private async loadCategoryRules(): Promise<void> {
    try {
      // Load rules from database
      const rules = await this.databaseService.query<CategoryRule>(`
        SELECT * FROM category_rules WHERE enabled = true ORDER BY weight DESC
      `);

      // Group rules by category
      for (const rule of rules) {
        if (!this.categoryRules.has(rule.category)) {
          this.categoryRules.set(rule.category, []);
        }
        this.categoryRules.get(rule.category)!.push(rule);
      }

      this.logger.info(`Loaded ${rules.length} category rules for ${this.categoryRules.size} categories`);
    } catch (error) {
      this.logger.warn('Failed to load category rules from database, using default rules');
      this.setupDefaultRules();
    }
  }

  private setupDefaultRules(): void {
    const defaultRules: { [key: string]: CategoryRule } = {
      'artificial-intelligence': {
        id: 'ai-default',
        category: 'artificial-intelligence',
        keywords: ['artificial intelligence', 'ai', 'machine intelligence', 'cognitive computing', 'intelligent systems'],
        patterns: ['\\bAI\\b', 'artificial.{1,10}intelligence', 'machine.{1,10}intelligence'],
        weight: 1.0,
        enabled: true,
      },
      'machine-learning': {
        id: 'ml-default',
        category: 'machine-learning',
        keywords: ['machine learning', 'ml', 'supervised learning', 'unsupervised learning', 'reinforcement learning', 'statistical learning'],
        patterns: ['\\bML\\b', 'machine.{1,10}learning', 'statistical.{1,10}learning'],
        weight: 1.0,
        enabled: true,
      },
      'deep-learning': {
        id: 'dl-default',
        category: 'deep-learning',
        keywords: ['deep learning', 'neural networks', 'deep neural networks', 'cnn', 'rnn', 'lstm', 'transformer'],
        patterns: ['deep.{1,10}learning', 'neural.{1,10}network', 'convolutional', 'recurrent'],
        weight: 1.0,
        enabled: true,
      },
      'nlp': {
        id: 'nlp-default',
        category: 'nlp',
        keywords: ['natural language processing', 'nlp', 'text mining', 'language model', 'text analysis', 'sentiment analysis'],
        patterns: ['\\bNLP\\b', 'natural.{1,10}language', 'text.{1,10}processing', 'language.{1,10}model'],
        weight: 1.0,
        enabled: true,
      },
      'computer-vision': {
        id: 'cv-default',
        category: 'computer-vision',
        keywords: ['computer vision', 'image recognition', 'object detection', 'image processing', 'visual recognition'],
        patterns: ['computer.{1,10}vision', 'image.{1,10}recognition', 'object.{1,10}detection'],
        weight: 1.0,
        enabled: true,
      },
      'robotics': {
        id: 'robotics-default',
        category: 'robotics',
        keywords: ['robotics', 'robot', 'automation', 'autonomous systems', 'robotic systems'],
        patterns: ['robot(ic|s)?', 'automat(ion|ed)', 'autonomous.{1,10}system'],
        weight: 1.0,
        enabled: true,
      },
    };

    for (const [category, rule] of Object.entries(defaultRules)) {
      this.categoryRules.set(category, [rule]);
    }
  }

  private async initializeLocalClassifier(): Promise<void> {
    try {
      // Initialize a simple Naive Bayes classifier with natural
      this.classifier = new natural.BayesClassifier();
      
      // You would load pre-trained model here
      // For now, we'll add some basic training data
      await this.trainDefaultClassifier();
      
      this.logger.info('Local classifier initialized');
    } catch (error) {
      this.logger.error('Failed to initialize local classifier:', error);
      this.classifier = null;
    }
  }

  private async trainDefaultClassifier(): Promise<void> {
    if (!this.classifier) return;

    const trainingData: TrainingData[] = [
      { content: 'artificial intelligence machine learning deep learning neural networks', category: 'artificial-intelligence' },
      { content: 'supervised learning unsupervised learning reinforcement learning algorithms', category: 'machine-learning' },
      { content: 'neural networks deep neural networks convolutional recurrent transformer', category: 'deep-learning' },
      { content: 'natural language processing text mining sentiment analysis language models', category: 'nlp' },
      { content: 'computer vision image recognition object detection visual processing', category: 'computer-vision' },
      { content: 'robotics automation autonomous systems robotic control', category: 'robotics' },
      { content: 'startup funding venture capital investment AI company', category: 'startups' },
      { content: 'research paper academic study scientific findings', category: 'research' },
      { content: 'industry news business technology market trends', category: 'industry' },
      { content: 'cybersecurity security threats data protection privacy', category: 'cybersecurity' },
      { content: 'blockchain cryptocurrency bitcoin ethereum decentralized', category: 'blockchain' },
      { content: 'quantum computing quantum algorithms quantum supremacy', category: 'quantum-computing' },
      { content: 'cloud computing aws azure google cloud serverless', category: 'cloud-computing' },
      { content: 'data science analytics big data visualization statistics', category: 'data-science' },
      { content: 'biotechnology genomics biotech medical ai healthcare', category: 'biotech' },
      { content: 'fintech financial technology banking payments digital finance', category: 'fintech' },
    ];

    for (const item of trainingData) {
      this.classifier.addDocument(item.content, item.category);
    }

    this.classifier.train();
    this.logger.info('Default classifier training completed');
  }

  private setupCache(): void {
    // Clean cache every hour
    setInterval(() => {
      const now = Date.now();
      const maxAge = 60 * 60 * 1000; // 1 hour
      
      for (const [key, result] of this.categoryCache.entries()) {
        if (now - result.processingTime > maxAge) {
          this.categoryCache.delete(key);
        }
      }
    }, 60 * 60 * 1000);
  }

  /**
   * Categorize content using multiple methods and return best result
   */
  async categorizeContent(
    content: string,
    title?: string,
    existingCategory?: string,
    options?: {
      method?: 'ai' | 'keyword' | 'embedding' | 'hybrid' | 'auto';
      useCache?: boolean;
      includeTags?: boolean;
      minConfidence?: number;
    }
  ): Promise<CategorizationResult> {
    if (!this.isInitialized) {
      throw new Error('ContentCategorizationService not initialized');
    }

    const startTime = Date.now();
    const fullText = title ? `${title}. ${content}` : content;
    const cacheKey = this.generateCacheKey(fullText);

    // Check cache
    if (options?.useCache !== false && this.categoryCache.has(cacheKey)) {
      const cached = this.categoryCache.get(cacheKey)!;
      this.logger.debug('Returning cached categorization result');
      return cached;
    }

    try {
      const method = options?.method || 'auto';
      let result: CategorizationResult;

      switch (method) {
        case 'ai':
          result = await this.categorizeWithAI(fullText);
          break;
        case 'keyword':
          result = await this.categorizeWithKeywords(fullText);
          break;
        case 'embedding':
          result = await this.categorizeWithEmbeddings(fullText);
          break;
        case 'hybrid':
          result = await this.categorizeWithHybrid(fullText);
          break;
        case 'auto':
        default:
          result = await this.categorizeWithBestMethod(fullText);
          break;
      }

      // Apply minimum confidence threshold
      const minConfidence = options?.minConfidence || this.config.categorization.confidenceThreshold;
      if (result.confidence < minConfidence) {
        result.primaryCategory = existingCategory || 'general';
        result.confidence = 0.5; // Default confidence for fallback
      }

      // Add tags if requested
      if (options?.includeTags !== false) {
        result.tags = await this.extractTags(fullText);
      }

      result.processingTime = Date.now() - startTime;

      // Cache result
      if (options?.useCache !== false) {
        this.categoryCache.set(cacheKey, result);
      }

      // Track metrics
      await this.trackCategorizationMetrics(result);

      this.logger.info('Content categorization completed', {
        method: result.method,
        primaryCategory: result.primaryCategory,
        confidence: result.confidence,
        processingTime: result.processingTime,
      });

      return result;

    } catch (error) {
      this.logger.error('Content categorization failed:', error);
      
      // Return fallback result
      return {
        primaryCategory: existingCategory || 'general',
        additionalCategories: [],
        confidence: 0.3,
        method: 'keyword',
        tags: [],
        keywords: this.extractKeywords(fullText),
        processingTime: Date.now() - startTime,
      };
    }
  }

  /**
   * Categorize content using OpenAI GPT
   */
  private async categorizeWithAI(content: string): Promise<CategorizationResult> {
    if (!this.openai) {
      throw new Error('OpenAI client not available');
    }

    const prompt = this.createCategorizationPrompt(content);

    const response = await this.openai.chat.completions.create({
      model: this.config.openai.models.chat,
      messages: [
        {
          role: 'system',
          content: 'You are an expert content categorizer for AI and technology news. Analyze the content and provide accurate categorization with confidence scores.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.3,
      max_tokens: 500,
    });

    const aiResponse = response.choices[0]?.message?.content;
    if (!aiResponse) {
      throw new Error('No response from OpenAI');
    }

    return this.parseAIResponse(aiResponse);
  }

  private createCategorizationPrompt(content: string): string {
    const categories = AI_NEWS_CATEGORIES.join('", "');
    
    return `
Analyze the following content and categorize it into one of these categories: "${categories}".

Content to analyze:
"""
${content.substring(0, 2000)} ${content.length > 2000 ? '...' : ''}
"""

Please respond in the following JSON format:
{
  "primaryCategory": "category-name",
  "additionalCategories": [
    {"category": "category-name", "confidence": 0.8, "reasoning": "brief explanation"}
  ],
  "confidence": 0.95,
  "reasoning": "explanation for primary category choice",
  "keywords": ["keyword1", "keyword2", "keyword3"]
}

Rules:
1. Use only the provided categories
2. Confidence should be between 0 and 1
3. Include up to 3 additional categories if relevant (confidence > 0.5)
4. Provide clear reasoning for your choice
5. Extract 5-10 relevant keywords
`;
  }

  private parseAIResponse(response: string): CategorizationResult {
    try {
      // Clean the response and extract JSON
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in AI response');
      }

      const parsed = JSON.parse(jsonMatch[0]);
      
      return {
        primaryCategory: parsed.primaryCategory || 'general',
        additionalCategories: parsed.additionalCategories || [],
        confidence: Math.min(Math.max(parsed.confidence || 0.5, 0), 1),
        method: 'ai',
        tags: [],
        keywords: parsed.keywords || [],
        processingTime: 0, // Will be set by caller
      };
    } catch (error) {
      this.logger.error('Failed to parse AI response:', error);
      throw new Error('Invalid AI response format');
    }
  }

  /**
   * Categorize content using keyword matching
   */
  private async categorizeWithKeywords(content: string): Promise<CategorizationResult> {
    const keywords = this.extractKeywords(content);
    const scores: { [category: string]: number } = {};
    const matchedKeywords: { [category: string]: string[] } = {};

    // Score each category based on keyword matches
    for (const [category, rules] of this.categoryRules.entries()) {
      let categoryScore = 0;
      matchedKeywords[category] = [];

      for (const rule of rules) {
        // Keyword matching
        for (const keyword of rule.keywords) {
          const regex = new RegExp(keyword.replace(/\s+/g, '\\s+'), 'gi');
          const matches = content.match(regex);
          if (matches) {
            categoryScore += matches.length * rule.weight;
            matchedKeywords[category].push(keyword);
          }
        }

        // Pattern matching
        for (const pattern of rule.patterns) {
          const regex = new RegExp(pattern, 'gi');
          const matches = content.match(regex);
          if (matches) {
            categoryScore += matches.length * rule.weight * 1.2; // Patterns get slight boost
            matchedKeywords[category].push(`pattern:${pattern}`);
          }
        }
      }

      if (categoryScore > 0) {
        scores[category] = categoryScore;
      }
    }

    // Find best category
    const sortedCategories = Object.entries(scores)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 3);

    if (sortedCategories.length === 0) {
      return {
        primaryCategory: 'general',
        additionalCategories: [],
        confidence: 0.3,
        method: 'keyword',
        tags: [],
        keywords,
        processingTime: 0,
      };
    }

    const [primaryCategory, primaryScore] = sortedCategories[0];
    const totalScore = Object.values(scores).reduce((sum, score) => sum + score, 0);
    const confidence = Math.min(primaryScore / Math.max(totalScore, 1), 1);

    const additionalCategories: CategoryPrediction[] = sortedCategories
      .slice(1)
      .map(([category, score]) => ({
        category,
        confidence: Math.min(score / Math.max(totalScore, 1), 1),
        reasoning: `Matched keywords: ${matchedKeywords[category].join(', ')}`,
      }));

    return {
      primaryCategory,
      additionalCategories,
      confidence,
      method: 'keyword',
      tags: [],
      keywords,
      processingTime: 0,
    };
  }

  /**
   * Categorize content using embedding similarity
   */
  private async categorizeWithEmbeddings(content: string): Promise<CategorizationResult> {
    try {
      // Generate embedding for content
      const contentEmbedding = await this.embeddingService.generateEmbedding(content);

      // Find similar content and use their categories
      const similarContent = await this.findSimilarCategorizedContent(contentEmbedding.embedding);

      if (similarContent.length === 0) {
        throw new Error('No similar categorized content found');
      }

      // Calculate category scores based on similarity
      const categoryScores: { [category: string]: { score: number; count: number } } = {};

      for (const similar of similarContent) {
        if (!categoryScores[similar.category]) {
          categoryScores[similar.category] = { score: 0, count: 0 };
        }
        categoryScores[similar.category].score += similar.similarity;
        categoryScores[similar.category].count += 1;
      }

      // Calculate average scores
      const avgScores = Object.entries(categoryScores)
        .map(([category, { score, count }]) => ({
          category,
          avgScore: score / count,
          count,
        }))
        .sort((a, b) => b.avgScore - a.avgScore);

      const primaryCategory = avgScores[0].category;
      const confidence = avgScores[0].avgScore;

      const additionalCategories: CategoryPrediction[] = avgScores
        .slice(1, 3)
        .filter(item => item.avgScore > 0.6)
        .map(item => ({
          category: item.category,
          confidence: item.avgScore,
          reasoning: `Based on ${item.count} similar articles`,
        }));

      return {
        primaryCategory,
        additionalCategories,
        confidence,
        method: 'embedding',
        tags: [],
        keywords: this.extractKeywords(content),
        processingTime: 0,
      };

    } catch (error) {
      this.logger.error('Embedding categorization failed:', error);
      throw error;
    }
  }

  private async findSimilarCategorizedContent(
    embedding: number[]
  ): Promise<Array<{ category: string; similarity: number }>> {
    const query = `
      SELECT 
        category,
        1 - (content_embedding <=> $1::vector) as similarity
      FROM articles
      WHERE content_embedding IS NOT NULL
        AND category IS NOT NULL
        AND category != 'general'
        AND deleted_at IS NULL
        AND 1 - (content_embedding <=> $1::vector) >= 0.7
      ORDER BY content_embedding <=> $1::vector
      LIMIT 20
    `;

    const results = await this.databaseService.query(query, [JSON.stringify(embedding)]);
    
    return results.map(row => ({
      category: row.category,
      similarity: parseFloat(row.similarity),
    }));
  }

  /**
   * Categorize content using hybrid approach combining multiple methods
   */
  private async categorizeWithHybrid(content: string): Promise<CategorizationResult> {
    try {
      // Run multiple methods in parallel
      const [keywordResult, embeddingResult] = await Promise.allSettled([
        this.categorizeWithKeywords(content),
        this.categorizeWithEmbeddings(content),
      ]);

      const results: CategorizationResult[] = [];

      if (keywordResult.status === 'fulfilled') {
        results.push(keywordResult.value);
      }

      if (embeddingResult.status === 'fulfilled') {
        results.push(embeddingResult.value);
      }

      // Try AI if available and other methods have low confidence
      const avgConfidence = results.length > 0 ? 
        results.reduce((sum, r) => sum + r.confidence, 0) / results.length : 0;

      if (this.openai && avgConfidence < 0.7) {
        try {
          const aiResult = await this.categorizeWithAI(content);
          results.push(aiResult);
        } catch (error) {
          this.logger.warn('AI categorization failed in hybrid mode:', error);
        }
      }

      // Combine results
      return this.combineCategorizationResults(results, content);

    } catch (error) {
      this.logger.error('Hybrid categorization failed:', error);
      throw error;
    }
  }

  private combineCategorizationResults(
    results: CategorizationResult[],
    content: string
  ): CategorizationResult {
    if (results.length === 0) {
      return {
        primaryCategory: 'general',
        additionalCategories: [],
        confidence: 0.3,
        method: 'hybrid',
        tags: [],
        keywords: this.extractKeywords(content),
        processingTime: 0,
      };
    }

    // Weight results by confidence and method reliability
    const methodWeights = { ai: 1.0, embedding: 0.8, keyword: 0.6 };
    const categoryScores: { [category: string]: number } = {};

    for (const result of results) {
      const weight = methodWeights[result.method] || 0.5;
      const score = result.confidence * weight;
      
      categoryScores[result.primaryCategory] = 
        (categoryScores[result.primaryCategory] || 0) + score;

      // Add additional categories with lower weight
      for (const additional of result.additionalCategories) {
        const additionalScore = additional.confidence * weight * 0.5;
        categoryScores[additional.category] = 
          (categoryScores[additional.category] || 0) + additionalScore;
      }
    }

    // Find best category
    const sortedCategories = Object.entries(categoryScores)
      .sort(([,a], [,b]) => b - a);

    const primaryCategory = sortedCategories[0]?.[0] || 'general';
    const totalScore = Object.values(categoryScores).reduce((sum, score) => sum + score, 0);
    const confidence = Math.min(sortedCategories[0]?.[1] / Math.max(totalScore, 1) || 0.3, 1);

    const additionalCategories: CategoryPrediction[] = sortedCategories
      .slice(1, 3)
      .filter(([, score]) => score / totalScore > 0.2)
      .map(([category, score]) => ({
        category,
        confidence: Math.min(score / totalScore, 1),
        reasoning: 'Combined from multiple methods',
      }));

    return {
      primaryCategory,
      additionalCategories,
      confidence,
      method: 'hybrid',
      tags: [],
      keywords: this.extractKeywords(content),
      processingTime: 0,
    };
  }

  /**
   * Automatically choose the best categorization method
   */
  private async categorizeWithBestMethod(content: string): Promise<CategorizationResult> {
    const contentLength = content.length;
    const hasKeywords = this.hasStrongKeywordSignals(content);

    // Choose method based on content characteristics
    if (this.openai && contentLength > 500 && !hasKeywords) {
      // Use AI for longer, complex content without clear keyword signals
      try {
        return await this.categorizeWithAI(content);
      } catch (error) {
        this.logger.warn('AI categorization failed, falling back to hybrid');
        return await this.categorizeWithHybrid(content);
      }
    } else if (hasKeywords) {
      // Use keyword matching for content with clear signals
      return await this.categorizeWithKeywords(content);
    } else {
      // Use hybrid approach for other cases
      return await this.categorizeWithHybrid(content);
    }
  }

  private hasStrongKeywordSignals(content: string): boolean {
    const strongKeywords = [
      'artificial intelligence', 'machine learning', 'deep learning',
      'neural network', 'nlp', 'computer vision', 'robotics',
      'blockchain', 'cryptocurrency', 'quantum computing'
    ];

    const lowerContent = content.toLowerCase();
    return strongKeywords.some(keyword => lowerContent.includes(keyword));
  }

  /**
   * Batch categorize multiple pieces of content
   */
  async batchCategorizeContent(
    contents: Array<{ id: string; content: string; title?: string; existingCategory?: string }>,
    options?: {
      method?: 'ai' | 'keyword' | 'embedding' | 'hybrid' | 'auto';
      maxConcurrency?: number;
      useCache?: boolean;
    }
  ): Promise<Array<{ id: string; result: CategorizationResult }>> {
    const maxConcurrency = options?.maxConcurrency || this.config.processing.maxConcurrency;
    const semaphore = new Semaphore(maxConcurrency);
    
    this.logger.info('Starting batch categorization', {
      totalItems: contents.length,
      method: options?.method || 'auto',
      maxConcurrency,
    });

    const results = await Promise.allSettled(
      contents.map(async (item) => {
        await semaphore.acquire();
        
        try {
          const result = await this.categorizeContent(
            item.content,
            item.title,
            item.existingCategory,
            options
          );
          
          return { id: item.id, result };
        } finally {
          semaphore.release();
        }
      })
    );

    const successfulResults = results
      .filter((result): result is PromiseFulfilledResult<{ id: string; result: CategorizationResult }> => 
        result.status === 'fulfilled'
      )
      .map(result => result.value);

    const failedCount = results.length - successfulResults.length;

    this.logger.info('Batch categorization completed', {
      totalItems: contents.length,
      successful: successfulResults.length,
      failed: failedCount,
    });

    return successfulResults;
  }

  /**
   * Extract relevant tags from content
   */
  private async extractTags(content: string): Promise<string[]> {
    try {
      const keywords = this.extractKeywords(content);
      const tags: string[] = [];

      // Use keyword extraction as base
      tags.push(...keywords.slice(0, 10));

      // Add domain-specific tags
      const domainTags = this.extractDomainSpecificTags(content);
      tags.push(...domainTags);

      // Remove duplicates and return
      return [...new Set(tags)].slice(0, 15);
    } catch (error) {
      this.logger.error('Tag extraction failed:', error);
      return [];
    }
  }

  private extractDomainSpecificTags(content: string): string[] {
    const lowerContent = content.toLowerCase();
    const tags: string[] = [];

    const tagPatterns = {
      'tensorflow': /tensorflow|tf\.keras/gi,
      'pytorch': /pytorch|torch/gi,
      'openai': /openai|gpt|chatgpt/gi,
      'google': /google|bert|lamda/gi,
      'microsoft': /microsoft|azure|copilot/gi,
      'meta': /meta|facebook|llama/gi,
      'research': /research|paper|study|arxiv/gi,
      'startup': /startup|funding|investment|vc/gi,
      'enterprise': /enterprise|business|corporate/gi,
      'open-source': /open.source|github|oss/gi,
    };

    for (const [tag, pattern] of Object.entries(tagPatterns)) {
      if (pattern.test(content)) {
        tags.push(tag);
      }
    }

    return tags;
  }

  private extractKeywords(content: string): string[] {
    try {
      return extractKeywords(content, {
        language: 'english',
        remove_digits: false,
        return_changed_case: true,
        remove_duplicates: true,
      }).slice(0, 15);
    } catch (error) {
      this.logger.error('Keyword extraction failed:', error);
      return [];
    }
  }

  /**
   * Save categorization result to database
   */
  async saveCategorization(
    contentId: string,
    contentType: 'article' | 'arxiv_paper',
    result: CategorizationResult
  ): Promise<void> {
    try {
      let updateQuery: string;
      
      if (contentType === 'article') {
        updateQuery = `
          UPDATE articles 
          SET 
            category = $2,
            tags = $3,
            updated_at = NOW()
          WHERE id = $1
        `;
      } else {
        updateQuery = `
          UPDATE arxiv_papers 
          SET 
            primary_category = $2,
            tags = $3,
            updated_at = NOW()
          WHERE id = $1
        `;
      }

      await this.databaseService.query(updateQuery, [
        contentId,
        result.primaryCategory,
        result.tags,
      ]);

      // Save additional categories if multi-label is enabled
      if (this.config.categorization.enableMultiLabel && result.additionalCategories.length > 0) {
        await this.saveAdditionalCategories(contentId, contentType, result.additionalCategories);
      }

      this.logger.debug('Categorization saved to database', {
        contentId,
        contentType,
        primaryCategory: result.primaryCategory,
        additionalCategories: result.additionalCategories.length,
      });

    } catch (error) {
      this.logger.error('Failed to save categorization to database', {
        contentId,
        contentType,
        error: error.message,
      });
      throw error;
    }
  }

  private async saveAdditionalCategories(
    contentId: string,
    contentType: 'article' | 'arxiv_paper',
    categories: CategoryPrediction[]
  ): Promise<void> {
    // This would save to a separate table for multi-label categorization
    // Implementation depends on your database schema requirements
    const tableName = contentType === 'article' ? 'article_categories' : 'paper_categories';
    
    // Delete existing additional categories
    await this.databaseService.query(
      `DELETE FROM ${tableName} WHERE content_id = $1`,
      [contentId]
    );

    // Insert new categories
    for (const category of categories) {
      await this.databaseService.query(
        `INSERT INTO ${tableName} (content_id, category, confidence) VALUES ($1, $2, $3)`,
        [contentId, category.category, category.confidence]
      );
    }
  }

  /**
   * Get categorization metrics and performance stats
   */
  async getCategorizationMetrics(): Promise<{
    dailyCategorizations: number;
    methodBreakdown: { [method: string]: number };
    categoryDistribution: { [category: string]: number };
    avgConfidence: number;
    avgProcessingTime: number;
  }> {
    try {
      const today = new Date().toISOString().split('T')[0];
      
      const [
        dailyCategorizations,
        aiCategorizations,
        keywordCategorizations,
        embeddingCategorizations,
        hybridCategorizations,
        totalConfidence,
        totalProcessingTime,
      ] = await Promise.all([
        this.databaseService.cacheGet(`categorization_metrics:${today}:total`) || 0,
        this.databaseService.cacheGet(`categorization_metrics:${today}:ai`) || 0,
        this.databaseService.cacheGet(`categorization_metrics:${today}:keyword`) || 0,
        this.databaseService.cacheGet(`categorization_metrics:${today}:embedding`) || 0,
        this.databaseService.cacheGet(`categorization_metrics:${today}:hybrid`) || 0,
        this.databaseService.cacheGet(`categorization_metrics:${today}:confidence`) || 0,
        this.databaseService.cacheGet(`categorization_metrics:${today}:processing_time`) || 0,
      ]);

      const totalCategorizations = Number(dailyCategorizations);

      // Get category distribution from database
      const categoryQuery = `
        SELECT category, COUNT(*) as count
        FROM articles
        WHERE DATE(updated_at) = $1
        GROUP BY category
        ORDER BY count DESC
        LIMIT 20
      `;
      
      const categoryResults = await this.databaseService.query(categoryQuery, [today]);
      const categoryDistribution: { [category: string]: number } = {};
      
      for (const row of categoryResults) {
        categoryDistribution[row.category] = parseInt(row.count);
      }

      return {
        dailyCategorizations: totalCategorizations,
        methodBreakdown: {
          ai: Number(aiCategorizations),
          keyword: Number(keywordCategorizations),
          embedding: Number(embeddingCategorizations),
          hybrid: Number(hybridCategorizations),
        },
        categoryDistribution,
        avgConfidence: totalCategorizations > 0 ? Number(totalConfidence) / totalCategorizations : 0,
        avgProcessingTime: totalCategorizations > 0 ? Number(totalProcessingTime) / totalCategorizations : 0,
      };
    } catch (error) {
      this.logger.error('Failed to get categorization metrics:', error);
      return {
        dailyCategorizations: 0,
        methodBreakdown: {},
        categoryDistribution: {},
        avgConfidence: 0,
        avgProcessingTime: 0,
      };
    }
  }

  // Utility methods
  private generateCacheKey(content: string): string {
    const crypto = require('crypto');
    return `categorization:${crypto.createHash('md5').update(content).digest('hex')}`;
  }

  private async trackCategorizationMetrics(result: CategorizationResult): Promise<void> {
    try {
      const today = new Date().toISOString().split('T')[0];
      
      await Promise.all([
        this.databaseService.incrementCounter(`categorization_metrics:${today}:total`, 1, 86400),
        this.databaseService.incrementCounter(`categorization_metrics:${today}:${result.method}`, 1, 86400),
        this.databaseService.incrementCounter(`categorization_metrics:${today}:confidence`, result.confidence, 86400),
        this.databaseService.incrementCounter(`categorization_metrics:${today}:processing_time`, result.processingTime, 86400),
      ]);
    } catch (error) {
      this.logger.error('Failed to track categorization metrics:', error);
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