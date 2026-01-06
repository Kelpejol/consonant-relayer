/**
 * @fileoverview Configuration Loader
 * 
 * Loads and validates configuration from environment variables.
 * 
 * Configuration Priority:
 * 1. Environment variables (highest priority)
 * 2. Default values (fallback)
 * 
 * Usage:
 * ```typescript
 * import { config } from './config/index.js';
 * 
 * console.log(config.apiServer.port); // 8080
 * console.log(config.backendClient.url); // from BACKEND_URL env var
 * ```
 * 
 * Required Environment Variables:
 * - BACKEND_URL: Backend WebSocket URL
 * - CLUSTER_ID: Unique cluster identifier
 * - CLUSTER_NAME: Human-readable cluster name
 * - CLUSTER_TOKEN: Authentication token for backend
 * - KUBERNETES_NAMESPACE: K8s namespace to watch
 * 
 * Optional Environment Variables:
 * - NODE_ENV: Environment (development, staging, production)
 * - LOG_LEVEL: Log level (trace, debug, info, warn, error, fatal)
 * - LOG_PRETTY: Pretty-print logs (true/false)
 * - API_SERVER_PORT: HTTP API port (default: 8080)
 * - OTEL_COLLECTOR_PORT: OTLP gRPC port (default: 4317)
 * 
 * @author Consonant Engineering
 * @version 2.0.0
 */

import {
  DEFAULT_CONFIG,
  ENV_VAR_MAPPING,
  REQUIRED_ENV_VARS,
  validateConfig,
  getByPath,
  setByPath,
  type RelayerConfig,
} from './validation.js';

/**
 * Parse environment variable value
 * 
 * Handles type conversion for common types:
 * - "true"/"false" → boolean
 * - Numeric strings → number
 * - Everything else → string
 * 
 * @param value - Raw environment variable value
 * @returns Parsed value
 */
function parseEnvValue(value: string): string | number | boolean {
  // Boolean
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  
  // Number
  if (/^\d+$/.test(value)) {
    const num = parseInt(value, 10);
    if (!isNaN(num)) return num;
  }
  
  // String
  return value;
}

/**
 * Load configuration from environment
 * 
 * Merges default configuration with environment variables.
 * 
 * @returns Validated configuration
 * @throws {Error} If required environment variables are missing or validation fails
 */
function loadConfig(): RelayerConfig {
  // Check required environment variables
  const missingVars: string[] = [];
  
  for (const envVar of REQUIRED_ENV_VARS) {
    if (!process.env[envVar]) {
      missingVars.push(envVar);
    }
  }
  
  if (missingVars.length > 0) {
    throw new Error(
      `Missing required environment variables:\n${missingVars.join('\n')}\n\n` +
      `Please set these variables before starting the relayer.`
    );
  }
  
  // Start with default configuration
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as RelayerConfig;
  
  // Apply environment variables
  for (const [envVar, configPath] of Object.entries(ENV_VAR_MAPPING)) {
    const value = process.env[envVar];
    
    if (value !== undefined) {
      const parsedValue = parseEnvValue(value);
      setByPath(config, configPath, parsedValue);
    }
  }
  
  // Validate configuration
  return validateConfig(config);
}

/**
 * Global configuration instance
 * 
 * Loaded once at module initialization.
 * Throws error if configuration is invalid or required env vars are missing.
 */
export const config: RelayerConfig = loadConfig();

/**
 * Get configuration as JSON string
 * 
 * Useful for debugging. Redacts sensitive values (tokens, secrets).
 * 
 * @returns JSON string of configuration
 */
export function getConfigJSON(): string {
  const redacted = JSON.parse(JSON.stringify(config));
  
  // Redact sensitive values
  if (redacted.backendClient?.clusterToken) {
    redacted.backendClient.clusterToken = '***REDACTED***';
  }
  
  return JSON.stringify(redacted, null, 2);
}

/**
 * Export types and validators
 */
export type { RelayerConfig } from './validation.js';
export { validateConfig } from './validation.js';