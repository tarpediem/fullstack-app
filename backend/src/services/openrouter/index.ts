/**
 * OpenRouter Service Module
 * Main export and initialization for OpenRouter services
 */

import { Pool } from 'pg';
import Redis from 'ioredis';
import { OpenRouterService } from './OpenRouterService';
import { setOpenRouterService } from '../../controllers/openrouter.controller';
import { logger } from '../../utils/logger';

let openRouterServiceInstance: OpenRouterService | null = null;

/**
 * Initialize OpenRouter services
 */
export async function initializeOpenRouterServices(db: Pool, redis: Redis): Promise<OpenRouterService> {
  try {
    if (openRouterServiceInstance) {
      return openRouterServiceInstance;
    }

    logger.info('Initializing OpenRouter services...');

    // Create service instance
    openRouterServiceInstance = new OpenRouterService(db, redis);

    // Set up event listeners for monitoring
    setupEventListeners(openRouterServiceInstance);

    // Set the service instance in the controller
    setOpenRouterService(openRouterServiceInstance);

    // Perform initial health check
    const healthStatus = await openRouterServiceInstance.updateHealthStatus();
    logger.info('OpenRouter services initialized', { 
      status: healthStatus.status,
      checks: healthStatus.checks
    });

    return openRouterServiceInstance;

  } catch (error) {
    logger.error('Failed to initialize OpenRouter services', error);
    throw new Error('OpenRouter service initialization failed');
  }
}

/**
 * Get the OpenRouter service instance
 */
export function getOpenRouterService(): OpenRouterService {
  if (!openRouterServiceInstance) {
    throw new Error('OpenRouter service not initialized. Call initializeOpenRouterServices first.');
  }
  return openRouterServiceInstance;
}

/**
 * Shutdown OpenRouter services gracefully
 */
export async function shutdownOpenRouterServices(): Promise<void> {
  if (openRouterServiceInstance) {
    await openRouterServiceInstance.shutdown();
    openRouterServiceInstance = null;
    logger.info('OpenRouter services shut down successfully');
  }
}

/**
 * Set up event listeners for service monitoring
 */
function setupEventListeners(service: OpenRouterService): void {
  // Rate limit warnings
  service.on('rateLimitWarning', (info) => {
    logger.warn('OpenRouter rate limit warning', info);
    
    // Could emit to WebSocket clients here for real-time updates
    // webSocketService.broadcast('rateLimitWarning', info);
  });

  // Cost alerts
  service.on('costAlert', (info) => {
    logger.warn('OpenRouter cost alert', info);
    
    // Could send email notifications here
    // emailService.sendCostAlert(info);
  });

  // Emergency stops
  service.on('emergencyStop', () => {
    logger.error('OpenRouter emergency stop triggered');
    
    // Could notify administrators
    // alertingService.sendEmergencyAlert();
  });

  // Error events
  service.on('error', (error) => {
    logger.error('OpenRouter service error', error);
  });

  logger.info('OpenRouter event listeners configured');
}

/**
 * Health check for the OpenRouter service
 */
export async function checkOpenRouterHealth(): Promise<boolean> {
  try {
    if (!openRouterServiceInstance) {
      return false;
    }

    const health = openRouterServiceInstance.getHealthStatus();
    return health.status === 'healthy';
  } catch (error) {
    logger.error('OpenRouter health check failed', error);
    return false;
  }
}

// Export the service classes for direct use if needed
export { OpenRouterService } from './OpenRouterService';
export { OpenRouterClient } from './OpenRouterClient';
export { SettingsService } from './SettingsService';
export { SummarizationService } from './SummarizationService';

// Export types
export * from '../../types/openrouter';