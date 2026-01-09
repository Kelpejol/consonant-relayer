/**
 * Event Emitter
 * 
 * Emits events from Kubernetes watchers to the backend via gRPC stream.
 * Events are sent immediately (stateless, no buffering).
 */

import type { GrpcClient } from '../grpc/client.js';
import { logger, createComponentLogger } from '../utils/logger.js';

// ===========================================================================
// TYPES
// ===========================================================================

export interface Event {
  event_id: string;
  type: string;
  timestamp: { seconds: number; nanos: number };
  data: any;
  resource?: {
    kind: string;
    api_version: string;
    namespace: string;
    name: string;
    uid?: string;
  };
  severity?: string;
  metadata?: Record<string, string>;
}

// ===========================================================================
// EVENT EMITTER
// ===========================================================================

export class EventEmitter {
  private readonly log = createComponentLogger('EventEmitter');
  private eventSequence = 0;

  constructor(private readonly grpcClient: GrpcClient) {}

  // -------------------------------------------------------------------------
  // EVENT EMISSION
  // -------------------------------------------------------------------------

  /**
   * Emit an event to the backend
   */
  emitEvent(event: Partial<Event>): void {
    if (!this.grpcClient.isConnected()) {
      this.log.warn({ event_type: event.type }, 'Cannot emit event: gRPC not connected');
      return;
    }

    // Generate event ID if not provided
    if (!event.event_id) {
      event.event_id = this.generateEventId();
    }

    // Generate timestamp if not provided
    if (!event.timestamp) {
      event.timestamp = this.createTimestamp();
    }

    // Default severity
    if (!event.severity) {
      event.severity = 'EVENT_SEVERITY_INFO';
    }

    try {
      this.grpcClient.sendMessage({
        event,
        message_id: this.generateMessageId(),
        timestamp: this.createTimestamp(),
      });

      this.log.debug(
        {
          event_id: event.event_id,
          event_type: event.type,
        },
        'Event emitted'
      );
    } catch (error) {
      this.log.error({ error, event_type: event.type }, 'Failed to emit event');
    }
  }

  // -------------------------------------------------------------------------
  // AGENT EVENTS
  // -------------------------------------------------------------------------

  /**
   * Emit agent created event
   */
  emitAgentCreated(agent: any): void {
    this.emitEvent({
      type: 'EVENT_TYPE_AGENT_CREATED',
      data: this.extractAgentData(agent),
      resource: this.createResourceReference(agent, 'Agent', 'kagent.dev/v1alpha2'),
      severity: 'EVENT_SEVERITY_INFO',
    });
  }

  /**
   * Emit agent updated event
   */
  emitAgentUpdated(agent: any): void {
    this.emitEvent({
      type: 'EVENT_TYPE_AGENT_UPDATED',
      data: this.extractAgentData(agent),
      resource: this.createResourceReference(agent, 'Agent', 'kagent.dev/v1alpha2'),
      severity: 'EVENT_SEVERITY_INFO',
    });
  }

  /**
   * Emit agent deleted event
   */
  emitAgentDeleted(agent: any): void {
    this.emitEvent({
      type: 'EVENT_TYPE_AGENT_DELETED',
      data: this.extractAgentData(agent),
      resource: this.createResourceReference(agent, 'Agent', 'kagent.dev/v1alpha2'),
      severity: 'EVENT_SEVERITY_INFO',
    });
  }

  /**
   * Emit agent ready event
   */
  emitAgentReady(agent: any): void {
    this.emitEvent({
      type: 'EVENT_TYPE_AGENT_READY',
      data: this.extractAgentData(agent),
      resource: this.createResourceReference(agent, 'Agent', 'kagent.dev/v1alpha2'),
      severity: 'EVENT_SEVERITY_INFO',
    });
  }

  /**
   * Emit agent failed event
   */
  emitAgentFailed(agent: any): void {
    this.emitEvent({
      type: 'EVENT_TYPE_AGENT_FAILED',
      data: this.extractAgentData(agent),
      resource: this.createResourceReference(agent, 'Agent', 'kagent.dev/v1alpha2'),
      severity: 'EVENT_SEVERITY_ERROR',
    });
  }

  // -------------------------------------------------------------------------
  // POD EVENTS
  // -------------------------------------------------------------------------

  /**
   * Emit pod created event
   */
  emitPodCreated(pod: any): void {
    this.emitEvent({
      type: 'EVENT_TYPE_POD_CREATED',
      data: this.extractPodData(pod),
      resource: this.createResourceReference(pod, 'Pod', 'v1'),
      severity: 'EVENT_SEVERITY_INFO',
    });
  }

  /**
   * Emit pod updated event
   */
  emitPodUpdated(pod: any): void {
    this.emitEvent({
      type: 'EVENT_TYPE_POD_UPDATED',
      data: this.extractPodData(pod),
      resource: this.createResourceReference(pod, 'Pod', 'v1'),
      severity: 'EVENT_SEVERITY_INFO',
    });
  }

  /**
   * Emit pod deleted event
   */
  emitPodDeleted(pod: any): void {
    this.emitEvent({
      type: 'EVENT_TYPE_POD_DELETED',
      data: this.extractPodData(pod),
      resource: this.createResourceReference(pod, 'Pod', 'v1'),
      severity: 'EVENT_SEVERITY_INFO',
    });
  }

