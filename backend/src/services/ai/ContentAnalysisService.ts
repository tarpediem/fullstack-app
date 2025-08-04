import OpenAI from 'openai';
import { Logger } from 'winston';
import { DatabaseService } from '../database/DatabaseService';
import { aiConfig, AIConfig } from '../../config/ai.config';
import * as natural from 'natural';
import { Sentiment } from 'sentiment';
import * as compromise from 'compromise';

export interface ContentAnalysisResult {
  contentId: string;
  contentType: 'article' | 'arxiv_paper';
  analysis: {
    summary?: {
      short: string; // 1-2 sentences
      medium: string; // 3-4 sentences
      long: string; // paragraph
      keyPoints: string[];
      method: 'extractive' | 'abstractive';
    };
    sentiment: {
      polarity: number; // -1 to 1
      subjectivity: number; // 0 to 1
      emotion?: {
        joy: number;
        sadness: number;
        anger: number;
        fear: number;
        surprise: number;
        trust: number;
        anticipation: number;
        disgust: number;
      };
      confidence: number;
    };
    quality: {
      overall: number; // 0 to 100
      readability: {
        score: number;
        level: 'elementary' | 'middle' | 'high' | 'college' | 'graduate';
        fleschKincaid: number;
        automated: number;
      };
      grammar: {
        score: number;
        errors: Array<{
          type: string;
          message: string;
          suggestion?: string;
          position: { start: number; end: number };
        }>;
      };
      factuality: {
        score: number;
        claims: Array<{
          claim: string;
          confidence: number;
          sources?: string[];
        }>;
        verifiability: number;
      };
      bias: {
        score: number; // 0 = neutral, higher = more biased
        type?: 'political' | 'commercial' | 'cultural' | 'confirmation';
        indicators: string[];
      };
      coherence: {
        score: number;
        structure: number;
        flow: number;
        consistency: number;
      };
    };
    metadata: {
      wordCount: number;
      sentenceCount: number;
      paragraphCount: number;
      avgWordsPerSentence: number;
      avgSyllablesPerWord: number;
      complexWordCount: number;
      readingTime: number; // minutes
      language: string;
      topics: Array<{
        topic: string;
        confidence: number;
        keywords: string[];
      }>;
      entities: Array<{
        text: string;
        type: 'PERSON' | 'ORGANIZATION' | 'LOCATION' | 'MISC';
        confidence: number;
      }>;
      keywords: Array<{
        word: string;
        score: number;
        frequency: number;
      }>;
    };
  };
  processingTime: number;
  timestamp: Date;
}

export interface BatchAnalysisResult {
  results: ContentAnalysisResult[];
  summary: {
    totalProcessed: number;
    successful: number;
    failed: number;
    avgProcessingTime: number;
    avgQualityScore: number;
    avgSentiment: number;
  };
  processingTime: number;
}

export class ContentAnalysisService {
  private openai: OpenAI | null = null;
  private sentimentAnalyzer: Sentiment;
  private isInitialized: boolean = false;
  private analysisCache: Map<string, ContentAnalysisResult> = new Map();

  constructor(
    private config: AIConfig,
    private logger: Logger,
    private databaseService: DatabaseService
  ) {
    this.sentimentAnalyzer = new Sentiment();
  }

  async initialize(): Promise<void> {
    try {
      await this.initializeOpenAI();
      this.setupCache();
      this.isInitialized = true;
      this.logger.info('ContentAnalysisService initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize ContentAnalysisService:', error);
      throw error;
    }
  }

  private async initializeOpenAI(): Promise<void> {
    if (!this.config.openai.apiKey) {
      this.logger.warn('OpenAI API key not provided, AI analysis will be limited');
      return;
    }

    try {
      this.openai = new OpenAI({
        apiKey: this.config.openai.apiKey,
        organization: this.config.openai.organization,
      });
      this.logger.info('OpenAI client initialized for content analysis');
    } catch (error) {
      this.logger.error('Failed to initialize OpenAI client for analysis:', error);
      this.openai = null;
    }
  }

  private setupCache(): void {
    // Clean cache every 2 hours
    setInterval(() => {
      const now = Date.now();
      const maxAge = 2 * 60 * 60 * 1000; // 2 hours
      
      for (const [key, result] of this.analysisCache.entries()) {
        if (now - result.timestamp.getTime() > maxAge) {
          this.analysisCache.delete(key);
        }
      }
    }, 2 * 60 * 60 * 1000);
  }

