import { config } from 'dotenv';

// Load environment variables
config();

export interface AIConfig {
  openai: {
    apiKey: string;
    organization?: string;
    baseURL?: string;
    models: {
      text: string;
      chat: string;
      dimensions: number;
    };
    batch: {
      size: number;
      maxTokens: number;
    };
    rateLimit: {
      requestsPerMinute: number;
      tokensPerMinute: number;
    };
  };
  huggingface: {
    apiKey?: string;
    models: {
      embedding: string;
      classification: string;
      sentiment: string;
    };
  };
  tensorflow: {
    modelPath: string;
    enableGPU: boolean;
    memoryLimit: number;
  };
  processing: {
    batchSize: number;
    maxConcurrency: number;
    timeout: number;
    retryAttempts: number;
  };
  semantic: {
    similarityThreshold: number;
    maxResults: number;
    enableHybridSearch: boolean;
    weightings: {
      semantic: number;
      fullText: number;
      recency: number;
    };
  };
  categorization: {
    confidenceThreshold: number;
    maxCategories: number;
    enableMultiLabel: boolean;
    fallbackToKeywords: boolean;
  };
  sentiment: {
    enableAdvanced: boolean;
    languages: string[];
    aspectBased: boolean;
  };
  recommendations: {
    maxRecommendations: number;
    diversityFactor: number;
    recencyWeight: number;
    popularityWeight: number;
    personalityWeight: number;
    coldStartThreshold: number;
  };
  trending: {
    timeWindows: {
      shortTerm: number; // minutes
      mediumTerm: number; // hours  
      longTerm: number; // days
    };
    minMentions: number;
    trendingThreshold: number;
    decayFactor: number;
  };
  quality: {
    minLength: number;
    maxLength: number;
    readabilityWeight: number;
    grammarWeight: number;
    factsWeight: number;
    biasWeight: number;
  };
  duplicate: {
    similarityThreshold: number;
    contentHashEnabled: boolean;
    embeddingEnabled: boolean;
    titleWeight: number;
    contentWeight: number;
  };
}

export const aiConfig: AIConfig = {
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    organization: process.env.OPENAI_ORGANIZATION,
    baseURL: process.env.OPENAI_BASE_URL,
    models: {
      text: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
      chat: process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini',
      dimensions: parseInt(process.env.EMBEDDING_DIMENSIONS || '1536'),
    },
    batch: {
      size: parseInt(process.env.OPENAI_BATCH_SIZE || '50'),
      maxTokens: parseInt(process.env.OPENAI_MAX_TOKENS || '100000'),
    },
    rateLimit: {
      requestsPerMinute: parseInt(process.env.OPENAI_RPM || '3000'),
      tokensPerMinute: parseInt(process.env.OPENAI_TPM || '1000000'),
    },
  },
  huggingface: {
    apiKey: process.env.HUGGINGFACE_API_KEY,
    models: {
      embedding: 'sentence-transformers/all-MiniLM-L6-v2',
      classification: 'microsoft/DialoGPT-medium',
      sentiment: 'cardiffnlp/twitter-roberta-base-sentiment-latest',
    },
  },
  tensorflow: {
    modelPath: process.env.TF_MODEL_PATH || './models',
    enableGPU: process.env.TF_ENABLE_GPU === 'true',
    memoryLimit: parseInt(process.env.TF_MEMORY_LIMIT || '2048'),
  },
  processing: {
    batchSize: parseInt(process.env.AI_BATCH_SIZE || '25'),
    maxConcurrency: parseInt(process.env.AI_MAX_CONCURRENCY || '5'),
    timeout: parseInt(process.env.AI_TIMEOUT || '30000'),
    retryAttempts: parseInt(process.env.AI_RETRY_ATTEMPTS || '3'),
  },
  semantic: {
    similarityThreshold: parseFloat(process.env.SIMILARITY_THRESHOLD || '0.7'),
    maxResults: parseInt(process.env.MAX_SEARCH_RESULTS || '50'),
    enableHybridSearch: process.env.ENABLE_HYBRID_SEARCH !== 'false',
    weightings: {
      semantic: parseFloat(process.env.SEMANTIC_WEIGHT || '0.6'),
      fullText: parseFloat(process.env.FULLTEXT_WEIGHT || '0.3'),
      recency: parseFloat(process.env.RECENCY_WEIGHT || '0.1'),
    },
  },
  categorization: {
    confidenceThreshold: parseFloat(process.env.CATEGORIZATION_THRESHOLD || '0.6'),
    maxCategories: parseInt(process.env.MAX_CATEGORIES || '3'),
    enableMultiLabel: process.env.ENABLE_MULTI_LABEL !== 'false',
    fallbackToKeywords: process.env.FALLBACK_TO_KEYWORDS !== 'false',
  },
  sentiment: {
    enableAdvanced: process.env.ENABLE_ADVANCED_SENTIMENT === 'true',
    languages: (process.env.SENTIMENT_LANGUAGES || 'en,es,fr,de').split(','),
    aspectBased: process.env.ASPECT_BASED_SENTIMENT === 'true',
  },
  recommendations: {
    maxRecommendations: parseInt(process.env.MAX_RECOMMENDATIONS || '20'),
    diversityFactor: parseFloat(process.env.DIVERSITY_FACTOR || '0.3'),
    recencyWeight: parseFloat(process.env.RECENCY_WEIGHT || '0.2'),
    popularityWeight: parseFloat(process.env.POPULARITY_WEIGHT || '0.2'),
    personalityWeight: parseFloat(process.env.PERSONALITY_WEIGHT || '0.6'),
    coldStartThreshold: parseInt(process.env.COLD_START_THRESHOLD || '5'),
  },
  trending: {
    timeWindows: {
      shortTerm: parseInt(process.env.TRENDING_SHORT_TERM || '60'), // 1 hour
      mediumTerm: parseInt(process.env.TRENDING_MEDIUM_TERM || '24'), // 24 hours
      longTerm: parseInt(process.env.TRENDING_LONG_TERM || '7'), // 7 days
    },
    minMentions: parseInt(process.env.TRENDING_MIN_MENTIONS || '5'),
    trendingThreshold: parseFloat(process.env.TRENDING_THRESHOLD || '2.0'),
    decayFactor: parseFloat(process.env.TRENDING_DECAY_FACTOR || '0.9'),
  },
  quality: {
    minLength: parseInt(process.env.QUALITY_MIN_LENGTH || '100'),
    maxLength: parseInt(process.env.QUALITY_MAX_LENGTH || '50000'),
    readabilityWeight: parseFloat(process.env.READABILITY_WEIGHT || '0.3'),
    grammarWeight: parseFloat(process.env.GRAMMAR_WEIGHT || '0.2'),
    factsWeight: parseFloat(process.env.FACTS_WEIGHT || '0.3'),
    biasWeight: parseFloat(process.env.BIAS_WEIGHT || '0.2'),
  },
  duplicate: {
    similarityThreshold: parseFloat(process.env.DUPLICATE_THRESHOLD || '0.85'),
    contentHashEnabled: process.env.CONTENT_HASH_ENABLED !== 'false',
    embeddingEnabled: process.env.EMBEDDING_DUPLICATE_ENABLED !== 'false',
    titleWeight: parseFloat(process.env.TITLE_WEIGHT || '0.4'),
    contentWeight: parseFloat(process.env.CONTENT_WEIGHT || '0.6'),
  },
};

