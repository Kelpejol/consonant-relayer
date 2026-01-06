/**
 * @fileoverview Agent Invoker - Execute Agent Tasks
 * 
 * Handles agent invocation requests from backend:
 * 1. Receive invocation request via event
 * 2. POST to Kagent A2A API: /api/a2a/{ns}/{name}/message/send
 * 3. Track in-flight invocations with timeout (default: 60s)
 * 4. Return response via event
 * 
 * Features:
 * - Timeout handling (configurable per invocation)
 * - Cancellation support
 * - Circuit breaker for Kagent API
 * - Retry logic with exponential backoff
 * - In-flight tracking
 * - Concurrent invocation limiting
 * 
 * @author Consonant Engineering
 * @version 1.0.0
 */

import { EventEmitter } from 'events';
import { fetch } from 'undici';
import PQueue from 'p-queue';

import type {
  AgentInvocationRequest,
  AgentInvocationResponse,
  InFlightInvocation,
} from '../../types/agents.js';
import { CircuitBreaker } from '../../utils/circuit-breaker.js';
import { retry, DEFAULT_RETRY_CONFIG } from '../../utils/retry.js';
import { createLogger } from '../../utils/logger.js';
import type { AgentStore } from './store.js';

const logger = createLogger('agent-invoker');

/**
 * Agent Invoker Events
 */
export interface AgentInvokerEvents {
  'invocation:started': (invocationId: string, agentId: string) => void;
  'invocation:completed': (response: AgentInvocationResponse) => void;
  'invocation:failed': (invocationId: string, error: Error) => void;
  'invocation:timeout': (invocationId: string) => void;
  'invocation:cancelled': (invocationId: string) => void;
}

/**
 * Agent Invoker Configuration
 */
export interface AgentInvokerConfig {
  /** Default timeout in seconds */
  readonly defaultTimeout: number;
  
  /** Maximum concurrent invocations */
  readonly maxConcurrent: number;
  
  /** Maximum queue size */
  readonly maxQueueSize: number;
  
  /** Circuit breaker config */
  readonly circuitBreaker: {
    readonly failureThreshold: number;
    readonly successThreshold: number;
    readonly timeout: number;
  };
}

/**
 * Agent Invoker Service
 * 
 * Executes agent invocations by calling Kagent A2A API.
 * Tracks in-flight invocations with timeout handling.
 */
export class AgentInvokerService extends EventEmitter {
  /** In-flight invocations */
  private readonly inflightInvocations = new Map<string, InFlightInvocation>();
  
  /** Circuit breaker for Kagent API */
  private readonly circuitBreaker: CircuitBreaker;
  
  /** Queue for concurrent invocation limiting */
  private readonly queue: PQueue;
  
  /** Running flag */
  private running = false;
  
  constructor(
    private readonly agentStore: AgentStore,
    private readonly config: AgentInvokerConfig
  ) {
    super();
    
    // Create circuit breaker
    this.circuitBreaker = new CircuitBreaker({
      name: 'kagent-invocation-api',
      failureThreshold: config.circuitBreaker.failureThreshold,
      successThreshold: config.circuitBreaker.successThreshold,
      timeout: config.circuitBreaker.timeout,
    });
    
    // Create queue for concurrency limiting
    this.queue = new PQueue({
      concurrency: config.maxConcurrent,
      timeout: config.defaultTimeout * 1000,
      throwOnTimeout: false,
    });
    
    // Log circuit breaker state changes
    this.circuitBreaker.on('stateChange', (state) => {
      logger.warn({ state }, 'Kagent invocation API circuit breaker state changed');
    });
  }
  
  /**
   * Start service
   */
  start(): void {
    if (this.running) {
      logger.warn('Agent invoker already running');
      return;
    }
    
    logger.info('Starting agent invoker service');
    this.running = true;
  }
  
