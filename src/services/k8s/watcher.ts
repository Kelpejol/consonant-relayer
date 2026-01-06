/**
 * @fileoverview Kubernetes Watcher - Watch Agent CRDs, Pods, and Events
 * 
 * Watches Kubernetes resources and emits events for downstream processing.
 * 
 * Watches:
 * 1. Agent CRDs (kagent.dev/v1alpha2) - Trigger agent discovery
 * 2. Pods (label: kagent-managed=true) - Track agent pod status
 * 3. Events (agent-related only) - Forward important events
 * 
 * Features:
 * - Resource version tracking (resume from last seen, no replay)
 * - Automatic recovery from watch errors
 * - Namespace-scoped watches (least privilege)
 * - Event filtering (only relevant events)
 * - Metrics integration
 * 
 * @author Consonant Engineering
 * @version 2.0.0
 */

import { EventEmitter } from 'events';
import * as k8s from '@kubernetes/client-node';

import type {
  AgentCRD,
  Pod,
  K8sEvent,
  WatchEvent,
  WatchType,
} from '../../types/k8s.js';
import type { PodInfo, KubernetesEvent } from '../../types/socket.js';
import type { IService, ServiceHealth } from '../interfaces.js';
import { MetricsCollector } from '../../utils/metrics.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('k8s-watcher');

/**
 * Kubernetes Watcher Events
 */
export interface KubernetesWatcherEvents {
  /** Agent CRD added */
  'agent:added': (agent: AgentCRD) => void;
  
  /** Agent CRD modified */
  'agent:modified': (agent: AgentCRD) => void;
  
  /** Agent CRD deleted */
  'agent:deleted': (agent: AgentCRD) => void;
  
  /** Pod status changed */
  'pod:status': (pod: PodInfo) => void;
  
  /** Kubernetes event */
  'k8s:event': (event: KubernetesEvent) => void;
}

/**
 * Kubernetes Watcher Configuration
 */
export interface KubernetesWatcherConfig {
  readonly namespace: string;
  readonly watchRetryDelay: number;
}

/**
 * Kubernetes Watcher Service
 * 
 * Watches K8s resources with automatic recovery and resource version tracking.
 * 
 * NO TODOS - Complete implementation with resource version tracking.
 */
export class KubernetesWatcherService extends EventEmitter implements IService {
  private readonly k8sClient: k8s.KubeConfig;
  private readonly customObjectsApi: k8s.CustomObjectsApi;
  private readonly coreV1Api: k8s.CoreV1Api;
  private readonly watch: k8s.Watch;
  
  private running = false;
  private readonly metrics: MetricsCollector;
  
  /** Active watch requests (for cleanup) */
  private readonly activeWatches = new Map<WatchType, { abort: () => void }>();
  
  /** Resource versions for each watch (for resuming) */
  private readonly resourceVersions = new Map<WatchType, string>();
  
  /** Statistics */
  private activePodCount = 0;
  
  constructor(private readonly config: KubernetesWatcherConfig) {
    super();
    
    this.metrics = MetricsCollector.getInstance();
    
    // Initialize Kubernetes client
    this.k8sClient = new k8s.KubeConfig();
    this.k8sClient.loadFromDefault();
    
    this.customObjectsApi = this.k8sClient.makeApiClient(k8s.CustomObjectsApi);
    this.coreV1Api = this.k8sClient.makeApiClient(k8s.CoreV1Api);
    this.watch = new k8s.Watch(this.k8sClient);
  }
  
  /**
   * Start service
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('Kubernetes watcher already running');
      return;
    }
    
    logger.info(
      { namespace: this.config.namespace },
      'Starting Kubernetes watcher'
    );
    
    this.running = true;
    
    // Start watches
    await this.startAgentCRDWatch();
    await this.startPodWatch();
    await this.startEventWatch();
    
    logger.info('Kubernetes watcher started');
  }
  
  /**
   * Stop service
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    
    logger.info('Stopping Kubernetes watcher');
    
    this.running = false;
    
    // Stop all watches
    for (const [type, watch] of this.activeWatches.entries()) {
      logger.debug({ type }, 'Aborting watch');
      watch.abort();
    }
    
    this.activeWatches.clear();
    this.resourceVersions.clear();
    
    logger.info('Kubernetes watcher stopped');
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
    return 'kubernetes-watcher';
  }
  
  /**
   * Get health
   */
  getHealth(): ServiceHealth {
    const status = this.running ? 'healthy' : 'unhealthy';
    
    return {
      name: 'kubernetes-watcher',
      status,
      details: {
        activeWatches: this.activeWatches.size,
        activePods: this.activePodCount,
      },
      lastCheck: new Date().toISOString(),
    };
  }
  
