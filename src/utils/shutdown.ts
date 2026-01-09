/**
 * Graceful Shutdown
 * 
 * Handles process termination signals and ensures clean shutdown:
 * - Stop accepting new commands
 * - Wait for in-flight commands to complete
 * - Flush pending events
 * - Close gRPC stream
 * - Close Kubernetes watchers
 * - Exit cleanly
 */

import { logger, createComponentLogger } from './logger.js';

// ===========================================================================
// TYPES
// ===========================================================================

export interface ShutdownHandler {
  (): Promise<void>;
}

export interface ShutdownOptions {
  gracePeriodMs?: number;
  signals?: NodeJS.Signals[];
}

// ===========================================================================
// SHUTDOWN MANAGER
// ===========================================================================

export class ShutdownManager {
  private readonly log = createComponentLogger('ShutdownManager');
  private handlers: ShutdownHandler[] = [];
  private isShuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(private readonly options: ShutdownOptions = {}) {
    const signals = options.signals || ['SIGTERM', 'SIGINT'];
    
    // Register signal handlers
    for (const signal of signals) {
      process.on(signal, () => {
        this.log.info({ signal }, `Received ${signal} signal`);
        this.shutdown().catch((error) => {
          this.log.fatal({ error }, 'Shutdown failed');
          process.exit(1);
        });
      });
    }

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      this.log.fatal({ error }, 'Uncaught exception');
      this.shutdown().catch(() => {
        process.exit(1);
      });
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      this.log.fatal({ reason, promise }, 'Unhandled promise rejection');
      this.shutdown().catch(() => {
        process.exit(1);
      });
    });

    this.log.info({ signals }, 'Shutdown manager initialized');
  }

  /**
   * Register a shutdown handler
   */
  registerHandler(handler: ShutdownHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Perform graceful shutdown
   */
  async shutdown(): Promise<void> {
    // Prevent multiple simultaneous shutdowns
    if (this.isShuttingDown) {
      this.log.info('Shutdown already in progress');
      return this.shutdownPromise || Promise.resolve();
    }

    this.isShuttingDown = true;

    this.shutdownPromise = (async () => {
      this.log.info('Starting graceful shutdown');

      const startTime = Date.now();
      const gracePeriodMs = this.options.gracePeriodMs || 30000;

      try {
        // Execute all handlers with timeout
        await Promise.race([
          this.executeHandlers(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Shutdown timeout')), gracePeriodMs)
          ),
        ]);

        const duration = Date.now() - startTime;
        this.log.info({ duration_ms: duration }, 'Graceful shutdown completed');

        process.exit(0);
      } catch (error) {
        const duration = Date.now() - startTime;
        this.log.error({ error, duration_ms: duration }, 'Shutdown completed with errors');

        process.exit(1);
      }
    })();

    return this.shutdownPromise;
  }

  /**
   * Execute all registered handlers
   */
  private async executeHandlers(): Promise<void> {
    this.log.info({ handlerCount: this.handlers.length }, 'Executing shutdown handlers');

    // Execute handlers in reverse order (LIFO)
    const reversedHandlers = [...this.handlers].reverse();

    for (let i = 0; i < reversedHandlers.length; i++) {
      const handler = reversedHandlers[i];
      
      try {
        this.log.debug({ index: i }, `Executing shutdown handler ${i + 1}/${reversedHandlers.length}`);
        await handler();
        this.log.debug({ index: i }, `Shutdown handler ${i + 1} completed`);
      } catch (error) {
        this.log.error({ error, index: i }, `Shutdown handler ${i + 1} failed`);
        // Continue with other handlers even if one fails
      }
    }

    this.log.info('All shutdown handlers executed');
  }

  /**
   * Check if shutdown is in progress
   */
  isShuttingDown_(): boolean {
    return this.isShuttingDown;
  }
}

// ===========================================================================
// CONVENIENCE FUNCTIONS
// ===========================================================================

let globalShutdownManager: ShutdownManager | null = null;

/**
 * Initialize the global shutdown manager
 */
export function initializeShutdownManager(options?: ShutdownOptions): ShutdownManager {
  if (globalShutdownManager) {
    throw new Error('Shutdown manager already initialized');
  }

  globalShutdownManager = new ShutdownManager(options);
  return globalShutdownManager;
}

/**
 * Register a shutdown handler
 */
export function registerShutdownHandler(handler: ShutdownHandler): void {
  if (!globalShutdownManager) {
    throw new Error('Shutdown manager not initialized');
  }

  globalShutdownManager.registerHandler(handler);
}

/**
 * Perform graceful shutdown
 */
export async function performShutdown(): Promise<void> {
  if (!globalShutdownManager) {
    throw new Error('Shutdown manager not initialized');
  }

  await globalShutdownManager.shutdown();
}

/**
 * Check if shutdown is in progress
 */
export function isShuttingDown(): boolean {
  return globalShutdownManager?.isShuttingDown_() || false;
}

/**
 * Setup graceful shutdown with handlers
 * 
 * This is a convenience function for common shutdown patterns
 */
export function setupGracefulShutdown(
  handlers: {
    onShutdown?: () => Promise<void>;
    onWatchersStop?: () => Promise<void>;
    onGrpcClose?: () => Promise<void>;
    onCleanup?: () => Promise<void>;
  },
  options?: ShutdownOptions
): void {
  const manager = initializeShutdownManager(options);

  // Register handlers in order
  if (handlers.onWatchersStop) {
    manager.registerHandler(async () => {
      logger.info('Stopping watchers');
      await handlers.onWatchersStop!();
    });
  }

  if (handlers.onGrpcClose) {
    manager.registerHandler(async () => {
      logger.info('Closing gRPC connection');
      await handlers.onGrpcClose!();
    });
  }

  if (handlers.onCleanup) {
    manager.registerHandler(async () => {
      logger.info('Performing cleanup');
      await handlers.onCleanup!();
    });
  }

  if (handlers.onShutdown) {
    manager.registerHandler(async () => {
      logger.info('Running custom shutdown handler');
      await handlers.onShutdown!();
    });
  }

  logger.info('Graceful shutdown configured');
}