  /**
   * Stop service
   * 
   * Cancels all in-flight invocations and waits for queue to drain.
   */
  async stop(timeout: number = 5000): Promise<void> {
    if (!this.running) return;
    
    logger.info('Stopping agent invoker service');
    this.running = false;
    
    // Cancel all in-flight invocations
    for (const [invocationId, invocation] of this.inflightInvocations.entries()) {
      this.cancelInvocation(invocationId);
    }
    
    // Wait for queue to drain (with timeout)
    try {
      await Promise.race([
        this.queue.onIdle(),
        new Promise((resolve) => setTimeout(resolve, timeout)),
      ]);
    } catch (error) {
      logger.warn({ error: (error as Error).message }, 'Queue drain timeout');
    }
    
    logger.info('Agent invoker service stopped');
  }
  
  /**
   * Check if running
   */
  isRunning(): boolean {
    return this.running;
  }
  
  /**
   * Invoke agent
   * 
   * @param request - Invocation request
   */
  async invoke(request: AgentInvocationRequest): Promise<void> {
    const { invocationId, agentId, namespace, name } = request;
    
    logger.info({ invocationId, agentId }, 'Agent invocation requested');
    
    // Check if agent exists
    const agent = this.agentStore.get(agentId);
    if (!agent) {
      const error = new Error(`Agent not found: ${agentId}`);
      logger.error({ invocationId, agentId }, error.message);
      this.emitFailure(invocationId, error);
      return;
    }
    
    // Check if agent is reachable
    if (!agent.reachable) {
      const error = new Error(`Agent unreachable: ${agentId}`);
      logger.error({ invocationId, agentId }, error.message);
      this.emitFailure(invocationId, error);
      return;
    }
    
    // Add to queue
    void this.queue.add(async () => {
      await this.executeInvocation(request);
    });
  }
  
  /**
   * Execute invocation (internal)
   * 
   * Tracks in-flight, sets timeout, calls Kagent API, returns response.
   */
  private async executeInvocation(request: AgentInvocationRequest): Promise<void> {
    const { invocationId, agentId, namespace, name, message, parameters, timeout } = request;
    const timeoutMs = (timeout ?? this.config.defaultTimeout) * 1000;
    const startedAt = Date.now();
    
    // Track in-flight
    const inflight: InFlightInvocation = {
      request,
      startedAt,
      cancelled: false,
    };
    
    // Set timeout
    inflight.timeoutHandle = setTimeout(() => {
      this.handleTimeout(invocationId);
    }, timeoutMs);
    
    this.inflightInvocations.set(invocationId, inflight);
    
    // Emit started event
    this.emit('invocation:started', invocationId, agentId);
    
    try {
      // Call Kagent A2A API
      const response = await this.callKagentAPI(namespace, name, message, parameters);
      
      // Check if cancelled during execution
      if (inflight.cancelled) {
        logger.info({ invocationId }, 'Invocation was cancelled');
        return;
      }
      
      const durationMs = Date.now() - startedAt;
      
      // Emit success
      this.emitSuccess(invocationId, response, durationMs);
    } catch (error) {
      const err = error as Error;
      
      // Check if cancelled
      if (inflight.cancelled) {
        logger.info({ invocationId }, 'Invocation was cancelled');
        return;
      }
      
      logger.error(
        { invocationId, agentId, error: err.message },
        'Invocation failed'
      );
      
      this.emitFailure(invocationId, err);
    } finally {
      // Clean up
      if (inflight.timeoutHandle) {
        clearTimeout(inflight.timeoutHandle);
      }
      this.inflightInvocations.delete(invocationId);
    }
  }
  
