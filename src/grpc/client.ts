/**
 * gRPC Client with Bidirectional Streaming
 * 
 * This module provides:
 * - Bidirectional gRPC streaming
 * - Automatic reconnection with exponential backoff
 * - Authentication via metadata
 * - Connection lifecycle management
 * - Error handling and recovery
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import type { Config } from '../config/config.js';
import { logger, createComponentLogger, logError } from '../utils/logger.js';
import type { ClientDuplexStream } from '@grpc/grpc-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ===========================================================================
// TYPES
// ===========================================================================

export interface GrpcClientOptions {
  config: Config;
  onStreamReady?: (stream: ClientDuplexStream<any, any>) => void;
  onStreamError?: (error: Error) => void;
  onStreamEnd?: () => void;
  onStreamData?: (data: any) => void;
}

interface GrpcServiceClient {
  OpenStream: (
    metadata: grpc.Metadata,
    options?: grpc.CallOptions
  ) => ClientDuplexStream<any, any>;
}

// ===========================================================================
// GRPC CLIENT
// ===========================================================================

export class GrpcClient {
  private readonly log = createComponentLogger('GrpcClient');
  private client: GrpcServiceClient | null = null;
  private stream: ClientDuplexStream<any, any> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private isConnecting = false;
  private isShuttingDown = false;
  private messageSequence = 0;

  constructor(private readonly options: GrpcClientOptions) {}

  // -------------------------------------------------------------------------
  // CONNECTION MANAGEMENT
  // -------------------------------------------------------------------------

  /**
   * Initialize the gRPC client and load the proto file
   */
  async initialize(): Promise<void> {
    this.log.info('Initializing gRPC client');

    try {
      // Load proto file
      const protoPath = join(__dirname, '../../proto/relayer.proto');
      
      const packageDefinition = protoLoader.loadSync(protoPath, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
        includeDirs: [join(__dirname, '../../proto')],
      });

      const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as any;
      
      // Get the RelayerService
      const RelayerService = protoDescriptor.consonant.relayer.v1.RelayerService;

      if (!RelayerService) {
        throw new Error('RelayerService not found in proto definition');
      }

      // Create credentials
      const credentials = this.createCredentials();

      // Parse endpoint
      const endpoint = this.parseEndpoint(this.options.config.backend.grpcUrl);

      // Create gRPC options
      const grpcOptions = this.createGrpcOptions();

      // Create client
      this.client = new RelayerService(endpoint, credentials, grpcOptions);

      this.log.info({ endpoint }, 'gRPC client initialized');
    } catch (error) {
      logError(error, { context: 'gRPC client initialization' });
      throw error;
    }
  }

  /**
   * Connect and open the bidirectional stream
   */
  async connect(): Promise<void> {
    if (this.isShuttingDown) {
      this.log.warn('Cannot connect during shutdown');
      return;
    }

    if (this.isConnecting) {
      this.log.debug('Connection already in progress');
      return;
    }

    if (this.stream) {
      this.log.debug('Stream already connected');
      return;
    }

    this.isConnecting = true;

    try {
      this.log.info('Opening gRPC stream');

      if (!this.client) {
        throw new Error('Client not initialized');
      }

      // Create metadata with authentication
      const metadata = this.createMetadata();

      // Open the stream
      this.stream = this.client.OpenStream(metadata);

      // Set up stream handlers
      this.setupStreamHandlers(this.stream);

      // Notify that stream is ready
      if (this.options.onStreamReady) {
        this.options.onStreamReady(this.stream);
      }

      this.log.info('gRPC stream opened successfully');
      
      // Reset reconnect attempts on successful connection
      this.reconnectAttempts = 0;
    } catch (error) {
      logError(error, { context: 'gRPC stream connection' });
      
      // Schedule reconnection
      this.scheduleReconnect();
    } finally {
      this.isConnecting = false;
    }
  }

  /**
   * Send a message through the stream
   */
  sendMessage(message: any): void {
    if (!this.stream) {
      this.log.error('Cannot send message: stream not connected');
      throw new Error('Stream not connected');
    }

    try {
      // Add message ID and timestamp if not present
      if (!message.message_id) {
        message.message_id = this.generateMessageId();
      }
      
      if (!message.timestamp) {
        message.timestamp = this.createTimestamp();
      }

      // Write to stream
      this.stream.write(message);
      
      this.log.debug({ message_id: message.message_id }, 'Message sent');
    } catch (error) {
      logError(error, { context: 'send message' });
      throw error;
    }
  }

  /**
   * Close the stream gracefully
   */
  async close(): Promise<void> {
    this.log.info('Closing gRPC client');
    
    this.isShuttingDown = true;

    // Cancel reconnection timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Close stream
    if (this.stream) {
      try {
        // Send close message
        this.sendMessage({
          close: {
            reason: 'CLOSE_REASON_SHUTDOWN',
            message: 'Relayer shutting down',
            permanent: true,
          },
        });

        // End the stream
        this.stream.end();
        
        // Wait a bit for graceful close
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        logError(error, { context: 'stream close' });
      }
      
      this.stream = null;
    }

    // Close client
    if (this.client) {
      try {
        (this.client as any).close?.();
      } catch (error) {
        logError(error, { context: 'client close' });
      }
      
      this.client = null;
    }

    this.log.info('gRPC client closed');
  }

  // -------------------------------------------------------------------------
  // STREAM HANDLERS
  // -------------------------------------------------------------------------

  private setupStreamHandlers(stream: ClientDuplexStream<any, any>): void {
    // Handle incoming messages
    stream.on('data', (data: any) => {
      this.log.debug({ message_id: data.message_id }, 'Received message from backend');
      
      if (this.options.onStreamData) {
        this.options.onStreamData(data);
      }
    });

    // Handle stream errors
    stream.on('error', (error: Error) => {
      this.log.error({ error }, 'gRPC stream error');
      
      if (this.options.onStreamError) {
        this.options.onStreamError(error);
      }

      // Clear stream reference
      this.stream = null;

      // Schedule reconnection
      if (!this.isShuttingDown) {
        this.scheduleReconnect();
      }
    });

    // Handle stream end
    stream.on('end', () => {
      this.log.info('gRPC stream ended');
      
      if (this.options.onStreamEnd) {
        this.options.onStreamEnd();
      }

      // Clear stream reference
      this.stream = null;

      // Schedule reconnection
      if (!this.isShuttingDown) {
        this.scheduleReconnect();
      }
    });

    // Handle stream close
    stream.on('close', () => {
      this.log.info('gRPC stream closed');
      this.stream = null;
    });
  }

  // -------------------------------------------------------------------------
  // RECONNECTION LOGIC
  // -------------------------------------------------------------------------

  private scheduleReconnect(): void {
    if (this.isShuttingDown) {
      this.log.debug('Not scheduling reconnect during shutdown');
      return;
    }

    if (this.reconnectTimer) {
      this.log.debug('Reconnect already scheduled');
      return;
    }

    if (!this.options.config.reconnection.enabled) {
      this.log.warn('Reconnection disabled, not attempting to reconnect');
      return;
    }

    const delay = this.calculateReconnectDelay();
    
    this.reconnectAttempts++;
    
    this.log.info(
      { attempt: this.reconnectAttempts, delay_ms: delay },
      `Scheduling reconnection attempt ${this.reconnectAttempts}`
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((error) => {
        logError(error, { context: 'reconnection attempt' });
      });
    }, delay);
  }

  private calculateReconnectDelay(): number {
    const config = this.options.config.reconnection;
    
    // Calculate exponential backoff
    let delay = config.initialDelay * Math.pow(config.multiplier, this.reconnectAttempts - 1);
    
    // Cap at max delay
    delay = Math.min(delay, config.maxDelay);
    
    // Add jitter if enabled
    if (config.jitter) {
      const jitterAmount = delay * 0.1; // 10% jitter
      delay += (Math.random() * 2 - 1) * jitterAmount;
    }
    
    return Math.floor(delay);
  }

  // -------------------------------------------------------------------------
  // CREDENTIALS & METADATA
  // -------------------------------------------------------------------------

  private createCredentials(): grpc.ChannelCredentials {
    const tlsConfig = this.options.config.backend.tls;

    if (!tlsConfig.enabled) {
      this.log.info('Using insecure credentials (no TLS)');
      return grpc.credentials.createInsecure();
    }

    this.log.info('Using SSL/TLS credentials');

    try {
      // Load certificates if provided
      const rootCerts = tlsConfig.caPath ? readFileSync(tlsConfig.caPath) : undefined;
      const privateKey = tlsConfig.keyPath ? readFileSync(tlsConfig.keyPath) : undefined;
      const certChain = tlsConfig.certPath ? readFileSync(tlsConfig.certPath) : undefined;

      return grpc.credentials.createSsl(
        rootCerts,
        privateKey,
        certChain,
        tlsConfig.insecureSkipVerify ? { checkServerIdentity: () => undefined } : undefined
      );
    } catch (error) {
      logError(error, { context: 'TLS credentials creation' });
      throw new Error('Failed to create TLS credentials');
    }
  }

  private createMetadata(): grpc.Metadata {
    const metadata = new grpc.Metadata();
    
    // Add authentication headers
    metadata.set('cluster-id', this.options.config.cluster.id);
    metadata.set('cluster-token', this.options.config.cluster.token);
    metadata.set('cluster-name', this.options.config.cluster.name);
    
    if (this.options.config.cluster.region) {
      metadata.set('cluster-region', this.options.config.cluster.region);
    }
    
    if (this.options.config.cluster.environment) {
      metadata.set('cluster-environment', this.options.config.cluster.environment);
    }
    
    return metadata;
  }

  private createGrpcOptions(): grpc.ClientOptions {
    const grpcConfig = this.options.config.grpc;
    
    return {
      'grpc.keepalive_time_ms': grpcConfig.keepaliveTime,
      'grpc.keepalive_timeout_ms': grpcConfig.keepaliveTimeout,
      'grpc.keepalive_permit_without_calls': grpcConfig.keepalivePermitWithoutCalls ? 1 : 0,
      'grpc.max_receive_message_length': grpcConfig.maxReceiveMessageLength,
      'grpc.max_send_message_length': grpcConfig.maxSendMessageLength,
      'grpc.enable_retries': grpcConfig.enableRetry ? 1 : 0,
      'grpc.service_config': JSON.stringify({
        methodConfig: [{
          name: [{ service: 'consonant.relayer.v1.RelayerService' }],
          retryPolicy: {
            maxAttempts: grpcConfig.maxRetryAttempts,
            initialBackoff: '0.1s',
            maxBackoff: '1s',
            backoffMultiplier: 2,
            retryableStatusCodes: ['UNAVAILABLE', 'DEADLINE_EXCEEDED'],
          },
        }],
      }),
    };
  }

  // -------------------------------------------------------------------------
  // UTILITIES
  // -------------------------------------------------------------------------

  private parseEndpoint(grpcUrl: string): string {
    // Remove protocol prefix
    return grpcUrl.replace(/^grpcs?:\/\//, '');
  }

  private generateMessageId(): string {
    this.messageSequence++;
    return `msg_${Date.now()}_${this.messageSequence}_${Math.random().toString(36).substring(2, 9)}`;
  }

  private createTimestamp(): { seconds: number; nanos: number } {
    const now = Date.now();
    return {
      seconds: Math.floor(now / 1000),
      nanos: (now % 1000) * 1000000,
    };
  }

  // -------------------------------------------------------------------------
  // STATUS
  // -------------------------------------------------------------------------

  /**
   * Check if stream is connected
   */
  isConnected(): boolean {
    return this.stream !== null && !this.isShuttingDown;
  }

  /**
   * Get reconnection status
   */
  getReconnectionStatus(): {
    attempts: number;
    nextAttemptIn: number | null;
  } {
    return {
      attempts: this.reconnectAttempts,
      nextAttemptIn: this.reconnectTimer ? this.calculateReconnectDelay() : null,
    };
  }
}