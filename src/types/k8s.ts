/**
 * @fileoverview Kubernetes Types
 * 
 * Type definitions for Kubernetes resources we interact with:
 * - Agent CRDs (kagent.dev/v1alpha2)
 * - Pods
 * - Events
 * 
 * @author Consonant Engineering
 * @version 2.0.0
 */

/**
 * Kubernetes metadata (standard)
 */
export interface K8sMetadata {
  readonly name: string;
  readonly namespace?: string;
  readonly uid?: string;
  readonly resourceVersion?: string;
  readonly creationTimestamp?: string;
  readonly labels?: Record<string, string>;
  readonly annotations?: Record<string, string>;
}

/**
 * Agent CRD (kagent.dev/v1alpha2)
 */
export interface AgentCRD {
  readonly apiVersion: 'kagent.dev/v1alpha2';
  readonly kind: 'Agent';
  readonly metadata: K8sMetadata;
  readonly spec: {
    readonly name: string;
    readonly description?: string;
    readonly image?: string;
    readonly replicas?: number;
    readonly resources?: {
      readonly requests?: {
        readonly cpu?: string;
        readonly memory?: string;
      };
      readonly limits?: {
        readonly cpu?: string;
        readonly memory?: string;
      };
    };
  };
  readonly status?: {
    readonly phase?: string;
    readonly conditions?: Array<{
      readonly type: string;
      readonly status: string;
      readonly reason?: string;
      readonly message?: string;
      readonly lastTransitionTime?: string;
    }>;
  };
}

/**
 * Kubernetes Pod
 */
export interface Pod {
  readonly apiVersion: 'v1';
  readonly kind: 'Pod';
  readonly metadata: K8sMetadata;
  readonly spec: {
    readonly nodeName?: string;
    readonly containers: Array<{
      readonly name: string;
      readonly image: string;
      readonly ports?: Array<{
        readonly containerPort: number;
        readonly protocol?: string;
      }>;
    }>;
  };
  readonly status?: {
    readonly phase: string;
    readonly conditions?: Array<{
      readonly type: string;
      readonly status: string;
      readonly reason?: string;
      readonly message?: string;
      readonly lastTransitionTime?: string;
    }>;
    readonly containerStatuses?: Array<{
      readonly name: string;
      readonly ready: boolean;
      readonly restartCount: number;
      readonly state?: {
        readonly waiting?: {
          readonly reason?: string;
          readonly message?: string;
        };
        readonly running?: {
          readonly startedAt?: string;
        };
        readonly terminated?: {
          readonly exitCode?: number;
          readonly reason?: string;
          readonly message?: string;
        };
      };
    }>;
    readonly podIP?: string;
    readonly hostIP?: string;
    readonly startTime?: string;
  };
}

/**
 * Kubernetes Event
 */
export interface K8sEvent {
  readonly apiVersion: 'v1';
  readonly kind: 'Event';
  readonly metadata: K8sMetadata;
  readonly involvedObject: {
    readonly apiVersion?: string;
    readonly kind: string;
    readonly name: string;
    readonly namespace?: string;
    readonly uid?: string;
    readonly resourceVersion?: string;
  };
  readonly reason: string;
  readonly message: string;
  readonly type: string; // Normal, Warning
  readonly count?: number;
  readonly firstTimestamp?: string;
  readonly lastTimestamp?: string;
  readonly source?: {
    readonly component?: string;
    readonly host?: string;
  };
}

/**
 * Kubernetes Watch Event
 */
export interface WatchEvent<T = unknown> {
  readonly type: 'ADDED' | 'MODIFIED' | 'DELETED' | 'ERROR';
  readonly object: T;
}

/**
 * Watch type identifier
 */
export type WatchType = 'agents' | 'pods' | 'events';