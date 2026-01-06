/**
 * @fileoverview Service Interfaces - Standard Contract for All Services
 * 
 * Defines the standard interface that ALL services must implement.
 * This ensures consistent lifecycle management, health checks, and naming.
 * 
 * Benefits:
 * - Uniform service lifecycle (start, stop)
 * - Consistent health check interface
 * - Easy service registry management
 * - Testability and mocking
 * 
 * @author Consonant Engineering
 * @version 2.0.0
 */

/**
 * Service Health Status
 */
export type ServiceStatus = 'healthy' | 'unhealthy' | 'degraded';

/**
 * Service Health Information
 * 
 * Standard health check response format.
 */
export interface ServiceHealth {
  /** Service name */
  readonly name: string;
  
  /** Current status */
  readonly status: ServiceStatus;
  
  /** Additional details (metrics, errors, etc.) */
  readonly details?: Record<string, unknown>;
  
  /** When health was last checked */
  readonly lastCheck: string; // ISO 8601
}

/**
 * Service Interface
 * 
 * ALL services in the relayer must implement this interface.
 * 
 * Examples:
 * - AgentManagerService
 * - BackendClientService
 * - OtelCollectorService
 * - KubernetesWatcherService
 * - ApiServerService
 */
export interface IService {
  /**
   * Start the service
   * 
   * Initialize resources, connect to external systems, start listeners.
   * Must be idempotent (calling twice should be safe).
   * 
   * @throws {Error} If service fails to start
   */
  start(): Promise<void>;
  
  /**
   * Stop the service
   * 
   * Clean up resources, disconnect, stop listeners.
   * Should gracefully handle in-flight operations.
   * Must be idempotent (calling twice should be safe).
   * 
   * @param timeout - Maximum time to wait for graceful shutdown (ms)
   */
  stop(timeout?: number): Promise<void>;
  
  /**
   * Check if service is currently running
   * 
   * @returns True if service is running
   */
  isRunning(): boolean;
  
  /**
   * Get service health
   * 
   * @returns Current health status
   */
  getHealth(): ServiceHealth;
  
  /**
   * Get service name
   * 
   * @returns Human-readable service name
   */
  getName(): string;
}

/**
 * Service Registry
 * 
 * Manages a collection of services with lifecycle operations.
 * Useful for orchestrating multiple services in main index.ts
 */
export class ServiceRegistry {
  private readonly services = new Map<string, IService>();
  
  /**
   * Register a service
   * 
   * @param service - Service to register
   */
  register(service: IService): void {
    const name = service.getName();
    
    if (this.services.has(name)) {
      throw new Error(`Service ${name} is already registered`);
    }
    
    this.services.set(name, service);
  }
  
  /**
   * Start all services in registration order
   */
  async startAll(): Promise<void> {
    for (const [name, service] of this.services.entries()) {
      await service.start();
    }
  }
  
  /**
   * Stop all services in reverse registration order
   */
  async stopAll(timeout?: number): Promise<void> {
    const services = Array.from(this.services.entries()).reverse();
    
    for (const [name, service] of services) {
      await service.stop(timeout);
    }
  }
  
  /**
   * Get a specific service
   * 
   * @param name - Service name
   * @returns Service instance or undefined
   */
  get(name: string): IService | undefined {
    return this.services.get(name);
  }
  
  /**
   * Get all services
   */
  getAll(): IService[] {
    return Array.from(this.services.values());
  }
  
  /**
   * Get aggregated health of all services
   */
  getHealth(): {
    overall: ServiceStatus;
    services: ServiceHealth[];
  } {
    const services = Array.from(this.services.values());
    const healths = services.map((s) => s.getHealth());
    
    // Determine overall status
    let overall: ServiceStatus = 'healthy';
    
    if (healths.some((h) => h.status === 'unhealthy')) {
      overall = 'unhealthy';
    } else if (healths.some((h) => h.status === 'degraded')) {
      overall = 'degraded';
    }
    
    return { overall, services: healths };
  }
}