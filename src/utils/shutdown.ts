/**
 * Shutdown Manager
 * 
 * Handles graceful shutdown of the application
 * Coordinates cleanup of all services in reverse order
 */

import { logger } from './logger.js';

/**
 * Shutdown handler function type
 */
type ShutdownHandler = () => Promise<void> | void;

/**
 * Shutdown Manager Class
 */
class ShutdownManager {
  private handlers: Array<{ name: string; handler: ShutdownHandler }> = [];
  private isShuttingDown = false;
  private shutdownPromise?: Promise<void>;
  
  /**
   * Register a shutdown handler
   * Handlers are called in reverse order (LIFO)
   */
  register(name: string, handler: ShutdownHandler): void {
    if (this.isShuttingDown) {
      logger.warn({ name }, 'Attempted to register handler during shutdown');
      return;
    }
    
    this.handlers.push({ name, handler });
    logger.debug({ name, totalHandlers: this.handlers.length }, 'Registered shutdown handler');
  }
  
  /**
   * Alias for register - more intuitive API
   */
  onShutdown(handler: (signal: string) => Promise<void>): void {
    this.register('app-shutdown', async () => {
      // Signal will be provided by gracefulShutdown
      await handler('SIGTERM');
    });
  }
  
  /**
   * Execute graceful shutdown
   * Calls all handlers in reverse order
   */
  async shutdown(signal?: string): Promise<void> {
    // Prevent multiple simultaneous shutdowns
    if (this.isShuttingDown) {
      return this.shutdownPromise;
    }
    
    this.isShuttingDown = true;
    
    this.shutdownPromise = (async () => {
      logger.info({ 
        signal: signal || 'manual',
        handlerCount: this.handlers.length 
      }, '🛑 Starting graceful shutdown...');
      
      // Call handlers in reverse order (LIFO)
      const reversedHandlers = [...this.handlers].reverse();
      
      for (const { name, handler } of reversedHandlers) {
        try {
          logger.info({ component: name }, `Shutting down ${name}...`);
          await handler();
          logger.info({ component: name }, `✓ ${name} shut down successfully`);
        } catch (error) {
          logger.error({ 
            component: name, 
            err: error instanceof Error ? error : new Error(String(error))
          }, `✗ Error shutting down ${name}`);
          // Continue with other handlers even if one fails
        }
      }
      
      logger.info('🎉 Graceful shutdown complete');
    })();
    
    return this.shutdownPromise;
  }
  
  /**
   * Check if shutdown is in progress
   */
  isShutdown(): boolean {
    return this.isShuttingDown;
  }
  
  /**
   * Get number of registered handlers
   */
  getHandlerCount(): number {
    return this.handlers.length;
  }
}

// Singleton instance
const shutdownManager = new ShutdownManager();

/**
 * Helper function for graceful shutdown with signal handling
 * Sets up signal handlers to trigger shutdownManager
 */
export function gracefulShutdown(options: {
  signals?: NodeJS.Signals[];
  timeout?: number;
} = {}): void {
  const { signals = ['SIGTERM', 'SIGINT'], timeout = 30000 } = options;
  
  let shutdownInitiated = false;
  
  const handleShutdown = async (signal: string) => {
    if (shutdownInitiated) {
      logger.warn({ signal }, 'Shutdown already initiated, ignoring signal');
      return;
    }
    
    shutdownInitiated = true;
    
    logger.info({ signal }, `Received ${signal}, initiating graceful shutdown`);
    
    // Set timeout for forced shutdown
    const forceTimeout = setTimeout(() => {
      logger.error({ timeout }, 'Graceful shutdown timeout exceeded, forcing exit');
      process.exit(1);
    }, timeout);
    
    try {
      await shutdownManager.shutdown(signal);
      clearTimeout(forceTimeout);
      logger.info('Shutdown complete, exiting');
      process.exit(0);
    } catch (error) {
      clearTimeout(forceTimeout);
      logger.fatal({ 
        err: error instanceof Error ? error : new Error(String(error))
      }, 'Shutdown failed with error');
      process.exit(1);
    }
  };
  
  // Register signal handlers
  for (const signal of signals) {
    process.on(signal, () => handleShutdown(signal));
  }
}

export { shutdownManager };