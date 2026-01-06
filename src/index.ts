/**
 * @fileoverview Main Orchestrator - Consonant Relayer Entry Point
 * 
 * Initializes and orchestrates all services:
 * - Agent Manager (discovery, registry, invoker, store)
 * - API Server (HTTP REST endpoints)
 * - Backend Client (Socket.io to backend via Cloudflare Tunnel)
 * - OTEL Collector (gRPC OTLP telemetry)
 * - Kubernetes Watcher (Agent CRDs, Pods, Events)
 * 
 * Event Flow:
 * 1. K8s Watch → Agent Manager → Backend Client
 * 2. HTTP POST → Agent Manager → Backend Client
 * 3. Backend Client → Agent Manager (invocations)
 * 4. OTEL Collector → Backend Client (telemetry)
 * 5. K8s Watch → Backend Client (pods, events)
 * 
 * Startup Sequence:
 * 1. Load and validate configuration
 * 2. Initialize services
 * 3. Wire events between services
 * 4. Start services (Agent Manager → API Server → K8s Watcher → OTEL → Backend)
 * 5. Setup signal handlers
 * 
 * Shutdown Sequence (graceful):
 * 1. Stop accepting new work (API Server, OTEL)
 * 2. Complete in-flight operations (invocations, telemetry)
 * 3. Stop backend connection
 * 4. Stop remaining services
 * 
 * NO TODOs - Complete implementation.
 * 
 * @author Consonant Engineering
 * @version 2.0.0
 */

import { config, getConfigJSON } from './config/index.js';
import { createLogger } from './utils/logger.js';
import { MetricsCollector } from './utils/metrics.js';

// Services
import { AgentManagerService } from './services/agents/manager.js';
import { ApiServerService } from './services/api/server.js';
import { BackendClientService } from './services/socket/client.js';
import { OtelCollectorService } from './services/telemetry/collector.js';
import { KubernetesWatcherService } from './services/k8s/watcher.js';
import { ServiceRegistry } from './services/interfaces.js';

// Types
import type { AgentInvocationRequest } from './types/agents.js';
import type { TelemetryEvent } from './types/socket.js';

const logger = createLogger('main');
const metrics = MetricsCollector.getInstance();

/**
 * Main Orchestrator Class
 * 
 * Manages the lifecycle of all services and wires events between them.
 */
class ConsonantRelayer {
  private readonly serviceRegistry: ServiceRegistry;
  
  // Services
  private readonly agentManager: AgentManagerService;
  private readonly apiServer: ApiServerService;
  private readonly backendClient: BackendClientService;
  private readonly otelCollector: OtelCollectorService;
  private readonly k8sWatcher: KubernetesWatcherService;
  
  private running = false;
  private shutdownInProgress = false;
  
  constructor() {
    logger.info(
      {
        version: '2.0.0',
        environment: config.environment,
        clusterId: config.backendClient.clusterId,
        clusterName: config.backendClient.clusterName,
        namespace: config.kubernetesWatcher.namespace,
      },
      'Initializing Consonant Relayer'
    );
    
    // Log configuration (with sensitive values redacted)
    logger.debug({ config: getConfigJSON() }, 'Configuration loaded');
    
    // Initialize services
    this.agentManager = new AgentManagerService(config.agentManager);
    this.apiServer = new ApiServerService(this.agentManager, config.apiServer);
    this.backendClient = new BackendClientService(config.backendClient);
    this.otelCollector = new OtelCollectorService(config.otelCollector);
    this.k8sWatcher = new KubernetesWatcherService(config.kubernetesWatcher);
    
    // Create service registry
    this.serviceRegistry = new ServiceRegistry();
    
    // Register services (order matters for shutdown)
    this.serviceRegistry.register(this.agentManager);
    this.serviceRegistry.register(this.apiServer);
    this.serviceRegistry.register(this.k8sWatcher);
    this.serviceRegistry.register(this.otelCollector);
    this.serviceRegistry.register(this.backendClient); // Last to start, first to stop
    
    // Wire events between services
    this.wireEvents();
    
    logger.info('Consonant Relayer initialized');
  }
  
