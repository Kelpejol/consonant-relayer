/**
 * @fileoverview Agent Discovery - PULL from Kagent Well-Known
 * 
 * Discovers agents by fetching their well-known endpoint from Kagent.
 * 
 * Triggered by:
 * - Kubernetes watch (new Agent CRD)
 * - Periodic refresh (optional)
 * - Manual request
 * 
 * Flow:
 * 1. Receive discovery request (namespace, name)
 * 2. Fetch from Kagent: GET /api/a2a/{ns}/{name}/.well-known/agent.json
 * 3. Parse AgentCard
 * 4. Store in agent store
 * 5. Emit discovery event
 * 
 * Features:
 * - Circuit breaker protection
 * - Retry with exponential backoff
 * - Error handling (unreachable agents)
 * - Fetch count tracking
 * 
 * @author Consonant Engineering
 * @version 2.0.0
 */

import { fetch } from 'undici';
import type { AgentCard, AgentMetadata } from '../../types/agents.js';
import type { AgentStore } from './store.js';
import { CircuitBreaker } from '../../utils/circuit-breaker.js';
import { retry, DEFAULT_RETRY_CONFIG } from '../../utils/retry.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('agent-discovery');

/**
 * Discovery Configuration
 */
export interface AgentDiscoveryConfig {
  readonly timeout: number;
  readonly retryAttempts: number;
  readonly retryDelay: number;
  readonly circuitBreaker: {
    readonly failureThreshold: number;
    readonly successThreshold: number;
    readonly timeout: number;
  };
}

/**
 * Agent Discovery Service
 * 
 * Discovers agents by pulling from Kagent well-known endpoint.
 */
export class AgentDiscoveryService {
  /** Circuit breaker for Kagent API */
  private readonly circuitBreaker: CircuitBreaker;
  
  constructor(
    private readonly agentStore: AgentStore,
    private readonly config: AgentDiscoveryConfig
  ) {
    // Create circuit breaker
    this.circuitBreaker = new CircuitBreaker({
      name: 'kagent-discovery-api',
      failureThreshold: config.circuitBreaker.failureThreshold,
      successThreshold: config.circuitBreaker.successThreshold,
      timeout: config.circuitBreaker.timeout,
    });
    
    // Log circuit breaker state changes
    this.circuitBreaker.on('stateChange', (state) => {
      logger.warn({ state }, 'Kagent discovery API circuit breaker state changed');
    });
  }
  
  /**
   * Discover agent
   * 
   * Fetches agent card from Kagent well-known endpoint and stores.
   * 
   * @param namespace - Kubernetes namespace
   * @param name - Agent name
   * @returns Discovered agent metadata
   * @throws {Error} If discovery fails
   */
  async discover(namespace: string, name: string): Promise<AgentMetadata> {
    const agentId = `${namespace}/${name}`;
    
    logger.info({ namespace, name }, 'Discovering agent from Kagent');
    
    try {
      // Fetch agent card
      const card = await this.fetchAgentCard(namespace, name);
      
      // Get existing agent (if any)
      const existing = this.agentStore.get(agentId);
      
      // Create or update agent metadata
      const now = new Date().toISOString();
      const agent: AgentMetadata = {
        id: agentId,
        namespace,
        name,
        card,
        discoveryMethod: 'wellknown',
        firstSeenAt: existing?.firstSeenAt ?? now,
        lastUpdatedAt: now,
        fetchCount: (existing?.fetchCount ?? 0) + 1,
        reachable: true,
        lastError: undefined,
      };
      
      // Store agent
      this.agentStore.set(agent);
      
      logger.info(
        {
          agentId,
          namespace,
          name,
          skills: card.skills.length,
          streaming: card.capabilities.streaming,
          fetchCount: agent.fetchCount,
        },
        'Agent discovered successfully'
      );
      
      return agent;
    } catch (error) {
      const err = error as Error;
      
      logger.error(
        { namespace, name, error: err.message },
        'Failed to discover agent'
      );
      
      // Update existing agent to mark as unreachable
      const existing = this.agentStore.get(agentId);
      if (existing) {
        const updated: AgentMetadata = {
          ...existing,
          reachable: false,
          lastError: err.message,
          lastUpdatedAt: new Date().toISOString(),
        };
        this.agentStore.set(updated);
      }
      
      throw err;
    }
  }
  
  /**
   * Fetch agent card from Kagent well-known endpoint
   * 
   * GET /api/a2a/{namespace}/{agent-name}/.well-known/agent.json
   * 
   * Uses circuit breaker and retry logic for resilience.
   * 
   * @param namespace - Kubernetes namespace
   * @param name - Agent name
   * @returns Agent card
   * @throws {Error} If fetch fails
   */
  private async fetchAgentCard(namespace: string, name: string): Promise<AgentCard> {
    // Build URL (Kagent controller default port: 8083)
    const url = `http://kagent-controller.${namespace}.svc.cluster.local:8083/api/a2a/${namespace}/${name}/.well-known/agent.json`;
    
    logger.debug({ url }, 'Fetching agent card from Kagent');
    
    // Use circuit breaker + retry
    return await this.circuitBreaker.execute(async () => {
      return await retry(
        async () => {
          const response = await fetch(url, {
            method: 'GET',
            headers: {
              Accept: 'application/json',
            },
            signal: AbortSignal.timeout(this.config.timeout),
          });
          
          if (!response.ok) {
            throw new Error(
              `Failed to fetch agent card: ${response.status} ${response.statusText}`
            );
          }
          
          const card = (await response.json()) as AgentCard;
          
          // Basic validation
          if (!card.name || !card.url) {
            throw new Error('Invalid agent card: missing required fields (name, url)');
          }
          
          if (!Array.isArray(card.skills)) {
            throw new Error('Invalid agent card: skills must be an array');
          }
          
          return card;
        },
        {
          ...DEFAULT_RETRY_CONFIG,
          maxAttempts: this.config.retryAttempts,
          initialDelay: this.config.retryDelay,
          operation: `fetch-agent-card-${namespace}/${name}`,
        }
      );
    });
  }
  
  /**
   * Rediscover agent (force refresh)
   * 
   * Same as discover() but explicitly refreshes existing agent.
   * 
   * @param namespace - Kubernetes namespace
   * @param name - Agent name
   * @returns Updated agent metadata
   */
  async rediscover(namespace: string, name: string): Promise<AgentMetadata> {
    logger.info({ namespace, name }, 'Rediscovering agent (forced refresh)');
    return await this.discover(namespace, name);
  }
  
  /**
   * Discover multiple agents
   * 
   * Discovers agents in parallel with concurrency limit.
   * 
   * @param agents - Array of {namespace, name}
   * @param concurrency - Max parallel discoveries (default: 5)
   * @returns Array of discovered agents (errors logged but not thrown)
   */
  async discoverMany(
    agents: Array<{ namespace: string; name: string }>,
    concurrency: number = 5
  ): Promise<AgentMetadata[]> {
    logger.info({ count: agents.length, concurrency }, 'Discovering multiple agents');
    
    const results: AgentMetadata[] = [];
    
    // Process in chunks
    for (let i = 0; i < agents.length; i += concurrency) {
      const chunk = agents.slice(i, i + concurrency);
      
      const chunkResults = await Promise.allSettled(
        chunk.map(({ namespace, name }) => this.discover(namespace, name))
      );
      
      for (const result of chunkResults) {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        }
        // Errors already logged in discover()
      }
    }
    
    logger.info(
      { total: agents.length, discovered: results.length },
      'Batch discovery completed'
    );
    
    return results;
  }
}
