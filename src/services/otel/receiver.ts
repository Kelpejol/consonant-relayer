/**
 * OTEL Receiver - gRPC Server
 * 
 * Receives OpenTelemetry traces, logs, and metrics from KAgent
 * Implements OTLP (OpenTelemetry Protocol) over gRPC
 * 
 * Architecture:
 * ┌────────────┐        gRPC         ┌──────────────┐
 * │  KAgent    │───────────────────►│ OTEL         │
 * │ Controller │  :4317 (OTLP)      │ Receiver     │
 * └────────────┘                    │              │
 *                                    │ → Telemetry  │
 *                                    │   Collector  │
 *                                    └──────────────┘
 * 
 * Protocol: OTLP/gRPC
 * Port: 4317 (standard OTEL collector port)
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { join } from 'path';
import { TelemetryCollector, TelemetryEventType } from '../telemetry/collector.js';
import { MetricsCollector } from '../metrics/index.js';

export interface OTelReceiverConfig {
  port: number;
  collector: TelemetryCollector;
}

export class OTelReceiver {
  private server?: grpc.Server;
  private started: boolean = false;
  private stats = {
    tracesReceived: 0,
    logsReceived: 0,
    metricsReceived: 0,
    errors: 0,
  };

  constructor(
    private config: OTelReceiverConfig,
    private logger: any,
    private metrics?: MetricsCollector
  ) {}

  /**
   * Start the gRPC server
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Load OTLP proto definitions
        const packageDefinition = protoLoader.loadSync(
          join(__dirname, '../../protos/opentelemetry/proto/collector/trace/v1/trace_service.proto'),
          {
            keepCase: true,
            longs: String,
            enums: String,
            defaults: true,
            oneofs: true,
            includeDirs: [
              join(__dirname, '../../protos'),
            ],
          }
        );

        const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
        
        // Type assertion for nested proto structure
        const opentelemetry = protoDescriptor.opentelemetry as any;
        if (!opentelemetry?.proto?.collector?.trace?.v1) {
          throw new Error('Failed to load trace service proto definitions');
        }
        const otlp = opentelemetry.proto.collector.trace.v1;

        // Create gRPC server
        this.server = new grpc.Server({
          'grpc.max_receive_message_length': 100 * 1024 * 1024, // 100MB
          'grpc.max_send_message_length': 100 * 1024 * 1024,
        });

        // Register trace service
        this.server.addService(otlp.TraceService.service, {
          Export: this.handleTraceExport.bind(this),
        });

        // Load logs service
        const logsPackageDefinition = protoLoader.loadSync(
          join(__dirname, '../../protos/opentelemetry/proto/collector/logs/v1/logs_service.proto'),
          {
            keepCase: true,
            longs: String,
            enums: String,
            defaults: true,
            oneofs: true,
            includeDirs: [
              join(__dirname, '../../protos'),
            ],
          }
        );

        const logsProtoDescriptor = grpc.loadPackageDefinition(logsPackageDefinition);
        
        // Type assertion for nested proto structure
        const logsOpentelemetry = logsProtoDescriptor.opentelemetry as any;
        if (!logsOpentelemetry?.proto?.collector?.logs?.v1) {
          throw new Error('Failed to load logs service proto definitions');
        }
        const logsOtlp = logsOpentelemetry.proto.collector.logs.v1;

        // Register logs service
        this.server.addService(logsOtlp.LogsService.service, {
          Export: this.handleLogsExport.bind(this),
        });

        // Bind to port
        this.server.bindAsync(
          `0.0.0.0:${this.config.port}`,
          grpc.ServerCredentials.createInsecure(),
          (error, port) => {
            if (error) {
              this.logger.error({ error }, 'Failed to bind OTEL receiver');
              return reject(error);
            }

            this.server!.start();
            this.started = true;
            this.logger.info({ port }, 'OTEL receiver started');
            resolve();
          }
        );
      } catch (error) {
        this.logger.error({ error }, 'Failed to start OTEL receiver');
        reject(error);
      }
    });
  }

  /**
   * Handle trace export (from KAgent)
   */
  private handleTraceExport(call: any, callback: any): void {
    try {
      const request = call.request;
      
      this.logger.debug({ 
        resourceSpansCount: request.resource_spans?.length || 0,
      }, 'Received trace export');

      // Process resource spans
      let totalSpans = 0;
      
      if (request.resource_spans) {
        for (const resourceSpan of request.resource_spans) {
          if (resourceSpan.scope_spans) {
            for (const scopeSpan of resourceSpan.scope_spans) {
              if (scopeSpan.spans) {
                totalSpans += scopeSpan.spans.length;
                
                // Convert each span to telemetry event
                for (const span of scopeSpan.spans) {
                  this.processSpan(span, resourceSpan.resource);
                }
              }
            }
          }
        }
      }

      this.stats.tracesReceived += totalSpans;
      this.metrics?.recordOtelSpansReceived(totalSpans);

      // Send success response
      callback(null, {
        partial_success: {
          rejected_spans: 0,
          error_message: '',
        },
      });
    } catch (error) {
      this.stats.errors++;
      this.logger.error({ error }, 'Error processing trace export');
      this.metrics?.recordOtelError('trace_export');
      callback({
        code: grpc.status.INTERNAL,
        message: 'Internal error processing traces',
      });
    }
  }

  /**
   * Handle logs export (from KAgent)
   */
  private handleLogsExport(call: any, callback: any): void {
    try {
      const request = call.request;
      
      this.logger.debug({ 
        resourceLogsCount: request.resource_logs?.length || 0,
      }, 'Received logs export');

      // Process resource logs
      let totalLogs = 0;
      
      if (request.resource_logs) {
        for (const resourceLog of request.resource_logs) {
          if (resourceLog.scope_logs) {
            for (const scopeLog of resourceLog.scope_logs) {
              if (scopeLog.log_records) {
                totalLogs += scopeLog.log_records.length;
                
                // Convert each log to telemetry event
                for (const logRecord of scopeLog.log_records) {
                  this.processLog(logRecord, resourceLog.resource);
                }
              }
            }
          }
        }
      }

      this.stats.logsReceived += totalLogs;
      this.metrics?.recordOtelLogsReceived(totalLogs);

      // Send success response
      callback(null, {
        partial_success: {
          rejected_log_records: 0,
          error_message: '',
        },
      });
    } catch (error) {
      this.stats.errors++;
      this.logger.error({ error }, 'Error processing logs export');
      this.metrics?.recordOtelError('logs_export');
      callback({
        code: grpc.status.INTERNAL,
        message: 'Internal error processing logs',
      });
    }
  }

  /**
   * Process a single span and convert to telemetry event
   */
  private processSpan(span: any, resource: any): void {
    // Extract attributes
    const attributes: Record<string, any> = {};
    if (span.attributes) {
      for (const attr of span.attributes) {
        attributes[attr.key] = this.extractAttributeValue(attr.value);
      }
    }

    // Extract resource attributes
    const resourceAttributes: Record<string, any> = {};
    if (resource && resource.attributes) {
      for (const attr of resource.attributes) {
        resourceAttributes[attr.key] = this.extractAttributeValue(attr.value);
      }
    }

    // Convert span IDs from buffer to hex string if needed
    const spanId = span.span_id 
      ? (Buffer.isBuffer(span.span_id) ? span.span_id.toString('hex') : span.span_id)
      : undefined;
    const traceId = span.trace_id
      ? (Buffer.isBuffer(span.trace_id) ? span.trace_id.toString('hex') : span.trace_id)
      : undefined;
    const parentSpanId = span.parent_span_id
      ? (Buffer.isBuffer(span.parent_span_id) ? span.parent_span_id.toString('hex') : span.parent_span_id)
      : undefined;

    // Collect as OTEL trace event
    this.config.collector.collect(
      TelemetryEventType.OTEL_TRACE,
      {
        spanId,
        traceId,
        parentSpanId,
        name: span.name,
        startTime: span.start_time_unix_nano,
        endTime: span.end_time_unix_nano,
        duration: span.end_time_unix_nano 
          ? Number(span.end_time_unix_nano) - Number(span.start_time_unix_nano)
          : undefined,
        attributes: {
          ...attributes,
          ...resourceAttributes,
        },
        events: span.events || [],
        status: span.status || { code: 0 },
      },
      {
        traceId,
        spanId,
        agentName: resourceAttributes['service.name'],
        namespace: resourceAttributes['k8s.namespace.name'],
        podName: resourceAttributes['k8s.pod.name'],
      }
    );
  }

  /**
   * Process a single log record and convert to telemetry event
   */
  private processLog(logRecord: any, resource: any): void {
    // Extract attributes
    const attributes: Record<string, any> = {};
    if (logRecord.attributes) {
      for (const attr of logRecord.attributes) {
        attributes[attr.key] = this.extractAttributeValue(attr.value);
      }
    }

    // Extract resource attributes
    const resourceAttributes: Record<string, any> = {};
    if (resource && resource.attributes) {
      for (const attr of resource.attributes) {
        resourceAttributes[attr.key] = this.extractAttributeValue(attr.value);
      }
    }

    // Determine log level
    const severityNumber = logRecord.severity_number || 0;
    let level = 'info';
    if (severityNumber >= 17) level = 'error';
    else if (severityNumber >= 13) level = 'warn';
    else if (severityNumber >= 9) level = 'info';
    else if (severityNumber >= 5) level = 'debug';
    else level = 'trace';

    // Get message
    const message = this.extractAttributeValue(logRecord.body) || '';

    // Convert span IDs from buffer to hex string if needed
    const spanId = logRecord.span_id 
      ? (Buffer.isBuffer(logRecord.span_id) ? logRecord.span_id.toString('hex') : logRecord.span_id)
      : undefined;
    const traceId = logRecord.trace_id
      ? (Buffer.isBuffer(logRecord.trace_id) ? logRecord.trace_id.toString('hex') : logRecord.trace_id)
      : undefined;

    // Collect as OTEL log event
    this.config.collector.collect(
      TelemetryEventType.OTEL_LOG,
      {
        source: 'kagent',
        logger: resourceAttributes['service.name'] || 'unknown',
        level,
        message,
        severityNumber,
        timestamp: logRecord.time_unix_nano,
        attributes: {
          ...attributes,
          ...resourceAttributes,
        },
      },
      {
        traceId,
        spanId,
        agentName: resourceAttributes['service.name'],
        namespace: resourceAttributes['k8s.namespace.name'],
        podName: resourceAttributes['k8s.pod.name'],
      }
    );
  }

  /**
   * Extract value from OTLP attribute
   */
  private extractAttributeValue(value: any): any {
    if (!value) return undefined;

    if (value.string_value !== undefined) return value.string_value;
    if (value.bool_value !== undefined) return value.bool_value;
    if (value.int_value !== undefined) return value.int_value;
    if (value.double_value !== undefined) return value.double_value;
    if (value.array_value) {
      return value.array_value.values.map((v: any) => this.extractAttributeValue(v));
    }
    if (value.kvlist_value) {
      const obj: Record<string, any> = {};
      for (const kv of value.kvlist_value.values) {
        obj[kv.key] = this.extractAttributeValue(kv.value);
      }
      return obj;
    }

    return undefined;
  }

  /**
   * Stop the gRPC server
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        return resolve();
      }

      this.logger.info('Stopping OTEL receiver');

      this.server.tryShutdown(() => {
        this.started = false;
        this.logger.info('OTEL receiver stopped');
        resolve();
      });

      // Force shutdown after 5 seconds
      setTimeout(() => {
        if (this.started) {
          this.logger.warn('Force shutting down OTEL receiver');
          this.server?.forceShutdown();
          this.started = false;
          resolve();
        }
      }, 5000);
    });
  }

  /**
   * Check if receiver is running
   */
  isRunning(): boolean {
    return this.started;
  }

  /**
   * Check if receiver is listening (alias for isRunning)
   */
  isListening(): boolean {
    return this.started;
  }

  /**
   * Get receiver statistics
   */
  getStats() {
    return {
      ...this.stats,
      running: this.started,
      port: this.config.port,
    };
  }

  /**
   * Get receiver status
   */
  getStatus() {
    return {
      running: this.started,
      port: this.config.port,
    };
  }
}