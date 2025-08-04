import { Logger } from 'winston';
import { DatabaseService } from '../database/DatabaseService';
import { EmbeddingService } from './EmbeddingService';
import { aiConfig, AIConfig } from '../../config/ai.config';
import * as natural from 'natural';
import { removeStopwords } from 'stopword';
import { extract as extractKeywords } from 'keyword-extractor';

export interface SearchQuery {
  text: string;
  filters?: {
    categories?: string[];
    sources?: string[];
    dateRange?: {
      start: Date;
      end: Date;
    };
    qualityThreshold?: number;
    contentTypes?: ('article' | 'arxiv_paper')[];
    tags?: string[];
    authors?: string[];
  };
  options?: {
    limit?: number;
    offset?: number;
    includeContent?: boolean;
    includeSimilar?: boolean;
    searchType?: 'semantic' | 'fulltext' | 'hybrid';
    sortBy?: 'relevance' | 'date' | 'quality' | 'popularity';
    sortOrder?: 'asc' | 'desc';
  };
}

export interface SearchResult {
  id: string;
  title: string;
  description?: string;
  content?: string;
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
    semantic?: number;
    fulltext?: number;
    quality: number;
    recency: number;
    popularity: number;
    combined: number;
  };
  highlighting?: {
    title?: string;
    description?: string;
    content?: string;
  };
  metadata?: {
    wordCount?: number;
    readingTime?: number;
    language?: string;
    sentiment?: number;
  };
}

export interface SearchResponse {
  results: SearchResult[];
  totalCount: number;
  searchTime: number;
  query: {
    original: string;
    expanded?: string[];
    keywords: string[];
    searchType: string;
  };
  aggregations?: {
    categories: { [key: string]: number };
    sources: { [key: string]: number };
    contentTypes: { [key: string]: number };
    timeDistribution: { [key: string]: number };
  };
  suggestions?: string[];
}

export interface QueryExpansion {
  synonyms: string[];
  relatedTerms: string[];
  conceptualTerms: string[];
}

export class SemanticSearchService {
  private stemmer = natural.PorterStemmer;
  private isInitialized: boolean = false;
  private queryCache: Map<string, SearchResponse> = new Map();
  private synonymCache: Map<string, string[]> = new Map();

  constructor(
    private config: AIConfig,
    private logger: Logger,
    private databaseService: DatabaseService,
    private embeddingService: EmbeddingService
  ) {}

  async initialize(): Promise<void> {
    try {
      this.setupQueryCache();
      this.isInitialized = true;
      this.logger.info('SemanticSearchService initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize SemanticSearchService:', error);
      throw error;
    }
  }

  private setupQueryCache(): void {
    // Clean cache every 15 minutes
    setInterval(() => {
      const now = Date.now();
      const maxAge = 15 * 60 * 1000; // 15 minutes
      
      for (const [key, value] of this.queryCache.entries()) {
        if (now - value.searchTime > maxAge) {
          this.queryCache.delete(key);
        }
      }
    }, 15 * 60 * 1000);
  }

