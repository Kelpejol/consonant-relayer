/**
 * Socket.io Server
 * 
 * Bidirectional Socket.io server that accepts connections from Terra Backend.
 * Handles commands from backend and sends responses/events back.
 * 
 * Architecture:
 * Terra Backend → Socket.io → This Server → Execute Command → Response
 * 
 * Supported Commands:
 * - deploy:agent - Deploy a new agent
 * - delete:agent - Delete an agent
 * - invoke:agent - Invoke an agent
 * - list:agents - List agents
 * - get:agent - Get agent details
 */

import { Server as SocketIOServer, Socket } from 'socket.io';
import { createServer, Server as HttpServer } from 'http';
import { EventEmitter } from 'events';
import type { AgentDeployment } from './agent-deployment.js';
import type { AgentRegistry } from './agent-registry.js';
import type { KagentClient } from './kagent-client.js';
import type { TelemetryCollector } from './telemetry-collector.js';
import type {
  DeployAgentRequest,
  DeployAgentResponse,
  DeleteAgentRequest,
  DeleteAgentResponse,
  InvokeAgentRequest,
  InvokeAgentResponse,
  ListAgentsRequest,
  ListAgentsResponse,
  GetAgentRequest,
  GetAgentResponse,
} from '../types/agent.js';
import { logger as rootLogger } from '../utils/logger.js';

export interface SocketServerConfig {
  port: number;
  clusterId: string;
  clusterToken: string;
  cors?: {
    origin: string | string[];
    credentials: boolean;
  };
}

/**
 * Socket.io Server
 * 
 * Accepts connections from Terra Backend and handles commands
 */
export class SocketServer extends EventEmitter {
  private httpServer: HttpServer;
  private io: SocketIOServer;
  private connectedClients = new Map<string, Socket>();
  private isStarted = false;
  
  constructor(
    private config: SocketServerConfig,
    private agentDeployment: AgentDeployment,
    private agentRegistry: AgentRegistry,
    private kagentClient: KagentClient,
    private telemetryCollector: TelemetryCollector,
    private logger: typeof rootLogger
  ) {
    super();
    
    // Create HTTP server
    this.httpServer = createServer();
    
    // Create Socket.io server
    this.io = new SocketIOServer(this.httpServer, {
      cors: config.cors || {
        origin: '*',
        credentials: true,
      },
      transports: ['websocket', 'polling'],
      pingTimeout: 60000,
      pingInterval: 25000,
    });
    
    this.setupHandlers();
  }

  /**
   * Setup Socket.io event handlers
   */
  private setupHandlers(): void {
    this.io.on('connection', (socket: Socket) => {
      this.handleConnection(socket);
    });
  }

  /**
   * Handle new client connection
   */
  private handleConnection(socket: Socket): void {
    const clientId = socket.id;
    
    this.logger.info({
      clientId,
      remoteAddress: socket.handshake.address,
    }, 'Client connected to socket server');
    
    this.connectedClients.set(clientId, socket);
    
    // Authentication
    socket.on('authenticate', (data: { token: string }, callback) => {
      this.handleAuthenticate(socket, data, callback);
    });
    
    // Agent deployment commands
    socket.on('deploy:agent', (req: DeployAgentRequest, callback) => {
      this.handleDeployAgent(socket, req, callback);
    });
    
    socket.on('delete:agent', (req: DeleteAgentRequest, callback) => {
      this.handleDeleteAgent(socket, req, callback);
    });
    
    socket.on('list:agents', (req: ListAgentsRequest, callback) => {
      this.handleListAgents(socket, req, callback);
    });
    
    socket.on('get:agent', (req: GetAgentRequest, callback) => {
      this.handleGetAgent(socket, req, callback);
    });
    
    // Agent invocation commands
    socket.on('invoke:agent', (req: InvokeAgentRequest, callback) => {
      this.handleInvokeAgent(socket, req, callback);
    });
    
    // Disconnect
    socket.on('disconnect', (reason) => {
      this.handleDisconnect(socket, reason);
    });
    
    // Error
    socket.on('error', (error) => {
      this.logger.error({
        error,
        clientId,
      }, 'Socket error');
    });
  }

