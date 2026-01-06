/**
 * Consonant Relayer
 * 
 * Main application orchestrator.
 * Initializes and coordinates all services:
 * - Socket.io client (backend connection)
 * - OTEL receiver (telemetry ingestion)
 * - Kubernetes watchers (resource monitoring)
 * - Telemetry collector (buffering and batching)
 * - Health server (liveness/readiness probes)
 * 
 * Handles graceful shutdown and error recovery.
 */

import { EventEmitter } from 'events';
import { getConfig, printConfig } from './config/index.js';
import { initLogger, getLogger, log } from './utils/logger.js';
import { SocketClient } from './services/socket/client.js';
import { OTELReceiver } from './services/otel/receiver.js';
import { K8sWatcher } from './services/k8s/watcher.js';
import { KagentClient } from './services/k8s/kagent-client.js';
import { WellKnownDiscovery } from './services/k8s/wellknown-discovery.js';
import { TelemetryCollector } from './services/telemetry/collector.js';
import { HealthServer } from './services/health/server.js';
import type {
  TelemetryEvent,
  AgentInvocationRequest,
  AgentInvocationResponse,
  ComponentHealth,
} from './types/index.js';

const APP_VERSION = '1.0.0';

export class Relayer extends EventEmitter {
  private config = getConfig();
  private logger = getLogger();
  
  // Services
  private socketClient?: SocketClient;
  private otelReceiver?: OTELReceiver;
  private k8sWatcher?: K8sWatcher;
  private kagentClient?: KagentClient;
  private wellKnownDiscovery?: WellKnownDiscovery;
  private telemetryCollector?: TelemetryCollector;
  private healthServer?: HealthServer;

  // State
  private running = false;
  private shuttingDown = false;

  constructor() {
    super();
  }

  /**
   * Start all services
   */
  async start(): Promise<void> {
    this.logger.info('='.repeat(80));
    this.logger.info(`🚀 Starting Consonant Relayer v${APP_VERSION}`);
    this.logger.info('='.repeat(80));
    this.logger.info(printConfig(this.config));
    this.logger.info('='.repeat(80));

    try {
      // Initialize services in order
      await this.initTelemetryCollector();
      await this.initSocketClient();
      await this.initKagentClient();
      await this.initWellKnownDiscovery();
      await this.initOTELReceiver();
      await this.initK8sWatcher();
      await this.initHealthServer();

      this.running = true;

      this.logger.info('='.repeat(80));
      this.logger.info('✅ All services started successfully');
      this.logger.info('='.repeat(80));
      this.logger.info({
        cluster: this.config.cluster.name,
        backend: this.config.backend.wsUrl,
        otelPort: this.config.otel.port,
        healthPort: this.config.health.port,
      }, 'Relayer is ready');

      this.emit('ready');
    } catch (error) {
      this.logger.error({ error }, 'Failed to start relayer');
      await this.stop();
      throw error;
    }
  }

  /**
   * Initialize telemetry collector
   */
  private async initTelemetryCollector(): Promise<void> {
    this.logger.info('Initializing telemetry collector...');

    this.telemetryCollector = new TelemetryCollector({
      clusterId: this.config.cluster.id,
      batchSize: this.config.otel.batchSize,
      flushInterval: this.config.otel.flushInterval,
    });

    // Forward batches to backend
    this.telemetryCollector.on('flush', async (events: TelemetryEvent[]) => {
      if (this.socketClient?.isReady()) {
        try {
          await this.socketClient.forwardEvents(events);
        } catch (error) {
          this.logger.error({ error, count: events.length }, 'Failed to forward events');
        }
      } else {
        this.logger.warn({ count: events.length }, 'Cannot forward events: not connected to backend');
      }
    });

    this.logger.info('✓ Telemetry collector initialized');
  }

  /**
   * Initialize Socket.io client
   */
  private async initSocketClient(): Promise<void> {
    this.logger.info('Initializing Socket.io client...');

    this.socketClient = new SocketClient({
      cluster: this.config.cluster,
      backend: this.config.backend,
      kagentVersion: process.env.KAGENT_VERSION,
    });

    // Handle backend disconnection
    this.socketClient.on('disconnected', (reason: string) => {
      this.logger.warn({ reason }, 'Disconnected from backend');
    });

    // Handle reconnection
    this.socketClient.on('reconnected', (attemptNumber: number) => {
      this.logger.info({ attemptNumber }, 'Reconnected to backend');
    });

    // Handle fatal errors
    this.socketClient.on('fatal', (error: Error) => {
      log.fatal(error, { component: 'SocketClient' });
    });

    // Handle agent invocation commands
    this.socketClient.on('invoke:agent', async (request: AgentInvocationRequest) => {
      await this.handleAgentInvocation(request);
    });

    // Connect and register
    await this.socketClient.connect();
    await this.socketClient.register();

    this.logger.info('✓ Socket.io client initialized and registered');
  }

