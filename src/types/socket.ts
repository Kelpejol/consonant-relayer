/**
 * @fileoverview Backend Types - Socket.io Protocol
 * 
 * Type definitions for bidirectional communication between
 * Relayer and Backend via Socket.io
 * 
 * @author Consonant Engineering
 * @version 2.0.0
 */

import type { AgentMetadata, AgentInvocationRequest, AgentInvocationResponse } from './agents.js';

/**
 * Telemetry event (from OTEL collector)
 */
export interface TelemetryEvent {
  readonly type: 'trace' | 'log' | 'metric';
  readonly timestamp: string;
  readonly data: unknown;
}

/**
 * Pod information
 */
export interface PodInfo {
  readonly namespace: string;
  readonly name: string;
  readonly phase: string;
  readonly conditions?: Array<{
    readonly type: string;
    readonly status: string;
    readonly reason?: string;
    readonly message?: string;
  }>;
  readonly containerStatuses?: Array<{
    readonly name: string;
    readonly ready: boolean;
    readonly restartCount: number;
    readonly state?: unknown;
  }>;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Kubernetes event
 */
export interface KubernetesEvent {
  readonly type: string;
  readonly reason: string;
  readonly message: string;
  readonly involvedObject: {
    readonly kind: string;
    readonly namespace?: string;
    readonly name: string;
  };
  readonly firstTimestamp?: string;
  readonly lastTimestamp?: string;
  readonly count?: number;
}

/**
 * Cluster registration request
 */
export interface ClusterRegistration {
  readonly clusterId: string;
  readonly clusterName: string;
  readonly version: string;
  readonly capabilities: string[];
}

/**
 * Heartbeat payload
 */
export interface Heartbeat {
  readonly timestamp: string;
  readonly metrics: {
    readonly agentsDiscovered: number;
    readonly agentsActive: number;
    readonly agentsReachable: number;
    readonly activePods: number;
    readonly telemetryEventsPerSecond: number;
    readonly inflightInvocations: number;
  };
}

/**
 * Client → Server Events (Relayer sends to Backend)
 */
export interface ClientToServerEvents {
  /** Register cluster with backend */
  'cluster:register': (registration: ClusterRegistration) => void;
  
  /** Heartbeat */
  'cluster:heartbeat': (heartbeat: Heartbeat) => void;
  
  /** Agent discovered or registered */
  'agent:discovered': (agent: AgentMetadata) => void;
  
  /** Agent metadata updated */
  'agent:updated': (agent: AgentMetadata) => void;
  
  /** Agent removed */
  'agent:removed': (agentId: string) => void;
  
  /** Invocation response */
  'invocation:response': (response: AgentInvocationResponse) => void;
  
  /** Telemetry batch */
  'telemetry:batch': (events: TelemetryEvent[]) => void;
  
  /** Pod status update */
  'pod:status': (pod: PodInfo) => void;
  
  /** Kubernetes event */
  'k8s:event': (event: KubernetesEvent) => void;
}

/**
 * Server → Client Events (Backend sends to Relayer)
 */
export interface ServerToClientEvents {
  /** Cluster registration confirmed */
  'cluster:registered': (clusterId: string) => void;
  
  /** Invoke agent */
  'agent:invoke': (request: AgentInvocationRequest) => void;
  
  /** Cancel invocation */
  'agent:cancel': (invocationId: string) => void;
  
  /** Configuration update */
  'config:update': (config: Record<string, unknown>) => void;
}