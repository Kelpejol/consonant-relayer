/**
 * @fileoverview Agent Types - Complete Agent System
 * 
 * Unified type system for all agent operations:
 * - Discovery (PULL from Kagent)
 * - Registry (PUSH from agents)
 * - Invocation (EXECUTE via Kagent A2A)
 * 
 * @author Consonant Engineering
 * @version 1.0.0
 */

/**
 * Agent card from Kagent A2A protocol
 */
export interface AgentCard {
  readonly name: string;
  readonly description: string;
  readonly url: string;
  readonly version: string;
  readonly protocolVersion: string;
  readonly capabilities: {
    readonly streaming: boolean;
    readonly pushNotifications: boolean;
    readonly stateTransitionHistory: boolean;
  };
  readonly defaultInputModes: ReadonlyArray<string>;
  readonly defaultOutputModes: ReadonlyArray<string>;
  readonly skills: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly examples: ReadonlyArray<string>;
    readonly inputModes: ReadonlyArray<string>;
    readonly outputModes: ReadonlyArray<string>;
  }>;
}

/**
 * Agent metadata stored in relayer
 */
export interface AgentMetadata {
  readonly id: string;
  readonly namespace: string;
  readonly name: string;
  readonly card: AgentCard;
  readonly discoveryMethod: 'wellknown' | 'registration' | 'crd';
  readonly firstSeenAt: string;
  readonly lastUpdatedAt: string;
  readonly fetchCount: number;
  readonly reachable: boolean;
  readonly lastError?: string;
  readonly registration?: {
    readonly sourceIP: string;
    readonly userAgent?: string;
    readonly registeredAt: string;
  };
}

/**
 * Agent registration request (HTTP POST)
 */
export interface AgentRegistrationRequest {
  readonly namespace: string;
  readonly name: string;
  readonly card: AgentCard;
}

/**
 * Agent registration response
 */
export interface AgentRegistrationResponse {
  readonly success: boolean;
  readonly agentId: string;
  readonly message: string;
  readonly isNew: boolean;
}

/**
 * Agent invocation request (from backend)
 */
export interface AgentInvocationRequest {
  readonly invocationId: string;
  readonly agentId: string;
  readonly namespace: string;
  readonly name: string;
  readonly message: string;
  readonly parameters?: Record<string, unknown>;
  readonly timeout?: number;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Agent invocation response (to backend)
 */
export interface AgentInvocationResponse {
  readonly invocationId: string;
  readonly status: 'success' | 'failure' | 'timeout' | 'cancelled';
  readonly response?: string;
  readonly error?: string;
  readonly durationMs: number;
  readonly timestamp: string;
}

/**
 * In-flight invocation tracking
 */
export interface InFlightInvocation {
  readonly request: AgentInvocationRequest;
  readonly startedAt: number;
  timeoutHandle?: NodeJS.Timeout;
  cancelled: boolean;
}

/**
 * Agent query options
 */
export interface AgentQueryOptions {
  readonly namespace?: string;
  readonly reachable?: boolean;
  readonly discoveryMethod?: AgentMetadata['discoveryMethod'];
  readonly limit?: number;
}