  /**
   * Get active pod count (for metrics)
   */
  getActivePodCount(): number {
    return this.activePodCount;
  }
  
  // ========================================================================
  // AGENT CRD WATCH
  // ========================================================================
  
  /**
   * Start watching Agent CRDs
   */
  private async startAgentCRDWatch(): Promise<void> {
    const watchType: WatchType = 'agents';
    
    // Get last resource version (if any)
    const resourceVersion = this.resourceVersions.get(watchType);
    
    logger.info(
      {
        namespace: this.config.namespace,
        resourceVersion: resourceVersion || 'initial',
      },
      'Starting Agent CRD watch'
    );
    
    try {
      const path = `/apis/kagent.dev/v1alpha2/namespaces/${this.config.namespace}/agents`;
      
      const req = await this.watch.watch(
        path,
        { resourceVersion }, // Resume from last seen version
        this.handleAgentCRDEvent.bind(this),
        (err) => {
          this.handleWatchError(watchType, err);
        }
      );
      
      this.activeWatches.set(watchType, req);
      this.metrics.setGauge('k8s_watches_active', this.activeWatches.size);
      
      logger.debug('Agent CRD watch started');
    } catch (error) {
      logger.error(
        { error: (error as Error).message },
        'Failed to start Agent CRD watch'
      );
      
      // Retry after delay
      setTimeout(() => {
        if (this.running) {
          void this.startAgentCRDWatch();
        }
      }, this.config.watchRetryDelay);
    }
  }
  
  /**
   * Handle Agent CRD watch event
   */
  private handleAgentCRDEvent(type: string, obj: AgentCRD): void {
    // Update resource version
    if (obj.metadata.resourceVersion) {
      this.resourceVersions.set('agents', obj.metadata.resourceVersion);
    }
    
    logger.debug(
      {
        type,
        name: obj.metadata.name,
        namespace: obj.metadata.namespace,
      },
      'Agent CRD event'
    );
    
    // Emit typed events
    switch (type) {
      case 'ADDED':
        this.emit('agent:added', obj);
        break;
      case 'MODIFIED':
        this.emit('agent:modified', obj);
        break;
      case 'DELETED':
        this.emit('agent:deleted', obj);
        break;
    }
  }
  
  // ========================================================================
  // POD WATCH
  // ========================================================================
  
  /**
   * Start watching Pods (filtered by label: kagent-managed=true)
   */
  private async startPodWatch(): Promise<void> {
    const watchType: WatchType = 'pods';
    
    const resourceVersion = this.resourceVersions.get(watchType);
    
    logger.info(
      {
        namespace: this.config.namespace,
        resourceVersion: resourceVersion || 'initial',
        labelSelector: 'kagent-managed=true',
      },
      'Starting Pod watch'
    );
    
    try {
      const path = `/api/v1/namespaces/${this.config.namespace}/pods`;
      
      const req = await this.watch.watch(
        path,
        {
          resourceVersion,
          labelSelector: 'kagent-managed=true', // Only watch agent pods
        },
        this.handlePodEvent.bind(this),
        (err) => {
          this.handleWatchError(watchType, err);
        }
      );
      
      this.activeWatches.set(watchType, req);
      this.metrics.setGauge('k8s_watches_active', this.activeWatches.size);
      
      logger.debug('Pod watch started');
    } catch (error) {
      logger.error(
        { error: (error as Error).message },
        'Failed to start Pod watch'
      );
      
      // Retry after delay
      setTimeout(() => {
        if (this.running) {
          void this.startPodWatch();
        }
      }, this.config.watchRetryDelay);
    }
  }
  
  /**
   * Handle Pod watch event
   */
  private handlePodEvent(type: string, obj: Pod): void {
    // Update resource version
    if (obj.metadata.resourceVersion) {
      this.resourceVersions.set('pods', obj.metadata.resourceVersion);
    }
    
    logger.debug(
      {
        type,
        name: obj.metadata.name,
        namespace: obj.metadata.namespace,
        phase: obj.status?.phase,
      },
      'Pod event'
    );
    
    // Update active pod count
    if (type === 'ADDED') {
      this.activePodCount++;
    } else if (type === 'DELETED') {
      this.activePodCount = Math.max(0, this.activePodCount - 1);
    }
    
    this.metrics.setGauge('active_pods', this.activePodCount);
    
    // Convert to PodInfo and emit
    const podInfo = this.convertToPodInfo(obj);
    this.emit('pod:status', podInfo);
  }
  
