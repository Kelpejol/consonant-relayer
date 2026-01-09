/**
 * Kubernetes Client
 * 
 * This module provides:
 * - In-cluster Kubernetes API access
 * - Agent CRD (kagent.dev/v1alpha2) operations
 * - Resource watchers with automatic reconnection
 * - Pod and Event operations
 * - Namespace auto-detection from service account
 */

import * as k8s from '@kubernetes/client-node';
import { readFileSync } from 'fs';
import type { Config } from '../config/config.js';
import { logger, createComponentLogger, logError } from '../utils/logger.js';

// ===========================================================================
// TYPES
// ===========================================================================

export interface AgentCRD {
  apiVersion: 'kagent.dev/v1alpha2';
  kind: 'Agent';
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec: {
    model?: string;
    systemPrompt?: string;
    tools?: Array<{
      name: string;
      type: string;
      [key: string]: any;
    }>;
    [key: string]: any;
  };
  status?: {
    conditions?: Array<{
      type: string;
      status: string;
      lastTransitionTime: string;
      reason?: string;
      message?: string;
    }>;
    phase?: string;
    [key: string]: any;
  };
}

export interface WatchCallback {
  (type: 'ADDED' | 'MODIFIED' | 'DELETED', obj: any): void;
}

export interface WatchHandle {
  abort: () => void;
}

// ===========================================================================
// KUBERNETES CLIENT
// ===========================================================================

export class KubernetesClient {
  private readonly log = createComponentLogger('KubernetesClient');
  private readonly kc: k8s.KubeConfig;
  private readonly customApi: k8s.CustomObjectsApi;
  private readonly coreApi: k8s.CoreV1Api;
  private readonly appsApi: k8s.AppsV1Api;
  private readonly namespace: string;

  constructor(private readonly config: Config) {
    // Load in-cluster configuration
    this.kc = new k8s.KubeConfig();
    
    try {
      this.kc.loadFromCluster();
      this.log.info('Loaded in-cluster Kubernetes configuration');
    } catch (error) {
      // Fallback to default config for local development
      this.log.warn('Failed to load in-cluster config, trying default config');
      this.kc.loadFromDefault();
    }

    // Create API clients
    this.customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    this.appsApi = this.kc.makeApiClient(k8s.AppsV1Api);

    // Detect namespace
    this.namespace = this.detectNamespace();

    this.log.info({ namespace: this.namespace }, 'Kubernetes client initialized');
  }

  // -------------------------------------------------------------------------
  // NAMESPACE MANAGEMENT
  // -------------------------------------------------------------------------

  /**
   * Detect the namespace from service account or config
   */
  private detectNamespace(): string {
    // 1. Try from config
    if (this.config.kubernetes.namespace) {
      this.log.info({ namespace: this.config.kubernetes.namespace }, 'Using namespace from config');
      return this.config.kubernetes.namespace;
    }

    // 2. Try from service account
    try {
      const namespace = readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8').trim();
      this.log.info({ namespace }, 'Detected namespace from service account');
      return namespace;
    } catch (error) {
      this.log.warn('Failed to read namespace from service account');
    }

    // 3. Try from kubeconfig context
    try {
      const currentContext = this.kc.getCurrentContext();
      const context = this.kc.getContextObject(currentContext);
      if (context?.namespace) {
        this.log.info({ namespace: context.namespace }, 'Using namespace from kubeconfig context');
        return context.namespace;
      }
    } catch (error) {
      this.log.warn('Failed to get namespace from kubeconfig context');
    }

    // 4. Default to 'default'
    this.log.warn('Using default namespace');
    return 'default';
  }

  /**
   * Get the current namespace
   */
  getNamespace(): string {
    return this.namespace;
  }

  // -------------------------------------------------------------------------
  // AGENT CRD OPERATIONS (kagent.dev/v1alpha2)
  // -------------------------------------------------------------------------

  /**
   * Apply (create or update) an Agent CRD
   */
  async applyAgentCRD(agent: AgentCRD): Promise<AgentCRD> {
    const namespace = agent.metadata.namespace || this.namespace;
    const name = agent.metadata.name;

    this.log.info({ namespace, name }, 'Applying Agent CRD');

    try {
      // Try to get existing agent
      const existing = await this.getAgentCRD(namespace, name);

      if (existing) {
        // Update existing agent
        this.log.debug({ namespace, name }, 'Agent exists, updating');
        
        const response = await this.customApi.replaceNamespacedCustomObject({
          group: 'kagent.dev',
          version: 'v1alpha2',
          namespace,
          plural: 'agents',
          name,
          body: agent,
        });

        this.log.info({ namespace, name }, 'Agent CRD updated');
        return response as AgentCRD;
      }
    } catch (error: any) {
      // If not found, we'll create it below
      if (error.statusCode !== 404 && error.response?.statusCode !== 404) {
        throw error;
      }
    }

    // Create new agent
    this.log.debug({ namespace, name }, 'Creating new Agent');
    
    const response = await this.customApi.createNamespacedCustomObject({
      group: 'kagent.dev',
      version: 'v1alpha2',
      namespace,
      plural: 'agents',
      body: agent,
    });

    this.log.info({ namespace, name }, 'Agent CRD created');
    return response as AgentCRD;
  }