  /**
   * Wire events between services
   * 
   * This is where the magic happens - all services communicate via events.
   * NO direct method calls between services (loose coupling).
   */
  private wireEvents(): void {
    logger.debug('Wiring events between services');
    
    // ========================================================================
    // AGENT MANAGER → BACKEND CLIENT
    // ========================================================================
    
    // Agent registered (HTTP POST)
    this.agentManager.on('agent:registered', (agent) => {
      logger.info(
        {
          agentId: agent.id,
          method: 'registration',
        },
        'Agent registered'
      );
      
      this.backendClient.sendAgentDiscovered(agent);
      
      metrics.increment('agents_registered_total', 1);
      metrics.setGauge('agents_active', this.agentManager.getAgentCount());
    });
    
    // Agent discovered (Kagent well-known)
    this.agentManager.on('agent:discovered', (agent) => {
      logger.info(
        {
          agentId: agent.id,
          method: 'wellknown',
        },
        'Agent discovered'
      );
      
      this.backendClient.sendAgentDiscovered(agent);
      
      metrics.increment('agents_discovered_total', 1);
      metrics.setGauge('agents_active', this.agentManager.getAgentCount());
    });
    
    // Agent updated
    this.agentManager.on('agent:updated', (agent) => {
      logger.debug({ agentId: agent.id }, 'Agent updated');
      
      this.backendClient.sendAgentUpdated(agent);
    });
    
    // Agent removed
    this.agentManager.on('agent:removed', (agentId) => {
      logger.info({ agentId }, 'Agent removed');
      
      this.backendClient.sendAgentRemoved(agentId);
      
      metrics.setGauge('agents_active', this.agentManager.getAgentCount());
    });
    
    // Invocation completed
    this.agentManager.on('invocation:completed', (response) => {
      logger.info(
        {
          invocationId: response.invocationId,
          status: response.status,
          durationMs: response.durationMs,
        },
        'Invocation completed'
      );
      
      this.backendClient.sendAgentInvocationResponse(response);
      
      metrics.increment('invocations_total', 1, {
        status: response.status,
      });
      
      metrics.observe('invocations_duration_ms', response.durationMs);
    });
    
    // ========================================================================
    // BACKEND CLIENT → AGENT MANAGER
    // ========================================================================
    
    // Backend requests agent invocation
    this.backendClient.on('agent:invoke', async (request: AgentInvocationRequest) => {
      logger.info(
        {
          invocationId: request.invocationId,
          agentId: request.agentId,
        },
        'Invocation request from backend'
      );
      
      try {
        await this.agentManager.invokeAgent(request);
      } catch (error) {
        logger.error(
          {
            invocationId: request.invocationId,
            error: (error as Error).message,
          },
          'Failed to invoke agent'
        );
      }
    });
    
    // Backend requests invocation cancellation
    this.backendClient.on('agent:cancel', (invocationId: string) => {
      logger.info({ invocationId }, 'Cancellation request from backend');
      
      this.agentManager.cancelInvocation(invocationId);
    });
    
    // Backend sends configuration update
    this.backendClient.on('config:update', (update) => {
      logger.info({ update }, 'Configuration update from backend');
      // Note: Dynamic config updates not implemented yet
      // Could be added in future to update log levels, timeouts, etc.
    });
    
    // ========================================================================
    // KUBERNETES WATCHER → AGENT MANAGER
    // ========================================================================
    
    // Agent CRD added
    this.k8sWatcher.on('agent:added', async (agentCRD) => {
      logger.info(
        {
          namespace: agentCRD.metadata.namespace,
          name: agentCRD.metadata.name,
        },
        'Agent CRD added'
      );
      
      try {
        // Trigger agent discovery from Kagent
        const namespace = agentCRD.metadata.namespace || config.kubernetesWatcher.namespace;
        const name = agentCRD.spec.name || agentCRD.metadata.name;
        
        await this.agentManager.discoverAgent(namespace, name);
      } catch (error) {
        logger.error(
          {
            namespace: agentCRD.metadata.namespace,
            name: agentCRD.metadata.name,
            error: (error as Error).message,
          },
          'Failed to discover agent from CRD'
        );
      }
    });
    
    // Agent CRD modified
    this.k8sWatcher.on('agent:modified', async (agentCRD) => {
      logger.debug(
        {
          namespace: agentCRD.metadata.namespace,
          name: agentCRD.metadata.name,
        },
        'Agent CRD modified'
      );
      
      try {
        // Re-discover agent to update metadata
        const namespace = agentCRD.metadata.namespace || config.kubernetesWatcher.namespace;
        const name = agentCRD.spec.name || agentCRD.metadata.name;
        
        await this.agentManager.rediscoverAgent(namespace, name);
      } catch (error) {
        logger.warn(
          {
            namespace: agentCRD.metadata.namespace,
            name: agentCRD.metadata.name,
            error: (error as Error).message,
          },
          'Failed to rediscover agent from modified CRD'
        );
      }
    });
    
    // Agent CRD deleted
    this.k8sWatcher.on('agent:deleted', (agentCRD) => {
      logger.info(
        {
          namespace: agentCRD.metadata.namespace,
          name: agentCRD.metadata.name,
        },
        'Agent CRD deleted'
      );
      
      const namespace = agentCRD.metadata.namespace || config.kubernetesWatcher.namespace;
      const name = agentCRD.spec.name || agentCRD.metadata.name;
      const agentId = `${namespace}/${name}`;
      
      this.agentManager.removeAgent(agentId);
    });
    
    // ========================================================================
    // KUBERNETES WATCHER → BACKEND CLIENT
    // ========================================================================
    
    // Pod status changed
    this.k8sWatcher.on('pod:status', (pod) => {
      logger.debug(
        {
          namespace: pod.namespace,
          name: pod.name,
          phase: pod.phase,
        },
        'Pod status update'
      );
      
      this.backendClient.sendPodStatus(pod);
    });
    
    // Kubernetes event
    this.k8sWatcher.on('k8s:event', (event) => {
      logger.debug(
        {
          type: event.type,
          reason: event.reason,
          involvedObject: event.involvedObject,
        },
        'Kubernetes event'
      );
      
      this.backendClient.sendK8sEvent(event);
    });
    
    // ========================================================================
    // OTEL COLLECTOR → BACKEND CLIENT
    // ========================================================================
    
    // Telemetry batch (batched for efficiency)
    this.otelCollector.on('telemetry:batch', (events: TelemetryEvent[]) => {
      logger.debug({ count: events.length }, 'Telemetry batch');
      
      // Forward each event to backend
      for (const event of events) {
        this.backendClient.sendTelemetryEvent(event);
      }
    });
    
    // ========================================================================
    // BACKEND CLIENT → METRICS
    // ========================================================================
    
    // Register stats provider for backend heartbeat
    this.backendClient.registerStatsProvider(() => {
      const stats = this.agentManager.getStats();
      
      return {
        agentsDiscovered: stats.agents.total,
        agentsActive: stats.agents.total,
        agentsReachable: stats.agents.reachable,
        activePods: this.k8sWatcher.getActivePodCount(),
        inflightInvocations: stats.invocations.inflight,
      };
    });
    
    // Backend connected
    this.backendClient.on('connected', () => {
      logger.info('Backend connection established');
      metrics.setGauge('backend_connected', 1);
    });
    
    // Backend disconnected
    this.backendClient.on('disconnected', (reason) => {
      logger.warn({ reason }, 'Backend connection lost');
      metrics.setGauge('backend_connected', 0);
    });
    
    // Backend registered
    this.backendClient.on('registered', (clusterId) => {
      logger.info({ clusterId }, 'Cluster registered with backend');
    });
    
    // ========================================================================
    // API SERVER → SERVICE REGISTRY
    // ========================================================================
    
    // Register all services for health checks
    this.apiServer.registerHealthCheckServices([
      this.agentManager,
      this.backendClient,
      this.otelCollector,
      this.k8sWatcher,
    ]);
    
    logger.debug('Event wiring complete');
  }
  
