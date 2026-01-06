/**
 * @fileoverview API Server - HTTP REST Endpoints
 * 
 * Provides HTTP REST API for:
 * - Agent registration (POST /api/agents/register)
 * - Health checks (GET /health/liveness, /health/readiness)
 * - Prometheus metrics (GET /metrics)
 * 
 * Features:
 * - Fastify framework (fast, low overhead)
 * - Rate limiting (100 req/min per IP)
 * - Request validation (Zod via agent registry)
 * - CORS enabled
 * - Security headers (Helmet)
 * - Error handling
 * 
 * @author Consonant Engineering
 * @version 1.0.0
 */

import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';

import type { AgentManagerService } from '../agents/manager.js';
import type { IService, ServiceHealth } from '../interfaces.js';
import { MetricsCollector } from '../../utils/metrics.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('api-server');

/**
 * API Server Configuration
 */
export interface ApiServerConfig {
  readonly port: number;
  readonly host: string;
  readonly rateLimit: {
    readonly max: number;
    readonly timeWindow: string;
  };
}

/**
 * API Server Service
 * 
 * HTTP REST API for agent registration and health checks.
 */
export class ApiServerService implements IService {
  private server: FastifyInstance;
  private running = false;
  private readonly metrics: MetricsCollector;
  
  /** Services to check for readiness */
  private healthCheckServices: IService[] = [];
  
  constructor(
    private readonly agentManager: AgentManagerService,
    private readonly config: ApiServerConfig
  ) {
    this.metrics = MetricsCollector.getInstance();
    
    // Create Fastify instance
    this.server = Fastify({
      logger: false, // Use our own logger
      disableRequestLogging: true,
      trustProxy: true, // For rate limiting behind load balancer
    });
    
    this.setupMiddleware();
    this.setupRoutes();
  }
  
  /**
   * Register services for readiness check
   * 
   * @param services - Services to check
   */
  registerHealthCheckServices(services: IService[]): void {
    this.healthCheckServices = services;
  }
  
  /**
   * Setup middleware
   */
  private setupMiddleware(): void {
    // CORS
    void this.server.register(cors, {
      origin: true, // Allow all origins (can be restricted in production)
      credentials: true,
    });
    
    // Security headers
    void this.server.register(helmet, {
      contentSecurityPolicy: false, // Not needed for API
    });
    
    // Rate limiting
    void this.server.register(rateLimit, {
      max: this.config.rateLimit.max,
      timeWindow: this.config.rateLimit.timeWindow,
      errorResponseBuilder: () => ({
        error: 'Rate limit exceeded',
        message: 'Too many requests. Please try again later.',
      }),
    });
    
    // Request logging
    this.server.addHook('onRequest', async (request, reply) => {
      logger.debug(
        {
          method: request.method,
          url: request.url,
          ip: request.ip,
        },
        'HTTP request received'
      );
    });
    
    // Response logging
    this.server.addHook('onResponse', async (request, reply) => {
      const duration = reply.getResponseTime();
      
      logger.debug(
        {
          method: request.method,
          url: request.url,
          statusCode: reply.statusCode,
          durationMs: duration,
        },
        'HTTP response sent'
      );
      
      // Metrics
      this.metrics.increment('http_requests_total', 1, {
        method: request.method,
        endpoint: request.routeOptions?.url ?? request.url,
        status: reply.statusCode,
      });
      
      this.metrics.observe('http_request_duration_ms', duration, {
        method: request.method,
        endpoint: request.routeOptions?.url ?? request.url,
      });
    });
  }
  
