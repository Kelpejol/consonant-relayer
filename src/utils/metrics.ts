/**
 * @fileoverview Metrics Collector - Centralized Metrics System
 * 
 * Collects and exports metrics in Prometheus format.
 * 
 * Metric Types:
 * - Counter: Monotonically increasing (requests, errors)
 * - Gauge: Can go up or down (queue size, connections)
 * - Histogram: Distribution of values (latency, duration)
 * 
 * Usage:
 * ```typescript
 * const metrics = MetricsCollector.getInstance();
 * 
 * // Counters
 * metrics.increment('requests_total', 1, { method: 'POST' });
 * 
 * // Gauges
 * metrics.setGauge('connections_active', 5);
 * 
 * // Histograms
 * metrics.observe('request_duration_ms', 123.45, { endpoint: '/api' });
 * 
 * // Export
 * const prometheus = metrics.export();
 * ```
 * 
 * @author Consonant Engineering
 * @version 2.0.0
 */

/**
 * Metric labels (key-value pairs)
 */
export type MetricLabels = Record<string, string | number>;

/**
 * Counter metric (monotonically increasing)
 */
interface CounterMetric {
  type: 'counter';
  value: number;
  labels: MetricLabels;
}

/**
 * Gauge metric (can increase or decrease)
 */
interface GaugeMetric {
  type: 'gauge';
  value: number;
  labels: MetricLabels;
}

/**
 * Histogram bucket
 */
interface HistogramBucket {
  le: number; // Upper bound
  count: number;
}

/**
 * Histogram metric (distribution of values)
 */
interface HistogramMetric {
  type: 'histogram';
  buckets: HistogramBucket[];
  sum: number;
  count: number;
  labels: MetricLabels;
}

/**
 * Metric definition
 */
interface MetricDefinition {
  name: string;
  help: string;
  type: 'counter' | 'gauge' | 'histogram';
}

/**
 * Metrics Collector (Singleton)
 * 
 * Centralized metrics collection for entire system.
 * Thread-safe (single-threaded Node.js).
 */
export class MetricsCollector {
  private static instance: MetricsCollector;
  
  /** Metric definitions */
  private readonly definitions = new Map<string, MetricDefinition>();
  
  /** Counter metrics */
  private readonly counters = new Map<string, CounterMetric>();
  
  /** Gauge metrics */
  private readonly gauges = new Map<string, GaugeMetric>();
  
  /** Histogram metrics */
  private readonly histograms = new Map<string, HistogramMetric>();
  
  /** Default histogram buckets (in milliseconds for latency) */
  private readonly defaultBuckets = [
    1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
  ];
  
  private constructor() {
    // Register default metrics
    this.registerDefaults();
  }
  
  /**
   * Get singleton instance
   */
  static getInstance(): MetricsCollector {
    if (!MetricsCollector.instance) {
      MetricsCollector.instance = new MetricsCollector();
    }
    return MetricsCollector.instance;
  }
  
  /**
   * Register default relayer metrics
   */
  private registerDefaults(): void {
    // Agent metrics
    this.define('agents_registered_total', 'Total agents registered', 'counter');
    this.define('agents_discovered_total', 'Total agents discovered', 'counter');
    this.define('agents_active', 'Number of active agents', 'gauge');
    this.define('agents_reachable', 'Number of reachable agents', 'gauge');
    
    // Invocation metrics
    this.define('invocations_total', 'Total agent invocations', 'counter');
    this.define('invocations_duration_ms', 'Agent invocation duration', 'histogram');
    this.define('invocations_inflight', 'In-flight invocations', 'gauge');
    
    // Telemetry metrics
    this.define('telemetry_events_received_total', 'Total telemetry events received', 'counter');
    this.define('telemetry_events_exported_total', 'Total telemetry events exported', 'counter');
    this.define('telemetry_events_dropped_total', 'Total telemetry events dropped', 'counter');
    this.define('telemetry_buffer_size', 'Current telemetry buffer size', 'gauge');
    
    // Kubernetes metrics
    this.define('k8s_watch_errors_total', 'Total Kubernetes watch errors', 'counter');
    this.define('k8s_watches_active', 'Number of active Kubernetes watches', 'gauge');
    
    // Backend metrics
    this.define('backend_connected', 'Backend connection status (1=connected)', 'gauge');
    this.define('backend_messages_sent_total', 'Total messages sent to backend', 'counter');
    this.define('backend_messages_received_total', 'Total messages received from backend', 'counter');
    
    // HTTP API metrics
    this.define('http_requests_total', 'Total HTTP requests', 'counter');
    this.define('http_request_duration_ms', 'HTTP request duration', 'histogram');
  }
  
  /**
   * Define a metric
   * 
   * @param name - Metric name
   * @param help - Help text
   * @param type - Metric type
   */
  define(name: string, help: string, type: 'counter' | 'gauge' | 'histogram'): void {
    if (this.definitions.has(name)) {
      return; // Already defined
    }
    
    this.definitions.set(name, { name, help, type });
  }
  
  /**
   * Increment counter
   * 
   * @param name - Metric name
   * @param value - Value to add (default: 1)
   * @param labels - Optional labels
   */
  increment(name: string, value: number = 1, labels: MetricLabels = {}): void {
    const key = this.getKey(name, labels);
    const existing = this.counters.get(key);
    
    if (existing) {
      existing.value += value;
    } else {
      this.counters.set(key, { type: 'counter', value, labels });
    }
  }
  
