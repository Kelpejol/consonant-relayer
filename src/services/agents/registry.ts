/**
 * @fileoverview Agent Registry - Accept Agent Self-Registration
 * 
 * Handles agent registration via HTTP POST endpoint.
 * 
 * Flow:
 * 1. Agent POSTs to /api/agents/register with AgentCard
 * 2. Validate payload structure
 * 3. Store in agent store
 * 4. Emit registration event
 * 5. Return 200 OK with agent ID
 * 
 * Features:
 * - Zod schema validation
 * - Duplicate handling (update existing)
 * - IP tracking for security
 * - Event emission for backend forwarding
 * 
 * @author Consonant Engineering
 * @version 2.0.0
 */

import { z } from 'zod';
import type {
  AgentCard,
  AgentMetadata,
  AgentRegistrationRequest,
  AgentRegistrationResponse,
} from '../../types/agents.js';
import type { AgentStore } from './store.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('agent-registry');

/**
 * Zod schema for AgentCard validation
 * 
 * Validates the Kagent A2A structure exactly as documented.
 */
const AgentCardSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string(),
  url: z.string().url('URL must be valid'),
  version: z.string().min(1, 'Version is required'),
  protocolVersion: z.string().min(1, 'Protocol version is required'),
  capabilities: z.object({
    streaming: z.boolean(),
    pushNotifications: z.boolean(),
    stateTransitionHistory: z.boolean(),
  }),
  defaultInputModes: z.array(z.string()),
  defaultOutputModes: z.array(z.string()),
  skills: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      description: z.string(),
      examples: z.array(z.string()),
      inputModes: z.array(z.string()),
      outputModes: z.array(z.string()),
    })
  ),
});

/**
 * Zod schema for registration request
 */
const AgentRegistrationRequestSchema = z.object({
  namespace: z
    .string()
    .min(1, 'Namespace is required')
    .regex(/^[a-z0-9-]+$/, 'Namespace must be lowercase alphanumeric with hyphens'),
  name: z
    .string()
    .min(1, 'Name is required')
    .regex(/^[a-z0-9-]+$/, 'Name must be lowercase alphanumeric with hyphens'),
  card: AgentCardSchema,
});

/**
 * Agent Registry Service
 * 
 * Accepts agent self-registrations via HTTP POST.
 * Validates, stores, and emits events.
 */
export class AgentRegistryService {
  constructor(private readonly agentStore: AgentStore) {}
  
  /**
   * Register agent
   * 
   * Called by HTTP POST /api/agents/register endpoint.
   * 
   * @param request - Registration request
   * @param sourceIP - Client IP address
   * @param userAgent - Client User-Agent header
   * @returns Registration response
   * @throws {Error} If validation fails
   */
  register(
    request: unknown,
    sourceIP: string,
    userAgent?: string
  ): AgentRegistrationResponse {
    logger.info({ sourceIP }, 'Agent registration request received');
    
    // Validate request
    let validated: AgentRegistrationRequest;
    try {
      validated = AgentRegistrationRequestSchema.parse(request);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errorMessages = error.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
        const message = `Validation failed: ${errorMessages.join(', ')}`;
        
        logger.warn({ sourceIP, errors: errorMessages }, 'Invalid registration request');
        
        throw new Error(message);
      }
      throw error;
    }
    
    const { namespace, name, card } = validated;
    const agentId = `${namespace}/${name}`;
    
    // Check if agent already exists
    const existing = this.agentStore.get(agentId);
    const isNew = !existing;
    
    // Create agent metadata
    const now = new Date().toISOString();
    const agent: AgentMetadata = {
      id: agentId,
      namespace,
      name,
      card,
      discoveryMethod: 'registration',
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastUpdatedAt: now,
      fetchCount: 0, // Not applicable for registration
      reachable: true, // Assume reachable since agent is actively registering
      registration: {
        sourceIP,
        userAgent,
        registeredAt: now,
      },
    };
    
    // Store agent
    this.agentStore.set(agent);
    
    logger.info(
      {
        agentId,
        namespace,
        name,
        sourceIP,
        isNew,
        skills: card.skills.length,
      },
      isNew ? 'Agent registered (new)' : 'Agent updated (existing)'
    );
    
    // Return response
    return {
      success: true,
      agentId,
      message: isNew
        ? `Agent ${agentId} registered successfully`
        : `Agent ${agentId} updated successfully`,
      isNew,
    };
  }
  
  /**
   * Validate registration request (without storing)
   * 
   * Useful for pre-validation in HTTP handler.
   * 
   * @param request - Request to validate
   * @returns Validation result
   */
  validate(request: unknown): { valid: boolean; errors?: string[] } {
    try {
      AgentRegistrationRequestSchema.parse(request);
      return { valid: true };
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errors = error.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
        return { valid: false, errors };
      }
      return { valid: false, errors: ['Unknown validation error'] };
    }
  }
}