  /**
   * Setup routes
   */
  private setupRoutes(): void {
    // POST /api/agents/register - Agent registration
    this.server.post<{
      Body: unknown;
    }>('/api/agents/register', async (request, reply) => {
      return this.handleRegisterAgent(request, reply);
    });
    
    // GET /health/liveness - Always 200 (process alive)
    this.server.get('/health/liveness', async (request, reply) => {
      return {
        status: 'alive',
        timestamp: new Date().toISOString(),
      };
    });
    
    // GET /health/readiness - 503 if not ready
    this.server.get('/health/readiness', async (request, reply) => {
      return this.handleReadinessCheck(request, reply);
    });
    
    // GET /metrics - Prometheus metrics
    this.server.get('/metrics', async (request, reply) => {
      const metrics = this.metrics.export();
      
      reply.header('Content-Type', 'text/plain; version=0.0.4');
      return metrics;
    });
    
    // Root endpoint
    this.server.get('/', async (request, reply) => {
      return {
        name: 'Consonant Relayer',
        version: '2.0.0',
        endpoints: {
          register: 'POST /api/agents/register',
          liveness: 'GET /health/liveness',
          readiness: 'GET /health/readiness',
          metrics: 'GET /metrics',
        },
      };
    });
    
    // 404 handler
    this.server.setNotFoundHandler((request, reply) => {
      reply.code(404).send({
        error: 'Not Found',
        message: `Route ${request.method} ${request.url} not found`,
      });
    });
    
    // Error handler
    this.server.setErrorHandler((error, request, reply) => {
      logger.error(
        {
          error: error.message,
          stack: error.stack,
          method: request.method,
          url: request.url,
        },
        'HTTP error'
      );
      
      reply.code(500).send({
        error: 'Internal Server Error',
        message: 'An unexpected error occurred',
      });
    });
  }
  
  /**
   * Handle agent registration
   */
  private async handleRegisterAgent(
    request: FastifyRequest<{ Body: unknown }>,
    reply: FastifyReply
  ): Promise<unknown> {
    try {
      const sourceIP = request.ip;
      const userAgent = request.headers['user-agent'];
      
      // Register agent via agent manager
      const response = this.agentManager.registerAgent(
        request.body,
        sourceIP,
        userAgent
      );
      
      logger.info(
        {
          agentId: response.agentId,
          sourceIP,
          isNew: response.isNew,
        },
        'Agent registration successful'
      );
      
      // Metrics
      this.metrics.increment('agents_registered_total', 1);
      
      // Return 200 for updates, 201 for new registrations
      const statusCode = response.isNew ? 201 : 200;
      
      return reply.code(statusCode).send(response);
    } catch (error) {
      const err = error as Error;
      
      logger.warn(
        {
          error: err.message,
          sourceIP: request.ip,
        },
        'Agent registration failed'
      );
      
      // Return 400 for validation errors
      return reply.code(400).send({
        success: false,
        error: 'Validation Error',
        message: err.message,
      });
    }
  }
  
  /**
   * Handle readiness check
   */
  private async handleReadinessCheck(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<unknown> {
    // Check all registered services
    const serviceHealths: ServiceHealth[] = [];
    let allHealthy = true;
    
    for (const service of this.healthCheckServices) {
      const health = service.getHealth();
      serviceHealths.push(health);
      
      if (health.status !== 'healthy') {
        allHealthy = false;
      }
    }
    
    // Also check agent manager
    const agentManagerHealth = this.agentManager.getHealth();
    serviceHealths.push(agentManagerHealth);
    
    if (agentManagerHealth.status !== 'healthy') {
      allHealthy = false;
    }
    
    const statusCode = allHealthy ? 200 : 503;
    
    return reply.code(statusCode).send({
      status: allHealthy ? 'ready' : 'not ready',
      services: serviceHealths,
      timestamp: new Date().toISOString(),
    });
  }
  
  /**
   * Start service
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('API server already running');
      return;
    }
    
    logger.info(
      {
        port: this.config.port,
        host: this.config.host,
      },
      'Starting API server'
    );
    
    try {
      await this.server.listen({
        port: this.config.port,
        host: this.config.host,
      });
      
      this.running = true;
      
      logger.info(
        {
          port: this.config.port,
          host: this.config.host,
          endpoints: [
            'POST /api/agents/register',
            'GET /health/liveness',
            'GET /health/readiness',
            'GET /metrics',
          ],
        },
        'API server started'
      );
    } catch (error) {
      logger.error(
        {
          error: (error as Error).message,
          port: this.config.port,
        },
        'Failed to start API server'
      );
      throw error;
    }
  }
  
  /**
   * Stop service
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    
    logger.info('Stopping API server');
    
    this.running = false;
    
    await this.server.close();
    
    logger.info('API server stopped');
  }
  
  /**
   * Check if running
   */
  isRunning(): boolean {
    return this.running;
  }
  
  /**
   * Get health
   */
  getHealth(): ServiceHealth {
    return {
      name: 'api-server',
      status: this.running ? 'healthy' : 'unhealthy',
      details: {
        port: this.config.port,
        host: this.config.host,
      },
      lastCheck: new Date().toISOString(),
    };
  }
  
  /**
   * Get service name
   */
  getName(): string {
    return 'api-server';
  }
}