  /**
   * Analyze content comprehensively
   */
  async analyzeContent(
    contentId: string,
    contentType: 'article' | 'arxiv_paper',
    title: string,
    content: string,
    options?: {
      includesSummary?: boolean;
      includeSentiment?: boolean;
      includeQuality?: boolean;
      useCache?: boolean;
      analysisDepth?: 'basic' | 'standard' | 'comprehensive';
    }
  ): Promise<ContentAnalysisResult> {
    if (!this.isInitialized) {
      throw new Error('ContentAnalysisService not initialized');
    }

    const startTime = Date.now();
    const cacheKey = this.generateCacheKey(contentId, content);
    
    // Check cache
    if (options?.useCache !== false && this.analysisCache.has(cacheKey)) {
      const cached = this.analysisCache.get(cacheKey)!;
      this.logger.debug('Returning cached analysis result');
      return cached;
    }

    try {
      this.logger.info('Starting content analysis', {
        contentId,
        contentType,
        contentLength: content.length,
        depth: options?.analysisDepth || 'standard',
      });

      const fullText = `${title}\n\n${content}`;
      const analysisDepth = options?.analysisDepth || 'standard';

      // Run analysis components in parallel where possible
      const [
        summaryResult,
        sentimentResult,
        qualityResult,
        metadataResult,
      ] = await Promise.allSettled([
        options?.includesSummary !== false ? this.generateSummary(fullText, analysisDepth) : Promise.resolve(undefined),
        options?.includeSentiment !== false ? this.analyzeSentiment(fullText, analysisDepth) : Promise.resolve(undefined),
        options?.includeQuality !== false ? this.analyzeQuality(fullText, analysisDepth) : Promise.resolve(undefined),
        this.extractMetadata(fullText),
      ]);

      const result: ContentAnalysisResult = {
        contentId,
        contentType,
        analysis: {
          summary: summaryResult.status === 'fulfilled' ? summaryResult.value : undefined,
          sentiment: sentimentResult.status === 'fulfilled' ? sentimentResult.value! : this.getDefaultSentiment(),
          quality: qualityResult.status === 'fulfilled' ? qualityResult.value! : this.getDefaultQuality(),
          metadata: metadataResult.status === 'fulfilled' ? metadataResult.value : this.getDefaultMetadata(fullText),
        },
        processingTime: Date.now() - startTime,
        timestamp: new Date(),
      };

      // Cache result
      if (options?.useCache !== false) {
        this.analysisCache.set(cacheKey, result);
      }

      // Save to database
      await this.saveAnalysisResult(result);

      // Track metrics
      await this.trackAnalysisMetrics(result);

      this.logger.info('Content analysis completed', {
        contentId,
        processingTime: result.processingTime,
        qualityScore: result.analysis.quality.overall,
        sentiment: result.analysis.sentiment.polarity,
      });

      return result;

    } catch (error) {
      this.logger.error('Content analysis failed:', error);
      throw error;
    }
  }

  /**
   * Generate content summary using multiple methods
   */
  private async generateSummary(
    content: string,
    depth: 'basic' | 'standard' | 'comprehensive'
  ): Promise<ContentAnalysisResult['analysis']['summary']> {
    try {
      // Try AI-powered abstractive summarization first
      if (this.openai && depth !== 'basic') {
        const aiSummary = await this.generateAISummary(content);
        if (aiSummary) {
          return {
            ...aiSummary,
            method: 'abstractive' as const,
          };
        }
      }

      // Fallback to extractive summarization
      return this.generateExtractiveSummary(content);

    } catch (error) {
      this.logger.error('Summary generation failed:', error);
      return this.generateExtractiveSummary(content);
    }
  }

  private async generateAISummary(content: string): Promise<Omit<NonNullable<ContentAnalysisResult['analysis']['summary']>, 'method'> | null> {
    if (!this.openai) return null;

    try {
      const prompt = this.createSummaryPrompt(content);
      
      const response = await this.openai.chat.completions.create({
        model: this.config.openai.models.chat,
        messages: [
          {
            role: 'system',
            content: 'You are an expert content summarizer. Create accurate, concise summaries that capture the key points and maintain the original meaning.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.3,
        max_tokens: 800,
      });

      const aiResponse = response.choices[0]?.message?.content;
      if (!aiResponse) return null;

      return this.parseAISummaryResponse(aiResponse);

    } catch (error) {
      this.logger.error('AI summary generation failed:', error);
      return null;
    }
  }

  private createSummaryPrompt(content: string): string {
    return `
Please create summaries of the following content in three different lengths and extract key points:

Content to summarize:
"""
${content.substring(0, 4000)}${content.length > 4000 ? '...' : ''}
"""

Please respond in the following JSON format:
{
  "short": "1-2 sentence summary",
  "medium": "3-4 sentence summary", 
  "long": "Full paragraph summary",
  "keyPoints": ["key point 1", "key point 2", "key point 3", "key point 4", "key point 5"]
}

Requirements:
- Short: Essential information only, maximum 2 sentences
- Medium: Main points with some context, 3-4 sentences
- Long: Comprehensive summary in paragraph form
- Key points: 3-5 most important takeaways
- Maintain factual accuracy and original meaning
`;
  }

  private parseAISummaryResponse(response: string): Omit<NonNullable<ContentAnalysisResult['analysis']['summary']>, 'method'> | null {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      
      return {
        short: parsed.short || '',
        medium: parsed.medium || '',
        long: parsed.long || '',
        keyPoints: parsed.keyPoints || [],
      };
    } catch (error) {
      this.logger.error('Failed to parse AI summary response:', error);
      return null;
    }
  }

  private generateExtractiveSummary(content: string): NonNullable<ContentAnalysisResult['analysis']['summary']> {
    try {
      const sentences = this.extractSentences(content);
      const scoredSentences = this.scoreSentences(sentences, content);
      
      // Sort by score and select top sentences
      const topSentences = scoredSentences
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.min(5, Math.ceil(sentences.length * 0.3)));

      // Create summaries of different lengths
      const short = topSentences.slice(0, 2).map(s => s.sentence).join(' ');
      const medium = topSentences.slice(0, 4).map(s => s.sentence).join(' ');
      const long = topSentences.map(s => s.sentence).join(' ');

      // Extract key points
      const keyPoints = this.extractKeyPoints(content, 5);

      return {
        short,
        medium,
        long,
        keyPoints,
        method: 'extractive',
      };

    } catch (error) {
      this.logger.error('Extractive summarization failed:', error);
      return {
        short: content.substring(0, 200) + '...',
        medium: content.substring(0, 400) + '...',
        long: content.substring(0, 600) + '...',
        keyPoints: [],
        method: 'extractive',
      };
    }
  }

  private extractSentences(content: string): string[] {
    // Use compromise for better sentence detection
    const doc = compromise(content);
    return doc.sentences().out('array');
  }

