# OpenRouter Integration

Comprehensive backend service for OpenRouter API integration with advanced features including model management, usage tracking, cost optimization, and content summarization.

## Features

### 🔧 Core Functionality

- **Multi-Model Support**: Integration with all OpenRouter models (GPT-4, Claude, Llama, etc.)
- **Dynamic Model Fetching**: Real-time model discovery and selection
- **Smart Model Recommendation**: AI-driven model selection based on task requirements
- **Fallback Handling**: Automatic fallback to alternative models on failure

### 🔐 Security & Settings

- **Encrypted API Key Storage**: Secure storage using AES encryption
- **User Preference Management**: Customizable model preferences and settings
- **Usage Quotas**: Configurable daily/monthly limits and rate limiting
- **Audit Logging**: Complete audit trail for API key operations

### 📊 Usage Tracking & Analytics

- **Real-time Usage Monitoring**: Track tokens, costs, and performance
- **Cost Management**: Automatic cost tracking and budget alerts
- **Performance Analytics**: Model performance metrics and optimization
- **Usage Statistics**: Detailed analytics by user, model, and time period

### 🚀 Content Summarization

- **Intelligent Summarization**: Advanced news article summarization
- **Batch Processing**: Handle multiple articles efficiently
- **Multiple Output Formats**: Bullet points, paragraphs, structured summaries
- **Quality Control**: Content validation and optimization

### ⚡ Performance & Scalability

- **Request Queuing**: Intelligent request queuing and rate limiting
- **Redis Caching**: High-performance caching for models and settings
- **Connection Pooling**: Optimized database and Redis connections
- **Health Monitoring**: Comprehensive service health checks

## API Endpoints

### Settings Management

```typescript
// Update user settings
POST /api/openrouter/settings
{
  "api_key_encrypted": "your-api-key",
  "preferred_models": {
    "summarization": "anthropic/claude-3-haiku",
    "chat": "openai/gpt-4o-mini",
    "fallback": "meta-llama/llama-3.1-8b-instruct:free"
  },
  "usage_limits": {
    "daily_cost_limit": 1.0,
    "monthly_cost_limit": 10.0,
    "requests_per_hour": 100,
    "tokens_per_hour": 50000
  },
  "preferences": {
    "temperature": 0.7,
    "max_tokens": 1000,
    "enable_streaming": false,
    "fallback_enabled": true,
    "cost_optimization": true
  }
}

// Get user settings
GET /api/openrouter/settings

// Delete user settings
DELETE /api/openrouter/settings
```

### Model Management

```typescript
// Get available models
GET /api/openrouter/models?cache=true

// Get specific model info
GET /api/openrouter/models/:modelId
```

### Content Summarization

```typescript
// Summarize articles
POST /api/openrouter/summarize
{
  "articles": [
    {
      "id": "article-1",
      "title": "Article Title",
      "content": "Article content...",
      "url": "https://example.com/article",
      "source": "News Source"
    }
  ],
  "options": {
    "model": "anthropic/claude-3-haiku", // optional
    "summary_length": "medium", // short|medium|long
    "summary_style": "paragraph", // bullet_points|paragraph|structured
    "language": "en",
    "include_key_points": true,
    "include_sentiment": true,
    "batch_processing": false
  }
}

// Get batch job status
GET /api/openrouter/jobs/:jobId
```

### Analytics & Monitoring

```typescript
// Get usage statistics
GET /api/openrouter/usage?period=daily // daily|weekly|monthly

// Check usage limits
GET /api/openrouter/limits

// Service health
GET /api/openrouter/health

// Admin endpoints
GET /api/openrouter/admin/connections
POST /api/openrouter/admin/emergency-stop
```

## Database Schema

### Core Tables

```sql
-- User settings with encrypted API keys
openrouter_settings (
  user_id, api_key_encrypted, preferred_models, 
  usage_limits, preferences, created_at, updated_at
)

-- Usage tracking for analytics and billing
openrouter_usage (
  id, user_id, model, prompt_tokens, completion_tokens, 
  total_tokens, cost, request_type, metadata, timestamp
)

-- Batch job management
batch_jobs (
  id, user_id, status, job_type, input_data, 
  output_data, progress, metadata, created_at, updated_at
)

-- Error logging and monitoring
openrouter_errors (
  id, user_id, error_type, error_message, 
  request_data, response_data, model_used, timestamp
)
```

### Performance Views

```sql
-- Usage analytics dashboard
usage_analytics
-- Model performance summary  
model_performance_summary
```

## Environment Configuration

