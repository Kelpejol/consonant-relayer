

/**
 * 
 * 
 * Stateless gRPC bidirectional streaming relayer for Kubernetes.
 * 
 * Architecture:
 * - NO HTTP server (pure gRPC client)
 * - Completely stateless (no storage)
 * - Outbound-only connectivity
 * - Events sent immediately via gRPC
 * - Agent deployment via Kubernetes API
 * - Agent invocation via Kagent A2A API
 * 
 * Flow:
 * 1. Initialize configuration and logging
 * 2. Connect to Kubernetes API
 * 3. Connect to Kagent A2A API
 * 4. Connect to backend via gRPC bidirectional stream
 * 5. Start Kubernetes watchers (Agent CRDs, Pods, Events)
 * 6. Start heartbeat to backend
 * 7. Handle commands from backend
 * 8. Emit events to backend
 * 9. Gracefully shutdown on SIGTERM/SIGINT
 */

import { loadConfig, getSafeConfigForLogging } from './config/config.js';
import { initializeLogger, logger } from './utils/logger.js';
import { GrpcClient } from './grpc/client.js';
import { KubernetesClient } from './k8s/client.js';
import { KagentA2AClient } from './kagent/client.js';
import { CommandRouter } from './commands/router.js';
import { EventEmitter } from './events/emitter.js';
import { EventWatchers } from './events/watchers.js';
import { HeartbeatManager } from './utils/heartbeat.js';
import { setupGracefulShutdown } from './utils/shutdown.js';

// ===========================================================================
// BANNER
// ===========================================================================

const BANNER = `
╔═══════════════════════════════════════════════════════════════════════════╗
║                                                                           ║
║   ██████╗ ██████╗ ███╗   ██╗███████╗ ██████╗ ███╗   ██╗ █████╗ ███╗   ██║
║  ██╔════╝██╔═══██╗████╗  ██║██╔════╝██╔═══██╗████╗  ██║██╔══██╗████╗  ██║
║  ██║     ██║   ██║██╔██╗ ██║███████╗██║   ██║██╔██╗ ██║███████║██╔██╗ ██║
║  ██║     ██║   ██║██║╚██╗██║╚════██║██║   ██║██║╚██╗██║██╔══██║██║╚██╗██║
║  ╚██████╗╚██████╔╝██║ ╚████║███████║╚██████╔╝██║ ╚████║██║  ██║██║ ╚████║
║   ╚═════╝ ╚═════╝ ╚═╝  ╚═══╝╚══════╝ ╚═════╝ ╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝  ╚═══╝
║                                                                           ║
║                    RELAYER v2.0.0 - Stateless gRPC                       ║
║                                                                           ║
╚═══════════════════════════════════════════════════════════════════════════╝
`;

// ===========================================================================
// MAIN FUNCTION
// ===========================================================================

