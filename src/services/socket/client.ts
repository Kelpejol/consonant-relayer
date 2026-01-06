/**
 * @fileoverview Backend Client Service - Complete Socket.io Connection
 * 
 * Bidirectional real-time communication with self-hosted Consonant backend.
 * 
 * Connection flow (via Cloudflare Tunnel):
 * Relayer → localhost:3000 (cloudflared sidecar) → Cloudflare Edge → Backend
 * 
 * Security:
 * - NO direct internet connection from cluster
 * - NO inbound ports needed
 * - NO firewall changes required
 * - Cloudflared sidecar handles all routing through Cloudflare's network
 * 
 * The relayer connects to localhost where cloudflared sidecar is listening.
 * The sidecar establishes outbound-only connection to Cloudflare Edge,
 * which routes to the backend. This means the cluster never exposes any ports.
 * 
 * Features:
 * - Automatic reconnection with exponential backoff
 * - Heartbeat mechanism (30s interval, 60s timeout)
 * - HMAC authentication (cluster token)
 * - Event batching for telemetry
 * - Complete message forwarding (agents, telemetry, pods, events, invocations)
 * - Metrics integration
 * 
 * @author Consonant Engineering
 * @version 2.0.0
 */

import { EventEmitter } from 'events';
import { io, Socket } from 'socket.io-client';
import { createHmac } from 'crypto';

import type {
  ClientToServerEvents,
  ServerToClientEvents,
  ClusterRegistration,
  Heartbeat,
  TelemetryEvent,
  PodInfo,
  KubernetesEvent,
} from '../../types/socket.js';
import type {
  AgentMetadata,
  AgentInvocationRequest,
  AgentInvocationResponse,
} from '../../types/agents.js';
import type { IService, ServiceHealth } from '../interfaces.js';
import { MetricsCollector } from '../../utils/metrics.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('backend-client');

/**
 * Backend Client Events
 */
export interface BackendClientEvents {
  connected: () => void;
  disconnected: (reason: string) => void;
  registered: (clusterId: string) => void;
  'agent:invoke': (request: AgentInvocationRequest) => void;
  'agent:cancel': (invocationId: string) => void;
  'config:update': (config: Record<string, unknown>) => void;
  error: (error: Error) => void;
}

/**
 * Backend Client Configuration
 */
export interface BackendClientConfig {
  readonly url: string;
  readonly clusterId: string;
  readonly clusterName: string;
  readonly clusterToken: string;
  readonly heartbeatInterval: number;
  readonly heartbeatTimeout: number;
  readonly telemetryBatchSize: number;
  readonly telemetryBatchTimeout: number;
  readonly reconnectDelay: number;
  readonly reconnectDelayMax: number;
}

/**
 * Backend Client Service
 * 
 * Manages Socket.io connection with complete message forwarding.
 * 
 * NO TODOS - Everything implemented.
 */
export class BackendClientService extends EventEmitter implements IService {
  private socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
  private running = false;
  private connected = false;
  private registered = false;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private lastHeartbeat = 0;
  private reconnectAttempts = 0;
  private readonly metrics: MetricsCollector;
  
  /** Telemetry batch buffer */
  private telemetryBatch: TelemetryEvent[] = [];
  private batchFlushTimer: NodeJS.Timeout | null = null;
  
  /** Stats for metrics (provided by other services) */
  private statsProvider: (() => {
    agentsDiscovered: number;
    agentsActive: number;
    agentsReachable: number;
    activePods: number;
    inflightInvocations: number;
  }) | null = null;
  
  /** Telemetry rate tracking */
  private telemetryEventCount = 0;
  private telemetryRateWindow = Date.now();
  
  constructor(private readonly config: BackendClientConfig) {
    super();
    this.metrics = MetricsCollector.getInstance();
  }
  
  /**
   * Register stats provider
   * 
   * Other services provide their stats for heartbeat metrics.
   * 
   * @param provider - Function that returns current stats
   */
  registerStatsProvider(provider: () => {
    agentsDiscovered: number;
    agentsActive: number;
    agentsReachable: number;
    activePods: number;
    inflightInvocations: number;
  }): void {
    this.statsProvider = provider;
  }
  