  /**
   * Set gauge value
   * 
   * @param name - Metric name
   * @param value - New value
   * @param labels - Optional labels
   */
  setGauge(name: string, value: number, labels: MetricLabels = {}): void {
    const key = this.getKey(name, labels);
    this.gauges.set(key, { type: 'gauge', value, labels });
  }
  
  /**
   * Observe histogram value
   * 
   * @param name - Metric name
   * @param value - Observed value
   * @param labels - Optional labels
   */
  observe(name: string, value: number, labels: MetricLabels = {}): void {
    const key = this.getKey(name, labels);
    const existing = this.histograms.get(key);
    
    if (existing) {
      // Update existing histogram
      existing.sum += value;
      existing.count++;
      
      // Update buckets
      for (const bucket of existing.buckets) {
        if (value <= bucket.le) {
          bucket.count++;
        }
      }
    } else {
      // Create new histogram
      const buckets: HistogramBucket[] = this.defaultBuckets.map((le) => ({
        le,
        count: value <= le ? 1 : 0,
      }));
      
      // Add +Inf bucket
      buckets.push({ le: Infinity, count: 1 });
      
      this.histograms.set(key, {
        type: 'histogram',
        buckets,
        sum: value,
        count: 1,
        labels,
      });
    }
  }
  
  /**
   * Get metric key with labels
   */
  private getKey(name: string, labels: MetricLabels): string {
    const labelStr = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
    
    return labelStr ? `${name}{${labelStr}}` : name;
  }
  
  /**
   * Get metric value
   * 
   * @param name - Metric name
   * @param labels - Optional labels
   * @returns Metric value or undefined
   */
  get(name: string, labels: MetricLabels = {}): number | undefined {
    const key = this.getKey(name, labels);
    
    const counter = this.counters.get(key);
    if (counter) return counter.value;
    
    const gauge = this.gauges.get(key);
    if (gauge) return gauge.value;
    
    const histogram = this.histograms.get(key);
    if (histogram) return histogram.count;
    
    return undefined;
  }
  
  /**
   * Reset all metrics
   */
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }
  
  /**
   * Export metrics in Prometheus format
   * 
   * @returns Prometheus-formatted metrics
   */
  export(): string {
    const lines: string[] = [];
    
    // Export counters
    const countersByName = new Map<string, CounterMetric[]>();
    for (const [key, metric] of this.counters.entries()) {
      const name = key.split('{')[0];
      if (!countersByName.has(name)) {
        countersByName.set(name, []);
      }
      countersByName.get(name)!.push(metric);
    }
    
    for (const [name, metrics] of countersByName.entries()) {
      const def = this.definitions.get(name);
      if (def) {
        lines.push(`# HELP ${name} ${def.help}`);
        lines.push(`# TYPE ${name} counter`);
      }
      
      for (const metric of metrics) {
        const labels = this.formatLabels(metric.labels);
        lines.push(`${name}${labels} ${metric.value}`);
      }
      lines.push('');
    }
    
    // Export gauges
    const gaugesByName = new Map<string, GaugeMetric[]>();
    for (const [key, metric] of this.gauges.entries()) {
      const name = key.split('{')[0];
      if (!gaugesByName.has(name)) {
        gaugesByName.set(name, []);
      }
      gaugesByName.get(name)!.push(metric);
    }
    
    for (const [name, metrics] of gaugesByName.entries()) {
      const def = this.definitions.get(name);
      if (def) {
        lines.push(`# HELP ${name} ${def.help}`);
        lines.push(`# TYPE ${name} gauge`);
      }
      
      for (const metric of metrics) {
        const labels = this.formatLabels(metric.labels);
        lines.push(`${name}${labels} ${metric.value}`);
      }
      lines.push('');
    }
    
    // Export histograms
    const histogramsByName = new Map<string, HistogramMetric[]>();
    for (const [key, metric] of this.histograms.entries()) {
      const name = key.split('{')[0];
      if (!histogramsByName.has(name)) {
        histogramsByName.set(name, []);
      }
      histogramsByName.get(name)!.push(metric);
    }
    
    for (const [name, metrics] of histogramsByName.entries()) {
      const def = this.definitions.get(name);
      if (def) {
        lines.push(`# HELP ${name} ${def.help}`);
        lines.push(`# TYPE ${name} histogram`);
      }
      
      for (const metric of metrics) {
        const baseLabels = this.formatLabels(metric.labels);
        
        // Buckets
        for (const bucket of metric.buckets) {
          const labels = this.addLabel(metric.labels, 'le', bucket.le.toString());
          lines.push(`${name}_bucket${this.formatLabels(labels)} ${bucket.count}`);
        }
        
        // Sum and count
        lines.push(`${name}_sum${baseLabels} ${metric.sum}`);
        lines.push(`${name}_count${baseLabels} ${metric.count}`);
      }
      lines.push('');
    }
    
    return lines.join('\n');
  }
  
  /**
   * Format labels for Prometheus
   */
  private formatLabels(labels: MetricLabels): string {
    if (Object.keys(labels).length === 0) {
      return '';
    }
    
    const formatted = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
    
    return `{${formatted}}`;
  }
  
  /**
   * Add label to existing labels
   */
  private addLabel(labels: MetricLabels, key: string, value: string): MetricLabels {
    return { ...labels, [key]: value };
  }
}