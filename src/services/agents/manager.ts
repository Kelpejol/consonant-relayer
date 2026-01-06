/**
 * @fileoverview Agent Manager - Orchestrates All Agent Operations
 * 
 * Single entry point for all agent operations:
 * - Store (in-memory database)
 * - Registry (PUSH from HTTP)
 * - Discovery (PULL from Kagent)
 * - Invoker (EXECUTE via Kagent A2A)
 * 
 * Responsibilities:
 * - Initialize and manage all agent services
 * - Wire events between services
 * - Provide unified API for agent operations
 * - Emit consolidated events for backend client
 * - Track metrics
 * 
 * Architecture:
 * - Implements IService interface
 * - Event-driven communication
 * - Delegates to specialized services
 * - Aggregates statistics
 * 
 * @author Consonant Engineering
 * @version 2.0.0
 */

import { EventEmitter } from 'events';
import type {
  AgentMetadata,
  AgentRegistrationRequest,
  AgentRegistrationResponse,
  AgentInvocationRequest,
  AgentInvocationResponse,
  AgentQueryOptions,
} from '../../types/agents.js';
import { AgentStore } from './store.js';
import { AgentRegistryService } from './registry.js';
import { AgentDiscoveryService, type AgentDiscoveryConfig } from './discovery.js';
import { AgentInvokerService, type AgentInvokerConfig } from './invoker.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('agent-manager');

/**
 * Agent Manager Events
 * 
 * Consolidated events emitted to backend client.
 */
export interface AgentManagerEvents {
  /** Agent registered via HTTP */
  'agent:registered': (agent: AgentMetadata) => void;
  
  /** Agent discovered via Kagent well-known */
  'agent:discovered': (agent: AgentMetadata) => void;
  
  /** Agent metadata updated */
  'agent:updated': (agent: AgentMetadata) => void;
  
  /** Agent removed */
  'agent:removed': (agentId: string) => void;
  
  /** Invocation completed (success, failure, timeout, cancelled) */
  'invocation:completed': (response: AgentInvocationResponse) => void;
}

/**
 * Agent Manager Configuration
 */
export interface AgentManagerConfig {
  readonly discovery: AgentDiscoveryConfig;
  readonly invoker: AgentInvokerConfig;
}

/**
 * Agent Manager Service
 * 
 * Orchestrates all agent operations. Single entry point for:
 * - Agent storage
 * - Agent registration (HTTP)
 * - Agent discovery (Kagent)
 * - Agent invocation (A2A)
 */
export class AgentManagerService extends EventEmitter {
  /** Agent store (in-memory database) */
  private readonly store: AgentStore;
  
  /** Registry service (HTTP POST) */
  private readonly registry: AgentRegistryService;
  
  /** Discovery service (Kagent well-known) */
  private readonly discovery: AgentDiscoveryService;
  
  /** Invoker service (Kagent A2A) */
  private readonly invoker: AgentInvokerService;
  
  /** Running flag */
  private running = false;
  
  constructor(config: AgentManagerConfig) {
    super();
    
    // Create store
    this.store = new AgentStore();
    
    // Create services
    this.registry = new AgentRegistryService(this.store);
    this.discovery = new AgentDiscoveryService(this.store, config.discovery);
    this.invoker = new AgentInvokerService(this.store, config.invoker);
    
    // Wire events
    this.wireEvents();
    
    logger.info('Agent manager initialized');
  }
  
  /**
   * Wire events between services
   * 
   * Store events → Manager events → Backend client
   */
  private wireEvents(): void {
    // Store events
    this.store.on('agent:added', (agent) => {
      // Determine if this was registration or discovery
      if (agent.discoveryMethod === 'registration') {
        this.emit('agent:registered', agent);
      } else {
        this.emit('agent:discovered', agent);
      }
    });
    
    this.store.on('agent:updated', (agent) => {
      this.emit('agent:updated', agent);
    });
    
    this.store.on('agent:deleted', (agentId) => {
      this.emit('agent:removed', agentId);
    });
    
    // Invoker events
    this.invoker.on('invocation:completed', (response) => {
      this.emit('invocation:completed', response);
    });
    
    this.invoker.on('invocation:started', (invocationId, agentId) => {
      logger.debug({ invocationId, agentId }, 'Invocation started');
    });
    
    this.invoker.on('invocation:timeout', (invocationId) => {
      logger.warn({ invocationId }, 'Invocation timed out');
    });
    
    this.invoker.on('invocation:cancelled', (invocationId) => {
      logger.info({ invocationId }, 'Invocation cancelled');
    });
    
    this.invoker.on('invocation:failed', (invocationId, error) => {
      logger.error({ invocationId, error: error.message }, 'Invocation failed');
    });
  }
  
