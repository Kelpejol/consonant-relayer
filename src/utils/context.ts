/**
 * Context Manager
 * 
 * Provides AsyncLocalStorage-based context propagation
 * Allows passing trace IDs, request IDs, etc. through async call chains
 */

import { AsyncLocalStorage } from 'async_hooks';

/**
 * Context data structure
 */
export interface Context {
  traceId?: string;
  spanId?: string;
  requestId?: string;
  agentRunId?: string;
  agentName?: string;
  [key: string]: unknown;
}

/**
 * Context Manager using AsyncLocalStorage
 * 
 * Usage:
 * ```ts
 * contextManager.run({ traceId: '123' }, () => {
 *   // Any code here can access the context
 *   const ctx = contextManager.getContext();
 *   console.log(ctx.traceId); // '123'
 * });
 * ```
 */
class ContextManager {
  private storage = new AsyncLocalStorage<Context>();
  
  /**
   * Run a function with a specific context
   * Context will be available to all async operations within
   */
  run<T>(context: Context, fn: () => T): T {
    return this.storage.run(context, fn);
  }
  
  /**
   * Get the current context
   * Returns undefined if not within a context
   */
  getContext(): Context | undefined {
    return this.storage.getStore();
  }
  
  /**
   * Get all context data
   * Safe version that returns empty object if no context
   */
  getAllContext(): Context {
    return this.storage.getStore() || {};
  }
  
  /**
   * Get a specific context value
   */
  get<T = unknown>(key: string): T | undefined {
    const context = this.storage.getStore();
    return context?.[key] as T | undefined;
  }
  
  /**
   * Set a context value
   * Only works within an active context
   */
  set(key: string, value: unknown): void {
    const context = this.storage.getStore();
    if (context) {
      context[key] = value;
    }
  }
  
  /**
   * Get trace ID from context
   */
  getTraceId(): string | undefined {
    return this.get<string>('traceId');
  }
  
  /**
   * Get request ID from context
   */
  getRequestId(): string | undefined {
    return this.get<string>('requestId');
  }
  
  /**
   * Get agent run ID from context
   */
  getAgentRunId(): string | undefined {
    return this.get<string>('agentRunId');
  }
  
  /**
   * Get agent name from context
   */
  getAgentName(): string | undefined {
    return this.get<string>('agentName');
  }
  
  /**
   * Set metadata in context
   */
  setMetadata(key: string, value: unknown): void {
    this.set(key, value);
  }
  
  /**
   * Get metadata from context
   */
  getMetadata<T = unknown>(key: string): T | undefined {
    return this.get<T>(key);
  }
  
  /**
   * Check if within an active context
   */
  hasContext(): boolean {
    return this.storage.getStore() !== undefined;
  }
  
  /**
   * Create a child context with additional data
   * Merges with parent context
   */
  withContext<T>(additionalContext: Partial<Context>, fn: () => T): T {
    const parentContext = this.getAllContext();
    const childContext = { ...parentContext, ...additionalContext };
    return this.storage.run(childContext, fn);
  }
}

// Export singleton instance
export const contextManager = new ContextManager();