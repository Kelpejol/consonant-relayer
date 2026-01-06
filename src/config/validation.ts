/**
 * @fileoverview Configuration Validation - Zod Schemas
 * 
 * Validates all environment variables and configuration using Zod.
 * Ensures type safety and catches configuration errors at startup.
 * 
 * @author Consonant Engineering
 * @version 2.0.0
 */

import { z } from 'zod';

/**
 * Log level schema
 */
const LogLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

/**
 * Environment schema
 */
const EnvironmentSchema = z.enum(['development', 'staging', 'production']);

/**
 * Port number schema
 */
const PortSchema = z.number().int().min(1).max(65535);

/**
 * URL schema
 */
const UrlSchema = z.string().url();

/**
 * Non-empty string schema
 */
const NonEmptyString = z.string().min(1);

/**
 * Kubernetes namespace schema
 */
const NamespaceSchema = z.string().regex(/^[a-z0-9-]+$/);

/**
 * Logger Configuration Schema
 */
export const LoggerConfigSchema = z.object({
  level: LogLevelSchema,
  pretty: z.boolean(),
});

export type LoggerConfig = z.infer<typeof LoggerConfigSchema>;

/**
 * Agent Manager Configuration Schema
 */
export const AgentManagerConfigSchema = z.object({
  discovery: z.object({
    timeout: z.number().int().positive(),
    retryAttempts: z.number().int().min(0).max(10),
    retryDelay: z.number().int().positive(),
    circuitBreaker: z.object({
      failureThreshold: z.number().int().positive(),
      successThreshold: z.number().int().positive(),
      timeout: z.number().int().positive(),
    }),
  }),
  invoker: z.object({
    defaultTimeout: z.number().int().positive(),
    maxConcurrent: z.number().int().positive(),
    maxQueueSize: z.number().int().positive(),
    circuitBreaker: z.object({
      failureThreshold: z.number().int().positive(),
      successThreshold: z.number().int().positive(),
      timeout: z.number().int().positive(),
    }),
  }),
});

export type AgentManagerConfig = z.infer<typeof AgentManagerConfigSchema>;

/**
 * API Server Configuration Schema
 */
export const ApiServerConfigSchema = z.object({
  port: PortSchema,
  host: z.string().ip().or(z.literal('0.0.0.0')),
  rateLimit: z.object({
    max: z.number().int().positive(),
    timeWindow: z.string(),
  }),
});

export type ApiServerConfig = z.infer<typeof ApiServerConfigSchema>;

/**
 * Backend Client Configuration Schema
 */
export const BackendClientConfigSchema = z.object({
  url: UrlSchema,
  clusterId: NonEmptyString,
  clusterName: NonEmptyString,
  clusterToken: NonEmptyString,
  heartbeatInterval: z.number().int().positive(),
  heartbeatTimeout: z.number().int().positive(),
  telemetryBatchSize: z.number().int().positive(),
  telemetryBatchTimeout: z.number().int().positive(),
  reconnectDelay: z.number().int().positive(),
  reconnectDelayMax: z.number().int().positive(),
});

export type BackendClientConfig = z.infer<typeof BackendClientConfigSchema>;

/**
 * OTEL Collector Configuration Schema
 */
export const OtelCollectorConfigSchema = z.object({
  port: PortSchema,
  host: z.string().ip().or(z.literal('0.0.0.0')),
  maxQueueSize: z.number().int().positive(),
  batchSize: z.number().int().positive(),
  batchTimeout: z.number().int().positive(),
});

export type OtelCollectorConfig = z.infer<typeof OtelCollectorConfigSchema>;

/**
 * Kubernetes Watcher Configuration Schema
 */
export const KubernetesWatcherConfigSchema = z.object({
  namespace: NamespaceSchema,
  watchRetryDelay: z.number().int().positive(),
});

export type KubernetesWatcherConfig = z.infer<typeof KubernetesWatcherConfigSchema>;

/**
 * Complete Relayer Configuration Schema
 */
export const RelayerConfigSchema = z.object({
  /** Environment */
  environment: EnvironmentSchema,
  
  /** Logger configuration */
  logger: LoggerConfigSchema,
  
  /** Agent manager configuration */
  agentManager: AgentManagerConfigSchema,
  
  /** API server configuration */
  apiServer: ApiServerConfigSchema,
  
  /** Backend client configuration */
  backendClient: BackendClientConfigSchema,
  
  /** OTEL collector configuration */
  otelCollector: OtelCollectorConfigSchema,
  
  /** Kubernetes watcher configuration */
  kubernetesWatcher: KubernetesWatcherConfigSchema,
});