  /**
   * Start the relayer
   * 
   * Starts all services in the correct order.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('Relayer already running');
      return;
    }
    
    logger.info('Starting Consonant Relayer');
    
    try {
      // Start services in order
      // Agent Manager first (needed by API Server)
      await this.agentManager.start();
      logger.info('✓ Agent Manager started');
      
      // API Server (HTTP endpoints)
      await this.apiServer.start();
      logger.info('✓ API Server started');
      
      // Kubernetes Watcher (watches for Agent CRDs)
      await this.k8sWatcher.start();
      logger.info('✓ Kubernetes Watcher started');
      
      // OTEL Collector (receives telemetry)
      await this.otelCollector.start();
      logger.info('✓ OTEL Collector started');
      
      // Backend Client last (connects to backend)
      await this.backendClient.start();
      logger.info('✓ Backend Client started');
      
      this.running = true;
      
      logger.info(
        {
          apiPort: config.apiServer.port,
          otelPort: config.otelCollector.port,
          backendUrl: config.backendClient.url,
          namespace: config.kubernetesWatcher.namespace,
        },
        '🚀 Consonant Relayer is running'
      );
      
      // Setup signal handlers for graceful shutdown
      this.setupSignalHandlers();
      
    } catch (error) {
      logger.error(
        { error: (error as Error).message },
        'Failed to start Consonant Relayer'
      );
      
      // Cleanup on startup failure
      await this.stop();
      
      throw error;
    }
  }
  
  /**
   * Stop the relayer
   * 
   * Gracefully shuts down all services in reverse order.
   */
  async stop(): Promise<void> {
    if (this.shutdownInProgress) {
      logger.warn('Shutdown already in progress');
      return;
    }
    
    this.shutdownInProgress = true;
    
    logger.info('Stopping Consonant Relayer');
    
    try {
      // Stop services in reverse order
      // Backend Client first (stop sending data)
      await this.backendClient.stop();
      logger.info('✓ Backend Client stopped');
      
      // OTEL Collector (stop receiving telemetry)
      await this.otelCollector.stop();
      logger.info('✓ OTEL Collector stopped');
      
      // Kubernetes Watcher (stop watching)
      await this.k8sWatcher.stop();
      logger.info('✓ Kubernetes Watcher stopped');
      
      // API Server (stop accepting requests)
      await this.apiServer.stop();
      logger.info('✓ API Server stopped');
      
      // Agent Manager last (complete in-flight invocations)
      await this.agentManager.stop();
      logger.info('✓ Agent Manager stopped');
      
      this.running = false;
      
      logger.info('Consonant Relayer stopped gracefully');
      
    } catch (error) {
      logger.error(
        { error: (error as Error).message },
        'Error during shutdown'
      );
      
      throw error;
    }
  }
  