  /**
   * Call Kagent A2A API
   * 
   * POST /api/a2a/{namespace}/{agent-name}/message/send
   * 
   * @param namespace - K8s namespace
   * @param name - Agent name
   * @param message - Message/task
   * @param parameters - Optional parameters
   * @returns Agent response
   */
  private async callKagentAPI(
    namespace: string,
    name: string,
    message: string,
    parameters?: Record<string, unknown>
  ): Promise<string> {
    const url = `http://kagent-controller.${namespace}.svc.cluster.local:8083/api/a2a/${namespace}/${name}/message/send`;
    
    logger.debug({ url, message }, 'Calling Kagent A2A API');
    
    // Use circuit breaker + retry
    return await this.circuitBreaker.execute(async () => {
      return await retry(
        async () => {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify({
              message,
              parameters: parameters ?? {},
            }),
            signal: AbortSignal.timeout(30000), // 30s request timeout
          });
          
          if (!response.ok) {
            throw new Error(
              `Kagent API error: ${response.status} ${response.statusText}`
            );
          }
          
          const data = (await response.json()) as { response?: string; error?: string };
          
          if (data.error) {
            throw new Error(`Agent error: ${data.error}`);
          }
          
          return data.response ?? '';
        },
        {
          ...DEFAULT_RETRY_CONFIG,
          maxAttempts: 2, // Don't retry too much for invocations
          operation: `invoke-agent-${namespace}/${name}`,
        }
      );
    });
  }
  
  /**
   * Cancel invocation
   * 
   * @param invocationId - Invocation ID
   */
  cancelInvocation(invocationId: string): void {
    const invocation = this.inflightInvocations.get(invocationId);
    
    if (!invocation) {
      logger.warn({ invocationId }, 'Cannot cancel - invocation not found');
      return;
    }
    
    logger.info({ invocationId }, 'Cancelling invocation');
    
    // Mark as cancelled
    invocation.cancelled = true;
    
    // Clear timeout
    if (invocation.timeoutHandle) {
      clearTimeout(invocation.timeoutHandle);
      invocation.timeoutHandle = undefined;
    }
    
    // Remove from tracking
    this.inflightInvocations.delete(invocationId);
    
    // Emit cancelled event
    this.emit('invocation:cancelled', invocationId);
    
    // Emit response
    const response: AgentInvocationResponse = {
      invocationId,
      status: 'cancelled',
      durationMs: Date.now() - invocation.startedAt,
      timestamp: new Date().toISOString(),
    };
    
    this.emit('invocation:completed', response);
  }
  
  /**
   * Handle timeout
   */
  private handleTimeout(invocationId: string): void {
    const invocation = this.inflightInvocations.get(invocationId);
    
    if (!invocation || invocation.cancelled) {
      return;
    }
    
    logger.warn({ invocationId }, 'Invocation timeout');
    
    // Mark as cancelled (prevents further processing)
    invocation.cancelled = true;
    
    // Remove from tracking
    this.inflightInvocations.delete(invocationId);
    
    // Emit timeout event
    this.emit('invocation:timeout', invocationId);
    
    // Emit response
    const response: AgentInvocationResponse = {
      invocationId,
      status: 'timeout',
      error: 'Invocation timed out',
      durationMs: Date.now() - invocation.startedAt,
      timestamp: new Date().toISOString(),
    };
    
    this.emit('invocation:completed', response);
  }
  
  /**
   * Emit success response
   */
  private emitSuccess(invocationId: string, agentResponse: string, durationMs: number): void {
    const response: AgentInvocationResponse = {
      invocationId,
      status: 'success',
      response: agentResponse,
      durationMs,
      timestamp: new Date().toISOString(),
    };
    
    this.emit('invocation:completed', response);
    
    logger.info({ invocationId, durationMs }, 'Invocation completed successfully');
  }
  
  /**
   * Emit failure response
   */
  private emitFailure(invocationId: string, error: Error): void {
    const response: AgentInvocationResponse = {
      invocationId,
      status: 'failure',
      error: error.message,
      durationMs: 0,
      timestamp: new Date().toISOString(),
    };
    
    this.emit('invocation:completed', response);
    this.emit('invocation:failed', invocationId, error);
  }
  
  /**
   * Get in-flight invocation count
   */
  getInflightCount(): number {
    return this.inflightInvocations.size;
  }
  
  /**
   * Get queue statistics
   */
  getQueueStats(): {
    size: number;
    pending: number;
    isPaused: boolean;
  } {
    return {
      size: this.queue.size,
      pending: this.queue.pending,
      isPaused: this.queue.isPaused,
    };
  }
}