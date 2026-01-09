/**
 * Event Watchers
 * 
 * Watches Kubernetes resources and emits events to the backend.
 * Handles Agent CRDs, Pods, and Kubernetes Events.
 */

import type { KubernetesClient, WatchHandle } from '../k8s/client.js';
import type { EventEmitter } from './emitter.js';
import type { Config } from '../config/config.js';
import { logger, createComponentLogger } from '../utils/logger.js';

// ===========================================================================
// EVENT WATCHERS MANAGER
// ===========================================================================

export class EventWatchers {
  private readonly log = createComponentLogger('EventWatchers');
  private watchHandles: WatchHandle[] = [];
  private isWatching = false;

  constructor(
    private readonly k8sClient: KubernetesClient,
    private readonly eventEmitter: EventEmitter,
    private readonly config: Config
  ) {}

  // -------------------------------------------------------------------------
  // LIFECYCLE
  // -------------------------------------------------------------------------

  /**
   * Start all watchers
   */
  start(): void {
    if (this.isWatching) {
      this.log.warn('Watchers already started');
      return;
    }

    this.log.info('Starting event watchers');

    // Always watch Agent CRDs
    this.startAgentWatcher();

    // Optionally watch Pods
    if (this.config.features.watchPods) {
      this.startPodWatcher();
    }

    // Optionally watch K8s Events
    if (this.config.features.watchK8sEvents) {
      this.startK8sEventWatcher();
    }

    this.isWatching = true;

    this.log.info({ watcherCount: this.watchHandles.length }, 'Event watchers started');
  }

  /**
   * Stop all watchers
   */
  stop(): void {
    if (!this.isWatching) {
      this.log.warn('Watchers not running');
      return;
    }

    this.log.info('Stopping event watchers');

    // Abort all watch handles
    for (const handle of this.watchHandles) {
      try {
        handle.abort();
      } catch (error) {
        this.log.error({ error }, 'Error stopping watcher');
      }
    }

    this.watchHandles = [];
    this.isWatching = false;

    this.log.info('Event watchers stopped');
  }

  // -------------------------------------------------------------------------
  // AGENT CRD WATCHER
  // -------------------------------------------------------------------------

  private startAgentWatcher(): void {
    this.log.info('Starting Agent CRD watcher');

    const handle = this.k8sClient.watchAgentCRDs((type, agent) => {
      this.handleAgentEvent(type, agent);
    });

    this.watchHandles.push(handle);
  }

  private handleAgentEvent(type: 'ADDED' | 'MODIFIED' | 'DELETED', agent: any): void {
    const name = agent.metadata?.name;
    const namespace = agent.metadata?.namespace;

    this.log.debug({ type, name, namespace }, 'Agent event received');

    try {
      switch (type) {
        case 'ADDED':
          this.eventEmitter.emitAgentCreated(agent);
          
          // Check if agent is ready
          if (this.isAgentReady(agent)) {
            this.eventEmitter.emitAgentReady(agent);
          } else if (this.isAgentFailed(agent)) {
            this.eventEmitter.emitAgentFailed(agent);
          }
          break;

        case 'MODIFIED':
          this.eventEmitter.emitAgentUpdated(agent);
          
          // Check for status changes
          if (this.isAgentReady(agent)) {
            this.eventEmitter.emitAgentReady(agent);
          } else if (this.isAgentFailed(agent)) {
            this.eventEmitter.emitAgentFailed(agent);
          }
          break;

        case 'DELETED':
          this.eventEmitter.emitAgentDeleted(agent);
          break;
      }
    } catch (error) {
      this.log.error({ error, type, name, namespace }, 'Error handling agent event');
      this.eventEmitter.emitSystemError(error as Error, {
        context: 'agent_event_handler',
        type,
        agent_name: name,
        agent_namespace: namespace,
      });
    }
  }

  private isAgentReady(agent: any): boolean {
    const conditions = agent.status?.conditions || [];
    
    return conditions.some(
      (c: any) =>
        c.type === 'Ready' && c.status === 'True'
    );
  }

  private isAgentFailed(agent: any): boolean {
    const phase = agent.status?.phase;
    
    if (phase === 'Failed') {
      return true;
    }

    const conditions = agent.status?.conditions || [];
    
    return conditions.some(
      (c: any) =>
        c.type === 'Failed' && c.status === 'True'
    );
  }

  // -------------------------------------------------------------------------
  // POD WATCHER
  // -------------------------------------------------------------------------

