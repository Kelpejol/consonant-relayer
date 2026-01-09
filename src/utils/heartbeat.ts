/**
 * Heartbeat Manager
 * 
 * Sends periodic heartbeats to the backend to:
 * - Keep the gRPC stream alive
 * - Report relayer health status
 * - Report active command count
 */

import type { GrpcClient } from '../grpc/client.js';
import type { CommandRouter } from '../commands/router.js';
import type { KubernetesClient } from '../k8s/client.js';
import type { KagentA2AClient } from '../kagent/client.js';
import { logger, createComponentLogger } from '../utils/logger.js';

// ===========================================================================
// HEARTBEAT MANAGER
// ===========================================================================

export class HeartbeatManager {
  private readonly log = createComponentLogger('HeartbeatManager');
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private sequence = 0;
  private startTime = Date.now();

  constructor(
    private readonly grpcClient: GrpcClient,
    private readonly commandRouter: CommandRouter,
    private readonly k8sClient: KubernetesClient,
    private readonly kagentClient: KagentA2AClient,
    private readonly intervalMs: number = 30000
  ) {}

  // -------------------------------------------------------------------------
  // LIFECYCLE
  // -------------------------------------------------------------------------

  /**
   * Start sending heartbeats
   */
  start(): void {
    if (this.heartbeatTimer) {
      this.log.warn('Heartbeat already started');
      return;
    }

    this.log.info({ interval_ms: this.intervalMs }, 'Starting heartbeat');

    this.startTime = Date.now();
    this.sequence = 0;

    // Send initial heartbeat immediately
    this.sendHeartbeat();

    // Start periodic heartbeats
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, this.intervalMs);
  }

  /**
   * Stop sending heartbeats
   */
  stop(): void {
    if (!this.heartbeatTimer) {
      this.log.warn('Heartbeat not running');
      return;
    }

    this.log.info('Stopping heartbeat');

    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  // -------------------------------------------------------------------------
  // HEARTBEAT
  // -------------------------------------------------------------------------

  /**
   * Send a heartbeat message
   */
  private async sendHeartbeat(): Promise<void> {
    if (!this.grpcClient.isConnected()) {
      this.log.debug('Skipping heartbeat: gRPC not connected');
      return;
    }

    this.sequence++;

    try {
      const health = await this.collectHealthStatus();
      const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);
      const activeCommands = this.commandRouter.getActiveCommandCount();

      this.grpcClient.sendMessage({
        heartbeat: {
          sequence: this.sequence,
          health,
          active_commands: activeCommands,
          uptime_seconds: uptimeSeconds,
        },
        message_id: this.generateMessageId(),
        timestamp: this.createTimestamp(),
      });

      this.log.debug(
        {
          sequence: this.sequence,
          healthy: health.healthy,
          active_commands: activeCommands,
        },
        'Heartbeat sent'
      );
    } catch (error) {
      this.log.error({ error }, 'Failed to send heartbeat');
    }
  }

  // -------------------------------------------------------------------------
  // HEALTH STATUS
  // -------------------------------------------------------------------------

  /**
   * Collect health status from all components
   */
  private async collectHealthStatus(): Promise<any> {
    const components: Record<string, string> = {};

    // Check Kubernetes connectivity
    try {
      await this.k8sClient.getClusterVersion();
      components['kubernetes'] = 'healthy';
    } catch (error) {
      components['kubernetes'] = 'unhealthy';
    }

    // Check Kagent connectivity
    try {
      const kagentHealthy = await this.kagentClient.healthCheck();
      components['kagent'] = kagentHealthy ? 'healthy' : 'unhealthy';
    } catch (error) {
      components['kagent'] = 'unhealthy';
    }

    // Check gRPC connection
    components['grpc'] = this.grpcClient.isConnected() ? 'healthy' : 'unhealthy';

    // Check Kagent circuit breaker
    components['kagent_circuit'] = this.kagentClient.getCircuitState();

    // Overall health
    const healthy = Object.values(components).every(
      (status) => status === 'healthy' || status === 'CLOSED'
    );

    return {
      healthy,
      uptime_seconds: Math.floor((Date.now() - this.startTime) / 1000),
      components,
      last_check: this.createTimestamp(),
    };
  }

  // -------------------------------------------------------------------------
  // UTILITIES
  // -------------------------------------------------------------------------

  private generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
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
   * Check if heartbeat is running
   */
  isRunning(): boolean {
    return this.heartbeatTimer !== null;
  }

  /**
   * Get current heartbeat sequence
   */
  getSequence(): number {
    return this.sequence;
  }
}