  /**
   * Handle authentication
   */
  private handleAuthenticate(
    socket: Socket,
    data: { token: string },
    callback: (response: { success: boolean; message?: string }) => void
  ): void {
    this.logger.debug({ clientId: socket.id }, 'Authenticating client');
    
    // Verify token
    if (data.token !== this.config.clusterToken) {
      this.logger.warn({ clientId: socket.id }, 'Authentication failed');
      callback({ success: false, message: 'Invalid token' });
      socket.disconnect(true);
      return;
    }
    
    // Mark as authenticated
    (socket as any).authenticated = true;
    
    this.logger.info({ clientId: socket.id }, 'Client authenticated');
    
    callback({
      success: true,
      message: 'Authenticated successfully',
    });
    
    // Send cluster info
    socket.emit('cluster:info', {
      clusterId: this.config.clusterId,
      agents: this.agentRegistry.getStats(),
    });
  }

  /**
   * Handle deploy agent command
   */
  private async handleDeployAgent(
    socket: Socket,
    req: DeployAgentRequest,
    callback: (response: DeployAgentResponse) => void
  ): void {
    this.logger.info({
      agent: req.config.name,
      image: req.config.image,
    }, 'Received deploy agent command');
    
    try {
      const result = await this.agentDeployment.deployAgent(req.config);
      
      if (result.success && result.agent) {
        // Broadcast to all connected clients
        this.io.emit('agent:registered', result.agent);
        
        callback({
          success: true,
          agent: result.agent,
        });
      } else {
        callback({
          success: false,
          error: result.error || 'Deployment failed',
        });
      }
    } catch (error) {
      this.logger.error({
        error: error instanceof Error ? error : new Error(String(error)),
        agent: req.config.name,
      }, 'Failed to deploy agent');
      
      callback({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle delete agent command
   */
  private async handleDeleteAgent(
    socket: Socket,
    req: DeleteAgentRequest,
    callback: (response: DeleteAgentResponse) => void
  ): void {
    this.logger.info({
      agent: req.name,
      namespace: req.namespace,
    }, 'Received delete agent command');
    
    try {
      const result = await this.agentDeployment.deleteAgent(req.name, req.namespace);
      
      if (result.success) {
        // Broadcast to all connected clients
        this.io.emit('agent:unregistered', {
          name: req.name,
          namespace: req.namespace,
        });
        
        callback({ success: true });
      } else {
        callback({
          success: false,
          error: result.error || 'Deletion failed',
        });
      }
    } catch (error) {
      this.logger.error({
        error: error instanceof Error ? error : new Error(String(error)),
        agent: req.name,
      }, 'Failed to delete agent');
      
      callback({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle list agents command
   */
  private handleListAgents(
    socket: Socket,
    req: ListAgentsRequest,
    callback: (response: ListAgentsResponse) => void
  ): void {
    this.logger.debug({ filters: req }, 'Received list agents command');
    
    try {
      let agents = req.namespace
        ? this.agentRegistry.listByNamespace(req.namespace)
        : req.clusterId
          ? this.agentRegistry.listByCluster(req.clusterId)
          : this.agentRegistry.listAll();
      
      // Filter by status
      if (req.status && req.status !== 'all') {
        agents = agents.filter(agent => {
          switch (req.status) {
            case 'ready':
              return agent.k8sStatus.ready;
            case 'pending':
              return !agent.k8sStatus.ready && agent.k8sStatus.phase === 'Pending';
            case 'failed':
              return agent.k8sStatus.phase === 'Failed';
            default:
              return true;
          }
        });
      }
      
      callback({
        agents,
        total: agents.length,
      });
    } catch (error) {
      this.logger.error({
        error: error instanceof Error ? error : new Error(String(error)),
      }, 'Failed to list agents');
      
      callback({
        agents: [],
        total: 0,
      });
    }
  }

  /**
   * Handle get agent command
   */
  private handleGetAgent(
    socket: Socket,
    req: GetAgentRequest,
    callback: (response: GetAgentResponse) => void
  ): void {
    this.logger.debug({
      agent: req.name,
      namespace: req.namespace,
    }, 'Received get agent command');
    
    try {
      const agent = this.agentRegistry.get(req.name, req.namespace);
      
      if (agent) {
        callback({ agent });
      } else {
        callback({
          error: `Agent ${req.name} not found in namespace ${req.namespace}`,
        });
      }
    } catch (error) {
      this.logger.error({
        error: error instanceof Error ? error : new Error(String(error)),
        agent: req.name,
      }, 'Failed to get agent');
      
      callback({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle invoke agent command
   */
  private async handleInvokeAgent(
    socket: Socket,
    req: InvokeAgentRequest,
    callback: (response: InvokeAgentResponse) => void
  ): void {
    this.logger.info({
      agent: req.agent,
      namespace: req.namespace,
      messageId: req.message.messageId,
    }, 'Received invoke agent command');
    
    try {
      // Check if agent exists
      const agent = this.agentRegistry.get(req.agent, req.namespace);
      if (!agent) {
        callback({
          error: `Agent ${req.agent} not found`,
        });
        return;
      }
      
      // Send message to agent via Kagent
      if (req.options?.streaming) {
        // TODO: Handle streaming invocation
        callback({
          error: 'Streaming not yet implemented',
        });
      } else {
        const result = await this.kagentClient.sendMessage(
          req.agent,
          req.message,
          {
            blocking: req.options?.blocking,
            historyLength: req.options?.historyLength,
          }
        );
        
        // Check if result is a Task or Message
        if ('id' in result) {
          // It's a Task
          callback({
            taskId: result.id,
            contextId: result.contextId,
            task: result,
          });
        } else {
          // It's a Message
          callback({
            message: result,
          });
        }
      }
    } catch (error) {
      this.logger.error({
        error: error instanceof Error ? error : new Error(String(error)),
        agent: req.agent,
      }, 'Failed to invoke agent');
      
      callback({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle client disconnect
   */
  private handleDisconnect(socket: Socket, reason: string): void {
    const clientId = socket.id;
    
    this.logger.info({
      clientId,
      reason,
    }, 'Client disconnected from socket server');
    
    this.connectedClients.delete(clientId);
  }

  /**
   * Start the server
   */
  async start(): Promise<void> {
    if (this.isStarted) {
      this.logger.warn('Socket server already started');
      return;
    }
    
    return new Promise((resolve, reject) => {
      this.httpServer.listen(this.config.port, () => {
        this.isStarted = true;
        this.logger.info({
          port: this.config.port,
        }, 'Socket.io server started');
        resolve();
      });
      
      this.httpServer.on('error', (error) => {
        this.logger.error({ error }, 'Socket server error');
        reject(error);
      });
    });
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    if (!this.isStarted) {
      return;
    }
    
    this.logger.info('Stopping socket server');
    
    // Disconnect all clients
    for (const [clientId, socket] of this.connectedClients.entries()) {
      socket.disconnect(true);
    }
    this.connectedClients.clear();
    
    // Close Socket.io
    await new Promise<void>((resolve) => {
      this.io.close(() => {
        this.logger.info('Socket.io closed');
        resolve();
      });
    });
    
    // Close HTTP server
    await new Promise<void>((resolve, reject) => {
      this.httpServer.close((error) => {
        if (error) {
          reject(error);
        } else {
          this.logger.info('HTTP server closed');
          resolve();
        }
      });
    });
    
    this.isStarted = false;
  }

  /**
   * Broadcast event to all connected clients
   */
  broadcast(event: string, data: unknown): void {
    this.io.emit(event, data);
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.isStarted;
  }

  /**
   * Get connected client count
   */
  getClientCount(): number {
    return this.connectedClients.size;
  }
}