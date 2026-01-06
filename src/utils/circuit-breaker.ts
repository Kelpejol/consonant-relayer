/**
 * @fileoverview Circuit Breaker Pattern Implementation
 * 
 * Prevents cascade failures by stopping calls to failing services.
 * 
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Service failing, reject requests immediately (fail-fast)
 * - HALF_OPEN: Testing if service recovered, allow limited requests
 * 
 * Flow:
 * 1. Start CLOSED
 * 2. Count failures
 * 3. If failures >= threshold → OPEN (stop all requests)
 * 4. After timeout → HALF_OPEN (test with 1 request)
 * 5. If success → CLOSED (resume normal)
 * 6. If failure → OPEN (back to waiting)
 * 
 * This prevents:
 * - Thundering herd (all requests retry simultaneously)
 * - Resource exhaustion (connections, memory)
 * - Cascade failures (one service takes down others)
 * 
 * @author Consonant Engineering
 * @version 1.0.0
 */

import { EventEmitter } from 'events';

import { createLogger } from './logger.js';
import { RelayerError, RelayerErrorCode } from '../types/index.js';

const logger = createLogger('circuit-breaker');

/**
 * Circuit breaker state
 */
export enum CircuitState {
  /** Normal operation - requests pass through */
  CLOSED = 'closed',
  
  /** Service failing - reject requests immediately */
  OPEN = 'open',
  
  /** Testing recovery - allow limited requests */
  HALF_OPEN = 'half-open',
}

/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerConfig {
  /** Number of failures before opening circuit */
  readonly failureThreshold: number;
  
  /** Number of successes before closing circuit (from half-open) */
  readonly successThreshold: number;
  
  /** Time to wait before attempting half-open (ms) */
  readonly timeout: number;
  
  /** Name for logging */
  readonly name: string;
}

/**
 * Circuit breaker events
 */
export interface CircuitBreakerEvents {
  stateChange: (state: CircuitState) => void;
  failure: (error: Error) => void;
  success: () => void;
}

/**
 * Circuit Breaker
 * 
 * Wraps a function and monitors its success/failure rate.
 * Opens circuit (fails fast) when error rate exceeds threshold.
 * 
 * @example
 * const breaker = new CircuitBreaker({
 *   name: 'backend-connection',
 *   failureThreshold: 5,
 *   successThreshold: 2,
 *   timeout: 60000,
 * });
 * 
 * const result = await breaker.execute(async () => {
 *   return await backend.send(message);
 * });
 */
export class CircuitBreaker extends EventEmitter {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private nextAttemptTime: number | null = null;
  
  constructor(private readonly config: CircuitBreakerConfig) {
    super();
    
    logger.debug(
      {
        name: config.name,
        failureThreshold: config.failureThreshold,
        successThreshold: config.successThreshold,
        timeout: config.timeout,
      },
      'Circuit breaker created'
    );
  }
  
  /**
   * Execute function with circuit breaker protection
   * 
   * @param fn - Async function to execute
   * @returns Function result
   * @throws {RelayerError} If circuit is open
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if circuit is open
    if (this.state === CircuitState.OPEN) {
      // Check if timeout has elapsed
      if (this.nextAttemptTime && Date.now() < this.nextAttemptTime) {
        // Still in timeout - reject immediately (fail-fast)
        const remainingMs = this.nextAttemptTime - Date.now();
        throw new RelayerError(
          RelayerErrorCode.INTERNAL_ERROR,
          `Circuit breaker open for ${this.config.name} (retry in ${Math.ceil(remainingMs / 1000)}s)`,
          {
            circuitName: this.config.name,
            state: this.state,
            remainingMs,
          }
        );
      }
      
      // Timeout elapsed - transition to half-open
      this.transitionTo(CircuitState.HALF_OPEN);
    }
    
    try {
      // Execute function
      const result = await fn();
      
      // Success!
      this.onSuccess();
      
      return result;
    } catch (error) {
      // Failure
      this.onFailure(error as Error);
      
      // Re-throw original error
      throw error;
    }
  }
  
  /**
   * Handle successful execution
   */
  private onSuccess(): void {
    this.emit('success');
    
    if (this.state === CircuitState.HALF_OPEN) {
      // In half-open, increment success counter
      this.successCount++;
      
      logger.debug(
        {
          name: this.config.name,
          successCount: this.successCount,
          threshold: this.config.successThreshold,
        },
        'Circuit breaker success in half-open'
      );
      
      // Check if we can close circuit
      if (this.successCount >= this.config.successThreshold) {
        this.transitionTo(CircuitState.CLOSED);
      }
    } else if (this.state === CircuitState.CLOSED) {
      // In closed, reset failure count on success
      if (this.failureCount > 0) {
        this.failureCount = 0;
      }
    }
  }
  
  /**
   * Handle failed execution
   */
  private onFailure(error: Error): void {
    this.emit('failure', error);
    
    if (this.state === CircuitState.HALF_OPEN) {
      // In half-open, any failure immediately opens circuit
      logger.warn(
        {
          name: this.config.name,
          error: error.message,
        },
        'Circuit breaker failed in half-open, reopening'
      );
      
      this.transitionTo(CircuitState.OPEN);
    } else if (this.state === CircuitState.CLOSED) {
      // In closed, increment failure counter
      this.failureCount++;
      
      logger.debug(
        {
          name: this.config.name,
          failureCount: this.failureCount,
          threshold: this.config.failureThreshold,
        },
        'Circuit breaker failure'
      );
      
      // Check if we should open circuit
      if (this.failureCount >= this.config.failureThreshold) {
        this.transitionTo(CircuitState.OPEN);
      }
    }
  }
  
  /**
   * Transition to new state
   */
  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;
    
    // Reset counters
    this.failureCount = 0;
    this.successCount = 0;
    
    // Set next attempt time if opening
    if (newState === CircuitState.OPEN) {
      this.nextAttemptTime = Date.now() + this.config.timeout;
      
      logger.warn(
        {
          name: this.config.name,
          oldState,
          newState,
          nextAttemptIn: this.config.timeout,
        },
        'Circuit breaker opened - failing fast'
      );
    } else {
      this.nextAttemptTime = null;
      
      logger.info(
        {
          name: this.config.name,
          oldState,
          newState,
        },
        'Circuit breaker state changed'
      );
    }
    
    this.emit('stateChange', newState);
  }
  
  /**
   * Get current state
   */
  getState(): CircuitState {
    return this.state;
  }
  
  /**
   * Get current metrics
   */
  getMetrics(): {
    state: CircuitState;
    failureCount: number;
    successCount: number;
    nextAttemptTime: number | null;
  } {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      nextAttemptTime: this.nextAttemptTime,
    };
  }
  
  /**
   * Force reset circuit to closed state
   * Use sparingly - only for manual intervention
   */
  reset(): void {
    logger.info({ name: this.config.name }, 'Circuit breaker manually reset');
    this.transitionTo(CircuitState.CLOSED);
  }
}