async function main(): Promise<void> {
  console.log(BANNER);

  // -------------------------------------------------------------------------
  // 1. LOAD CONFIGURATION
  // -------------------------------------------------------------------------

  logger.info('Loading configuration...');
  
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    logger.fatal({ error }, 'Failed to load configuration');
    process.exit(1);
  }

  // Initialize logger with config
  initializeLogger({
    level: config.logging.level,
    pretty: config.logging.pretty,
    redact: config.logging.redact,
  });

  logger.info({ config: getSafeConfigForLogging(config) }, 'Configuration loaded');

  // -------------------------------------------------------------------------
  // 2. INITIALIZE KUBERNETES CLIENT
  // -------------------------------------------------------------------------

  logger.info('Initializing Kubernetes client...');
  
  let k8sClient: KubernetesClient;
  try {
    k8sClient = new KubernetesClient(config);
    
    // Verify connectivity
    const clusterInfo = await k8sClient.getClusterInfo();
    logger.info({ clusterInfo }, 'Connected to Kubernetes cluster');
  } catch (error) {
    logger.fatal({ error }, 'Failed to initialize Kubernetes client');
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // 3. INITIALIZE KAGENT CLIENT
  // -------------------------------------------------------------------------

  logger.info('Initializing Kagent A2A client...');
  
  const kagentClient = new KagentA2AClient(config);
  
  // Verify Kagent connectivity (non-blocking)
  kagentClient.healthCheck().then((healthy) => {
    if (healthy) {
      logger.info('Kagent service is reachable');
    } else {
      logger.warn('Kagent service health check failed (non-fatal)');
    }
  });

  // -------------------------------------------------------------------------
  // 4. INITIALIZE GRPC CLIENT
  // -------------------------------------------------------------------------

  logger.info('Initializing gRPC client...');
  
  let grpcClient: GrpcClient;
  let eventEmitter: EventEmitter;
  let commandRouter: CommandRouter;
  let eventWatchers: EventWatchers;
  let heartbeatManager: HeartbeatManager;

  try {
    // Create gRPC client
    grpcClient = new GrpcClient({
      config,
      onStreamReady: async (stream) => {
        logger.info('gRPC stream ready, sending init message');
        
        // Send init message
        grpcClient.sendMessage({
          init: {
            cluster_id: config.cluster.id,
            cluster_name: config.cluster.name,
            namespace: k8sClient.getNamespace(),
            relayer_version: '2.0.0',
            kubernetes_version: (await k8sClient.getClusterVersion()).gitVersion || 'unknown',
            region: config.cluster.region,
            environment: config.cluster.environment,
          },
          message_id: generateMessageId(),
          timestamp: createTimestamp(),
        });

        // Start heartbeat
        heartbeatManager.start();

        // Start watchers
        eventWatchers.start();

        // Emit stream connected event
        eventEmitter.emitStreamConnected();
      },
      onStreamData: async (serverMessage) => {
        logger.debug({ message_id: serverMessage.message_id }, 'Received server message');
        
        // Handle acknowledgment
        if (serverMessage.ack) {
          logger.info(
            {
              session_id: serverMessage.ack.session_id,
              backend_version: serverMessage.ack.backend_version,
            },
            'Stream acknowledged by backend'
          );
          
          // Update heartbeat interval if provided
          if (serverMessage.ack.heartbeat_interval_seconds) {
            logger.info(
              { interval_seconds: serverMessage.ack.heartbeat_interval_seconds },
              'Backend requested heartbeat interval change'
            );
          }
        }
        
        // Handle commands
        if (serverMessage.command) {
          logger.info(
            {
              command_id: serverMessage.command.command_id,
              command_type: serverMessage.command.type,
            },
            'Received command from backend'
          );
          
          // Execute command asynchronously
          commandRouter
            .executeCommand(serverMessage.command)
            .then((response) => {
              // Send response back to backend
              grpcClient.sendMessage({
                command_response: response,
                message_id: generateMessageId(),
                timestamp: createTimestamp(),
              });
            })
            .catch((error) => {
              logger.error({ error, command_id: serverMessage.command.command_id }, 'Command execution error');
            });
        }
        
        // Handle control messages
        if (serverMessage.control) {
          logger.info({ type: serverMessage.control.type }, 'Received control message');
          
          // Handle control message types
          switch (serverMessage.control.type) {
            case 'CONTROL_MESSAGE_TYPE_PAUSE':
              logger.info('Pausing event streaming');
              eventWatchers.stop();
              break;
              
            case 'CONTROL_MESSAGE_TYPE_RESUME':
              logger.info('Resuming event streaming');
              eventWatchers.start();
              break;
              
            case 'CONTROL_MESSAGE_TYPE_PING':
              logger.debug('Received ping, sending pong');
              grpcClient.sendMessage({
                control: {
                  type: 'CONTROL_MESSAGE_TYPE_PONG',
                  data: {},
                },
                message_id: generateMessageId(),
                timestamp: createTimestamp(),
              });
              break;
          }
        }
      },
      onStreamError: (error) => {
        logger.error({ error }, 'gRPC stream error');
        eventEmitter.emitStreamDisconnected();
      },
      onStreamEnd: () => {
        logger.warn('gRPC stream ended');
        eventEmitter.emitStreamDisconnected();
        
        // Stop heartbeat
        if (heartbeatManager.isRunning()) {
          heartbeatManager.stop();
        }
        
        // Stop watchers
        if (eventWatchers.isRunning()) {
          eventWatchers.stop();
        }
      },
    });

    await grpcClient.initialize();
  } catch (error) {
    logger.fatal({ error }, 'Failed to initialize gRPC client');
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // 5. INITIALIZE COMMAND ROUTER
  // -------------------------------------------------------------------------

  logger.info('Initializing command router...');
  
  commandRouter = new CommandRouter(k8sClient, kagentClient);

  // -------------------------------------------------------------------------
  // 6. INITIALIZE EVENT SYSTEM
  // -------------------------------------------------------------------------

  logger.info('Initializing event system...');
  
  eventEmitter = new EventEmitter(grpcClient);
  eventWatchers = new EventWatchers(k8sClient, eventEmitter, config);

  // -------------------------------------------------------------------------
  // 7. INITIALIZE HEARTBEAT
  // -------------------------------------------------------------------------

  logger.info('Initializing heartbeat manager...');
  
  heartbeatManager = new HeartbeatManager(
    grpcClient,
    commandRouter,
    k8sClient,
    kagentClient,
    config.heartbeat.interval
  );

  // -------------------------------------------------------------------------
  // 8. CONNECT TO BACKEND
  // -------------------------------------------------------------------------

  logger.info('Connecting to backend...');
  
  try {
    await grpcClient.connect();
  } catch (error) {
    logger.fatal({ error }, 'Failed to connect to backend');
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // 9. SETUP GRACEFUL SHUTDOWN
  // -------------------------------------------------------------------------

  setupGracefulShutdown(
    {
      onWatchersStop: async () => {
        logger.info('Stopping event watchers...');
        eventWatchers.stop();
      },
      onGrpcClose: async () => {
        logger.info('Stopping heartbeat...');
        heartbeatManager.stop();
        
        logger.info('Closing gRPC connection...');
        await grpcClient.close();
      },
      onCleanup: async () => {
        logger.info('Cleanup completed');
      },
    },
    {
      gracePeriodMs: config.shutdown.gracePeriod,
    }
  );

  // -------------------------------------------------------------------------
  // 10. STARTUP COMPLETE
  // -------------------------------------------------------------------------

  logger.info(
    {
      cluster_id: config.cluster.id,
      cluster_name: config.cluster.name,
      namespace: k8sClient.getNamespace(),
      backend_url: config.backend.grpcUrl,
    },
    '🚀 Consonant Relayer started successfully'
  );
}

// ===========================================================================
// UTILITIES
// ===========================================================================

function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

function createTimestamp(): { seconds: number; nanos: number } {
  const now = Date.now();
  return {
    seconds: Math.floor(now / 1000),
    nanos: (now % 1000) * 1000000,
  };
}

// ===========================================================================
// ENTRY POINT
// ===========================================================================

main().catch((error) => {
  console.error('Fatal error during startup:');
  console.error(error);
  process.exit(1);
});