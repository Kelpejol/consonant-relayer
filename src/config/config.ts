import { logger } from '../utils/logger.js';

export interface RelayerConfig {
  // Cluster identity
  clusterId: string;
  clusterToken: string;
  clusterName: string;
  namespace: string;
  region?: string;
  environment?: string;

  // gRPC configuration
  grpcEndpoint: string;
  grpcKeepaliveTime: number;
  grpcKeepaliveTimeout: number;
  grpcKeepalivePermitWithoutStream: boolean;

  // Reconnection configuration
  reconnectInitialDelay: number;
  reconnectMaxDelay: number;
  reconnectMultiplier: number;
  reconnectJitter: number;

  // Circuit breaker configuration
  circuitBreakerEnabled: boolean;
  circuitBreakerFailureThreshold: number;
  circuitBreakerSuccessThreshold: number;
  circuitBreakerTimeout: number;

  // Health configuration
  healthPort: number;

  // Logging
  logLevel: string;
}

export function loadConfig(): RelayerConfig {
  // Required environment variables
  const required = [
    'CLUSTER_ID',
    'CLUSTER_TOKEN',
    'CLUSTER_NAME',
    'NAMESPACE',
    'GRPC_ENDPOINT'
  ];

  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }

  const config: RelayerConfig = {
    // Cluster identity
    clusterId: process.env.CLUSTER_ID!,
    clusterToken: process.env.CLUSTER_TOKEN!,
    clusterName: process.env.CLUSTER_NAME!,
    namespace: process.env.NAMESPACE!,
    region: process.env.CLUSTER_REGION,
    environment: process.env.CLUSTER_ENVIRONMENT,

    // gRPC configuration
    grpcEndpoint: process.env.GRPC_ENDPOINT!,
    grpcKeepaliveTime: parseInt(process.env.GRPC_KEEPALIVE_TIME || '30000'),
    grpcKeepaliveTimeout: parseInt(process.env.GRPC_KEEPALIVE_TIMEOUT || '10000'),
    grpcKeepalivePermitWithoutStream: process.env.GRPC_KEEPALIVE_PERMIT_WITHOUT_STREAM !== 'false',

    // Reconnection configuration
    reconnectInitialDelay: parseInt(process.env.RECONNECT_INITIAL_DELAY || '1000'),
    reconnectMaxDelay: parseInt(process.env.RECONNECT_MAX_DELAY || '30000'),
    reconnectMultiplier: parseFloat(process.env.RECONNECT_MULTIPLIER || '2'),
    reconnectJitter: parseFloat(process.env.RECONNECT_JITTER || '0.25'),

    // Circuit breaker configuration
    circuitBreakerEnabled: process.env.CIRCUIT_BREAKER_ENABLED !== 'false',
    circuitBreakerFailureThreshold: parseInt(process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD || '5'),
    circuitBreakerSuccessThreshold: parseInt(process.env.CIRCUIT_BREAKER_SUCCESS_THRESHOLD || '2'),
    circuitBreakerTimeout: parseInt(process.env.CIRCUIT_BREAKER_TIMEOUT || '60000'),

    // Health configuration
    healthPort: parseInt(process.env.HEALTH_PORT || '8080'),

    // Logging
    logLevel: process.env.LOG_LEVEL || 'info'
  };

  logger.debug({ config },'Configuration loaded');

  return config;
}