  /**
   * Initialize Kagent client
   */
  private async initKagentClient(): Promise<void> {
    this.logger.info('Initializing Kagent client...');

    this.kagentClient = new KagentClient(this.config.cluster.namespace);

    // Check if Kagent is available
    const available = await this.kagentClient.checkKagentAvailability();
    
    if (!available) {
      this.logger.warn('Kagent CRDs not found - agent invocations will not work');
      this.logger.warn('Please ensure Kagent is installed in the cluster');
    } else {
      this.logger.info('✓ Kagent client initialized and CRDs detected');
    }
  }

  /**
   * Initialize Well-Known Discovery
   */
  private async initWellKnownDiscovery(): Promise<void> {
    this.logger.info('Initializing well-known endpoint discovery...');

    this.wellKnownDiscovery = new WellKnownDiscovery({
      cacheTTL: 300000, // 5 minutes
      timeout: 10000, // 10 seconds
      retryAttempts: 3,
      retryDelay: 1000,
    });

    // Handle discovery events
    this.wellKnownDiscovery.on('discovered', ({ agentId, capabilities }) => {
      this.logger.info({
        agentId,
        capabilitiesCount: capabilities.capabilities.length,
      }, 'Discovered agent capabilities');

      // Send capabilities to backend
      this.socketClient?.sendEvent('agent:capabilities', [{
        type: 'agent:capabilities',
        timestamp: Date.now(),
        clusterId: this.config.cluster.id,
        data: {
          agentId,
          capabilities: capabilities.capabilities,
          version: capabilities.version,
          runtime: capabilities.runtime,
          observability: capabilities.observability,
          performance: capabilities.performance_metadata,
        },
      }]);
    });

    // Start periodic discovery (every 10 minutes)
    this.wellKnownDiscovery.startPeriodicDiscovery(
      async () => {
        const agents = await this.k8sWatcher?.listAgents() || [];
        return agents;
      },
      600000 // 10 minutes
    );

    this.logger.info('✓ Well-known endpoint discovery initialized');
  }

  /**
   * Initialize OTEL receiver
   */
  private async initOTELReceiver(): Promise<void> {
    this.logger.info('Initializing OTEL receiver...');

    this.otelReceiver = new OTELReceiver({
      port: this.config.otel.port,
      clusterId: this.config.cluster.id,
    });

    // Forward OTEL events to collector
    this.otelReceiver.on('traces', (events: TelemetryEvent[]) => {
      this.telemetryCollector?.collectMany(events);
    });

    this.otelReceiver.on('logs', (events: TelemetryEvent[]) => {
      this.telemetryCollector?.collectMany(events);
    });

    this.otelReceiver.on('metrics', (events: TelemetryEvent[]) => {
      this.telemetryCollector?.collectMany(events);
    });

    await this.otelReceiver.start();

    this.logger.info({ port: this.config.otel.port }, '✓ OTEL receiver initialized');
  }

  /**
   * Initialize Kubernetes watcher
   */
  private async initK8sWatcher(): Promise<void> {
    this.logger.info('Initializing Kubernetes watcher...');

    this.k8sWatcher = new K8sWatcher({
      namespace: this.config.cluster.namespace,
      clusterId: this.config.cluster.id,
    });

    // Forward K8s events to collector
    this.k8sWatcher.on('event', (event: TelemetryEvent) => {
      this.telemetryCollector?.collect(event);
    });

    await this.k8sWatcher.start();

    this.logger.info('✓ Kubernetes watcher initialized');
  }

  /**
   * Initialize health server
   */
  private async initHealthServer(): Promise<void> {
    this.logger.info('Initializing health server...');

    this.healthServer = new HealthServer(
      { port: this.config.health.port },
      {
        socket: () => this.getSocketHealth(),
        otel: () => this.getOTELHealth(),
        k8s: () => this.getK8sHealth(),
      }
    );

    await this.healthServer.start();

    this.logger.info({ port: this.config.health.port }, '✓ Health server initialized');
  }

  /**
   * Handle agent invocation request from backend
   */
  private async handleAgentInvocation(request: AgentInvocationRequest): Promise<void> {
    this.logger.info({ request }, 'Handling agent invocation');

    try {
      // Check if Kagent client is available
      if (!this.kagentClient) {
        throw new Error('Kagent client not initialized');
      }

      // Get agent details from K8s watcher
      const agent = await this.k8sWatcher?.getAgent(request.agentName);

      if (!agent) {
        throw new Error(`Agent not found: ${request.agentName}`);
      }

      this.logger.info({
        requestId: request.requestId,
        agentName: request.agentName,
        namespace: request.namespace || this.config.cluster.namespace,
      }, 'Invoking agent via Kagent');

      // Invoke agent via Kagent
      const result = await this.kagentClient.invokeAgent(request);

      // Send successful response to backend
      this.socketClient?.sendInvocationResponse(
        request.requestId,
        result.success,
        result.result,
        result.error
      );

      this.logger.info({
        requestId: request.requestId,
        success: result.success,
        duration: result.duration,
      }, 'Agent invocation completed');

    } catch (error) {
      this.logger.error({ error, request }, 'Agent invocation failed');
      
      // Send error response to backend
      this.socketClient?.sendInvocationResponse(
        request.requestId,
        false,
        undefined,
        error instanceof Error ? error.message : 'Unknown error'
      );
    }
  }