  /**
   * Get an Agent CRD by name
   */
  async getAgentCRD(namespace: string, name: string): Promise<AgentCRD | null> {
    this.log.debug({ namespace, name }, 'Getting Agent CRD');

    try {
      const response = await this.customApi.getNamespacedCustomObject({
        group: 'kagent.dev',
        version: 'v1alpha2',
        namespace,
        plural: 'agents',
        name,
      });

      return response as AgentCRD;
    } catch (error: any) {
      if (error.statusCode === 404 || error.response?.statusCode === 404) {
        return null;
      }
      
      logError(error, { namespace, name, operation: 'get agent' });
      throw error;
    }
  }

  /**
   * List all Agent CRDs in a namespace
   */
  async listAgentCRDs(namespace?: string): Promise<AgentCRD[]> {
    const ns = namespace || this.namespace;
    
    this.log.debug({ namespace: ns }, 'Listing Agent CRDs');

    try {
      const response = await this.customApi.listNamespacedCustomObject({
        group: 'kagent.dev',
        version: 'v1alpha2',
        namespace: ns,
        plural: 'agents',
      }) as any;

      const agents = response.items || [];
      
      this.log.info({ namespace: ns, count: agents.length }, 'Listed Agent CRDs');
      
      return agents;
    } catch (error) {
      logError(error, { namespace: ns, operation: 'list agents' });
      throw error;
    }
  }

  /**
   * Delete an Agent CRD
   */
  async deleteAgentCRD(namespace: string, name: string): Promise<void> {
    this.log.info({ namespace, name }, 'Deleting Agent CRD');

    try {
      await this.customApi.deleteNamespacedCustomObject({
        group: 'kagent.dev',
        version: 'v1alpha2',
        namespace,
        plural: 'agents',
        name,
      });

      this.log.info({ namespace, name }, 'Agent CRD deleted');
    } catch (error: any) {
      if (error.statusCode === 404 || error.response?.statusCode === 404) {
        this.log.warn({ namespace, name }, 'Agent not found, already deleted');
        return;
      }
      
      logError(error, { namespace, name, operation: 'delete agent' });
      throw error;
    }
  }