  /**
   * Emit pod ready event
   */
  emitPodReady(pod: any): void {
    this.emitEvent({
      type: 'EVENT_TYPE_POD_READY',
      data: this.extractPodData(pod),
      resource: this.createResourceReference(pod, 'Pod', 'v1'),
      severity: 'EVENT_SEVERITY_INFO',
    });
  }

  /**
   * Emit pod failed event
   */
  emitPodFailed(pod: any): void {
    this.emitEvent({
      type: 'EVENT_TYPE_POD_FAILED',
      data: this.extractPodData(pod),
      resource: this.createResourceReference(pod, 'Pod', 'v1'),
      severity: 'EVENT_SEVERITY_ERROR',
    });
  }

  // -------------------------------------------------------------------------
  // KUBERNETES EVENTS
  // -------------------------------------------------------------------------

  /**
   * Emit Kubernetes event
   */
  emitK8sEvent(event: any): void {
    const severity = this.getK8sEventSeverity(event);

    this.emitEvent({
      type: this.getK8sEventType(event),
      data: {
        reason: event.reason,
        message: event.message,
        type: event.type,
        count: event.count,
        first_timestamp: event.firstTimestamp,
        last_timestamp: event.lastTimestamp,
        involved_object: event.involvedObject,
      },
      resource: event.involvedObject
        ? {
            kind: event.involvedObject.kind,
            api_version: event.involvedObject.apiVersion,
            namespace: event.involvedObject.namespace,
            name: event.involvedObject.name,
            uid: event.involvedObject.uid,
          }
        : undefined,
      severity,
    });
  }

  // -------------------------------------------------------------------------
  // SYSTEM EVENTS
  // -------------------------------------------------------------------------

  /**
   * Emit system error event
   */
  emitSystemError(error: Error, context?: Record<string, any>): void {
    this.emitEvent({
      type: 'EVENT_TYPE_SYSTEM_ERROR',
      data: {
        error: {
          message: error.message,
          stack: error.stack,
          name: error.name,
        },
        context,
      },
      severity: 'EVENT_SEVERITY_ERROR',
    });
  }

  /**
   * Emit system warning event
   */
  emitSystemWarning(message: string, context?: Record<string, any>): void {
    this.emitEvent({
      type: 'EVENT_TYPE_SYSTEM_WARNING',
      data: {
        message,
        context,
      },
      severity: 'EVENT_SEVERITY_WARNING',
    });
  }

  /**
   * Emit stream connected event
   */
  emitStreamConnected(): void {
    this.emitEvent({
      type: 'EVENT_TYPE_STREAM_CONNECTED',
      data: {
        timestamp: new Date().toISOString(),
      },
      severity: 'EVENT_SEVERITY_INFO',
    });
  }

  /**
   * Emit stream disconnected event
   */
  emitStreamDisconnected(): void {
    this.emitEvent({
      type: 'EVENT_TYPE_STREAM_DISCONNECTED',
      data: {
        timestamp: new Date().toISOString(),
      },
      severity: 'EVENT_SEVERITY_WARNING',
    });
  }

  // -------------------------------------------------------------------------
  // DATA EXTRACTION
  // -------------------------------------------------------------------------

  private extractAgentData(agent: any): any {
    return {
      name: agent.metadata?.name,
      namespace: agent.metadata?.namespace,
      labels: agent.metadata?.labels,
      annotations: agent.metadata?.annotations,
      spec: agent.spec,
      status: agent.status,
      creation_timestamp: agent.metadata?.creationTimestamp,
    };
  }

  private extractPodData(pod: any): any {
    return {
      name: pod.metadata?.name,
      namespace: pod.metadata?.namespace,
      labels: pod.metadata?.labels,
      annotations: pod.metadata?.annotations,
      phase: pod.status?.phase,
      conditions: pod.status?.conditions,
      container_statuses: pod.status?.containerStatuses,
      creation_timestamp: pod.metadata?.creationTimestamp,
      node_name: pod.spec?.nodeName,
    };
  }

  private createResourceReference(
    resource: any,
    kind: string,
    apiVersion: string
  ): Event['resource'] {
    return {
      kind,
      api_version: apiVersion,
      namespace: resource.metadata?.namespace || '',
      name: resource.metadata?.name || '',
      uid: resource.metadata?.uid,
    };
  }

  private getK8sEventType(event: any): string {
    if (event.type === 'Warning') {
      return 'EVENT_TYPE_K8S_WARNING';
    } else if (event.type === 'Error') {
      return 'EVENT_TYPE_K8S_ERROR';
    } else {
      return 'EVENT_TYPE_K8S_EVENT';
    }
  }

  private getK8sEventSeverity(event: any): string {
    if (event.type === 'Warning') {
      return 'EVENT_SEVERITY_WARNING';
    } else if (event.type === 'Error') {
      return 'EVENT_SEVERITY_ERROR';
    } else {
      return 'EVENT_SEVERITY_INFO';
    }
  }

  // -------------------------------------------------------------------------
  // UTILITIES
  // -------------------------------------------------------------------------

  private generateEventId(): string {
    this.eventSequence++;
    return `evt_${Date.now()}_${this.eventSequence}_${Math.random().toString(36).substring(2, 9)}`;
  }

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
}