  /**
   * Start service
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('Agent manager already running');
      return;
    }
    
    logger.info('Starting agent manager');
    
    // Start invoker
    this.invoker.start();
    
    this.running = true;
    
    logger.info('Agent manager started');
  }
  
  /**
   * Stop service
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    
    logger.info('Stopping agent manager');
    
    this.running = false;
    
    // Stop invoker (waits for in-flight invocations)
    await this.invoker.stop();
    
    // Clear store
    this.store.clear();
    
    logger.info('Agent manager stopped');
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
    return 'agent-manager';
  }
  
  // ========================================================================
  // AGENT REGISTRY (HTTP POST)
  // ========================================================================
  
  /**
   * Register agent (called by HTTP POST endpoint)
   * 
   * @param request - Registration request
   * @param sourceIP - Client IP
   * @param userAgent - Client User-Agent
   * @returns Registration response
   * @throws {Error} If validation fails
   */
  registerAgent(
    request: unknown,
    sourceIP: string,
    userAgent?: string
  ): AgentRegistrationResponse {
    return this.registry.register(request, sourceIP, userAgent);
  }
  
  /**
   * Validate registration request
   * 
   * @param request - Request to validate
   * @returns Validation result
   */
  validateRegistration(request: unknown): { valid: boolean; errors?: string[] } {
    return this.registry.validate(request);
  }
  
  // ========================================================================
  // AGENT DISCOVERY (KAGENT PULL)
  // ========================================================================
  
  /**
   * Discover agent from Kagent
   * 
   * @param namespace - Kubernetes namespace
   * @param name - Agent name
   * @returns Discovered agent
   */
  async discoverAgent(namespace: string, name: string): Promise<AgentMetadata> {
    return await this.discovery.discover(namespace, name);
  }
  
  /**
   * Rediscover agent (force refresh)
   * 
   * @param namespace - Kubernetes namespace
   * @param name - Agent name
   * @returns Updated agent
   */
  async rediscoverAgent(namespace: string, name: string): Promise<AgentMetadata> {
    return await this.discovery.rediscover(namespace, name);
  }
  
  /**
   * Discover multiple agents
   * 
   * @param agents - Array of {namespace, name}
   * @param concurrency - Max parallel discoveries
   * @returns Array of discovered agents
   */
  async discoverMany(
    agents: Array<{ namespace: string; name: string }>,
    concurrency?: number
  ): Promise<AgentMetadata[]> {
    return await this.discovery.discoverMany(agents, concurrency);
  }
  
  // ========================================================================
  // AGENT INVOCATION (KAGENT A2A)
  // ========================================================================
  
  /**
   * Invoke agent
   * 
   * @param request - Invocation request
   */
  async invokeAgent(request: AgentInvocationRequest): Promise<void> {
    await this.invoker.invoke(request);
  }
  
  /**
   * Cancel invocation
   * 
   * @param invocationId - Invocation ID
   */
  cancelInvocation(invocationId: string): void {
    this.invoker.cancelInvocation(invocationId);
  }
  
  /**
   * Get in-flight invocation count
   */
  getInflightCount(): number {
    return this.invoker.getInflightCount();
  }
  
  // ========================================================================
  // AGENT STORE (QUERIES)
  // ========================================================================
  
  /**
   * Get agent by ID
   * 
   * @param agentId - Agent identifier (namespace/name)
   * @returns Agent metadata or undefined
   */
  getAgent(agentId: string): AgentMetadata | undefined {
    return this.store.get(agentId);
  }
  
  /**
   * List agents with filters
   * 
   * @param options - Query options
   * @returns Array of agents
   */
  listAgents(options?: AgentQueryOptions): AgentMetadata[] {
    return this.store.list(options);
  }
  
  /**
   * Get agents by namespace
   * 
   * @param namespace - Kubernetes namespace
   * @returns Array of agents in namespace
   */
  getAgentsByNamespace(namespace: string): AgentMetadata[] {
    return this.store.getByNamespace(namespace);
  }
  
  /**
   * Remove agent
   * 
   * @param agentId - Agent identifier
   * @returns True if removed
   */
  removeAgent(agentId: string): boolean {
    return this.store.delete(agentId);
  }
  
  /**
   * Get agent count
   */
  getAgentCount(): number {
    return this.store.size();
  }
  
  // ========================================================================
  // STATISTICS & HEALTH
  // ========================================================================
  
  /**
   * Get comprehensive statistics
   */
  getStats(): {
    agents: ReturnType<AgentStore['getStats']>;
    invocations: {
      inflight: number;
      queue: ReturnType<AgentInvokerService['getQueueStats']>;
    };
  } {
    return {
      agents: this.store.getStats(),
      invocations: {
        inflight: this.invoker.getInflightCount(),
        queue: this.invoker.getQueueStats(),
      },
    };
  }
  
  /**
   * Get health status
   */
  getHealth(): {
    name: string;
    status: 'healthy' | 'unhealthy';
    details: {
      running: boolean;
      agentCount: number;
      reachableCount: number;
      inflightInvocations: number;
    };
    lastCheck: string;
  } {
    const stats = this.store.getStats();
    
    return {
      name: 'agent-manager',
      status: this.running ? 'healthy' : 'unhealthy',
      details: {
        running: this.running,
        agentCount: stats.total,
        reachableCount: stats.reachable,
        inflightInvocations: this.invoker.getInflightCount(),
      },
      lastCheck: new Date().toISOString(),
    };
  }
}