  /**
   * Get Socket.io client health
   */
  private getSocketHealth(): ComponentHealth {
    if (!this.socketClient) {
      return {
        status: 'error',
        message: 'Socket client not initialized',
      };
    }

    const status = this.socketClient.getStatus();

    if (!status.connected) {
      return {
        status: 'error',
        message: 'Not connected to backend',
      };
    }

    if (!status.registered) {
      return {
        status: 'degraded',
        message: 'Connected but not registered',
      };
    }

    return {
      status: 'ok',
      message: 'Connected and registered',
      lastCheck: Date.now(),
    };
  }

  /**
   * Get OTEL receiver health
   */
  private getOTELHealth(): ComponentHealth {
    if (!this.otelReceiver) {
      return {
        status: 'error',
        message: 'OTEL receiver not initialized',
      };
    }

    if (!this.otelReceiver.isRunning()) {
      return {
        status: 'error',
        message: 'OTEL receiver not running',
      };
    }

    return {
      status: 'ok',
      message: 'Receiving telemetry',
      lastCheck: Date.now(),
    };
  }

  /**
   * Get Kubernetes watcher health
   */
  private getK8sHealth(): ComponentHealth {
    if (!this.k8sWatcher) {
      return {
        status: 'error',
        message: 'K8s watcher not initialized',
      };
    }

    if (!this.k8sWatcher.isRunning()) {
      return {
        status: 'error',
        message: 'K8s watcher not running',
      };
    }

    return {
      status: 'ok',
      message: 'Watching resources',
      lastCheck: Date.now(),
    };
  }

  /**
   * Get overall status
   */
  getStatus() {
    return {
      running: this.running,
      shuttingDown: this.shuttingDown,
      socket: this.socketClient?.getStatus(),
      otel: this.otelReceiver?.getStats(),
      k8s: this.k8sWatcher?.getStats(),
      kagent: this.kagentClient ? { initialized: true } : { initialized: false },
      wellknown: this.wellKnownDiscovery?.getCacheStats(),
      telemetry: this.telemetryCollector?.getStats(),
      health: this.healthServer?.getStats(),
    };
  }

  /**
   * Graceful shutdown
   */
  async stop(): Promise<void> {
    if (this.shuttingDown) {
      this.logger.warn('Shutdown already in progress');
      return;
    }

    this.shuttingDown = true;
    this.logger.info('='.repeat(80));
    this.logger.info('🛑 Shutting down gracefully...');
    this.logger.info('='.repeat(80));

    try {
      // Stop services in reverse order
      if (this.healthServer) {
        await this.healthServer.stop();
        this.logger.info('✓ Health server stopped');
      }

      if (this.k8sWatcher) {
        await this.k8sWatcher.stop();
        this.logger.info('✓ Kubernetes watcher stopped');
      }

      if (this.wellKnownDiscovery) {
        await this.wellKnownDiscovery.stop();
        this.logger.info('✓ Well-known discovery stopped');
      }

      if (this.kagentClient) {
        await this.kagentClient.stop();
        this.logger.info('✓ Kagent client stopped');
      }

      if (this.otelReceiver) {
        await this.otelReceiver.stop();
        this.logger.info('✓ OTEL receiver stopped');
      }

      if (this.telemetryCollector) {
        await this.telemetryCollector.stop();
        this.logger.info('✓ Telemetry collector stopped');
      }

      if (this.socketClient) {
        await this.socketClient.disconnect();
        this.logger.info('✓ Socket client disconnected');
      }

      this.running = false;
      this.logger.info('='.repeat(80));
      this.logger.info('✅ Shutdown complete');
      this.logger.info('='.repeat(80));
    } catch (error) {
      this.logger.error({ error }, 'Error during shutdown');
      throw error;
    }
  }
}

/**
 * Setup signal handlers for graceful shutdown
 */
export function setupSignalHandlers(relayer: Relayer): void {
  const logger = getLogger();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Received shutdown signal');

    try {
      await relayer.stop();
      process.exit(0);
    } catch (error) {
      logger.error({ error }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    log.fatal(error, { event: 'uncaughtException' });
  });

  process.on('unhandledRejection', (reason) => {
    log.fatal(
      reason instanceof Error ? reason : new Error(String(reason)),
      { event: 'unhandledRejection' }
    );
  });
}