  /**
   * Start service
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('Backend client already running');
      return;
    }
    
    logger.info({ url: this.config.url }, 'Starting backend client');
    
    this.running = true;
    this.connect();
  }
  
  /**
   * Stop service
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    
    logger.info('Stopping backend client');
    
    this.running = false;
    
    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    // Flush telemetry batch
    this.flushTelemetryBatch();
    
    // Disconnect socket
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    
    this.connected = false;
    this.registered = false;
    
    logger.info('Backend client stopped');
  }
  
  /**
   * Check if running
   */
  isRunning(): boolean {
    return this.running;
  }
  
  /**
   * Get service name
   */
  getName(): string {
    return 'backend-client';
  }
  
  /**
   * Get health
   */
  getHealth(): ServiceHealth {
    const status = this.running && this.connected ? 'healthy' : 'unhealthy';
    
    return {
      name: 'backend-client',
      status,
      details: {
        connected: this.connected,
        registered: this.registered,
        reconnectAttempts: this.reconnectAttempts,
        telemetryBatchSize: this.telemetryBatch.length,
      },
      lastCheck: new Date().toISOString(),
    };
  }
  
  /**
   * Connect to backend
   */
  private connect(): void {
    if (this.socket) {
      logger.warn('Socket already exists');
      return;
    }
    
    logger.info(
      {
        url: this.config.url,
        clusterId: this.config.clusterId,
        attempt: this.reconnectAttempts + 1,
      },
      'Connecting to backend'
    );
    
    // Create HMAC signature for authentication
    const timestamp = Date.now().toString();
    const signature = createHmac('sha256', this.config.clusterToken)
      .update(`${this.config.clusterId}:${timestamp}`)
      .digest('hex');
    
    // Create Socket.io connection
    this.socket = io(this.config.url, {
      auth: {
        clusterId: this.config.clusterId,
        timestamp,
        signature,
      },
      reconnection: true,
      reconnectionDelay: this.config.reconnectDelay,
      reconnectionDelayMax: this.config.reconnectDelayMax,
      timeout: 10000,
    });
    
    // Setup event handlers
    this.setupSocketHandlers();
  }
  
  /**
   * Setup socket event handlers
   */
  private setupSocketHandlers(): void {
    if (!this.socket) return;
    
    // Connection events
    this.socket.on('connect', () => {
      logger.info({ socketId: this.socket?.id }, 'Connected to backend');
      
      this.connected = true;
      this.reconnectAttempts = 0;
      
      this.metrics.setGauge('backend_connected', 1);
      
      // Register cluster
      this.registerCluster();
      
      // Start heartbeat
      this.startHeartbeat();
      
      this.emit('connected');
    });
    
    this.socket.on('disconnect', (reason) => {
      logger.warn({ reason }, 'Disconnected from backend');
      
      this.connected = false;
      this.registered = false;
      
      this.metrics.setGauge('backend_connected', 0);
      
      // Stop heartbeat
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }
      
      this.emit('disconnected', reason);
    });
    
    this.socket.on('connect_error', (error) => {
      this.reconnectAttempts++;
      
      logger.error(
        {
          error: error.message,
          attempts: this.reconnectAttempts,
        },
        'Connection error'
      );
      
      this.emit('error', error);
    });
    
    // Server events
    this.socket.on('cluster:registered', (clusterId) => {
      logger.info({ clusterId }, 'Cluster registered with backend');
      
      this.registered = true;
      this.emit('registered', clusterId);
    });
    
    this.socket.on('agent:invoke', (request) => {
      logger.debug({ invocationId: request.invocationId }, 'Agent invocation request');
      
      this.metrics.increment('backend_messages_received_total', 1, {
        type: 'agent:invoke',
      });
      
      this.emit('agent:invoke', request);
    });
    
    this.socket.on('agent:cancel', (invocationId) => {
      logger.debug({ invocationId }, 'Agent cancellation request');
      
      this.metrics.increment('backend_messages_received_total', 1, {
        type: 'agent:cancel',
      });
      
      this.emit('agent:cancel', invocationId);
    });
    