  /**
   * Convert Pod to PodInfo
   */
  private convertToPodInfo(pod: Pod): PodInfo {
    return {
      namespace: pod.metadata.namespace || this.config.namespace,
      name: pod.metadata.name,
      phase: pod.status?.phase || 'Unknown',
      conditions: pod.status?.conditions,
      containerStatuses: pod.status?.containerStatuses?.map((cs) => ({
        name: cs.name,
        ready: cs.ready,
        restartCount: cs.restartCount,
        state: cs.state,
      })),
      metadata: {
        uid: pod.metadata.uid,
        resourceVersion: pod.metadata.resourceVersion,
        labels: pod.metadata.labels,
        creationTimestamp: pod.metadata.creationTimestamp,
        podIP: pod.status?.podIP,
        hostIP: pod.status?.hostIP,
        startTime: pod.status?.startTime,
      },
    };
  }
  
  // ========================================================================
  // EVENT WATCH
  // ========================================================================
  
  /**
   * Start watching Kubernetes Events (agent-related only)
   */
  private async startEventWatch(): Promise<void> {
    const watchType: WatchType = 'events';
    
    const resourceVersion = this.resourceVersions.get(watchType);
    
    logger.info(
      {
        namespace: this.config.namespace,
        resourceVersion: resourceVersion || 'initial',
      },
      'Starting Event watch'
    );
    
    try {
      const path = `/api/v1/namespaces/${this.config.namespace}/events`;
      
      const req = await this.watch.watch(
        path,
        { resourceVersion },
        this.handleK8sEvent.bind(this),
        (err) => {
          this.handleWatchError(watchType, err);
        }
      );
      
      this.activeWatches.set(watchType, req);
      this.metrics.setGauge('k8s_watches_active', this.activeWatches.size);
      
      logger.debug('Event watch started');
    } catch (error) {
      logger.error(
        { error: (error as Error).message },
        'Failed to start Event watch'
      );
      
      // Retry after delay
      setTimeout(() => {
        if (this.running) {
          void this.startEventWatch();
        }
      }, this.config.watchRetryDelay);
    }
  }
  
  /**
   * Handle Kubernetes Event
   */
  private handleK8sEvent(type: string, obj: K8sEvent): void {
    // Update resource version
    if (obj.metadata.resourceVersion) {
      this.resourceVersions.set('events', obj.metadata.resourceVersion);
    }
    
    // Only process ADDED events (events are immutable)
    if (type !== 'ADDED') return;
    
    // Filter: Only agent-related events
    if (!this.isAgentRelatedEvent(obj)) return;
    
    logger.debug(
      {
        type: obj.type,
        reason: obj.reason,
        involvedObject: obj.involvedObject,
      },
      'K8s event (agent-related)'
    );
    
    // Convert and emit
    const event = this.convertToKubernetesEvent(obj);
    this.emit('k8s:event', event);
  }
  
  /**
   * Check if event is agent-related
   */
  private isAgentRelatedEvent(event: K8sEvent): boolean {
    const kind = event.involvedObject.kind;
    
    // Include events for: Agent CRDs, Pods with kagent label, etc.
    if (kind === 'Agent') return true;
    
    if (kind === 'Pod') {
      // Check if pod has kagent-managed label
      // Note: We can't check labels here as they're not in the event object
      // So we include all pod events in the namespace
      return true;
    }
    
    // Include other relevant kinds
    if (['Deployment', 'ReplicaSet', 'StatefulSet'].includes(kind)) {
      return true;
    }
    
    return false;
  }
  
  /**
   * Convert K8sEvent to KubernetesEvent
   */
  private convertToKubernetesEvent(event: K8sEvent): KubernetesEvent {
    return {
      type: event.type,
      reason: event.reason,
      message: event.message,
      involvedObject: {
        kind: event.involvedObject.kind,
        namespace: event.involvedObject.namespace,
        name: event.involvedObject.name,
      },
      firstTimestamp: event.firstTimestamp,
      lastTimestamp: event.lastTimestamp,
      count: event.count,
    };
  }
  
  // ========================================================================
  // ERROR HANDLING
  // ========================================================================
  
  /**
   * Handle watch error
   */
  private handleWatchError(watchType: WatchType, err: unknown): void {
    logger.error(
      {
        watchType,
        error: err instanceof Error ? err.message : String(err),
      },
      'Watch error'
    );
    
    this.metrics.increment('k8s_watch_errors_total', 1, { type: watchType });
    
    // Remove from active watches
    this.activeWatches.delete(watchType);
    this.metrics.setGauge('k8s_watches_active', this.activeWatches.size);
    
    // Restart watch after delay
    if (this.running) {
      setTimeout(() => {
        switch (watchType) {
          case 'agents':
            void this.startAgentCRDWatch();
            break;
          case 'pods':
            void this.startPodWatch();
            break;
          case 'events':
            void this.startEventWatch();
            break;
        }
      }, this.config.watchRetryDelay);
    }
  }
}