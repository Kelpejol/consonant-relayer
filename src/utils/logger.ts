/**
 * @fileoverview Structured Logging with Pino
 * 
 * Production-grade logging system using Pino for high-performance structured JSON logs.
 * 
 * Design principles:
 * - Structured JSON in production (machine-readable)
 * - Pretty-printed in development (human-readable)
 * - Component-based child loggers (trace log sources)
 * - Zero PII in logs (security requirement)
 * - ISO timestamps (RFC 3339)
 * - Log levels: trace, debug, info, warn, error, fatal
 * 
 * Performance characteristics:
 * - Pino is ~5x faster than Winston
 * - Async logging (doesn't block event loop)
 * - Safe JSON serialization (handles circular refs, errors)
 * 
 * @author Consonant Engineering
 * @version 1.0.0
 */

import pino from 'pino';
import type { Logger } from 'pino';

import { config } from '../config/index.js';

/**
 * Base Pino logger instance
 * 
 * Configuration:
 * - Production: JSON output for machine parsing (ELK, Loki, etc)
 * - Development: Pretty-printed with colors for human reading
 * - ISO timestamps (RFC 3339 compliant)
 * - No hostname/pid in logs (K8s pod name sufficient)
 */
const baseLogger: Logger = pino({
  level: config.logLevel,
  
  // ISO timestamp formatter (RFC 3339)
  timestamp: pino.stdTimeFunctions.isoTime,
  
  // Format log levels as strings (not numbers)
  formatters: {
    level: (label: string): { level: string } => ({ level: label }),
  },
  
  // Pretty print in development
  ...(config.nodeEnv === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname', // K8s pod name is sufficient
            singleLine: false,
          },
        },
      }
    : {}),
});

/**
 * Create a child logger for a specific component
 * 
 * Child loggers automatically include component name in all log entries,
 * making it easy to trace logs to their source in a distributed system.
 * 
 * @param component - Component name (e.g., 'backend-client', 'otel-collector')
 * @returns Child logger instance
 * 
 * @example
 * const logger = createLogger('backend-client');
 * logger.info({ event: 'connected' }, 'Connected to backend');
 * // Output: {"level":"info","time":"2024-01-01T00:00:00.000Z","component":"backend-client","event":"connected","msg":"Connected to backend"}
 */
export function createLogger(component: string): Logger {
  return baseLogger.child({ component });
}

/**
 * Global logger instance
 * 
 * Use sparingly - prefer component-specific loggers via createLogger().
 * Only use for truly global concerns (startup, shutdown, unhandled errors).
 */
export const logger: Logger = createLogger('relayer');

/**
 * Log fatal error and exit process
 * 
 * This is the nuclear option - only use for unrecoverable errors during startup.
 * For runtime errors, use regular error logging and let orchestrator (K8s) restart.
 * 
 * @param error - Error object or message
 * @param component - Component where fatal error occurred
 * 
 * @example
 * try {
 *   await connectToBackend();
 * } catch (error) {
 *   fatal(error, 'backend-client');
 * }
 */
export function fatal(error: Error | string, component: string = 'relayer'): never {
  const log = createLogger(component);
  
  if (error instanceof Error) {
    // Log full error details including stack trace
    log.fatal(
      {
        error: {
          message: error.message,
          name: error.name,
          stack: error.stack,
          cause: error.cause,
        },
      },
      'Fatal error - exiting process'
    );
  } else {
    // String message
    log.fatal({ message: error }, 'Fatal error - exiting process');
  }
  
  // Exit with non-zero code (signals failure to orchestrator)
  process.exit(1);
}

/**
 * Redact sensitive information from log data
 * 
 * CRITICAL: Never log secrets, tokens, passwords, or PII.
 * This function redacts common sensitive fields.
 * 
 * @param data - Object potentially containing sensitive data
 * @returns Sanitized copy with secrets redacted
 * 
 * @example
 * const data = { clusterToken: 'secret123', clusterName: 'prod' };
 * logger.info(redactSecrets(data), 'Cluster config');
 * // Output: {"clusterToken":"***REDACTED***","clusterName":"prod"}
 */
export function redactSecrets(data: Record<string, unknown>): Record<string, unknown> {
  const redacted = { ...data };
  
  // List of sensitive keys to redact (case-insensitive)
  const sensitiveKeys = [
    'token',
    'password',
    'secret',
    'apikey',
    'api_key',
    'authorization',
    'auth',
    'credential',
  ];
  
  // Redact any keys containing sensitive terms
  for (const [key, value] of Object.entries(redacted)) {
    const lowerKey = key.toLowerCase();
    if (sensitiveKeys.some((sensitive) => lowerKey.includes(sensitive))) {
      redacted[key] = '***REDACTED***';
    } else if (typeof value === 'string' && value.includes('://')) {
      // Redact passwords in URLs (e.g., redis://user:password@host)
      redacted[key] = value.replace(/:[^:@]+@/, ':***@');
    }
  }
  
  return redacted;
}