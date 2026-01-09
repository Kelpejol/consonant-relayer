/**
 * Command Router
 * 
 * Routes and executes commands received from the backend.
 * Handles all command types defined in the protocol.
 */

import type { KubernetesClient } from '../k8s/client.js';
import type { KagentA2AClient } from '../kagent/client.js';
import { logger, createComponentLogger, logError, createTimer } from '../utils/logger.js';
import { parse as parseYaml } from 'yaml';

// ===========================================================================
// TYPES
// ===========================================================================

export interface Command {
  command_id: string;
  type: string;
  parameters: any;
  timeout_seconds?: number;
  priority?: number;
  retryable?: boolean;
  idempotency_key?: string;
}

export interface CommandResponse {
  command_id: string;
  status: 'COMMAND_STATUS_SUCCESS' | 'COMMAND_STATUS_FAILED' | 'COMMAND_STATUS_TIMEOUT' | 'COMMAND_STATUS_REJECTED';
  data?: any;
  error?: string;
  execution_duration_ms: number;
  error_context?: {
    code: string;
    stack_trace?: string;
    context?: Record<string, string>;
  };
}

export interface CommandHandler {
  (command: Command): Promise<any>;
}

// ===========================================================================
// COMMAND ROUTER
// ===========================================================================

export class CommandRouter {
  private readonly log = createComponentLogger('CommandRouter');
  private readonly handlers = new Map<string, CommandHandler>();
  private activeCommands = 0;

  constructor(
    private readonly k8sClient: KubernetesClient,
    private readonly kagentClient: KagentA2AClient
  ) {
    this.registerHandlers();
  }

  // -------------------------------------------------------------------------
  // HANDLER REGISTRATION
  // -------------------------------------------------------------------------

  private registerHandlers(): void {
    // Agent operations
    this.handlers.set('COMMAND_TYPE_DEPLOY_AGENT', this.handleDeployAgent.bind(this));
    this.handlers.set('COMMAND_TYPE_DELETE_AGENT', this.handleDeleteAgent.bind(this));
    this.handlers.set('COMMAND_TYPE_INVOKE_AGENT', this.handleInvokeAgent.bind(this));
    this.handlers.set('COMMAND_TYPE_LIST_AGENTS', this.handleListAgents.bind(this));
    this.handlers.set('COMMAND_TYPE_GET_AGENT', this.handleGetAgent.bind(this));

    // Resource operations
    this.handlers.set('COMMAND_TYPE_GET_CLUSTER_INFO', this.handleGetClusterInfo.bind(this));
    this.handlers.set('COMMAND_TYPE_GET_LOGS', this.handleGetLogs.bind(this));

    // Health check
    this.handlers.set('COMMAND_TYPE_HEALTH_CHECK', this.handleHealthCheck.bind(this));

    this.log.info({ handlerCount: this.handlers.size }, 'Command handlers registered');
  }

  // -------------------------------------------------------------------------
  // COMMAND EXECUTION
  // -------------------------------------------------------------------------

  /**
   * Execute a command and return response
   */
  async executeCommand(command: Command): Promise<CommandResponse> {
    const timer = createTimer('execute_command', {
      command_id: command.command_id,
      command_type: command.type,
    });

    this.activeCommands++;

    try {
      this.log.info(
        {
          command_id: command.command_id,
          type: command.type,
          active_commands: this.activeCommands,
        },
        'Executing command'
      );

      // Get handler
      const handler = this.handlers.get(command.type);

      if (!handler) {
        return {
          command_id: command.command_id,
          status: 'COMMAND_STATUS_REJECTED',
          error: `Unknown command type: ${command.type}`,
          execution_duration_ms: timer.end(false),
          error_context: {
            code: 'UNKNOWN_COMMAND_TYPE',
          },
        };
      }

      // Execute with timeout
      const timeoutMs = (command.timeout_seconds || 30) * 1000;
      const result = await this.executeWithTimeout(handler(command), timeoutMs);

      const duration = timer.end(true);

      this.log.info(
        {
          command_id: command.command_id,
          type: command.type,
          duration_ms: duration,
        },
        'Command executed successfully'
      );

      return {
        command_id: command.command_id,
        status: 'COMMAND_STATUS_SUCCESS',
        data: result,
        execution_duration_ms: duration,
      };
    } catch (error) {
      const duration = timer.end(false);

      logError(error, {
        command_id: command.command_id,
        command_type: command.type,
      });

      const isTimeout = error instanceof Error && error.message.includes('timeout');

      return {
        command_id: command.command_id,
        status: isTimeout ? 'COMMAND_STATUS_TIMEOUT' : 'COMMAND_STATUS_FAILED',
        error: error instanceof Error ? error.message : String(error),
        execution_duration_ms: duration,
        error_context: {
          code: isTimeout ? 'TIMEOUT' : 'EXECUTION_ERROR',
          stack_trace: error instanceof Error ? error.stack : undefined,
        },
      };
    } finally {
      this.activeCommands--;
    }
  }

