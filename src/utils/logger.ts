/**
 * Structured Logging with Pino
 * 
 * This module provides a production-grade logger with:
 * - Structured JSON logging for machine parsing
 * - Automatic request ID correlation
 * - Redaction of sensitive data
 * - Performance optimized (Pino is fastest Node.js logger)
 * - Child loggers for context isolation
 */

import pino from 'pino';
import type { Logger as PinoLogger } from 'pino';

// ===========================================================================
// LOGGER CONFIGURATION
// ===========================================================================

interface LoggerConfig {
  level: string;
  pretty: boolean;
  redact?: string[];
}

let loggerInstance: PinoLogger | null = null;

/**
 * Initialize the global logger
 * Must be called once at startup before any logging occurs
 */
export function initializeLogger(config: LoggerConfig): PinoLogger {
  const pinoConfig: pino.LoggerOptions = {
    level: config.level,
    
    // Redact sensitive fields
    redact: {
      paths: config.redact || [
        'cluster.token',
        'password',
        'secret',
        'token',
        'authorization',
        'api_key',
        'apiKey',
      ],
      censor: '***REDACTED***',
    },
    
    // Use pretty formatting in development
    transport: config.pretty ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    } : undefined,
    
    // Production JSON formatting
    formatters: config.pretty ? undefined : {
      level: (label) => {
        return { level: label };
      },
      bindings: (bindings) => {
        return {
          pid: bindings.pid,
          hostname: bindings.hostname,
          node_version: process.version,
        };
      },
    },
    
    // Base context
    base: {
      service: 'consonant-relayer',
      version: '2.0.0',
    },
    
    // Timestamp
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  loggerInstance = pino(pinoConfig);
  
  return loggerInstance;
}

/**
 * Get the global logger instance
 * @throws {Error} If logger not initialized
 */
export function getLogger(): PinoLogger {
  if (!loggerInstance) {
    // Fallback for testing - create a basic logger
    loggerInstance = pino({
      level: 'info',
      base: { service: 'consonant-relayer' },
    });
  }
  
  return loggerInstance;
}

/**
 * Create a child logger with additional context
 */
export function createChildLogger(context: Record<string, unknown>): PinoLogger {
  return getLogger().child(context);
}

/**
 * Create a logger for a specific component
 */
export function createComponentLogger(component: string): PinoLogger {
  return createChildLogger({ component });
}

// ===========================================================================
// CONVENIENCE EXPORTS
// ===========================================================================

/**
 * Default logger instance (lazy-initialized)
 * Use this for quick logging without managing logger instances
 */
export const logger = new Proxy({} as PinoLogger, {
  get: (_target, prop: string) => {
    const log = getLogger();
    return typeof log[prop as keyof PinoLogger] === 'function'
      ? (log[prop as keyof PinoLogger] as Function).bind(log)
      : log[prop as keyof PinoLogger];
  },
});

// ===========================================================================
// UTILITY FUNCTIONS
// ===========================================================================

/**
 * Log an error with full context
 */
export function logError(error: Error | unknown, context?: Record<string, unknown>): void {
  const log = getLogger();
  
  if (error instanceof Error) {
    log.error({
      err: {
        type: error.name,
        message: error.message,
        stack: error.stack,
      },
      ...context,
    }, error.message);
  } else {
    log.error({
      error: String(error),
      ...context,
    }, 'Unknown error occurred');
  }
}

/**
 * Log a performance metric
 */
export function logPerformance(
  operation: string,
  durationMs: number,
  context?: Record<string, unknown>
): void {
  const log = getLogger();
  
  log.info({
    metric: 'performance',
    operation,
    duration_ms: durationMs,
    ...context,
  }, `${operation} completed in ${durationMs}ms`);
}

/**
 * Generate a unique request/trace ID
 */
export function generateTraceId(): string {
  return `trace_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Create a logger with a trace ID for request tracking
 */
export function createTracedLogger(traceId?: string): PinoLogger {
  return createChildLogger({
    trace_id: traceId || generateTraceId(),
  });
}

// ===========================================================================
// PERFORMANCE TRACKING
// ===========================================================================

/**
 * Track execution time of an async function
 */
export async function trackPerformance<T>(
  operation: string,
  fn: () => Promise<T>,
  context?: Record<string, unknown>
): Promise<T> {
  const startTime = Date.now();
  
  try {
    const result = await fn();
    const duration = Date.now() - startTime;
    
    logPerformance(operation, duration, context);
    
    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    
    logError(error, {
      operation,
      duration_ms: duration,
      ...context,
    });
    
    throw error;
  }
}

/**
 * Create a performance timer
 */
export function createTimer(operation: string, context?: Record<string, unknown>) {
  const startTime = Date.now();
  
  return {
    end: (success = true) => {
      const duration = Date.now() - startTime;
      
      if (success) {
        logPerformance(operation, duration, context);
      } else {
        getLogger().warn({
          metric: 'performance',
          operation,
          duration_ms: duration,
          success: false,
          ...context,
        }, `${operation} failed after ${duration}ms`);
      }
      
      return duration;
    },
  };
}