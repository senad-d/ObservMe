import type { Tracer } from "@opentelemetry/api";
import type { Resource } from "@opentelemetry/resources";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import type { Sampler, SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { ObservMeConfig, TraceBatchConfig } from "../config/schema.ts";
import type { StartOtelSdkFactoryOptions } from "./sdk.ts";

export const OBSERVME_TRACER_NAME = "@senad-d/observme";
export const OTLP_TRACE_SIGNAL_PATH = "/v1/traces";

export const DOCUMENTED_TRACE_BATCH_DEFAULTS = {
  maxQueueSize: 2048,
  maxExportBatchSize: 512,
  scheduledDelayMillis: 1000,
  exportTimeoutMillis: 3000,
} satisfies TraceBatchConfig;

export type TracePipelineState = "idle" | "disabled" | "started" | "shutdown";

export interface OtlpTraceExporterOptions {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly timeoutMillis: number;
}

export interface TraceProviderOptions {
  readonly resource: Resource;
  readonly sampler: Sampler;
  readonly spanProcessors: SpanProcessor[];
  readonly forceFlushTimeoutMillis: number;
}

export interface TraceProviderLike {
  register?: () => void;
  getTracer: (name: string) => Tracer;
  forceFlush?: () => Promise<void> | void;
  shutdown?: () => Promise<void> | void;
}

export type TraceExporterFactory = (options: OtlpTraceExporterOptions) => SpanExporter;
export type TraceSpanProcessorFactory = (exporter: SpanExporter, options: TraceBatchConfig) => SpanProcessor;
export type TraceProviderFactory = (options: TraceProviderOptions) => TraceProviderLike;

export interface ObservMeTraceSdkOptions {
  readonly config: ObservMeConfig;
  readonly tracerName?: string;
  readonly registerGlobal?: boolean;
  readonly exporterFactory?: TraceExporterFactory;
  readonly spanProcessorFactory?: TraceSpanProcessorFactory;
  readonly tracerProviderFactory?: TraceProviderFactory;
}

export interface TraceExporterWiring {
  readonly enabled: boolean;
  readonly exporter: OtlpTraceExporterOptions;
  readonly batch: TraceBatchConfig;
}

export class ObservMeTraceSdk {
  readonly #config: ObservMeConfig;
  readonly #tracerName: string;
  readonly #registerGlobal: boolean;
  readonly #exporterFactory: TraceExporterFactory;
  readonly #spanProcessorFactory: TraceSpanProcessorFactory;
  readonly #tracerProviderFactory: TraceProviderFactory;
  #provider?: TraceProviderLike;
  #tracer?: Tracer;
  #state: TracePipelineState = "idle";

  constructor(options: ObservMeTraceSdkOptions) {
    this.#config = options.config;
    this.#tracerName = options.tracerName ?? OBSERVME_TRACER_NAME;
    this.#registerGlobal = options.registerGlobal ?? true;
    this.#exporterFactory = options.exporterFactory ?? createOtlpTraceExporter;
    this.#spanProcessorFactory = options.spanProcessorFactory ?? createBatchSpanProcessor;
    this.#tracerProviderFactory = options.tracerProviderFactory ?? createNodeTraceProvider;
  }

  get state(): TracePipelineState {
    return this.#state;
  }

  get tracer(): Tracer | undefined {
    return this.#tracer;
  }

  start(): void {
    if (this.#state === "started" || this.#state === "disabled") return;
    if (!this.#config.traces.enabled) {
      this.#state = "disabled";
      return;
    }

    const wiring = buildTraceExporterWiring(this.#config);
    const exporter = this.#exporterFactory(wiring.exporter);
    const processor = this.#spanProcessorFactory(exporter, wiring.batch);
    this.#provider = this.#tracerProviderFactory({
      resource: createTraceResource(this.#config),
      sampler: createTraceSampler(this.#config),
      spanProcessors: [processor],
      forceFlushTimeoutMillis: this.#config.shutdown.flushTimeoutMs,
    });

    if (this.#registerGlobal) this.#provider.register?.();
    this.#tracer = this.#provider.getTracer(this.#tracerName);
    this.#state = "started";
  }

  async forceFlush(): Promise<void> {
    await this.#provider?.forceFlush?.();
  }

  async shutdown(): Promise<void> {
    await this.#provider?.shutdown?.();
    this.#state = "shutdown";
    this.#tracer = undefined;
  }
}

export function createTraceSessionScopedOtelSdk(options: StartOtelSdkFactoryOptions): ObservMeTraceSdk {
  return new ObservMeTraceSdk({ config: options.config });
}

export function buildTraceExporterWiring(config: ObservMeConfig): TraceExporterWiring {
  return {
    enabled: config.traces.enabled,
    exporter: buildOtlpTraceExporterOptions(config),
    batch: { ...config.traces.batch },
  };
}

export function buildOtlpTraceExporterOptions(config: ObservMeConfig): OtlpTraceExporterOptions {
  return {
    url: resolveTraceEndpoint(config),
    headers: { ...config.otlp.headers },
    timeoutMillis: config.otlp.timeoutMs,
  };
}

export function resolveTraceEndpoint(config: ObservMeConfig): string {
  return config.otlp.signalEndpoints?.traces ?? appendSignalPath(config.otlp.endpoint, OTLP_TRACE_SIGNAL_PATH);
}

function createOtlpTraceExporter(options: OtlpTraceExporterOptions): SpanExporter {
  return new OTLPTraceExporter(options);
}

function createBatchSpanProcessor(exporter: SpanExporter, options: TraceBatchConfig): SpanProcessor {
  return new BatchSpanProcessor(exporter, options);
}

function createNodeTraceProvider(options: TraceProviderOptions): TraceProviderLike {
  return new NodeTracerProvider(options);
}

function createTraceResource(config: ObservMeConfig): Resource {
  return resourceFromAttributes(config.resource.attributes);
}

function createTraceSampler(config: ObservMeConfig): Sampler {
  return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(config.traces.sampleRatio) });
}

function appendSignalPath(baseEndpoint: string, signalPath: string): string {
  const trimmedBaseEndpoint = removeTrailingSlashes(baseEndpoint);
  return `${trimmedBaseEndpoint}${signalPath}`;
}

function removeTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}
