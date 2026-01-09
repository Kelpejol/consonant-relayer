/**
 * Configuration Management
 * 
 * This module handles all configuration loading with:
 * - Type-safe validation using Zod
 * - Sensible defaults
 * - Environment variable parsing
 * - Secret handling (never log secrets)
 * 
 * Configuration is loaded once at startup and is immutable.
 */

import { z } from 'zod';

// ===========================================================================
// CONFIGURATION SCHEMA
// ===========================================================================

const ConfigSchema = z.object({
  // -------------------------------------------------------------------------
  // Cluster Identity (REQUIRED - from secrets)
  // -------------------------------------------------------------------------
  cluster: z.object({
    id: z.string().min(1, 'CLUSTER_ID is required'),
    token: z.string().min(32, 'CLUSTER_TOKEN must be at least 32 characters'),
    name: z.string().min(1, 'CLUSTER_NAME is required'),
    region: z.string().optional(),
    environment: z.enum(['production', 'staging', 'development', 'test']).default('production'),
  }),

  // -------------------------------------------------------------------------
  // Backend Connection (REQUIRED)
  // -------------------------------------------------------------------------
  backend: z.object({
    // gRPC endpoint (format: grpc://host:port or grpcs://host:port)
    grpcUrl: z.string().url('Invalid BACKEND_GRPC_URL format'),
    
    // TLS configuration
    tls: z.object({
      enabled: z.boolean().default(false),
      certPath: z.string().optional(),
      keyPath: z.string().optional(),
      caPath: z.string().optional(),
      insecureSkipVerify: z.boolean().default(false),
    }),
  }),

  // -------------------------------------------------------------------------
  // gRPC Configuration
  // -------------------------------------------------------------------------
  grpc: z.object({
    // Keepalive settings (milliseconds)
    keepaliveTime: z.number().min(1000).default(30000),
    keepaliveTimeout: z.number().min(1000).default(10000),
    keepalivePermitWithoutCalls: z.boolean().default(true),
    
    // Connection settings
    maxReceiveMessageLength: z.number().default(100 * 1024 * 1024), // 100MB
    maxSendMessageLength: z.number().default(100 * 1024 * 1024),    // 100MB
    
    // Retry settings
    enableRetry: z.boolean().default(true),
    maxRetryAttempts: z.number().min(1).default(5),
  }),

  // -------------------------------------------------------------------------
  // Reconnection Strategy
  // -------------------------------------------------------------------------
  reconnection: z.object({
    enabled: z.boolean().default(true),
    initialDelay: z.number().min(100).default(1000),      // 1 second
    maxDelay: z.number().min(1000).default(60000),        // 60 seconds
    multiplier: z.number().min(1).default(2),
    jitter: z.boolean().default(true),
  }),

  // -------------------------------------------------------------------------
  // Heartbeat Configuration
  // -------------------------------------------------------------------------
  heartbeat: z.object({
    interval: z.number().min(1000).default(30000),        // 30 seconds
    timeout: z.number().min(1000).default(10000),         // 10 seconds
  }),

  // -------------------------------------------------------------------------
  // Kagent Configuration
  // -------------------------------------------------------------------------
  kagent: z.object({
    // Kagent service URL (in-cluster)
    serviceUrl: z.string().url().default('http://kagent-controller.kagent.svc.cluster.local:8083'),
    
    // Timeout for A2A API calls (milliseconds)
    timeout: z.number().min(1000).default(30000),
    
    // Retry settings
    maxRetries: z.number().min(0).default(3),
  }),

  // -------------------------------------------------------------------------
  // Kubernetes Configuration
  // -------------------------------------------------------------------------
  kubernetes: z.object({
    // Namespace (auto-detected from service account if not provided)
    namespace: z.string().optional(),
    
    // Watch settings
    watch: z.object({
      timeout: z.number().min(1000).default(300000),      // 5 minutes
      allowWatchBookmarks: z.boolean().default(true),
      reconnectDelay: z.number().min(100).default(5000),  // 5 seconds
    }),
  }),

  // -------------------------------------------------------------------------
  // Logging Configuration
  // -------------------------------------------------------------------------
  logging: z.object({
    level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    pretty: z.boolean().default(false),
    
    // Redact sensitive fields
    redact: z.array(z.string()).default([
      'cluster.token',
      'backend.tls.key',
      'password',
      'secret',
      'token',
      'authorization',
    ]),
  }),

  // -------------------------------------------------------------------------
  // Graceful Shutdown
  // -------------------------------------------------------------------------
  shutdown: z.object({
    // How long to wait for in-flight commands (milliseconds)
    gracePeriod: z.number().min(0).default(30000),        // 30 seconds
    
    // How long to wait for event flush (milliseconds)
    flushTimeout: z.number().min(0).default(5000),        // 5 seconds
  }),

  // -------------------------------------------------------------------------
  // Feature Flags
  // -------------------------------------------------------------------------
  features: z.object({
    // Enable watching pods
    watchPods: z.boolean().default(true),
    
    // Enable watching K8s events
    watchK8sEvents: z.boolean().default(true),
    
    // Enable metrics collection
    metricsEnabled: z.boolean().default(true),
  }),
});

// Export the inferred type
export type Config = z.infer<typeof ConfigSchema>;