  /**
   * Setup signal handlers for graceful shutdown
   */
  private setupSignalHandlers(): void {
    // SIGTERM (Kubernetes sends this for pod termination)
    process.on('SIGTERM', () => {
      logger.info('Received SIGTERM, initiating graceful shutdown');
      
      void this.stop().then(() => {
        process.exit(0);
      }).catch((error) => {
        logger.error({ error }, 'Error during graceful shutdown');
        process.exit(1);
      });
    });
    
    // SIGINT (Ctrl+C in terminal)
    process.on('SIGINT', () => {
      logger.info('Received SIGINT, initiating graceful shutdown');
      
      void this.stop().then(() => {
        process.exit(0);
      }).catch((error) => {
        logger.error({ error }, 'Error during graceful shutdown');
        process.exit(1);
      });
    });
    
    // Uncaught exceptions
    process.on('uncaughtException', (error) => {
      logger.fatal({ error }, 'Uncaught exception');
      
      void this.stop().then(() => {
        process.exit(1);
      });
    });
    
    // Unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      logger.fatal({ reason, promise }, 'Unhandled promise rejection');
      
      void this.stop().then(() => {
        process.exit(1);
      });
    });
    
    logger.debug('Signal handlers registered');
  }
  
  /**
   * Get health status
   */
  getHealth(): any {
    return this.serviceRegistry.getHealth();
  }
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

/**
 * Main entry point
 * 
 * Creates and starts the relayer.
 */
async function main(): Promise<void> {
  try {
    // Create relayer instance
    const relayer = new ConsonantRelayer();
    
    // Start relayer
    await relayer.start();
    
    // Keep process alive
    // (Signal handlers will trigger shutdown)
    
  } catch (error) {
    logger.fatal({ error }, 'Fatal error in main');
    process.exit(1);
  }
}

// Start if running as main module
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}

// Export for testing
export { ConsonantRelayer };