  /**
   * Main search method with automatic type detection and optimization
   */
  async search(query: SearchQuery): Promise<SearchResponse> {
    if (!this.isInitialized) {
      throw new Error('SemanticSearchService not initialized');
    }

    const startTime = Date.now();
    const searchType = query.options?.searchType || this.determineOptimalSearchType(query.text);
    
    this.logger.info('Starting search', {
      query: query.text,
      searchType,
      filters: query.filters,
    });

    // Check cache
    const cacheKey = this.generateCacheKey(query);
    if (this.queryCache.has(cacheKey)) {
      const cached = this.queryCache.get(cacheKey)!;
      this.logger.debug('Returning cached search results');
      return cached;
    }

    try {
      let results: SearchResult[];
      let totalCount: number;
      
      // Perform search based on type
      switch (searchType) {
        case 'semantic':
          ({ results, totalCount } = await this.performSemanticSearch(query));
          break;
        case 'fulltext':
          ({ results, totalCount } = await this.performFullTextSearch(query));
          break;
        case 'hybrid':
        default:
          ({ results, totalCount } = await this.performHybridSearch(query));
          break;
      }

      // Generate query expansion and suggestions
      const expandedQuery = await this.expandQuery(query.text);
      const keywords = this.extractKeywords(query.text);
      const suggestions = await this.generateSearchSuggestions(query.text, results.length);

      // Generate aggregations
      const aggregations = this.generateAggregations(results);

      const searchTime = Date.now() - startTime;

      const response: SearchResponse = {
        results,
        totalCount,
        searchTime,
        query: {
          original: query.text,
          expanded: expandedQuery.synonyms.concat(expandedQuery.relatedTerms),
          keywords,
          searchType,
        },
        aggregations,
        suggestions,
      };

      // Cache results
      this.queryCache.set(cacheKey, response);

      // Track search metrics
      await this.trackSearchMetrics({
        query: query.text,
        searchType,
        resultCount: results.length,
        searchTime,
        filters: query.filters,
      });

      this.logger.info('Search completed', {
        query: query.text,
        searchType,
        resultCount: results.length,
        totalCount,
        searchTime,
      });

      return response;

    } catch (error) {
      this.logger.error('Search failed', {
        query: query.text,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Perform semantic search using vector similarity
   */
  private async performSemanticSearch(query: SearchQuery): Promise<{ results: SearchResult[]; totalCount: number }> {
    // Generate query embedding
    const queryEmbedding = await this.embeddingService.generateEmbedding(query.text);
    
    const limit = query.options?.limit || 20;
    const offset = query.options?.offset || 0;
    const threshold = this.config.semantic.similarityThreshold;

    // Build base query for articles
    let articleQuery = `
      SELECT 
        a.id,
        a.title,
        a.description,
        ${query.options?.includeContent ? 'a.content,' : ''}
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
        a.language,
        a.sentiment_score,
        s.id as source_id,
        s.name as source_name,
        s.url as source_url,
        'article' as content_type,
        1 - (a.content_embedding <=> $1::vector) as semantic_score
      FROM articles a
      JOIN news_sources s ON a.source_id = s.id
      WHERE a.deleted_at IS NULL 
        AND a.status = 'published'
        AND a.content_embedding IS NOT NULL
        AND 1 - (a.content_embedding <=> $1::vector) >= $2
    `;

    // Build base query for ArXiv papers
    let paperQuery = `
      SELECT 
        p.id,
        p.title,
        p.summary as description,
        ${query.options?.includeContent ? 'p.summary as content,' : ''}
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
        'en' as language,
        NULL as sentiment_score,
        NULL as source_id,
        'ArXiv' as source_name,
        'https://arxiv.org' as source_url,
        'arxiv_paper' as content_type,
        1 - (p.summary_embedding <=> $1::vector) as semantic_score
      FROM arxiv_papers p
      WHERE p.summary_embedding IS NOT NULL
        AND 1 - (p.summary_embedding <=> $1::vector) >= $2
    `;

    const queryParams = [JSON.stringify(queryEmbedding.embedding), threshold];
    let paramIndex = 3;

    // Apply filters
    const { articleQuery: filteredArticleQuery, paperQuery: filteredPaperQuery, params } = 
      this.applyFilters(articleQuery, paperQuery, query.filters || {}, queryParams, paramIndex);

    // Combine queries
    const combinedQuery = `
      WITH combined_results AS (
        ${filteredArticleQuery}
        UNION ALL
        ${filteredPaperQuery}
      )
      SELECT *
      FROM combined_results
      ORDER BY semantic_score DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    params.push(limit, offset);

    // Execute search
    const results = await this.databaseService.query(combinedQuery, params);
    
    // Count total results
    const countQuery = `
      WITH combined_results AS (
        ${filteredArticleQuery}
        UNION ALL
        ${filteredPaperQuery}
      )
      SELECT COUNT(*) as total FROM combined_results
    `;

    const countResult = await this.databaseService.query(countQuery, params.slice(0, -2));
    const totalCount = parseInt(countResult[0]?.total || '0');

    // Transform results
    const searchResults = results.map(row => this.transformToSearchResult(row, {
      semantic: row.semantic_score,
    }));

    return { results: searchResults, totalCount };
  }

  /**
   * Perform full-text search using PostgreSQL's text search capabilities
   */
  private async performFullTextSearch(query: SearchQuery): Promise<{ results: SearchResult[]; totalCount: number }> {
    const limit = query.options?.limit || 20;
    const offset = query.options?.offset || 0;

    // Clean and prepare search query
    const searchTerms = this.prepareFullTextQuery(query.text);

    let articleQuery = `
      SELECT 
        a.id,
        a.title,
        a.description,
        ${query.options?.includeContent ? 'a.content,' : ''}
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
        a.language,
        a.sentiment_score,
        s.id as source_id,
        s.name as source_name,
        s.url as source_url,
        'article' as content_type,
        ts_rank(a.search_vector, plainto_tsquery('news_english', $1)) as fulltext_score,
        ts_headline('news_english', a.title, plainto_tsquery('news_english', $1), 'MaxWords=10, MinWords=1, ShortWord=3, HighlightAll=FALSE, MaxFragments=1') as title_highlight,
        ts_headline('news_english', a.description, plainto_tsquery('news_english', $1), 'MaxWords=20, MinWords=5, ShortWord=3, HighlightAll=FALSE, MaxFragments=2') as description_highlight
      FROM articles a
      JOIN news_sources s ON a.source_id = s.id
      WHERE a.deleted_at IS NULL 
        AND a.status = 'published'
        AND a.search_vector @@ plainto_tsquery('news_english', $1)
    `;

    let paperQuery = `
      SELECT 
        p.id,
        p.title,
        p.summary as description,
        ${query.options?.includeContent ? 'p.summary as content,' : ''}
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
        'en' as language,
        NULL as sentiment_score,
        NULL as source_id,
        'ArXiv' as source_name,
        'https://arxiv.org' as source_url,
        'arxiv_paper' as content_type,
        ts_rank(p.search_vector, plainto_tsquery('news_english', $1)) as fulltext_score,
        ts_headline('news_english', p.title, plainto_tsquery('news_english', $1), 'MaxWords=10, MinWords=1, ShortWord=3, HighlightAll=FALSE, MaxFragments=1') as title_highlight,
        ts_headline('news_english', p.summary, plainto_tsquery('news_english', $1), 'MaxWords=20, MinWords=5, ShortWord=3, HighlightAll=FALSE, MaxFragments=2') as description_highlight
      FROM arxiv_papers p
      WHERE p.search_vector @@ plainto_tsquery('news_english', $1)
    `;

    const queryParams = [searchTerms];
    let paramIndex = 2;

    // Apply filters
    const { articleQuery: filteredArticleQuery, paperQuery: filteredPaperQuery, params } = 
      this.applyFilters(articleQuery, paperQuery, query.filters || {}, queryParams, paramIndex);

    // Combine queries
    const combinedQuery = `
      WITH combined_results AS (
        ${filteredArticleQuery}
        UNION ALL
        ${filteredPaperQuery}
      )
      SELECT *
      FROM combined_results
      ORDER BY fulltext_score DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    params.push(limit, offset);

    // Execute search
    const results = await this.databaseService.query(combinedQuery, params);
    
    // Count total results
    const countQuery = `
      WITH combined_results AS (
        ${filteredArticleQuery}
        UNION ALL
        ${filteredPaperQuery}
      )
      SELECT COUNT(*) as total FROM combined_results
    `;

    const countResult = await this.databaseService.query(countQuery, params.slice(0, -2));
    const totalCount = parseInt(countResult[0]?.total || '0');

    // Transform results with highlighting
    const searchResults = results.map(row => this.transformToSearchResult(row, {
      fulltext: row.fulltext_score,
    }, {
      title: row.title_highlight,
      description: row.description_highlight,
    }));

    return { results: searchResults, totalCount };
  }

  /**
   * Perform hybrid search combining semantic and full-text search
   */
  private async performHybridSearch(query: SearchQuery): Promise<{ results: SearchResult[]; totalCount: number }> {
    const limit = query.options?.limit || 20;
    const offset = query.options?.offset || 0;

    // Get both semantic and full-text results
    const [semanticResults, fulltextResults] = await Promise.all([
      this.performSemanticSearch({ ...query, options: { ...query.options, limit: limit * 2 } }),
      this.performFullTextSearch({ ...query, options: { ...query.options, limit: limit * 2 } }),
    ]);

    // Combine and re-rank results
    const combinedResults = this.combineAndRerankResults(
      semanticResults.results,
      fulltextResults.results,
      query
    );

    // Apply pagination
    const paginatedResults = combinedResults.slice(offset, offset + limit);
    const totalCount = Math.max(semanticResults.totalCount, fulltextResults.totalCount);

    return { results: paginatedResults, totalCount };
  }

  /**
   * Combine and re-rank results from multiple search methods
   */
  private combineAndRerankResults(
    semanticResults: SearchResult[],
    fulltextResults: SearchResult[],
    query: SearchQuery
  ): SearchResult[] {
    const resultMap = new Map<string, SearchResult>();
    const weights = this.config.semantic.weightings;

    // Process semantic results
    for (const result of semanticResults) {
      resultMap.set(result.id, {
        ...result,
        scores: {
          ...result.scores,
          semantic: result.scores.semantic || 0,
        },
      });
    }

    // Process full-text results and merge
    for (const result of fulltextResults) {
      if (resultMap.has(result.id)) {
        const existing = resultMap.get(result.id)!;
        existing.scores.fulltext = result.scores.fulltext || 0;
        existing.highlighting = result.highlighting;
      } else {
        resultMap.set(result.id, {
          ...result,
          scores: {
            ...result.scores,
            fulltext: result.scores.fulltext || 0,
            semantic: 0,
          },
        });
      }
    }

    // Calculate combined scores and re-rank
    const combinedResults = Array.from(resultMap.values()).map(result => {
      const semanticScore = result.scores.semantic || 0;
      const fulltextScore = result.scores.fulltext || 0;
      const recencyScore = this.calculateRecencyScore(result.publishedAt);
      
      const combinedScore = 
        semanticScore * weights.semantic +
        fulltextScore * weights.fullText +
        recencyScore * weights.recency;

      return {
        ...result,
        scores: {
          ...result.scores,
          recency: recencyScore,
          combined: combinedScore,
        },
      };
    });

    // Sort by combined score
    return combinedResults.sort((a, b) => b.scores.combined - a.scores.combined);
  }

  /**
   * Apply filters to search queries
   */
  private applyFilters(
    articleQuery: string,
    paperQuery: string,
    filters: SearchQuery['filters'],
    params: any[],
    startIndex: number
  ): { articleQuery: string; paperQuery: string; params: any[] } {
    let paramIndex = startIndex;
    const newParams = [...params];

    // Category filter
    if (filters?.categories?.length) {
      articleQuery += ` AND a.category = ANY($${paramIndex})`;
      paperQuery += ` AND p.primary_category = ANY($${paramIndex})`;
      newParams.push(filters.categories);
      paramIndex++;
    }

    // Source filter (only applies to articles)
    if (filters?.sources?.length) {
      articleQuery += ` AND a.source_id = ANY($${paramIndex})`;
      newParams.push(filters.sources);
      paramIndex++;
    }

    // Date range filter
    if (filters?.dateRange) {
      articleQuery += ` AND a.published_at BETWEEN $${paramIndex} AND $${paramIndex + 1}`;
      paperQuery += ` AND p.published_at BETWEEN $${paramIndex} AND $${paramIndex + 1}`;
      newParams.push(filters.dateRange.start, filters.dateRange.end);
      paramIndex += 2;
    }

    // Quality threshold filter
    if (filters?.qualityThreshold !== undefined) {
      articleQuery += ` AND a.quality_score >= $${paramIndex}`;
      paperQuery += ` AND p.relevance_score >= $${paramIndex}`;
      newParams.push(filters.qualityThreshold);
      paramIndex++;
    }

    // Content types filter
    if (filters?.contentTypes?.length) {
      const includeArticles = filters.contentTypes.includes('article');
      const includePapers = filters.contentTypes.includes('arxiv_paper');
      
      if (!includeArticles) {
        articleQuery = 'SELECT NULL WHERE FALSE'; // Exclude articles
      }
      if (!includePapers) {
        paperQuery = 'SELECT NULL WHERE FALSE'; // Exclude papers
      }
    }

    // Tags filter (array overlap)
    if (filters?.tags?.length) {
      articleQuery += ` AND a.tags && $${paramIndex}`;
      paperQuery += ` AND p.tags && $${paramIndex}`;
      newParams.push(filters.tags);
      paramIndex++;
    }

    // Authors filter (for ArXiv papers)
    if (filters?.authors?.length) {
      paperQuery += ` AND EXISTS (
        SELECT 1 FROM unnest(p.authors) AS author 
        WHERE author = ANY($${paramIndex})
      )`;
      newParams.push(filters.authors);
      paramIndex++;
    }

    return { articleQuery, paperQuery, params: newParams };
  }

  /**
   * Transform database row to SearchResult
   */
  private transformToSearchResult(
    row: any,
    scores: { semantic?: number; fulltext?: number },
    highlighting?: { title?: string; description?: string; content?: string }
  ): SearchResult {
    const recencyScore = this.calculateRecencyScore(row.published_at);
    const popularityScore = this.calculatePopularityScore(row.view_count || 0);

    return {
      id: row.id,
      title: row.title,
      description: row.description,
      content: row.content,
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
        relevance: scores.semantic || scores.fulltext || 0,
        semantic: scores.semantic,
        fulltext: scores.fulltext,
        quality: (row.quality_score || 50) / 100,
        recency: recencyScore,
        popularity: popularityScore,
        combined: 0, // Will be calculated later
      },
      highlighting,
      metadata: {
        wordCount: row.word_count,
        readingTime: row.reading_time,
        language: row.language,
        sentiment: row.sentiment_score,
      },
    };
  }

  /**
   * Calculate recency score based on publication date
   */
  private calculateRecencyScore(publishedAt: Date): number {
    const now = new Date();
    const daysDiff = (now.getTime() - publishedAt.getTime()) / (1000 * 60 * 60 * 24);
    
    // Exponential decay with half-life of 30 days
    return Math.exp(-daysDiff / 30);
  }

  /**
   * Calculate popularity score based on view count
   */
  private calculatePopularityScore(viewCount: number): number {
    // Log scale normalization
    return Math.log10(viewCount + 1) / Math.log10(10000); // Assume max 10k views
  }

  /**
   * Determine optimal search type based on query characteristics
   */
  private determineOptimalSearchType(query: string): 'semantic' | 'fulltext' | 'hybrid' {
    const words = query.toLowerCase().split(/\s+/);
    
    // Use full-text for exact phrases or specific terms
    if (query.includes('"') || words.length <= 2) {
      return 'fulltext';
    }
    
    // Use semantic for conceptual queries
    if (words.length > 5 || this.containsConceptualTerms(query)) {
      return 'semantic';
    }
    
    // Default to hybrid
    return 'hybrid';
  }

  private containsConceptualTerms(query: string): boolean {
    const conceptualIndicators = [
      'similar to', 'like', 'about', 'related to', 'concerning',
      'regarding', 'topics', 'concepts', 'ideas', 'theory', 'approach'
    ];
    
    return conceptualIndicators.some(indicator => 
      query.toLowerCase().includes(indicator)
    );
  }

  /**
   * Expand query with synonyms and related terms
   */
  private async expandQuery(query: string): Promise<QueryExpansion> {
    try {
      // Extract key terms
      const keywords = this.extractKeywords(query);
      const synonyms: string[] = [];
      const relatedTerms: string[] = [];
      const conceptualTerms: string[] = [];

      // Get synonyms for each keyword
      for (const keyword of keywords) {
        const keywordSynonyms = await this.getSynonyms(keyword);
        synonyms.push(...keywordSynonyms);
      }

      // Use AI for conceptual expansion if available
      if (this.embeddingService && keywords.length > 0) {
        try {
          const expansionPrompt = `Generate 5 related terms for: ${keywords.join(', ')}`;
          // This would use the chat model to generate related terms
          // For now, we'll use a simplified approach
          const related = await this.generateRelatedTerms(keywords);
          relatedTerms.push(...related);
        } catch (error) {
          this.logger.debug('AI query expansion failed, using keyword-based expansion');
        }
      }

      return {
        synonyms: [...new Set(synonyms)], // Remove duplicates
        relatedTerms: [...new Set(relatedTerms)],
        conceptualTerms: [...new Set(conceptualTerms)],
      };

    } catch (error) {
      this.logger.error('Query expansion failed:', error);
      return { synonyms: [], relatedTerms: [], conceptualTerms: [] };
    }
  }

  /**
   * Extract keywords from query text
   */
  private extractKeywords(text: string): string[] {
    try {
      // Use keyword-extractor library
      const keywords = extractKeywords(text, {
        language: 'english',
        remove_digits: false,
        return_changed_case: true,
        remove_duplicates: true,
      });

      // Filter and process keywords
      const processedKeywords = keywords
        .filter(keyword => keyword.length > 2)
        .map(keyword => keyword.toLowerCase())
        .slice(0, 10); // Limit to top 10 keywords

      return processedKeywords;
    } catch (error) {
      this.logger.error('Keyword extraction failed:', error);
      return text.toLowerCase().split(/\s+/).filter(word => word.length > 2);
    }
  }

  /**
   * Get synonyms for a word (with caching)
   */
  private async getSynonyms(word: string): Promise<string[]> {
    if (this.synonymCache.has(word)) {
      return this.synonymCache.get(word)!;
    }

    try {
      // Simple synonym expansion using WordNet-like rules
      const synonyms = this.generateSimpleSynonyms(word);
      this.synonymCache.set(word, synonyms);
      return synonyms;
    } catch (error) {
      this.logger.debug(`Failed to get synonyms for "${word}":`, error);
      return [];
    }
  }

  private generateSimpleSynonyms(word: string): string[] {
    // Simple synonym mapping for common AI/tech terms
    const synonymMap: { [key: string]: string[] } = {
      'artificial intelligence': ['ai', 'machine intelligence', 'artificial neural networks'],
      'machine learning': ['ml', 'statistical learning', 'automated learning'],
      'deep learning': ['neural networks', 'deep neural networks', 'deep nets'],
      'natural language processing': ['nlp', 'text processing', 'language understanding'],
      'computer vision': ['image recognition', 'visual recognition', 'image processing'],
      'robotics': ['automation', 'autonomous systems', 'robotic systems'],
      'algorithm': ['method', 'procedure', 'technique', 'approach'],
      'model': ['system', 'framework', 'architecture', 'network'],
      'training': ['learning', 'optimization', 'fitting'],
      'prediction': ['inference', 'forecasting', 'estimation'],
    };

    const lowerWord = word.toLowerCase();
    return synonymMap[lowerWord] || [];
  }

  private async generateRelatedTerms(keywords: string[]): Promise<string[]> {
    // This is a simplified version. In a real implementation,
    // you would use the AI model to generate related terms
    const relatedMap: { [key: string]: string[] } = {
      'ai': ['automation', 'intelligence', 'cognitive'],
      'machine learning': ['supervised learning', 'unsupervised learning', 'reinforcement learning'],
      'neural': ['network', 'neuron', 'activation', 'backpropagation'],
      'data': ['dataset', 'information', 'analytics', 'statistics'],
      'algorithm': ['optimization', 'computation', 'processing'],
    };

    const related: string[] = [];
    for (const keyword of keywords) {
      const keywordRelated = relatedMap[keyword.toLowerCase()] || [];
      related.push(...keywordRelated);
    }

    return related.slice(0, 5); // Limit results
  }

  /**
   * Prepare full-text search query
   */
  private prepareFullTextQuery(query: string): string {
    // Remove special characters and normalize
    let cleanQuery = query
      .toLowerCase()
      .replace(/[^\w\s"]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Handle quoted phrases
    const phrases = cleanQuery.match(/"[^"]+"/g) || [];
    for (const phrase of phrases) {
      cleanQuery = cleanQuery.replace(phrase, phrase.replace(/"/g, ''));
    }

    return cleanQuery;
  }

  /**
   * Generate search suggestions based on query and results
   */
  private async generateSearchSuggestions(query: string, resultCount: number): Promise<string[]> {
    if (resultCount > 5) {
      return []; // Don't suggest if we have good results
    }

    const keywords = this.extractKeywords(query);
    const suggestions: string[] = [];

    // Get popular search terms from cache/database
    try {
      const popularQueries = await this.getPopularSearchQueries();
      
      // Find suggestions based on keyword overlap
      for (const popularQuery of popularQueries) {
        const popularKeywords = this.extractKeywords(popularQuery);
        const overlap = keywords.filter(k => popularKeywords.includes(k));
        
        if (overlap.length > 0 && popularQuery !== query) {
          suggestions.push(popularQuery);
        }
      }

      return suggestions.slice(0, 5);
    } catch (error) {
      this.logger.error('Failed to generate search suggestions:', error);
      return [];
    }
  }

  private async getPopularSearchQueries(): Promise<string[]> {
    // This would query your analytics database for popular search terms
    // For now, return some common AI/tech related queries
    return [
      'artificial intelligence trends',
      'machine learning algorithms',
      'deep learning applications',
      'neural network architectures',
      'natural language processing',
      'computer vision research',
      'robotics automation',
      'AI startups',
      'machine learning papers',
      'AI industry news',
    ];
  }

  /**
   * Generate aggregations for search results
   */
  private generateAggregations(results: SearchResult[]): SearchResponse['aggregations'] {
    const categories: { [key: string]: number } = {};
    const sources: { [key: string]: number } = {};
    const contentTypes: { [key: string]: number } = {};
    const timeDistribution: { [key: string]: number } = {};

    for (const result of results) {
      // Categories
      categories[result.category] = (categories[result.category] || 0) + 1;
      
      // Sources
      sources[result.source.name] = (sources[result.source.name] || 0) + 1;
      
      // Content types
      contentTypes[result.contentType] = (contentTypes[result.contentType] || 0) + 1;
      
      // Time distribution (by month)
      const monthKey = result.publishedAt.toISOString().substring(0, 7); // YYYY-MM
      timeDistribution[monthKey] = (timeDistribution[monthKey] || 0) + 1;
    }

    return {
      categories,
      sources,
      contentTypes,
      timeDistribution,
    };
  }

  /**
   * Generate cache key for search query
   */
  private generateCacheKey(query: SearchQuery): string {
    const crypto = require('crypto');
    const key = JSON.stringify({
      text: query.text,
      filters: query.filters,
      options: query.options,
    });
    return `search:${crypto.createHash('md5').update(key).digest('hex')}`;
  }

  /**
   * Track search metrics for analytics
   */
  private async trackSearchMetrics(metrics: {
    query: string;
    searchType: string;
    resultCount: number;
    searchTime: number;
    filters?: any;
  }): Promise<void> {
    try {
      const today = new Date().toISOString().split('T')[0];
      
      await Promise.all([
        this.databaseService.incrementCounter(`search_metrics:${today}:queries`, 1, 86400),
        this.databaseService.incrementCounter(`search_metrics:${today}:${metrics.searchType}`, 1, 86400),
        this.databaseService.incrementCounter(`search_metrics:${today}:total_results`, metrics.resultCount, 86400),
        this.databaseService.incrementCounter(`search_metrics:${today}:total_time`, metrics.searchTime, 86400),
      ]);

      // Store query for popularity analysis
      await this.databaseService.cacheSet(
        `recent_query:${Date.now()}:${Math.random()}`,
        { query: metrics.query, timestamp: new Date() },
        86400
      );
    } catch (error) {
      this.logger.error('Failed to track search metrics:', error);
    }
  }

  /**
   * Get search analytics and metrics
   */
  async getSearchMetrics(): Promise<{
    dailyQueries: number;
    avgResultCount: number;
    avgSearchTime: number;
    searchTypeBreakdown: { [key: string]: number };
    topQueries: string[];
  }> {
    try {
      const today = new Date().toISOString().split('T')[0];
      
      const [
        dailyQueries,
        totalResults,
        totalTime,
        semanticQueries,
        fulltextQueries,
        hybridQueries,
      ] = await Promise.all([
        this.databaseService.cacheGet(`search_metrics:${today}:queries`) || 0,
        this.databaseService.cacheGet(`search_metrics:${today}:total_results`) || 0,
        this.databaseService.cacheGet(`search_metrics:${today}:total_time`) || 0,
        this.databaseService.cacheGet(`search_metrics:${today}:semantic`) || 0,
        this.databaseService.cacheGet(`search_metrics:${today}:fulltext`) || 0,
        this.databaseService.cacheGet(`search_metrics:${today}:hybrid`) || 0,
      ]);

      const numQueries = Number(dailyQueries);

      return {
        dailyQueries: numQueries,
        avgResultCount: numQueries > 0 ? Number(totalResults) / numQueries : 0,
        avgSearchTime: numQueries > 0 ? Number(totalTime) / numQueries : 0,
        searchTypeBreakdown: {
          semantic: Number(semanticQueries),
          fulltext: Number(fulltextQueries),
          hybrid: Number(hybridQueries),
        },
        topQueries: await this.getPopularSearchQueries(),
      };
    } catch (error) {
      this.logger.error('Failed to get search metrics:', error);
      return {
        dailyQueries: 0,
        avgResultCount: 0,
        avgSearchTime: 0,
        searchTypeBreakdown: {},
        topQueries: [],
      };
    }
  }
}