/**
 * @fileoverview OpenTelemetry Types
 * 
 * Type definitions for OTLP (OpenTelemetry Protocol) telemetry data.
 * 
 * Based on official OpenTelemetry Protocol specification:
 * https://github.com/open-telemetry/opentelemetry-proto
 * 
 * @author Consonant Engineering
 * @version 2.0.0
 */

/**
 * OTLP Resource
 * 
 * Describes the entity producing telemetry (e.g., service, host, container)
 */
export interface OtlpResource {
  readonly attributes: OtlpKeyValue[];
  readonly droppedAttributesCount: number;
}

/**
 * OTLP Key-Value pair
 */
export interface OtlpKeyValue {
  readonly key: string;
  readonly value: OtlpAnyValue;
}

/**
 * OTLP Any Value (union type)
 */
export interface OtlpAnyValue {
  readonly stringValue?: string;
  readonly boolValue?: boolean;
  readonly intValue?: number | string; // Can be int64
  readonly doubleValue?: number;
  readonly arrayValue?: { values: OtlpAnyValue[] };
  readonly kvlistValue?: { values: OtlpKeyValue[] };
  readonly bytesValue?: Uint8Array;
}

/**
 * OTLP Instrumentation Scope
 */
export interface OtlpInstrumentationScope {
  readonly name: string;
  readonly version?: string;
  readonly attributes?: OtlpKeyValue[];
  readonly droppedAttributesCount?: number;
}

/**
 * OTLP Span (trace data)
 */
export interface OtlpSpan {
  readonly traceId: Uint8Array;
  readonly spanId: Uint8Array;
  readonly traceState?: string;
  readonly parentSpanId?: Uint8Array;
  readonly name: string;
  readonly kind: number; // SpanKind enum
  readonly startTimeUnixNano: number | string; // uint64
  readonly endTimeUnixNano: number | string; // uint64
  readonly attributes: OtlpKeyValue[];
  readonly droppedAttributesCount: number;
  readonly events: OtlpSpanEvent[];
  readonly droppedEventsCount: number;
  readonly links: OtlpSpanLink[];
  readonly droppedLinksCount: number;
  readonly status?: OtlpStatus;
}

/**
 * OTLP Span Event
 */
export interface OtlpSpanEvent {
  readonly timeUnixNano: number | string;
  readonly name: string;
  readonly attributes: OtlpKeyValue[];
  readonly droppedAttributesCount: number;
}

/**
 * OTLP Span Link
 */
export interface OtlpSpanLink {
  readonly traceId: Uint8Array;
  readonly spanId: Uint8Array;
  readonly traceState?: string;
  readonly attributes: OtlpKeyValue[];
  readonly droppedAttributesCount: number;
}

/**
 * OTLP Status
 */
export interface OtlpStatus {
  readonly message?: string;
  readonly code: number; // StatusCode enum
}

/**
 * OTLP Resource Spans
 */
export interface OtlpResourceSpans {
  readonly resource?: OtlpResource;
  readonly scopeSpans: OtlpScopeSpans[];
  readonly schemaUrl?: string;
}

/**
 * OTLP Scope Spans
 */
export interface OtlpScopeSpans {
  readonly scope?: OtlpInstrumentationScope;
  readonly spans: OtlpSpan[];
  readonly schemaUrl?: string;
}

/**
 * OTLP Export Trace Service Request
 */
export interface OtlpExportTraceServiceRequest {
  readonly resourceSpans: OtlpResourceSpans[];
}

/**
 * OTLP Export Trace Service Response
 */
export interface OtlpExportTraceServiceResponse {
  readonly partialSuccess?: {
    readonly rejectedSpans: number | string;
    readonly errorMessage: string;
  };
}

/**
 * OTLP Log Record
 */
export interface OtlpLogRecord {
  readonly timeUnixNano: number | string;
  readonly observedTimeUnixNano?: number | string;
  readonly severityNumber?: number;
  readonly severityText?: string;
  readonly body?: OtlpAnyValue;
  readonly attributes: OtlpKeyValue[];
  readonly droppedAttributesCount: number;
  readonly flags?: number;
  readonly traceId?: Uint8Array;
  readonly spanId?: Uint8Array;
}

/**
 * OTLP Resource Logs
 */
export interface OtlpResourceLogs {
  readonly resource?: OtlpResource;
  readonly scopeLogs: OtlpScopeLogs[];
  readonly schemaUrl?: string;
}

/**
 * OTLP Scope Logs
 */
export interface OtlpScopeLogs {
  readonly scope?: OtlpInstrumentationScope;
  readonly logRecords: OtlpLogRecord[];
  readonly schemaUrl?: string;
}

/**
 * OTLP Export Logs Service Request
 */
export interface OtlpExportLogsServiceRequest {
  readonly resourceLogs: OtlpResourceLogs[];
}

/**
 * OTLP Telemetry Event (simplified for backend forwarding)
 */
export interface OtlpTelemetryEvent {
  readonly type: 'trace' | 'log' | 'metric';
  readonly timestamp: string;
  readonly resource?: {
    readonly serviceName?: string;
    readonly serviceNamespace?: string;
    readonly attributes?: Record<string, unknown>;
  };
  readonly data: unknown;
}