// Validation
export function validateAIConfig(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Validate OpenAI configuration
  if (!aiConfig.openai.apiKey) {
    errors.push('OPENAI_API_KEY is required');
  }

  if (aiConfig.openai.models.dimensions <= 0) {
    errors.push('EMBEDDING_DIMENSIONS must be greater than 0');
  }

  // Validate processing configuration
  if (aiConfig.processing.batchSize <= 0) {
    errors.push('AI_BATCH_SIZE must be greater than 0');
  }

  if (aiConfig.processing.maxConcurrency <= 0) {
    errors.push('AI_MAX_CONCURRENCY must be greater than 0');
  }

  // Validate semantic search weights
  const totalWeight = aiConfig.semantic.weightings.semantic + 
                     aiConfig.semantic.weightings.fullText + 
                     aiConfig.semantic.weightings.recency;
  
  if (Math.abs(totalWeight - 1.0) > 0.01) {
    errors.push('Semantic search weightings must sum to 1.0');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// Environment template for .env file
export const envTemplate = `
# AI/ML Configuration
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_ORGANIZATION=your_openai_org_id (optional)
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_CHAT_MODEL=gpt-4o-mini
EMBEDDING_DIMENSIONS=1536
OPENAI_BATCH_SIZE=50
OPENAI_MAX_TOKENS=100000
OPENAI_RPM=3000
OPENAI_TPM=1000000

# Hugging Face (optional, for fallback models)
HUGGINGFACE_API_KEY=your_huggingface_token (optional)

# TensorFlow (optional, for local models)
TF_MODEL_PATH=./models
TF_ENABLE_GPU=false
TF_MEMORY_LIMIT=2048

# Processing Configuration
AI_BATCH_SIZE=25
AI_MAX_CONCURRENCY=5
AI_TIMEOUT=30000
AI_RETRY_ATTEMPTS=3

# Semantic Search
SIMILARITY_THRESHOLD=0.7
MAX_SEARCH_RESULTS=50
ENABLE_HYBRID_SEARCH=true
SEMANTIC_WEIGHT=0.6
FULLTEXT_WEIGHT=0.3
RECENCY_WEIGHT=0.1

# Content Categorization
CATEGORIZATION_THRESHOLD=0.6
MAX_CATEGORIES=3
ENABLE_MULTI_LABEL=true
FALLBACK_TO_KEYWORDS=true

# Sentiment Analysis
ENABLE_ADVANCED_SENTIMENT=false
SENTIMENT_LANGUAGES=en,es,fr,de
ASPECT_BASED_SENTIMENT=false

# Recommendations
MAX_RECOMMENDATIONS=20
DIVERSITY_FACTOR=0.3
RECENCY_WEIGHT=0.2
POPULARITY_WEIGHT=0.2
PERSONALITY_WEIGHT=0.6
COLD_START_THRESHOLD=5

# Trending Topics
TRENDING_SHORT_TERM=60
TRENDING_MEDIUM_TERM=24
TRENDING_LONG_TERM=7
TRENDING_MIN_MENTIONS=5
TRENDING_THRESHOLD=2.0
TRENDING_DECAY_FACTOR=0.9

# Quality Analysis
QUALITY_MIN_LENGTH=100
QUALITY_MAX_LENGTH=50000
READABILITY_WEIGHT=0.3
GRAMMAR_WEIGHT=0.2
FACTS_WEIGHT=0.3
BIAS_WEIGHT=0.2

# Duplicate Detection
DUPLICATE_THRESHOLD=0.85
CONTENT_HASH_ENABLED=true
EMBEDDING_DUPLICATE_ENABLED=true
TITLE_WEIGHT=0.4
CONTENT_WEIGHT=0.6
`;