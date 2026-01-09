/**
 * Kagent A2A (Agent-to-Agent) Client
 * 
 * This module provides:
 * - HTTP client for Kagent A2A API
 * - Agent invocation via message/send endpoint
 * - Circuit breaker for fault tolerance
 * - Retry logic with exponential backoff
 * - Timeout handling
 */

import { fetch } from 'undici';
import type { Config } from '../config/config.js';
import { logger, createComponentLogger, logError } from '../utils/logger.js';

// ===========================================================================
// TYPES
// ===========================================================================

export interface SendMessageRequest {
  message: string;
  parameters?: Record<string, any>;
}

export interface SendMessageResponse {
  response: string;
  metadata?: Record<string, any>;
}

export interface AgentCard {
  name: string;
  version: string;
  description?: string;
  capabilities?: string[];
  [key: string]: any;
}

// ===========================================================================
// CIRCUIT BREAKER
// ===========================================================================

enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private lastFailureTime = 0;
  private readonly failureThreshold = 5;
  private readonly resetTimeout = 60000; // 60 seconds

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      // Check if we should try again (half-open)
      if (Date.now() - this.lastFailureTime > this.resetTimeout) {
        this.state = CircuitState.HALF_OPEN;
        logger.info('Circuit breaker transitioning to HALF_OPEN');
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }

    try {
      const result = await fn();
      
      // Success - reset if half-open or reduce failure count
      if (this.state === CircuitState.HALF_OPEN) {
        this.state = CircuitState.CLOSED;
        this.failureCount = 0;
        logger.info('Circuit breaker closed after successful attempt');
      } else if (this.failureCount > 0) {
        this.failureCount--;
      }

      return result;
    } catch (error) {
      this.failureCount++;
      this.lastFailureTime = Date.now();

      // Open circuit if threshold reached
      if (this.failureCount >= this.failureThreshold) {
        this.state = CircuitState.OPEN;
        logger.warn(
          { failures: this.failureCount },
          'Circuit breaker opened due to repeated failures'
        );
      }

      throw error;
    }
  }

  getState(): CircuitState {
    return this.state;
  }
}

// ===========================================================================
// KAGENT A2A CLIENT
// ===========================================================================

export class KagentA2AClient {
  private readonly log = createComponentLogger('KagentA2AClient');
  private readonly baseUrl: string;
  private readonly circuitBreaker = new CircuitBreaker();

  constructor(private readonly config: Config) {
    this.baseUrl = config.kagent.serviceUrl;
    this.log.info({ baseUrl: this.baseUrl }, 'Kagent A2A client initialized');
  }

  // -------------------------------------------------------------------------
  // AGENT INVOCATION
  // -------------------------------------------------------------------------

  /**
   * Send a message to an agent via A2A API
   */
  async sendMessage(
    namespace: string,
    agentName: string,
    message: string,
    parameters?: Record<string, any>
  ): Promise<string> {
    this.log.info({ namespace, agentName }, 'Sending message to agent');

    const url = `${this.baseUrl}/api/a2a/${namespace}/${agentName}/message/send`;

    const request: SendMessageRequest = {
      message,
      parameters: parameters || {},
    };

    try {
      const response = await this.circuitBreaker.execute(() =>
        this.executeWithRetry(async () => {
          const fetchResponse = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(request),
            signal: AbortSignal.timeout(this.config.kagent.timeout),
          });

          if (!fetchResponse.ok) {
            const errorText = await fetchResponse.text();
            throw new Error(
              `Kagent A2A API error: ${fetchResponse.status} ${fetchResponse.statusText} - ${errorText}`
            );
          }

          return fetchResponse.json();
        })
      );

      const data = response as SendMessageResponse;

      this.log.info({ namespace, agentName }, 'Agent invoked successfully');

      return data.response || data.metadata?.response || '';
    } catch (error) {
      logError(error, {
        namespace,
        agentName,
        operation: 'send message',
        circuitState: this.circuitBreaker.getState(),
      });
      throw error;
    }
  }

  /**
   * Get agent card (metadata)
   */
  async getAgentCard(namespace: string, agentName: string): Promise<AgentCard> {
    this.log.debug({ namespace, agentName }, 'Getting agent card');

    const url = `${this.baseUrl}/api/a2a/${namespace}/${agentName}/.well-known/agent.json`;

    try {
      const response = await this.circuitBreaker.execute(() =>
        this.executeWithRetry(async () => {
          const fetchResponse = await fetch(url, {
            method: 'GET',
            headers: {
              'Accept': 'application/json',
            },
            signal: AbortSignal.timeout(this.config.kagent.timeout),
          });

          if (!fetchResponse.ok) {
            throw new Error(
              `Failed to get agent card: ${fetchResponse.status} ${fetchResponse.statusText}`
            );
          }

          return fetchResponse.json();
        })
      );

      this.log.debug({ namespace, agentName }, 'Got agent card');

      return response as AgentCard;
    } catch (error) {
      logError(error, {
        namespace,
        agentName,
        operation: 'get agent card',
      });
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // RETRY LOGIC
  // -------------------------------------------------------------------------

  private async executeWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    const maxRetries = this.config.kagent.maxRetries;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;

        // Don't retry on last attempt
        if (attempt === maxRetries) {
          break;
        }

        // Don't retry on 4xx errors (client errors)
        if (error instanceof Error && error.message.includes('4')) {
          break;
        }

        // Calculate backoff delay
        const delay = this.calculateBackoffDelay(attempt);

        this.log.warn(
          { attempt, maxRetries, delay },
          `Request failed, retrying in ${delay}ms`
        );

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError || new Error('Request failed after retries');
  }

  private calculateBackoffDelay(attempt: number): number {
    // Exponential backoff: 100ms, 200ms, 400ms, 800ms, ...
    const baseDelay = 100;
    const delay = baseDelay * Math.pow(2, attempt);
    
    // Add jitter (±20%)
    const jitter = delay * 0.2 * (Math.random() * 2 - 1);
    
    return Math.floor(delay + jitter);
  }

  // -------------------------------------------------------------------------
  // HEALTH CHECK
  // -------------------------------------------------------------------------

  /**
   * Check if Kagent service is reachable
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });

      return response.ok;
    } catch (error) {
      this.log.warn('Kagent health check failed');
      return false;
    }
  }

  /**
   * Get circuit breaker state
   */
  getCircuitState(): string {
    return this.circuitBreaker.getState();
  }
}