  /**
   * Execute a promise with timeout
   */
  private async executeWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`Command timeout after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
  }

  /**
   * Get active command count
   */
  getActiveCommandCount(): number {
    return this.activeCommands;
  }

  // -------------------------------------------------------------------------
  // AGENT COMMANDS
  // -------------------------------------------------------------------------

  /**
   * Deploy an agent via Agent CRD
   */
  private async handleDeployAgent(command: Command): Promise<any> {
    const { yaml, agent_yaml } = command.parameters;
    const agentYaml = yaml || agent_yaml;

    if (!agentYaml) {
      throw new Error('Missing required parameter: yaml or agent_yaml');
    }

    this.log.debug('Deploying agent from YAML');

    // Parse YAML to JSON
    let agentCRD: any;
    try {
      agentCRD = typeof agentYaml === 'string' ? parseYaml(agentYaml) : agentYaml;
    } catch (error) {
      throw new Error(`Failed to parse agent YAML: ${(error as Error).message}`);
    }

    // Validate it's an Agent CRD
    if (agentCRD.apiVersion !== 'kagent.dev/v1alpha2' || agentCRD.kind !== 'Agent') {
      throw new Error('Invalid Agent CRD: must be kagent.dev/v1alpha2 Agent');
    }

    // Apply the CRD
    const result = await this.k8sClient.applyAgentCRD(agentCRD);

    return {
      name: result.metadata.name,
      namespace: result.metadata.namespace,
      status: 'deployed'
    
    };
  }

  /**
   * Delete an agent
   */
  private async handleDeleteAgent(command: Command): Promise<any> {
    const { namespace, name } = command.parameters;

    if (!name) {
      throw new Error('Missing required parameter: name');
    }

    const ns = namespace || this.k8sClient.getNamespace();

    this.log.debug({ namespace: ns, name }, 'Deleting agent');

    await this.k8sClient.deleteAgentCRD(ns, name);

    return {
      name,
      namespace: ns,
      status: 'deleted',
    };
  }

  /**
   * Invoke an agent via Kagent A2A API
   */
  private async handleInvokeAgent(command: Command): Promise<any> {
    const { namespace, agent_name, message, parameters } = command.parameters;

    if (!agent_name || !message) {
      throw new Error('Missing required parameters: agent_name, message');
    }

    const ns = namespace || this.k8sClient.getNamespace();

    this.log.debug({ namespace: ns, agent_name, message }, 'Invoking agent');

    const response = await this.kagentClient.sendMessage(ns, agent_name, message, parameters);

    return {
      agent_name,
      namespace: ns,
      response,
    };
  }

  /**
   * List agents
   */
  private async handleListAgents(command: Command): Promise<any> {
    const { namespace } = command.parameters;

    const ns = namespace || this.k8sClient.getNamespace();

    this.log.debug({ namespace: ns }, 'Listing agents');

    const agents = await this.k8sClient.listAgentCRDs(ns);

    return {
      namespace: ns,
      agents: agents.map((agent) => ({
        name: agent.metadata.name,
        namespace: agent.metadata.namespace,
        phase: agent.status?.phase,
        conditions: agent.status?.conditions,
      })),
      count: agents.length,
    };
  }

  /**
   * Get a single agent
   */
  private async handleGetAgent(command: Command): Promise<any> {
    const { namespace, name } = command.parameters;

    if (!name) {
      throw new Error('Missing required parameter: name');
    }

    const ns = namespace || this.k8sClient.getNamespace();

    this.log.debug({ namespace: ns, name }, 'Getting agent');

    const agent = await this.k8sClient.getAgentCRD(ns, name);

    if (!agent) {
      throw new Error(`Agent ${ns}/${name} not found`);
    }

    return {
      name: agent.metadata.name,
      namespace: agent.metadata.namespace,
      spec: agent.spec,
      status: agent.status,
    };
  }

  // -------------------------------------------------------------------------
  // CLUSTER COMMANDS
  // -------------------------------------------------------------------------

  /**
   * Get cluster information
   */
  private async handleGetClusterInfo(command: Command): Promise<any> {
    this.log.debug('Getting cluster info');

    const clusterInfo = await this.k8sClient.getClusterInfo();

    return clusterInfo;
  }

  /**
   * Get pod logs
   */
  private async handleGetLogs(command: Command): Promise<any> {
    const { namespace, pod_name, container_name, tail_lines } = command.parameters;

    if (!pod_name) {
      throw new Error('Missing required parameter: pod_name');
    }

    const ns = namespace || this.k8sClient.getNamespace();

    this.log.debug({ namespace: ns, pod_name, container_name }, 'Getting pod logs');

    const logs = await this.k8sClient.getPodLogs(ns, pod_name, container_name, tail_lines);

    return {
      namespace: ns,
      pod_name,
      container_name,
      logs,
    };
  }

  /**
   * Health check
   */
  private async handleHealthCheck(command: Command): Promise<any> {
    this.log.debug('Performing health check');

    // Check Kagent connectivity
    const kagentHealthy = await this.kagentClient.healthCheck();

    // Check Kubernetes connectivity
    let k8sHealthy = false;
    try {
      await this.k8sClient.getClusterVersion();
      k8sHealthy = true;
    } catch (error) {
      this.log.warn('Kubernetes API health check failed');
    }

    return {
      healthy: kagentHealthy && k8sHealthy,
      components: {
        kagent: kagentHealthy ? 'healthy' : 'unhealthy',
        kubernetes: k8sHealthy ? 'healthy' : 'unhealthy',
      },
      active_commands: this.activeCommands,
      circuit_breaker: {
        kagent: this.kagentClient.getCircuitState(),
      },
    };
  }
}