// ===========================================================================
// CONFIGURATION LOADER
// ===========================================================================

/**
 * Load and validate configuration from environment variables
 * 
 * @throws {z.ZodError} If configuration is invalid
 * @returns {Config} Validated configuration
 */
export function loadConfig(): Config {
  const rawConfig = {
    cluster: {
      id: process.env['CLUSTER_ID'],
      token: process.env['CLUSTER_TOKEN'],
      name: process.env['CLUSTER_NAME'],
      region: process.env['CLUSTER_REGION'],
      environment: process.env['CLUSTER_ENVIRONMENT'] || 'production',
    },
    backend: {
      grpcUrl: process.env['BACKEND_GRPC_URL'],
      tls: {
        enabled: process.env['BACKEND_TLS_ENABLED'] === 'true',
        certPath: process.env['BACKEND_TLS_CERT_PATH'],
        keyPath: process.env['BACKEND_TLS_KEY_PATH'],
        caPath: process.env['BACKEND_TLS_CA_PATH'],
        insecureSkipVerify: process.env['BACKEND_TLS_INSECURE_SKIP_VERIFY'] === 'true',
      },
    },
    grpc: {
      keepaliveTime: parseInt(process.env['GRPC_KEEPALIVE_TIME'] || '30000', 10),
      keepaliveTimeout: parseInt(process.env['GRPC_KEEPALIVE_TIMEOUT'] || '10000', 10),
      keepalivePermitWithoutCalls: process.env['GRPC_KEEPALIVE_PERMIT_WITHOUT_CALLS'] !== 'false',
      maxReceiveMessageLength: parseInt(process.env['GRPC_MAX_RECEIVE_MESSAGE_LENGTH'] || '104857600', 10),
      maxSendMessageLength: parseInt(process.env['GRPC_MAX_SEND_MESSAGE_LENGTH'] || '104857600', 10),
      enableRetry: process.env['GRPC_ENABLE_RETRY'] !== 'false',
      maxRetryAttempts: parseInt(process.env['GRPC_MAX_RETRY_ATTEMPTS'] || '5', 10),
    },
    reconnection: {
      enabled: process.env['RECONNECTION_ENABLED'] !== 'false',
      initialDelay: parseInt(process.env['RECONNECTION_INITIAL_DELAY'] || '1000', 10),
      maxDelay: parseInt(process.env['RECONNECTION_MAX_DELAY'] || '60000', 10),
      multiplier: parseFloat(process.env['RECONNECTION_MULTIPLIER'] || '2'),
      jitter: process.env['RECONNECTION_JITTER'] !== 'false',
    },
    heartbeat: {
      interval: parseInt(process.env['HEARTBEAT_INTERVAL'] || '30000', 10),
      timeout: parseInt(process.env['HEARTBEAT_TIMEOUT'] || '10000', 10),
    },
    kagent: {
      serviceUrl: process.env['KAGENT_SERVICE_URL'] || 'http://kagent-controller.kagent.svc.cluster.local:8083',
      timeout: parseInt(process.env['KAGENT_TIMEOUT'] || '30000', 10),
      maxRetries: parseInt(process.env['KAGENT_MAX_RETRIES'] || '3', 10),
    },
    kubernetes: {
      namespace: process.env['NAMESPACE'],
      watch: {
        timeout: parseInt(process.env['K8S_WATCH_TIMEOUT'] || '300000', 10),
        allowWatchBookmarks: process.env['K8S_WATCH_ALLOW_BOOKMARKS'] !== 'false',
        reconnectDelay: parseInt(process.env['K8S_WATCH_RECONNECT_DELAY'] || '5000', 10),
      },
    },
    logging: {
      level: process.env['LOG_LEVEL'] || 'info',
      pretty: process.env['LOG_PRETTY'] === 'true',
    },
    shutdown: {
      gracePeriod: parseInt(process.env['SHUTDOWN_GRACE_PERIOD'] || '30000', 10),
      flushTimeout: parseInt(process.env['SHUTDOWN_FLUSH_TIMEOUT'] || '5000', 10),
    },
    features: {
      watchPods: process.env['FEATURE_WATCH_PODS'] !== 'false',
      watchK8sEvents: process.env['FEATURE_WATCH_K8S_EVENTS'] !== 'false',
      metricsEnabled: process.env['FEATURE_METRICS_ENABLED'] !== 'false',
    },
  };

  // Validate and parse
  const config = ConfigSchema.parse(rawConfig);

  return config;
}

/**
 * Get a safe version of config for logging (secrets redacted)
 */
export function getSafeConfigForLogging(config: Config): Record<string, unknown> {
  return {
    cluster: {
      id: config.cluster.id,
      name: config.cluster.name,
      region: config.cluster.region,
      environment: config.cluster.environment,
      token: '***REDACTED***',
    },
    backend: {
      grpcUrl: config.backend.grpcUrl,
      tls: {
        enabled: config.backend.tls.enabled,
      },
    },
    grpc: config.grpc,
    reconnection: config.reconnection,
    heartbeat: config.heartbeat,
    kagent: config.kagent,
    kubernetes: config.kubernetes,
    logging: config.logging,
    shutdown: config.shutdown,
    features: config.features,
  };
}