  /**
   * Update Agent CRD status
   */
  async updateAgentStatus(namespace: string, name: string, status: any): Promise<AgentCRD> {
    this.log.debug({ namespace, name }, 'Updating Agent status');

    try {
      // Get current agent
      const agent = await this.getAgentCRD(namespace, name);
      
      if (!agent) {
        throw new Error(`Agent ${namespace}/${name} not found`);
      }

      // Update status
      agent.status = status;

      // Replace with status subresource
      const response = await this.customApi.replaceNamespacedCustomObjectStatus({
        group: 'kagent.dev',
        version: 'v1alpha2',
        namespace,
        plural: 'agents',
        name,
        body: agent,
      });

      this.log.info({ namespace, name }, 'Agent status updated');
      return response as AgentCRD;
    } catch (error) {
      logError(error, { namespace, name, operation: 'update agent status' });
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // WATCH OPERATIONS
  // -------------------------------------------------------------------------

  /**
   * Watch Agent CRDs in a namespace
   */
  watchAgentCRDs(callback: WatchCallback, namespace?: string): WatchHandle {
    const ns = namespace || this.namespace;
    
    this.log.info({ namespace: ns }, 'Starting Agent CRD watch');

    const watch = new k8s.Watch(this.kc);
    const path = `/apis/kagent.dev/v1alpha2/namespaces/${ns}/agents`;

    let watchRequest: any = null;

    const startWatch = () => {
      watchRequest = watch.watch(
        path,
        {
          allowWatchBookmarks: this.config.kubernetes.watch.allowWatchBookmarks,
        },
        (type, obj) => {
          this.log.debug({ type, name: obj.metadata?.name }, 'Agent watch event');
          callback(type as any, obj);
        },
        (error) => {
          if (error) {
            logError(error, { namespace: ns, operation: 'agent watch' });
            
            // Reconnect after delay
            setTimeout(() => {
              this.log.info('Reconnecting Agent watch');
              startWatch();
            }, this.config.kubernetes.watch.reconnectDelay);
          }
        }
      );
    };

    startWatch();

    return {
      abort: () => {
        this.log.info({ namespace: ns }, 'Stopping Agent CRD watch');
        if (watchRequest) {
          watchRequest.abort();
        }
      },
    };
  }

  /**
   * Watch Pods in a namespace
   */
  watchPods(callback: WatchCallback, namespace?: string, labelSelector?: string): WatchHandle {
    const ns = namespace || this.namespace;
    
    this.log.info({ namespace: ns, labelSelector }, 'Starting Pod watch');

    const watch = new k8s.Watch(this.kc);
    const path = `/api/v1/namespaces/${ns}/pods`;

    let watchRequest: any = null;

    const startWatch = () => {
      const queryParams: any = {
        allowWatchBookmarks: this.config.kubernetes.watch.allowWatchBookmarks,
      };
      
      if (labelSelector) {
        queryParams.labelSelector = labelSelector;
      }

      watchRequest = watch.watch(
        path,
        queryParams,
        (type, obj) => {
          this.log.debug({ type, name: obj.metadata?.name }, 'Pod watch event');
          callback(type as any, obj);
        },
        (error) => {
          if (error) {
            logError(error, { namespace: ns, operation: 'pod watch' });
            
            // Reconnect after delay
            setTimeout(() => {
              this.log.info('Reconnecting Pod watch');
              startWatch();
            }, this.config.kubernetes.watch.reconnectDelay);
          }
        }
      );
    };

    startWatch();

    return {
      abort: () => {
        this.log.info({ namespace: ns }, 'Stopping Pod watch');
        if (watchRequest) {
          watchRequest.abort();
        }
      },
    };
  }

  /**
   * Watch Kubernetes Events in a namespace
   */
  watchK8sEvents(callback: WatchCallback, namespace?: string): WatchHandle {
    const ns = namespace || this.namespace;
    
    this.log.info({ namespace: ns }, 'Starting K8s Events watch');

    const watch = new k8s.Watch(this.kc);
    const path = `/api/v1/namespaces/${ns}/events`;

    let watchRequest: any = null;

    const startWatch = () => {
      watchRequest = watch.watch(
        path,
        {
          allowWatchBookmarks: this.config.kubernetes.watch.allowWatchBookmarks,
        },
        (type, obj) => {
          this.log.debug({ type, name: obj.metadata?.name }, 'K8s Event watch event');
          callback(type as any, obj);
        },
        (error) => {
          if (error) {
            logError(error, { namespace: ns, operation: 'events watch' });
            
            // Reconnect after delay
            setTimeout(() => {
              this.log.info('Reconnecting Events watch');
              startWatch();
            }, this.config.kubernetes.watch.reconnectDelay);
          }
        }
      );
    };

    startWatch();

    return {
      abort: () => {
        this.log.info({ namespace: ns }, 'Stopping K8s Events watch');
        if (watchRequest) {
          watchRequest.abort();
        }
      },
    };
  }

  // -------------------------------------------------------------------------
  // POD OPERATIONS
  // -------------------------------------------------------------------------

  /**
   * Get pod logs
   */
  async getPodLogs(
    namespace: string,
    podName: string,
    containerName?: string,
    tailLines?: number
  ): Promise<string> {
    this.log.debug({ namespace, podName, containerName }, 'Getting pod logs');

    try {
      const response = await this.coreApi.readNamespacedPodLog({
        name: podName,
        namespace,
        container: containerName,
        follow: false,
        previous: false,
        tailLines,
        timestamps: false,
      });

      return response as string;
    } catch (error) {
      logError(error, { namespace, podName, containerName, operation: 'get pod logs' });
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // CLUSTER INFO
  // -------------------------------------------------------------------------

  /**
   * Get cluster version information
   */
  async getClusterVersion(): Promise<k8s.VersionInfo> {
    try {
      const versionApi = this.kc.makeApiClient(k8s.VersionApi);
      const response = await versionApi.getCode();
      return response;
    } catch (error) {
      logError(error, { operation: 'get cluster version' });
      throw error;
    }
  }

  /**
   * Get cluster information
   */
  async getClusterInfo(): Promise<any> {
    this.log.debug('Getting cluster info');

    try {
      const version = await this.getClusterVersion();
      
      // Get node count
      const nodes = await this.coreApi.listNode();
      
      return {
        version: {
          gitVersion: version.gitVersion,
          major: version.major,
          minor: version.minor,
          platform: version.platform,
        },
        nodeCount: (nodes as any).items?.length || 0,
        namespace: this.namespace,
      };
    } catch (error) {
      logError(error, { operation: 'get cluster info' });
      throw error;
    }
  }
}