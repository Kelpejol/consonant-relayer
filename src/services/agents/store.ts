/**
 * @fileoverview Agent Store - In-Memory Agent Database
 * 
 * Thread-safe in-memory storage for all discovered/registered agents.
 * 
 * Design:
 * - Single source of truth for agent metadata
 * - Map<agentId, AgentMetadata> for O(1) lookups
 * - Event emitter for change notifications
 * - NOT persistent (stateless relay design)
 * 
 * Operations:
 * - set(agent) - Add or update agent
 * - get(id) - Retrieve single agent
 * - delete(id) - Remove agent
 * - list(options) - Query agents with filters
 * - clear() - Remove all agents
 * 
 * Thread Safety:
 * - All operations are synchronous
 * - No race conditions (single-threaded Node.js)
 * - Immutable return values (defensive copies)
 * 
 * @author Consonant Engineering
 * @version 2.0.0
 */

import { EventEmitter } from 'events';
import type { AgentMetadata, AgentQueryOptions } from '../../types/agents.js';

/**
 * Agent Store Events
 */
export interface AgentStoreEvents {
  'agent:added': (agent: AgentMetadata) => void;
  'agent:updated': (agent: AgentMetadata, previous: AgentMetadata) => void;
  'agent:deleted': (agentId: string) => void;
}

/**
 * Agent Store - In-Memory Agent Database
 * 
 * Stateless, ephemeral storage for agent metadata.
 * All data lost on restart (by design - we're a relay).
 */
export class AgentStore extends EventEmitter {
  /** Primary storage: Map<agentId, AgentMetadata> */
  private readonly agents = new Map<string, AgentMetadata>();
  
  /**
   * Set agent metadata (add or update)
   * 
   * If agent exists, updates it. Otherwise, adds new agent.
   * Emits 'agent:added' or 'agent:updated' event.
   * 
   * @param agent - Agent metadata to store
   * @returns The stored agent (defensive copy)
   */
  set(agent: AgentMetadata): AgentMetadata {
    const previous = this.agents.get(agent.id);
    
    // Store (immutable)
    this.agents.set(agent.id, Object.freeze({ ...agent }));
    
    // Emit event
    if (previous) {
      this.emit('agent:updated', agent, previous);
    } else {
      this.emit('agent:added', agent);
    }
    
    return agent;
  }
  
  /**
   * Get agent by ID
   * 
   * @param agentId - Agent identifier (namespace/name)
   * @returns Agent metadata or undefined
   */
  get(agentId: string): AgentMetadata | undefined {
    const agent = this.agents.get(agentId);
    
    // Return defensive copy (prevent external mutation)
    return agent ? { ...agent } : undefined;
  }
  
  /**
   * Delete agent by ID
   * 
   * @param agentId - Agent identifier
   * @returns True if agent was deleted, false if not found
   */
  delete(agentId: string): boolean {
    const deleted = this.agents.delete(agentId);
    
    if (deleted) {
      this.emit('agent:deleted', agentId);
    }
    
    return deleted;
  }
  
  /**
   * Check if agent exists
   * 
   * @param agentId - Agent identifier
   * @returns True if agent exists
   */
  has(agentId: string): boolean {
    return this.agents.has(agentId);
  }
  
  /**
   * List all agents (with optional filters)
   * 
   * @param options - Query options (namespace, reachable, discoveryMethod, limit)
   * @returns Array of agent metadata (defensive copies)
   */
  list(options: AgentQueryOptions = {}): AgentMetadata[] {
    let agents = Array.from(this.agents.values());
    
    // Filter by namespace
    if (options.namespace) {
      agents = agents.filter((a) => a.namespace === options.namespace);
    }
    
    // Filter by reachable status
    if (options.reachable !== undefined) {
      agents = agents.filter((a) => a.reachable === options.reachable);
    }
    
    // Filter by discovery method
    if (options.discoveryMethod) {
      agents = agents.filter((a) => a.discoveryMethod === options.discoveryMethod);
    }
    
    // Apply limit
    if (options.limit && options.limit > 0) {
      agents = agents.slice(0, options.limit);
    }
    
    // Return defensive copies
    return agents.map((a) => ({ ...a }));
  }
  
  /**
   * Get agent count
   * 
   * @returns Total number of agents
   */
  size(): number {
    return this.agents.size;
  }
  
  /**
   * Clear all agents
   * 
   * Emits 'agent:deleted' for each agent.
   * Use sparingly - typically only on shutdown.
   */
  clear(): void {
    const agentIds = Array.from(this.agents.keys());
    
    this.agents.clear();
    
    // Emit delete events
    for (const agentId of agentIds) {
      this.emit('agent:deleted', agentId);
    }
  }
  
  /**
   * Get agents by namespace
   * 
   * Convenience method for namespace-specific queries.
   * 
   * @param namespace - Kubernetes namespace
   * @returns Array of agents in namespace
   */
  getByNamespace(namespace: string): AgentMetadata[] {
    return this.list({ namespace });
  }
  
  /**
   * Get reachable agents only
   * 
   * Convenience method for filtering reachable agents.
   * 
   * @returns Array of reachable agents
   */
  getReachable(): AgentMetadata[] {
    return this.list({ reachable: true });
  }
  
  /**
   * Get unreachable agents only
   * 
   * Useful for monitoring/debugging.
   * 
   * @returns Array of unreachable agents
   */
  getUnreachable(): AgentMetadata[] {
    return this.list({ reachable: false });
  }
  
  /**
   * Get statistics
   * 
   * @returns Store statistics
   */
  getStats(): {
    total: number;
    reachable: number;
    unreachable: number;
    byNamespace: Record<string, number>;
    byDiscoveryMethod: Record<string, number>;
  } {
    const agents = Array.from(this.agents.values());
    
    // Count by namespace
    const byNamespace: Record<string, number> = {};
    for (const agent of agents) {
      byNamespace[agent.namespace] = (byNamespace[agent.namespace] ?? 0) + 1;
    }
    
    // Count by discovery method
    const byDiscoveryMethod: Record<string, number> = {};
    for (const agent of agents) {
      byDiscoveryMethod[agent.discoveryMethod] =
        (byDiscoveryMethod[agent.discoveryMethod] ?? 0) + 1;
    }
    
    return {
      total: agents.length,
      reachable: agents.filter((a) => a.reachable).length,
      unreachable: agents.filter((a) => !a.reachable).length,
      byNamespace,
      byDiscoveryMethod,
    };
  }
}