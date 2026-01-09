import * as grpc from '@grpc/grpc-js';
import {
  RelayerServiceClient,
  ClientMessage,
  ServerMessage,
  GrpcMetadata,
  credentials
} from '@consonant/proto-relayer';
import { logger } from '../utils/logger.js';
import type { RelayerConfig } from '../config/config.js';

export class GrpcClient {
  private client: RelayerServiceClient | null = null;
  private stream: grpc.ClientDuplexStream<ClientMessage, ServerMessage> | null = null;

  constructor(private config: RelayerConfig) {}

  /**
   * Create gRPC client
   */
  createClient(): RelayerServiceClient {
    const channelCredentials = this.config.grpcEndpoint.startsWith('grpcs://')
      ? credentials.createSsl()
      : credentials.createInsecure();

    // Extract host:port from endpoint
    const endpoint = this.config.grpcEndpoint
      .replace('grpc://', '')
      .replace('grpcs://', '');

    this.client = new RelayerServiceClient(
      endpoint,
      channelCredentials,
      {
        'grpc.keepalive_time_ms': this.config.grpcKeepaliveTime,
        'grpc.keepalive_timeout_ms': this.config.grpcKeepaliveTimeout,
        'grpc.keepalive_permit_without_calls': this.config.grpcKeepalivePermitWithoutStream ? 1 : 0,
        'grpc.http2.min_ping_interval_without_data_ms': 60000,
        'grpc.http2.max_pings_without_data': 0
      }
    );

    logger.info({ endpoint },'[GrpcClient] Client created');

    return this.client;
  }

  /**
   * Open bidirectional stream
   */
  openStream(): grpc.ClientDuplexStream<ClientMessage, ServerMessage> {
    if (!this.client) {
      throw new Error('Client not created');
    }

    // Create metadata with authentication
    const metadata = new GrpcMetadata();
    metadata.set('cluster-id', this.config.clusterId);
    metadata.set('cluster-token', this.config.clusterToken);

    // Open stream
    this.stream = this.client.OpenStream(metadata);

    logger.info('[GrpcClient] Stream opened');

    return this.stream;
  }

  /**
   * Close stream
   */
  closeStream(): void {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
      logger.info('[GrpcClient] Stream closed');
    }
  }

  /**
   * Close client
   */
  close(): void {
    this.closeStream();
    if (this.client) {
      this.client.close();
      this.client = null;
      logger.info('[GrpcClient] Client closed');
    }
  }

  getStream(): grpc.ClientDuplexStream<ClientMessage, ServerMessage> | null {
    return this.stream;
  }
}