export type RelayerConfig = z.infer<typeof RelayerConfigSchema>;

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: RelayerConfig = {
  environment: 'production',
  
  logger: {
    level: 'info',
    pretty: false,
  },
  
  agentManager: {
    discovery: {
      timeout: 10000, // 10 seconds
      retryAttempts: 3,
      retryDelay: 1000, // 1 second
      circuitBreaker: {
        failureThreshold: 5,
        successThreshold: 2,
        timeout: 60000, // 1 minute
      },
    },
    invoker: {
      defaultTimeout: 60, // 60 seconds
      maxConcurrent: 10,
      maxQueueSize: 100,
      circuitBreaker: {
        failureThreshold: 5,
        successThreshold: 2,
        timeout: 60000, // 1 minute
      },
    },
  },
  
  apiServer: {
    port: 8080,
    host: '0.0.0.0',
    rateLimit: {
      max: 100,
      timeWindow: '1 minute',
    },
  },
  
  backendClient: {
    url: 'http://localhost:3000', // Will be overridden by env var
    clusterId: 'unknown', // Will be overridden by env var
    clusterName: 'unknown', // Will be overridden by env var
    clusterToken: 'unknown', // Will be overridden by env var
    heartbeatInterval: 30000, // 30 seconds
    heartbeatTimeout: 60000, // 60 seconds
    telemetryBatchSize: 100,
    telemetryBatchTimeout: 1000, // 1 second
    reconnectDelay: 1000, // 1 second
    reconnectDelayMax: 30000, // 30 seconds
  },
  
  otelCollector: {
    port: 4317,
    host: '0.0.0.0',
    maxQueueSize: 10000,
    batchSize: 100,
    batchTimeout: 1000, // 1 second
  },
  
  kubernetesWatcher: {
    namespace: 'default', // Will be overridden by env var
    watchRetryDelay: 5000, // 5 seconds
  },
};

/**
 * Environment variable mapping
 * 
 * Maps environment variables to configuration paths.
 */
export const ENV_VAR_MAPPING: Record<string, string> = {
  // Environment
  'NODE_ENV': 'environment',
  
  // Logger
  'LOG_LEVEL': 'logger.level',
  'LOG_PRETTY': 'logger.pretty',
  
  // API Server
  'API_SERVER_PORT': 'apiServer.port',
  'API_SERVER_HOST': 'apiServer.host',
  
  // Backend Client
  'BACKEND_URL': 'backendClient.url',
  'CLUSTER_ID': 'backendClient.clusterId',
  'CLUSTER_NAME': 'backendClient.clusterName',
  'CLUSTER_TOKEN': 'backendClient.clusterToken',
  
  // OTEL Collector
  'OTEL_COLLECTOR_PORT': 'otelCollector.port',
  'OTEL_COLLECTOR_HOST': 'otelCollector.host',
  
  // Kubernetes
  'KUBERNETES_NAMESPACE': 'kubernetesWatcher.namespace',
};

/**
 * Required environment variables
 * 
 * These must be set or configuration validation will fail.
 */
export const REQUIRED_ENV_VARS = [
  'BACKEND_URL',
  'CLUSTER_ID',
  'CLUSTER_NAME',
  'CLUSTER_TOKEN',
  'KUBERNETES_NAMESPACE',
];

/**
 * Validate configuration
 * 
 * @param config - Configuration to validate
 * @returns Validated configuration
 * @throws {Error} If validation fails
 */
export function validateConfig(config: unknown): RelayerConfig {
  try {
    return RelayerConfigSchema.parse(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errors = error.errors.map(
        (e) => `${e.path.join('.')}: ${e.message}`
      );
      throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
    }
    throw error;
  }
}

/**
 * Get nested object value by path
 * 
 * @param obj - Object to search
 * @param path - Dot-separated path (e.g., 'apiServer.port')
 * @returns Value at path or undefined
 */
export function getByPath(obj: any, path: string): any {
  return path.split('.').reduce((current, key) => current?.[key], obj);
}

/**
 * Set nested object value by path
 * 
 * @param obj - Object to modify
 * @param path - Dot-separated path
 * @param value - Value to set
 */
export function setByPath(obj: any, path: string, value: any): void {
  const keys = path.split('.');
  const lastKey = keys.pop()!;
  
  const target = keys.reduce((current, key) => {
    if (!current[key]) {
      current[key] = {};
    }
    return current[key];
  }, obj);
  
  target[lastKey] = value;
}