/**
 * @fileoverview Retry Logic with Exponential Backoff
 * 
 * Implements retry pattern with:
 * - Exponential backoff (delays grow: 1s, 2s, 4s, 8s, ...)
 * - Jitter (random variance to prevent thundering herd)
 * - Max attempts limit
 * - Max delay cap
 * 
 * Use cases:
 * - Transient network errors
 * - Service temporarily unavailable
 * - Rate limiting (429 responses)
 * - Database connection failures
 * 
 * Do NOT use for:
 * - 4xx errors (except 429) - these are client errors
 * - Invalid input - retrying won't help
 * - Authentication failures - need new credentials
 * - Circuit breaker OPEN - fail fast instead
 * 
 * @author Consonant Engineering
 * @version 1.0.0
 */

import pRetry, { AbortError } from 'p-retry';

import { createLogger } from './logger.js';

const logger = createLogger('retry');

/**
 * Retry configuration
 */
export interface RetryConfig {
  /** Maximum number of attempts (including initial) */
  readonly maxAttempts: number;
  
  /** Initial delay in milliseconds */
  readonly initialDelay: number;
  
  /** Maximum delay in milliseconds */
  readonly maxDelay: number;
  
  /** Backoff factor (2 = exponential doubling) */
  readonly factor: number;
  
  /** Random jitter (0-1, default 0.25 = ±25%) */
  readonly jitter: number;
  
  /** Operation name for logging */
  readonly operation: string;
}

/**
 * Default retry configuration
 * 
 * Delays: 1s, 2s, 4s (max 3 attempts)
 * With 25% jitter: actual delays vary ±250ms
 */
export const DEFAULT_RETRY_CONFIG: Omit<RetryConfig, 'operation'> = {
  maxAttempts: 3,
  initialDelay: 1000, // 1 second
  maxDelay: 30000, // 30 seconds
  factor: 2, // Exponential doubling
  jitter: 0.25, // ±25%
};

/**
 * Execute function with retry logic
 * 
 * Automatically retries on failure with exponential backoff.
 * Respects AbortError to stop retrying immediately.
 * 
 * @param fn - Async function to execute
 * @param config - Retry configuration
 * @returns Function result
 * @throws Final error if all retries exhausted
 * 
 * @example
 * const result = await retry(
 *   async () => {
 *     const res = await fetch('https://api.example.com/data');
 *     if (!res.ok) throw new Error('Request failed');
 *     return res.json();
 *   },
 *   { ...DEFAULT_RETRY_CONFIG, operation: 'fetch-data' }
 * );
 */
export async function retry<T>(
  fn: () => Promise<T>,
  config: RetryConfig
): Promise<T> {
  logger.debug(
    {
      operation: config.operation,
      maxAttempts: config.maxAttempts,
      initialDelay: config.initialDelay,
    },
    'Starting operation with retry'
  );
  
  try {
    return await pRetry(
      async (attemptNumber) => {
        logger.debug(
          {
            operation: config.operation,
            attempt: attemptNumber,
            maxAttempts: config.maxAttempts,
          },
          'Executing attempt'
        );
        
        try {
          const result = await fn();
          
          if (attemptNumber > 1) {
            logger.info(
              {
                operation: config.operation,
                attempt: attemptNumber,
              },
              'Operation succeeded after retry'
            );
          }
          
          return result;
        } catch (error) {
          const err = error as Error;
          
          // Check if we should stop retrying
          if (shouldNotRetry(err)) {
            logger.warn(
              {
                operation: config.operation,
                error: err.message,
              },
              'Error not retriable, aborting'
            );
            
            // Wrap in AbortError to stop p-retry
            throw new AbortError(err.message);
          }
          
          logger.warn(
            {
              operation: config.operation,
              attempt: attemptNumber,
              maxAttempts: config.maxAttempts,
              error: err.message,
            },
            'Attempt failed, will retry'
          );
          
          throw err;
        }
      },
      {
        retries: config.maxAttempts - 1, // p-retry counts retries, not attempts
        factor: config.factor,
        minTimeout: config.initialDelay,
        maxTimeout: config.maxDelay,
        randomize: true, // Add jitter
        
        onFailedAttempt: (error) => {
          logger.warn(
            {
              operation: config.operation,
              attempt: error.attemptNumber,
              attemptsLeft: error.retriesLeft,
              error: error.message,
            },
            'Retry attempt failed'
          );
        },
      }
    );
  } catch (error) {
    const err = error as Error;
    
    logger.error(
      {
        operation: config.operation,
        maxAttempts: config.maxAttempts,
        error: err.message,
      },
      'All retry attempts exhausted'
    );
    
    throw err;
  }
}

/**
 * Determine if error should NOT be retried
 * 
 * Don't retry:
 * - Client errors (4xx except 429)
 * - Authentication failures
 * - Invalid input
 * - Resource not found
 * 
 * @param error - Error to check
 * @returns True if should NOT retry
 */
function shouldNotRetry(error: Error): boolean {
  // Check for HTTP status codes in error
  const statusMatch = error.message.match(/status[:\s]+(\d{3})/i);
  if (statusMatch) {
    const status = parseInt(statusMatch[1] ?? '0', 10);
    
    // Don't retry client errors (except 429 Too Many Requests)
    if (status >= 400 && status < 500 && status !== 429) {
      return true;
    }
  }
  
  // Check for specific error types
  const message = error.message.toLowerCase();
  
  // Authentication/authorization errors
  if (
    message.includes('unauthorized') ||
    message.includes('forbidden') ||
    message.includes('authentication') ||
    message.includes('invalid token')
  ) {
    return true;
  }
  
  // Invalid input errors
  if (
    message.includes('invalid') ||
    message.includes('malformed') ||
    message.includes('bad request')
  ) {
    return true;
  }
  
  // Resource not found
  if (message.includes('not found') || message.includes('does not exist')) {
    return true;
  }
  
  // Circuit breaker open (should fail fast)
  if (message.includes('circuit breaker open')) {
    return true;
  }
  
  // Default: retry
  return false;
}

/**
 * Calculate exponential backoff delay
 * 
 * Formula: initialDelay * (factor ^ attempt) + jitter
 * 
 * @param attempt - Attempt number (0-indexed)
 * @param config - Retry configuration
 * @returns Delay in milliseconds
 * 
 * @example
 * calculateDelay(0, config); // ~1000ms (±250ms jitter)
 * calculateDelay(1, config); // ~2000ms (±500ms jitter)
 * calculateDelay(2, config); // ~4000ms (±1000ms jitter)
 */
export function calculateDelay(attempt: number, config: RetryConfig): number {
  // Exponential backoff: initialDelay * (factor ^ attempt)
  const exponentialDelay = config.initialDelay * Math.pow(config.factor, attempt);
  
  // Cap at maxDelay
  const cappedDelay = Math.min(exponentialDelay, config.maxDelay);
  
  // Add jitter: ±(jitter * delay)
  const jitterAmount = cappedDelay * config.jitter;
  const jitter = (Math.random() * 2 - 1) * jitterAmount; // Random between -jitterAmount and +jitterAmount
  
  return Math.max(0, cappedDelay + jitter);
}