```bash
# OpenRouter Configuration
OPENROUTER_API_KEY=your_openrouter_api_key
OPENROUTER_REFERER=https://yourdomain.com
OPENROUTER_TITLE=AI News Aggregator

# Encryption (IMPORTANT: Change in production)
ENCRYPTION_KEY=your_secure_encryption_key_change_in_production

# Database Configuration
DB_HOST=localhost
DB_PORT=5432
DB_NAME=ai_news_db
DB_USER=ai_news_user
DB_PASSWORD=secure_password_123

# Redis Configuration
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=your_redis_password
REDIS_DB=0
```

## Usage Examples

### Basic Setup

```typescript
import { initializeOpenRouterServices } from './services/openrouter';
import { pool } from './config/database';
import { redis } from './config/redis';

// Initialize services
const openRouterService = await initializeOpenRouterServices(pool, redis);

// Set up user
await openRouterService.initializeUser('user-123', 'openrouter-api-key');
```

### Summarize Articles

```typescript
const request = {
  articles: [
    {
      id: 'news-1',
      title: 'Breaking News: AI Breakthrough',
      content: 'Scientists have achieved a major breakthrough...',
      url: 'https://news.example.com/ai-breakthrough'
    }
  ],
  options: {
    summary_length: 'medium',
    summary_style: 'bullet_points',
    include_key_points: true,
    include_sentiment: true
  }
};

const result = await openRouterService.summarizeArticles('user-123', request);
console.log(result.summaries[0].summary);
```

### Monitor Usage

```typescript
// Check usage limits
const limits = await openRouterService.checkUserLimits('user-123');
if (!limits.within_limits) {
  console.log('User has exceeded limits:', limits);
}

// Get usage statistics
const stats = await openRouterService.getUserUsageStats('user-123', 'daily');
console.log(`Daily cost: $${stats.total_cost}`);
```

## Security Best Practices

### API Key Security

- API keys are encrypted using AES encryption before storage
- Keys are never returned in API responses
- Audit trail maintained for all key operations
- Automatic key rotation recommended

### Rate Limiting

- Per-user rate limiting based on configured limits
- Global rate limiting for system protection
- Intelligent queue management for burst handling
- Cost-based throttling to prevent budget overruns

### Input Validation

- Comprehensive request validation using express-validator
- Content length limits to prevent abuse
- SQL injection protection through parameterized queries
- XSS protection via input sanitization

## Monitoring & Alerting

### Health Checks

- Database connectivity monitoring
- Redis connectivity monitoring
- OpenRouter API availability
- Service performance metrics

### Real-time Alerts

- Rate limit warnings
- Cost budget alerts
- Service degradation notifications
- Emergency stop capabilities

### Performance Metrics

- Average response times
- Success/failure rates
- Cost per request tracking
- Model performance comparison

## Error Handling

### Graceful Degradation

- Automatic fallback to alternative models
- Queue-based retry mechanisms
- Circuit breaker patterns for failing services
- Comprehensive error logging

### Recovery Procedures

- Automatic service recovery
- Dead letter queues for failed requests
- Manual intervention capabilities
- Data consistency checks

## Scalability Considerations

### Database Optimization

- Proper indexing for analytics queries
- Connection pooling for high concurrency
- Partitioning for large usage tables
- Regular maintenance procedures

### Caching Strategy

- Redis caching for frequently accessed data
- Model information caching
- Settings caching with TTL
- Query result caching

### Load Balancing

- Horizontal scaling support
- Session affinity not required
- Stateless service design
- Queue-based processing

## Development Guidelines

### Code Structure

```
src/services/openrouter/
├── OpenRouterClient.ts      # HTTP client with rate limiting
├── SettingsService.ts       # User settings management
├── SummarizationService.ts  # Content summarization
├── OpenRouterService.ts     # Main orchestrator
└── index.ts                 # Module exports
```

### Testing Strategy

- Unit tests for individual services
- Integration tests for API endpoints
- Load testing for scalability
- Security testing for vulnerabilities

### Deployment

- Docker containerization
- Kubernetes deployment
- Environment-specific configurations
- Blue-green deployment support

## Troubleshooting

### Common Issues

1. **API Key Issues**
   - Verify encryption key is set
   - Check API key validity
   - Review audit logs

2. **Rate Limiting**
   - Check user limits configuration
   - Monitor queue status
   - Review OpenRouter account limits

3. **Performance Issues**
   - Check database connection pool
   - Monitor Redis performance
   - Review model selection logic

### Logging

Comprehensive logging is available at different levels:

- `DEBUG`: Detailed request/response logging
- `INFO`: Service status and operations
- `WARN`: Rate limits and degradation
- `ERROR`: Failures and exceptions

### Maintenance

Regular maintenance tasks:

- Clean up old usage records (90+ days)
- Update model cache (every 6 hours)
- Monitor storage usage
- Review security configurations

## Future Enhancements

- WebSocket real-time updates
- Advanced analytics dashboard
- Machine learning model recommendations
- Multi-tenant support
- Advanced caching strategies
- GraphQL API support