  private scoreSentences(sentences: string[], fullContent: string): Array<{ sentence: string; score: number }> {
    const wordFreq = this.calculateWordFrequency(fullContent);
    const sentences_length = sentences.length;

    return sentences.map((sentence, index) => {
      let score = 0;
      const words = sentence.toLowerCase().split(/\s+/);
      
      // Word frequency score
      for (const word of words) {
        if (wordFreq[word]) {
          score += wordFreq[word];
        }
      }
      
      // Position score (early sentences get bonus)
      const positionScore = 1 - (index / sentences_length);
      score *= (1 + positionScore * 0.3);
      
      // Length penalty for very short/long sentences
      const idealLength = 20;
      const lengthPenalty = Math.abs(words.length - idealLength) / idealLength;
      score *= (1 - lengthPenalty * 0.2);
      
      return { sentence, score };
    });
  }

  private calculateWordFrequency(content: string): { [word: string]: number } {
    const words = content.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 3);

    const frequency: { [word: string]: number } = {};
    for (const word of words) {
      frequency[word] = (frequency[word] || 0) + 1;
    }

    // Normalize frequencies
    const maxFreq = Math.max(...Object.values(frequency));
    for (const word in frequency) {
      frequency[word] = frequency[word] / maxFreq;
    }

    return frequency;
  }

  private extractKeyPoints(content: string, count: number): string[] {
    try {
      const doc = compromise(content);
      
      // Extract important phrases and statements
      const keyPhrases: string[] = [];
      
      // Get sentences with strong indicators
      const sentences = doc.sentences().out('array');
      const indicators = [
        'important', 'significant', 'key', 'main', 'primary', 'crucial',
        'essential', 'fundamental', 'critical', 'major', 'breakthrough',
        'discovery', 'finding', 'result', 'conclusion', 'demonstrate'
      ];

      for (const sentence of sentences) {
        const lowerSentence = sentence.toLowerCase();
        if (indicators.some(indicator => lowerSentence.includes(indicator))) {
          keyPhrases.push(sentence);
        }
      }

      // If not enough, add sentences with numbers or proper nouns
      if (keyPhrases.length < count) {
        for (const sentence of sentences) {
          if (keyPhrases.includes(sentence)) continue;
          
          const hasNumbers = /\d/.test(sentence);
          const hasProperNouns = compromise(sentence).nouns().out('array').length > 0;
          
          if (hasNumbers || hasProperNouns) {
            keyPhrases.push(sentence);
          }
          
          if (keyPhrases.length >= count) break;
        }
      }

      return keyPhrases.slice(0, count);

    } catch (error) {
      this.logger.error('Key point extraction failed:', error);
      return [];
    }
  }

  /**
   * Analyze sentiment with multiple approaches
   */
  private async analyzeSentiment(
    content: string,
    depth: 'basic' | 'standard' | 'comprehensive'
  ): Promise<ContentAnalysisResult['analysis']['sentiment']> {
    try {
      // Basic sentiment analysis using the sentiment library
      const basicSentiment = this.sentimentAnalyzer.analyze(content);
      
      let polarity = Math.max(-1, Math.min(1, basicSentiment.score / 10)); // Normalize to -1 to 1
      let subjectivity = 0.5; // Default subjectivity
      let confidence = Math.abs(polarity);
      let emotion: ContentAnalysisResult['analysis']['sentiment']['emotion'] | undefined;

      // Enhanced analysis for standard and comprehensive modes
      if (depth !== 'basic') {
        const enhancedSentiment = await this.analyzeEnhancedSentiment(content);
        if (enhancedSentiment) {
          polarity = enhancedSentiment.polarity;
          subjectivity = enhancedSentiment.subjectivity;
          confidence = enhancedSentiment.confidence;
          
          if (depth === 'comprehensive') {
            emotion = enhancedSentiment.emotion;
          }
        }
      }

      return {
        polarity,
        subjectivity,
        emotion,
        confidence,
      };

    } catch (error) {
      this.logger.error('Sentiment analysis failed:', error);
      return this.getDefaultSentiment();
    }
  }

  private async analyzeEnhancedSentiment(content: string): Promise<{
    polarity: number;
    subjectivity: number;
    confidence: number;
    emotion?: ContentAnalysisResult['analysis']['sentiment']['emotion'];
  } | null> {
    try {
      // Use natural language processing for better sentiment analysis
      const sentences = this.extractSentences(content);
      const sentiments = sentences.map(sentence => this.sentimentAnalyzer.analyze(sentence));
      
      // Calculate weighted average
      let totalScore = 0;
      let totalWeight = 0;
      let subjectivitySum = 0;
      
      for (const sentiment of sentiments) {
        const weight = Math.abs(sentiment.score) + 1; // Weight by strength
        totalScore += sentiment.score * weight;
        totalWeight += weight;
        
        // Estimate subjectivity based on emotional words
        const emotionalWords = sentiment.positive.concat(sentiment.negative);
        subjectivitySum += emotionalWords.length / sentence.split(' ').length;
      }
      
      const polarity = Math.max(-1, Math.min(1, totalScore / (totalWeight * 5))); // Normalize
      const subjectivity = Math.min(1, subjectivitySum / sentences.length);
      const confidence = Math.abs(polarity) * (1 - Math.abs(0.5 - subjectivity)); // More confident when less neutral
      
      // Basic emotion detection
      const emotion = this.detectEmotions(content);
      
      return {
        polarity,
        subjectivity,
        confidence,
        emotion,
      };

    } catch (error) {
      this.logger.error('Enhanced sentiment analysis failed:', error);
      return null;
    }
  }

  private detectEmotions(content: string): ContentAnalysisResult['analysis']['sentiment']['emotion'] {
    const emotionKeywords = {
      joy: ['happy', 'excited', 'pleased', 'delighted', 'thrilled', 'optimistic', 'successful', 'achievement'],
      sadness: ['sad', 'disappointed', 'unfortunate', 'tragic', 'loss', 'decline', 'failure', 'setback'],
      anger: ['angry', 'frustrated', 'outraged', 'furious', 'criticism', 'controversy', 'dispute', 'conflict'],
      fear: ['worried', 'concerned', 'afraid', 'anxious', 'threat', 'risk', 'danger', 'uncertainty'],
      surprise: ['surprising', 'unexpected', 'shocking', 'amazing', 'breakthrough', 'unprecedented', 'sudden'],
      trust: ['reliable', 'trustworthy', 'credible', 'proven', 'established', 'confident', 'secure'],
      anticipation: ['upcoming', 'future', 'expected', 'planned', 'anticipate', 'forecast', 'potential'],
      disgust: ['disgusting', 'appalling', 'terrible', 'awful', 'horrible', 'unacceptable', 'outrageous'],
    };

    const lowerContent = content.toLowerCase();
    const emotion: ContentAnalysisResult['analysis']['sentiment']['emotion'] = {
      joy: 0,
      sadness: 0,
      anger: 0,
      fear: 0,
      surprise: 0,
      trust: 0,
      anticipation: 0,
      disgust: 0,
    };

    for (const [emotionType, keywords] of Object.entries(emotionKeywords)) {
      let score = 0;
      for (const keyword of keywords) {
        const regex = new RegExp(`\\b${keyword}\\b`, 'g');
        const matches = lowerContent.match(regex);
        if (matches) {
          score += matches.length;
        }
      }
      emotion[emotionType as keyof typeof emotion] = Math.min(1, score / 10); // Normalize
    }

    return emotion;
  }

  /**
   * Analyze content quality across multiple dimensions
   */
  private async analyzeQuality(
    content: string,
    depth: 'basic' | 'standard' | 'comprehensive'
  ): Promise<ContentAnalysisResult['analysis']['quality']> {
    try {
      const readability = this.analyzeReadability(content);
      const grammar = depth !== 'basic' ? this.analyzeGrammar(content) : this.getDefaultGrammar();
      const factuality = depth === 'comprehensive' ? await this.analyzeFactuality(content) : this.getDefaultFactuality();
      const bias = depth !== 'basic' ? this.analyzeBias(content) : this.getDefaultBias();
      const coherence = this.analyzeCoherence(content);

      // Calculate overall quality score
      const overall = Math.round(
        readability.score * 0.25 +
        grammar.score * 0.20 +
        factuality.score * 0.25 +
        (100 - bias.score) * 0.15 + // Lower bias = higher quality
        coherence.score * 0.15
      );

      return {
        overall,
        readability,
        grammar,
        factuality,
        bias,
        coherence,
      };

    } catch (error) {
      this.logger.error('Quality analysis failed:', error);
      return this.getDefaultQuality();
    }
  }

  private analyzeReadability(content: string): ContentAnalysisResult['analysis']['quality']['readability'] {
    try {
      const sentences = this.extractSentences(content);
      const words = content.split(/\s+/);
      const syllables = this.countSyllables(content);
      
      // Flesch-Kincaid Grade Level
      const avgSentenceLength = words.length / sentences.length;
      const avgSyllablesPerWord = syllables / words.length;
      const fleschKincaid = 0.39 * avgSentenceLength + 11.8 * avgSyllablesPerWord - 15.59;
      
      // Automated Readability Index
      const avgWordsPerSentence = words.length / sentences.length;
      const avgCharsPerWord = content.replace(/\s/g, '').length / words.length;
      const automated = 4.71 * avgCharsPerWord + 0.5 * avgWordsPerSentence - 21.43;
      
      // Overall readability score (inverted because lower grade level = higher readability)
      const score = Math.max(0, Math.min(100, 100 - fleschKincaid * 5));
      
      // Determine reading level
      let level: ContentAnalysisResult['analysis']['quality']['readability']['level'];
      if (fleschKincaid <= 6) level = 'elementary';
      else if (fleschKincaid <= 9) level = 'middle';
      else if (fleschKincaid <= 13) level = 'high';
      else if (fleschKincaid <= 16) level = 'college';
      else level = 'graduate';

      return {
        score,
        level,
        fleschKincaid,
        automated,
      };

    } catch (error) {
      this.logger.error('Readability analysis failed:', error);
      return {
        score: 50,
        level: 'college',
        fleschKincaid: 12,
        automated: 12,
      };
    }
  }

  private countSyllables(text: string): number {
    // Simple syllable counting algorithm
    const words = text.toLowerCase().match(/\b[a-z']+\b/g) || [];
    let totalSyllables = 0;

    for (const word of words) {
      // Remove silent e
      let cleanWord = word.replace(/e$/, '');
      if (cleanWord.length === 0) cleanWord = word;

      // Count vowel groups
      const vowelGroups = cleanWord.match(/[aeiouy]+/g);
      const syllableCount = vowelGroups ? vowelGroups.length : 1;
      
      totalSyllables += Math.max(1, syllableCount);
    }

    return totalSyllables;
  }

  private analyzeGrammar(content: string): ContentAnalysisResult['analysis']['quality']['grammar'] {
    try {
      const doc = compromise(content);
      const errors: ContentAnalysisResult['analysis']['quality']['grammar']['errors'] = [];
      
      // Basic grammar checks using compromise
      const sentences = doc.sentences().out('array');
      let errorCount = 0;

      for (let i = 0; i < sentences.length; i++) {
        const sentence = sentences[i];
        const sentenceDoc = compromise(sentence);
        
        // Check for basic issues
        // 1. Sentence should start with capital letter
        if (!/^[A-Z]/.test(sentence.trim())) {
          errors.push({
            type: 'capitalization',
            message: 'Sentence should start with a capital letter',
            position: { start: 0, end: 1 },
          });
          errorCount++;
        }
        
        // 2. Sentence should end with punctuation
        if (!/[.!?]$/.test(sentence.trim())) {
          errors.push({
            type: 'punctuation',
            message: 'Sentence should end with proper punctuation',
            position: { start: sentence.length - 1, end: sentence.length },
          });
          errorCount++;
        }
        
        // 3. Check for very long sentences (> 40 words)
        const wordCount = sentence.split(/\s+/).length;
        if (wordCount > 40) {
          errors.push({
            type: 'sentence_length',
            message: 'Sentence is very long and may be hard to read',
            suggestion: 'Consider breaking into shorter sentences',
            position: { start: 0, end: sentence.length },
          });
          errorCount++;
        }
      }

      // Calculate grammar score (percentage of sentences without errors)
      const score = Math.max(0, 100 - (errorCount / sentences.length) * 20);

      return {
        score,
        errors: errors.slice(0, 10), // Limit to first 10 errors
      };

    } catch (error) {
      this.logger.error('Grammar analysis failed:', error);
      return this.getDefaultGrammar();
    }
  }

  private async analyzeFactuality(content: string): Promise<ContentAnalysisResult['analysis']['quality']['factuality']> {
    try {
      // Extract claims and statements
      const claims = this.extractClaims(content);
      const verifiability = this.assessVerifiability(content);
      
      // In a real implementation, you would check facts against databases
      // For now, we'll use heuristics
      let score = 70; // Base score
      
      // Penalize if too many unverifiable claims
      if (verifiability < 0.3) score -= 20;
      if (verifiability < 0.1) score -= 30;
      
      // Bonus for citing sources
      const hasReferences = /\b(according to|study|research|report|source)\b/gi.test(content);
      if (hasReferences) score += 15;
      
      return {
        score: Math.max(0, Math.min(100, score)),
        claims,
        verifiability,
      };

    } catch (error) {
      this.logger.error('Factuality analysis failed:', error);
      return this.getDefaultFactuality();
    }
  }

  private extractClaims(content: string): ContentAnalysisResult['analysis']['quality']['factuality']['claims'] {
    const doc = compromise(content);
    const sentences = doc.sentences().out('array');
    const claims: ContentAnalysisResult['analysis']['quality']['factuality']['claims'] = [];

    // Look for declarative statements with factual indicators
    const factualIndicators = [
      'is', 'are', 'was', 'were', 'has', 'have', 'shows', 'demonstrates',
      'found', 'discovered', 'proves', 'indicates', 'reveals', 'according'
    ];

    for (const sentence of sentences) {
      const lowerSentence = sentence.toLowerCase();
      const hasFactualIndicator = factualIndicators.some(indicator => 
        lowerSentence.includes(indicator)
      );

      if (hasFactualIndicator && sentence.length > 20) {
        claims.push({
          claim: sentence,
          confidence: 0.7, // Default confidence
        });
      }
    }

    return claims.slice(0, 5); // Limit to top 5 claims
  }

  private assessVerifiability(content: string): number {
    // Look for indicators of verifiable content
    const verifiableIndicators = [
      'study', 'research', 'report', 'survey', 'data', 'statistics',
      'according to', 'source', 'published', 'journal', 'university',
      'expert', 'scientist', 'researcher', 'analysis', 'findings'
    ];

    const lowerContent = content.toLowerCase();
    let verifiableScore = 0;

    for (const indicator of verifiableIndicators) {
      const regex = new RegExp(`\\b${indicator}\\b`, 'g');
      const matches = lowerContent.match(regex);
      if (matches) {
        verifiableScore += matches.length;
      }
    }

    // Normalize based on content length
    const wordsCount = content.split(/\s+/).length;
    return Math.min(1, verifiableScore / (wordsCount * 0.01));
  }

  private analyzeBias(content: string): ContentAnalysisResult['analysis']['quality']['bias'] {
    try {
      const lowerContent = content.toLowerCase();
      let biasScore = 0;
      const indicators: string[] = [];
      let biasType: ContentAnalysisResult['analysis']['quality']['bias']['type'] | undefined;

      // Political bias indicators
      const politicalWords = [
        'liberal', 'conservative', 'left-wing', 'right-wing', 'democrat', 'republican',
        'progressive', 'traditional', 'radical', 'extreme'
      ];
      
      const politicalCount = this.countWordOccurrences(lowerContent, politicalWords);
      if (politicalCount > 2) {
        biasScore += politicalCount * 5;
        indicators.push('political language');
        biasType = 'political';
      }

      // Commercial bias indicators
      const commercialWords = [
        'best', 'amazing', 'incredible', 'revolutionary', 'game-changing',
        'must-have', 'breakthrough', 'perfect', 'ultimate', 'superior'
      ];
      
      const commercialCount = this.countWordOccurrences(lowerContent, commercialWords);
      if (commercialCount > 3) {
        biasScore += commercialCount * 3;
        indicators.push('promotional language');
        if (!biasType) biasType = 'commercial';
      }

      // Emotional bias indicators
      const emotionalWords = [
        'outrageous', 'shocking', 'unbelievable', 'devastating', 'horrific',
        'brilliant', 'genius', 'stupid', 'ridiculous', 'absurd'
      ];
      
      const emotionalCount = this.countWordOccurrences(lowerContent, emotionalWords);
      if (emotionalCount > 2) {
        biasScore += emotionalCount * 4;
        indicators.push('emotional language');
      }

      // Absolute statements (potential confirmation bias)
      const absoluteWords = [
        'always', 'never', 'all', 'none', 'every', 'completely', 'totally',
        'absolutely', 'definitely', 'certainly', 'obviously', 'clearly'
      ];
      
      const absoluteCount = this.countWordOccurrences(lowerContent, absoluteWords);
      if (absoluteCount > 5) {
        biasScore += absoluteCount * 2;
        indicators.push('absolute statements');
        if (!biasType) biasType = 'confirmation';
      }

      return {
        score: Math.min(100, biasScore),
        type: biasType,
        indicators,
      };

    } catch (error) {
      this.logger.error('Bias analysis failed:', error);
      return this.getDefaultBias();
    }
  }

  private countWordOccurrences(content: string, words: string[]): number {
    let count = 0;
    for (const word of words) {
      const regex = new RegExp(`\\b${word}\\b`, 'g');
      const matches = content.match(regex);
      if (matches) count += matches.length;
    }
    return count;
  }

  private analyzeCoherence(content: string): ContentAnalysisResult['analysis']['quality']['coherence'] {
    try {
      const sentences = this.extractSentences(content);
      const paragraphs = content.split(/\n\s*\n/).filter(p => p.trim().length > 0);
      
      // Structure score (well-formed paragraphs)
      const avgSentencesPerParagraph = sentences.length / Math.max(paragraphs.length, 1);
      const structureScore = Math.min(100, avgSentencesPerParagraph * 20);
      
      // Flow score (transitional phrases and logical connections)
      const transitionWords = [
        'however', 'therefore', 'furthermore', 'moreover', 'additionally',
        'consequently', 'meanwhile', 'similarly', 'in contrast', 'on the other hand',
        'for example', 'in fact', 'indeed', 'specifically', 'particularly'
      ];
      
      const transitionCount = this.countWordOccurrences(content.toLowerCase(), transitionWords);
      const flowScore = Math.min(100, (transitionCount / sentences.length) * 1000);
      
      // Consistency score (consistent terminology and tone)
      const consistencyScore = this.analyzeTerminologyConsistency(content);
      
      // Overall coherence
      const score = Math.round((structureScore + flowScore + consistencyScore) / 3);

      return {
        score,
        structure: structureScore,
        flow: flowScore,
        consistency: consistencyScore,
      };

    } catch (error) {
      this.logger.error('Coherence analysis failed:', error);
      return {
        score: 50,
        structure: 50,
        flow: 50,
        consistency: 50,
      };
    }
  }

  private analyzeTerminologyConsistency(content: string): number {
    // Simple consistency check based on repeated key terms
    const words = content.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
    const wordFreq: { [word: string]: number } = {};
    
    for (const word of words) {
      wordFreq[word] = (wordFreq[word] || 0) + 1;
    }
    
    // Count words that appear multiple times (indicating consistent terminology)
    const consistentTerms = Object.values(wordFreq).filter(freq => freq > 1).length;
    const totalUniqueTerms = Object.keys(wordFreq).length;
    
    return Math.min(100, (consistentTerms / Math.max(totalUniqueTerms, 1)) * 200);
  }

  /**
   * Extract comprehensive metadata from content
   */
  private extractMetadata(content: string): ContentAnalysisResult['analysis']['metadata'] {
    try {
      const doc = compromise(content);
      const words = content.split(/\s+/);
      const sentences = this.extractSentences(content);
      const paragraphs = content.split(/\n\s*\n/).filter(p => p.trim().length > 0);

      // Basic statistics
      const wordCount = words.length;
      const sentenceCount = sentences.length;
      const paragraphCount = paragraphs.length;
      const avgWordsPerSentence = wordCount / Math.max(sentenceCount, 1);
      const avgSyllablesPerWord = this.countSyllables(content) / wordCount;
      
      // Complex words (3+ syllables)
      const complexWordCount = words.filter(word => 
        this.countSyllables(word) >= 3
      ).length;
      
      // Reading time (200 words per minute)
      const readingTime = Math.ceil(wordCount / 200);

      // Language detection (simplified)
      const language = 'en'; // Would implement proper language detection

      // Extract topics using keyword analysis
      const topics = this.extractTopics(content);

      // Extract entities using compromise
      const entities = this.extractEntities(doc);

      // Extract keywords with scoring
      const keywords = this.extractScoredKeywords(content);

      return {
        wordCount,
        sentenceCount,
        paragraphCount,
        avgWordsPerSentence,
        avgSyllablesPerWord,
        complexWordCount,
        readingTime,
        language,
        topics,
        entities,
        keywords,
      };

    } catch (error) {
      this.logger.error('Metadata extraction failed:', error);
      return this.getDefaultMetadata(content);
    }
  }

  private extractTopics(content: string): ContentAnalysisResult['analysis']['metadata']['topics'] {
    // Topic modeling using keyword clustering
    const keywords = this.extractScoredKeywords(content);
    const topics: ContentAnalysisResult['analysis']['metadata']['topics'] = [];

    // AI/Tech topics
    const aiKeywords = keywords.filter(k => 
      ['ai', 'artificial', 'intelligence', 'machine', 'learning', 'neural', 'network', 'deep'].includes(k.word.toLowerCase())
    );
    
    if (aiKeywords.length > 0) {
      topics.push({
        topic: 'Artificial Intelligence',
        confidence: Math.min(1, aiKeywords.reduce((sum, k) => sum + k.score, 0)),
        keywords: aiKeywords.map(k => k.word),
      });
    }

    // Add more topic categories as needed
    const techKeywords = keywords.filter(k => 
      ['technology', 'software', 'hardware', 'computing', 'digital', 'cyber'].includes(k.word.toLowerCase())
    );
    
    if (techKeywords.length > 0) {
      topics.push({
        topic: 'Technology',
        confidence: Math.min(1, techKeywords.reduce((sum, k) => sum + k.score, 0)),
        keywords: techKeywords.map(k => k.word),
      });
    }

    return topics.slice(0, 5); // Limit to top 5 topics
  }

  private extractEntities(doc: any): ContentAnalysisResult['analysis']['metadata']['entities'] {
    try {
      const entities: ContentAnalysisResult['analysis']['metadata']['entities'] = [];

      // Extract people
      const people = doc.people().out('array');
      for (const person of people.slice(0, 10)) {
        entities.push({
          text: person,
          type: 'PERSON',
          confidence: 0.8,
        });
      }

      // Extract organizations
      const organizations = doc.organizations().out('array');
      for (const org of organizations.slice(0, 10)) {
        entities.push({
          text: org,
          type: 'ORGANIZATION',
          confidence: 0.8,
        });
      }

      // Extract places
      const places = doc.places().out('array');
      for (const place of places.slice(0, 10)) {
        entities.push({
          text: place,
          type: 'LOCATION',
          confidence: 0.8,
        });
      }

      return entities;

    } catch (error) {
      this.logger.error('Entity extraction failed:', error);
      return [];
    }
  }

  private extractScoredKeywords(content: string): ContentAnalysisResult['analysis']['metadata']['keywords'] {
    const wordFreq = this.calculateWordFrequency(content);
    const keywords: ContentAnalysisResult['analysis']['metadata']['keywords'] = [];

    for (const [word, frequency] of Object.entries(wordFreq)) {
      // Skip common words and short words
      if (word.length < 4 || this.isStopWord(word)) continue;

      const score = frequency;
      keywords.push({
        word,
        score,
        frequency: Math.round(frequency * 100),
      });
    }

    return keywords
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
  }

  private isStopWord(word: string): boolean {
    const stopWords = new Set([
      'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'man', 'new', 'now', 'old', 'see', 'two', 'way', 'who', 'boy', 'did', 'its', 'let', 'put', 'say', 'she', 'too', 'use'
    ]);
    return stopWords.has(word.toLowerCase());
  }

  /**
   * Batch analyze multiple content pieces
   */
  async batchAnalyzeContent(
    contents: Array<{
      contentId: string;
      contentType: 'article' | 'arxiv_paper';
      title: string;
      content: string;
    }>,
    options?: {
      maxConcurrency?: number;
      analysisDepth?: 'basic' | 'standard' | 'comprehensive';
      useCache?: boolean;
    }
  ): Promise<BatchAnalysisResult> {
    const startTime = Date.now();
    const maxConcurrency = options?.maxConcurrency || this.config.processing.maxConcurrency;
    
    this.logger.info('Starting batch content analysis', {
      totalItems: contents.length,
      depth: options?.analysisDepth || 'standard',
      maxConcurrency,
    });

    const semaphore = new Semaphore(maxConcurrency);
    const results = await Promise.allSettled(
      contents.map(async (item) => {
        await semaphore.acquire();
        
        try {
          return await this.analyzeContent(
            item.contentId,
            item.contentType,
            item.title,
            item.content,
            { ...options, useCache: options?.useCache }
          );
        } finally {
          semaphore.release();
        }
      })
    );

    const successful = results
      .filter((result): result is PromiseFulfilledResult<ContentAnalysisResult> => 
        result.status === 'fulfilled'
      )
      .map(result => result.value);

    const failed = results.length - successful.length;
    const processingTime = Date.now() - startTime;

    const summary = {
      totalProcessed: contents.length,
      successful: successful.length,
      failed,
      avgProcessingTime: successful.length > 0 ? 
        successful.reduce((sum, r) => sum + r.processingTime, 0) / successful.length : 0,
      avgQualityScore: successful.length > 0 ? 
        successful.reduce((sum, r) => sum + r.analysis.quality.overall, 0) / successful.length : 0,
      avgSentiment: successful.length > 0 ? 
        successful.reduce((sum, r) => sum + r.analysis.sentiment.polarity, 0) / successful.length : 0,
    };

    this.logger.info('Batch content analysis completed', {
      ...summary,
      totalProcessingTime: processingTime,
    });

    return {
      results: successful,
      summary,
      processingTime,
    };
  }

  // Default/fallback methods
  private getDefaultSentiment(): ContentAnalysisResult['analysis']['sentiment'] {
    return {
      polarity: 0,
      subjectivity: 0.5,
      confidence: 0.3,
    };
  }

  private getDefaultQuality(): ContentAnalysisResult['analysis']['quality'] {
    return {
      overall: 50,
      readability: {
        score: 50,
        level: 'college',
        fleschKincaid: 12,
        automated: 12,
      },
      grammar: this.getDefaultGrammar(),
      factuality: this.getDefaultFactuality(),
      bias: this.getDefaultBias(),
      coherence: {
        score: 50,
        structure: 50,
        flow: 50,
        consistency: 50,
      },
    };
  }

  private getDefaultGrammar(): ContentAnalysisResult['analysis']['quality']['grammar'] {
    return {
      score: 70,
      errors: [],
    };
  }

  private getDefaultFactuality(): ContentAnalysisResult['analysis']['quality']['factuality'] {
    return {
      score: 60,
      claims: [],
      verifiability: 0.5,
    };
  }

  private getDefaultBias(): ContentAnalysisResult['analysis']['quality']['bias'] {
    return {
      score: 20,
      indicators: [],
    };
  }

  private getDefaultMetadata(content: string): ContentAnalysisResult['analysis']['metadata'] {
    const words = content.split(/\s+/);
    return {
      wordCount: words.length,
      sentenceCount: Math.ceil(words.length / 15),
      paragraphCount: Math.ceil(words.length / 100),
      avgWordsPerSentence: 15,
      avgSyllablesPerWord: 1.5,
      complexWordCount: Math.ceil(words.length * 0.1),
      readingTime: Math.ceil(words.length / 200),
      language: 'en',
      topics: [],
      entities: [],
      keywords: [],
    };
  }

  // Utility methods
  private generateCacheKey(contentId: string, content: string): string {
    const crypto = require('crypto');
    return `analysis:${contentId}:${crypto.createHash('md5').update(content).digest('hex')}`;
  }

  private async saveAnalysisResult(result: ContentAnalysisResult): Promise<void> {
    try {
      const query = `
        INSERT INTO content_quality_analysis (
          id, article_id, readability_score, grammar_score, 
          factual_accuracy_score, bias_score, issues, suggestions,
          analyzer_version, analyzed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (article_id) DO UPDATE SET
          readability_score = $3,
          grammar_score = $4,
          factual_accuracy_score = $5,
          bias_score = $6,
          issues = $7,
          suggestions = $8,
          analyzer_version = $9,
          analyzed_at = $10
      `;

      const issues = result.analysis.quality.grammar.errors.map(e => e.message);
      const suggestions = result.analysis.quality.grammar.errors
        .filter(e => e.suggestion)
        .map(e => e.suggestion);

      await this.databaseService.query(query, [
        require('uuid').v4(),
        result.contentId,
        result.analysis.quality.readability.score,
        result.analysis.quality.grammar.score,
        result.analysis.quality.factuality.score,
        result.analysis.quality.bias.score,
        JSON.stringify(issues),
        JSON.stringify(suggestions),
        '1.0.0',
        new Date(),
      ]);

      // Update main article/paper table with summary data
      if (result.contentType === 'article') {
        await this.databaseService.query(
          `UPDATE articles SET 
             quality_score = $2, 
             sentiment_score = $3,
             updated_at = NOW() 
           WHERE id = $1`,
          [result.contentId, result.analysis.quality.overall, result.analysis.sentiment.polarity]
        );
      } else {
        await this.databaseService.query(
          `UPDATE arxiv_papers SET 
             relevance_score = $2,
             updated_at = NOW() 
           WHERE id = $1`,
          [result.contentId, result.analysis.quality.overall]
        );
      }

    } catch (error) {
      this.logger.error('Failed to save analysis result:', error);
    }
  }

  private async trackAnalysisMetrics(result: ContentAnalysisResult): Promise<void> {
    try {
      const today = new Date().toISOString().split('T')[0];
      
      await Promise.all([
        this.databaseService.incrementCounter(`analysis_metrics:${today}:total`, 1, 86400),
        this.databaseService.incrementCounter(`analysis_metrics:${today}:processing_time`, result.processingTime, 86400),
        this.databaseService.incrementCounter(`analysis_metrics:${today}:quality_score`, result.analysis.quality.overall, 86400),
        this.databaseService.incrementCounter(`analysis_metrics:${today}:sentiment`, Math.abs(result.analysis.sentiment.polarity), 86400),
        this.databaseService.incrementCounter(`analysis_metrics:${today}:${result.contentType}`, 1, 86400),
      ]);
    } catch (error) {
      this.logger.error('Failed to track analysis metrics:', error);
    }
  }

  /**
   * Get analysis metrics and performance stats
   */
  async getAnalysisMetrics(): Promise<{
    dailyAnalyses: number;
    avgProcessingTime: number;
    avgQualityScore: number;
    avgSentimentScore: number;
    contentTypeBreakdown: { [type: string]: number };
  }> {
    try {
      const today = new Date().toISOString().split('T')[0];
      
      const [
        dailyAnalyses,
        totalProcessingTime,
        totalQualityScore,
        totalSentimentScore,
        articleCount,
        paperCount,
      ] = await Promise.all([
        this.databaseService.cacheGet(`analysis_metrics:${today}:total`) || 0,
        this.databaseService.cacheGet(`analysis_metrics:${today}:processing_time`) || 0,
        this.databaseService.cacheGet(`analysis_metrics:${today}:quality_score`) || 0,
        this.databaseService.cacheGet(`analysis_metrics:${today}:sentiment`) || 0,
        this.databaseService.cacheGet(`analysis_metrics:${today}:article`) || 0,
        this.databaseService.cacheGet(`analysis_metrics:${today}:arxiv_paper`) || 0,
      ]);

      const analyses = Number(dailyAnalyses);

      return {
        dailyAnalyses: analyses,
        avgProcessingTime: analyses > 0 ? Number(totalProcessingTime) / analyses : 0,
        avgQualityScore: analyses > 0 ? Number(totalQualityScore) / analyses : 0,
        avgSentimentScore: analyses > 0 ? Number(totalSentimentScore) / analyses : 0,
        contentTypeBreakdown: {
          article: Number(articleCount),
          arxiv_paper: Number(paperCount),
        },
      };
    } catch (error) {
      this.logger.error('Failed to get analysis metrics:', error);
      return {
        dailyAnalyses: 0,
        avgProcessingTime: 0,
        avgQualityScore: 0,
        avgSentimentScore: 0,
        contentTypeBreakdown: {},
      };
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