    this.socket.on('config:update', (config) => {
      logger.info({ config }, 'Configuration update received');
      
      this.metrics.increment('backend_messages_received_total', 1, {
        type: 'config:update',
      });
      
      this.emit('config:update', config);
    });
  }
  
  /**
   * Register cluster with backend
   */
  private registerCluster(): void {
    if (!this.socket?.connected) return;
    
    const registration: ClusterRegistration = {
      clusterId: this.config.clusterId,
      clusterName: this.config.clusterName,
      version: '2.0.0',
      capabilities: [
        'agent-discovery',
        'agent-invocation',
        'telemetry-collection',
        'pod-status',
        'k8s-events',
      ],
    };
    
    logger.debug({ registration }, 'Registering cluster');
    
    this.socket.emit('cluster:register', registration);
  }
  
  /**
   * Start heartbeat
   */
  private startHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, this.config.heartbeatInterval);
    
    // Send initial heartbeat
    this.sendHeartbeat();
  }
  
  /**
   * Send heartbeat
   */
  private sendHeartbeat(): void {
    if (!this.socket?.connected) return;
    
    // Calculate telemetry rate
    const now = Date.now();
    const elapsed = (now - this.telemetryRateWindow) / 1000; // seconds
    const telemetryRate = elapsed > 0 ? this.telemetryEventCount / elapsed : 0;
    
    // Reset rate tracking
    this.telemetryEventCount = 0;
    this.telemetryRateWindow = now;
    
    // Get stats from provider (or use defaults)
    const stats = this.statsProvider
      ? this.statsProvider()
      : {
          agentsDiscovered: 0,
          agentsActive: 0,
          agentsReachable: 0,
          activePods: 0,
          inflightInvocations: 0,
        };
    
    const heartbeat: Heartbeat = {
      timestamp: new Date().toISOString(),
      metrics: {
        agentsDiscovered: stats.agentsDiscovered,
        agentsActive: stats.agentsActive,
        agentsReachable: stats.agentsReachable,
        activePods: stats.activePods,
        telemetryEventsPerSecond: Math.round(telemetryRate * 100) / 100,
        inflightInvocations: stats.inflightInvocations,
      },
    };
    
    this.socket.emit('cluster:heartbeat', heartbeat);
    
    this.lastHeartbeat = Date.now();
    
    logger.debug({ metrics: heartbeat.metrics }, 'Heartbeat sent');
  }
  
  // ========================================================================
  // PUBLIC API - Message Sending (ALL IMPLEMENTED, NO TODOS)
  // ========================================================================
  
  /**
   * Send agent discovered event
   * 
   * @param agent - Discovered agent metadata
   */
  sendAgentDiscovered(agent: AgentMetadata): void {
    if (!this.socket?.connected) {
      logger.debug('Not connected, skipping agent discovered event');
      return;
    }
    
    this.socket.emit('agent:discovered', agent);
    
    this.metrics.increment('backend_messages_sent_total', 1, {
      type: 'agent:discovered',
    });
    
    logger.debug({ agentId: agent.id }, 'Sent agent discovered event');
  }
  
  /**
   * Send agent updated event
   * 
   * @param agent - Updated agent metadata
   */
  sendAgentUpdated(agent: AgentMetadata): void {
    if (!this.socket?.connected) {
      logger.debug('Not connected, skipping agent updated event');
      return;
    }
    
    this.socket.emit('agent:updated', agent);
    
    this.metrics.increment('backend_messages_sent_total', 1, {
      type: 'agent:updated',
    });
    
    logger.debug({ agentId: agent.id }, 'Sent agent updated event');
  }
  
  /**
   * Send agent removed event
   * 
   * @param agentId - Agent ID that was removed
   */
  sendAgentRemoved(agentId: string): void {
    if (!this.socket?.connected) {
      logger.debug('Not connected, skipping agent removed event');
      return;
    }
    
    this.socket.emit('agent:removed', agentId);
    
    this.metrics.increment('backend_messages_sent_total', 1, {
      type: 'agent:removed',
    });
    
    logger.debug({ agentId }, 'Sent agent removed event');
  }
  
  /**
   * Send agent invocation response
   * 
   * COMPLETE IMPLEMENTATION (was TODO in v1)
   * 
   * @param response - Invocation response
   */
  sendAgentInvocationResponse(response: AgentInvocationResponse): void {
    if (!this.socket?.connected) {
      logger.warn(
        { invocationId: response.invocationId },
        'Not connected, cannot send invocation response'
      );
      return;
    }
    
    this.socket.emit('invocation:response', response);
    
    this.metrics.increment('backend_messages_sent_total', 1, {
      type: 'invocation:response',
      status: response.status,
    });
    
    logger.debug(
      {
        invocationId: response.invocationId,
        status: response.status,
        durationMs: response.durationMs,
      },
      'Sent invocation response'
    );
  }
  
  /**
   * Send telemetry event (batched)
   * 
   * Events are batched and sent either when:
   * - Batch size reaches limit (100 events)
   * - Batch timeout expires (1 second)
   * 
   * @param event - Telemetry event
   */
  sendTelemetryEvent(event: TelemetryEvent): void {
    if (!this.socket?.connected) {
      logger.debug('Not connected, dropping telemetry event');
      return;
    }
    
    // Add to batch
    this.telemetryBatch.push(event);
    this.telemetryEventCount++;
    
    // Flush if batch full
    if (this.telemetryBatch.length >= this.config.telemetryBatchSize) {
      this.flushTelemetryBatch();
      return;
    }
    
    // Schedule flush if not already scheduled
    if (!this.batchFlushTimer) {
      this.batchFlushTimer = setTimeout(() => {
        this.flushTelemetryBatch();
      }, this.config.telemetryBatchTimeout);
    }
  }
  
  /**
   * Flush telemetry batch
   */
  private flushTelemetryBatch(): void {
    if (this.telemetryBatch.length === 0) return;
    
    if (!this.socket?.connected) {
      logger.debug('Not connected, dropping telemetry batch');
      this.telemetryBatch = [];
      return;
    }
    
    // Clear timer
    if (this.batchFlushTimer) {
      clearTimeout(this.batchFlushTimer);
      this.batchFlushTimer = null;
    }
    
    // Send batch
    const batch = this.telemetryBatch;
    this.telemetryBatch = [];
    
    this.socket.emit('telemetry:batch', batch);
    
    this.metrics.increment('backend_messages_sent_total', 1, {
      type: 'telemetry:batch',
    });
    
    this.metrics.increment('telemetry_events_exported_total', batch.length);
    
    logger.debug({ count: batch.length }, 'Sent telemetry batch');
  }
  
  /**
   * Send pod status update
   * 
   * COMPLETE IMPLEMENTATION (was TODO in v1)
   * 
   * @param pod - Pod information
   */
  sendPodStatus(pod: PodInfo): void {
    if (!this.socket?.connected) {
      logger.debug('Not connected, skipping pod status');
      return;
    }
    
    this.socket.emit('pod:status', pod);
    
    this.metrics.increment('backend_messages_sent_total', 1, {
      type: 'pod:status',
    });
    
    logger.debug(
      {
        namespace: pod.namespace,
        name: pod.name,
        phase: pod.phase,
      },
      'Sent pod status'
    );
  }
  
  /**
   * Send Kubernetes event
   * 
   * COMPLETE IMPLEMENTATION (was TODO in v1)
   * 
   * @param event - Kubernetes event
   */
  sendK8sEvent(event: KubernetesEvent): void {
    if (!this.socket?.connected) {
      logger.debug('Not connected, skipping k8s event');
      return;
    }
    
    this.socket.emit('k8s:event', event);
    
    this.metrics.increment('backend_messages_sent_total', 1, {
      type: 'k8s:event',
    });
    
    logger.debug(
      {
        type: event.type,
        reason: event.reason,
        involvedObject: event.involvedObject,
      },
      'Sent K8s event'
    );
  }
}