  private startPodWatcher(): void {
    this.log.info('Starting Pod watcher');

    const namespace = this.k8sClient.getNamespace();
    
    // Watch pods with label selector if needed
    const labelSelector = undefined; // Can be configured if needed

    const handle = this.k8sClient.watchPods((type, pod) => {
      this.handlePodEvent(type, pod);
    }, namespace, labelSelector);

    this.watchHandles.push(handle);
  }

  private handlePodEvent(type: 'ADDED' | 'MODIFIED' | 'DELETED', pod: any): void {
    const name = pod.metadata?.name;
    const namespace = pod.metadata?.namespace;

    this.log.debug({ type, name, namespace }, 'Pod event received');

    try {
      // Only emit events for pods we care about (e.g., agent pods)
      if (!this.shouldEmitPodEvent(pod)) {
        return;
      }

      switch (type) {
        case 'ADDED':
          this.eventEmitter.emitPodCreated(pod);
          
          if (this.isPodReady(pod)) {
            this.eventEmitter.emitPodReady(pod);
          } else if (this.isPodFailed(pod)) {
            this.eventEmitter.emitPodFailed(pod);
          }
          break;

        case 'MODIFIED':
          this.eventEmitter.emitPodUpdated(pod);
          
          if (this.isPodReady(pod)) {
            this.eventEmitter.emitPodReady(pod);
          } else if (this.isPodFailed(pod)) {
            this.eventEmitter.emitPodFailed(pod);
          }
          break;

        case 'DELETED':
          this.eventEmitter.emitPodDeleted(pod);
          break;
      }
    } catch (error) {
      this.log.error({ error, type, name, namespace }, 'Error handling pod event');
      this.eventEmitter.emitSystemError(error as Error, {
        context: 'pod_event_handler',
        type,
        pod_name: name,
        pod_namespace: namespace,
      });
    }
  }

  private shouldEmitPodEvent(pod: any): boolean {
    // Only emit events for pods with specific labels (e.g., managed by Kagent)
    const labels = pod.metadata?.labels || {};
    
    // For now, emit all pod events
    // Can be filtered later based on requirements
    return true;
  }

  private isPodReady(pod: any): boolean {
    const conditions = pod.status?.conditions || [];
    
    return conditions.some(
      (c: any) =>
        c.type === 'Ready' && c.status === 'True'
    );
  }

  private isPodFailed(pod: any): boolean {
    const phase = pod.status?.phase;
    
    return phase === 'Failed';
  }

  // -------------------------------------------------------------------------
  // KUBERNETES EVENT WATCHER
  // -------------------------------------------------------------------------

  private startK8sEventWatcher(): void {
    this.log.info('Starting Kubernetes Event watcher');

    const namespace = this.k8sClient.getNamespace();

    const handle = this.k8sClient.watchK8sEvents((type, event) => {
      this.handleK8sEvent(type, event);
    }, namespace);

    this.watchHandles.push(handle);
  }

  private handleK8sEvent(type: 'ADDED' | 'MODIFIED' | 'DELETED', event: any): void {
    // Only emit ADDED events to avoid duplicates
    if (type !== 'ADDED') {
      return;
    }

    this.log.debug(
      {
        type: event.type,
        reason: event.reason,
        message: event.message,
      },
      'K8s event received'
    );

    try {
      // Filter out noise - only emit relevant events
      if (this.shouldEmitK8sEvent(event)) {
        this.eventEmitter.emitK8sEvent(event);
      }
    } catch (error) {
      this.log.error({ error, event_type: event.type }, 'Error handling K8s event');
      this.eventEmitter.emitSystemError(error as Error, {
        context: 'k8s_event_handler',
        event_type: event.type,
        event_reason: event.reason,
      });
    }
  }

  private shouldEmitK8sEvent(event: any): boolean {
    // Filter out noisy events
    const noisyReasons = [
      'Pulling',
      'Pulled',
      'Created',
      'Started',
    ];

    if (noisyReasons.includes(event.reason)) {
      return false;
    }

    // Only emit Warning and Error events
    if (event.type === 'Normal') {
      return false;
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // STATUS
  // -------------------------------------------------------------------------

  /**
   * Check if watchers are running
   */
  isRunning(): boolean {
    return this.isWatching;
  }

  /**
   * Get number of active watchers
   */
  getWatcherCount(): number {
    return this.watchHandles.length;
  }
}