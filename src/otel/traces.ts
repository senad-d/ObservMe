import type { Tracer } from "@opentelemetry/api";
import type { Resource } from "@opentelemetry/resources";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import type { Sampler, SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  AlwaysOffSampler,
  BasicTracerProvider,
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { ObservMeConfig, TraceBatchConfig } from "../config/schema.ts";
import { appendOtlpSignalPath } from "./otlp-endpoint.ts";
import { buildOtlpHttpAgentOptions, type OtlpHttpAgentOptions } from "./otlp-http-options.ts";
import type { StartOtelSdkFactoryOptions } from "./sdk.ts";

export const OBSERVME_TRACER_NAME = "@senad-d/observme";
export const OTLP_TRACE_SIGNAL_PATH = "/v1/traces";

const noopTracer = new BasicTracerProvider({ sampler: new AlwaysOffSampler() }).getTracer(OBSERVME_TRACER_NAME);

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
  readonly httpAgentOptions: OtlpHttpAgentOptions;
}

export interface TraceProviderOptions {
  readonly resource: Resource;
  readonly sampler: Sampler;
  readonly spanProcessors: SpanProcessor[];
  readonly forceFlushTimeoutMillis: number;
}

export interface TraceProviderLike {
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
  readonly #exporterFactory: TraceExporterFactory;
  readonly #spanProcessorFactory: TraceSpanProcessorFactory;
  readonly #tracerProviderFactory: TraceProviderFactory;
  #exporter?: SpanExporter;
  #processor?: SpanProcessor;
  #provider?: TraceProviderLike;
  #tracer: Tracer = noopTracer;
  #state: TracePipelineState = "idle";

  constructor(options: ObservMeTraceSdkOptions) {
    this.#config = options.config;
    this.#tracerName = options.tracerName ?? OBSERVME_TRACER_NAME;
    this.#exporterFactory = options.exporterFactory ?? createOtlpTraceExporter;
    this.#spanProcessorFactory = options.spanProcessorFactory ?? createBatchSpanProcessor;
    this.#tracerProviderFactory = options.tracerProviderFactory ?? createNodeTraceProvider;
  }

  get state(): TracePipelineState {
    return this.#state;
  }

  get tracer(): Tracer {
    return this.#tracer;
  }

  start(): void {
    if (this.#state === "started" || this.#state === "disabled") return;
    if (!this.#config.enabled || !this.#config.traces.enabled) {
      this.#state = "disabled";
      return;
    }

    const wiring = buildTraceExporterWiring(this.#config);
    this.#exporter = this.#exporterFactory(wiring.exporter);
    this.#processor = this.#spanProcessorFactory(this.#exporter, wiring.batch);
    this.#provider = this.#tracerProviderFactory({
      resource: createTraceResource(this.#config),
      sampler: createTraceSampler(this.#config),
      spanProcessors: [this.#processor],
      forceFlushTimeoutMillis: this.#config.shutdown.flushTimeoutMs,
    });

    this.#tracer = this.#provider.getTracer(this.#tracerName);
    this.#state = "started";
  }

  async forceFlush(): Promise<void> {
    await this.#provider?.forceFlush?.();
  }

  async shutdown(): Promise<void> {
    if (this.#state === "shutdown") return;

    try {
      if (this.#provider?.shutdown) await this.#provider.shutdown();
      else if (this.#processor) await this.#processor.shutdown();
      else await this.#exporter?.shutdown();
    } finally {
      this.#provider = undefined;
      this.#processor = undefined;
      this.#exporter = undefined;
      this.#state = "shutdown";
      this.#tracer = noopTracer;
    }
  }
}

export function createTraceSessionScopedOtelSdk(options: StartOtelSdkFactoryOptions): ObservMeTraceSdk {
  return new ObservMeTraceSdk({ config: options.config });
}

export function buildTraceExporterWiring(config: ObservMeConfig): TraceExporterWiring {
  return {
    enabled: config.enabled && config.traces.enabled,
    exporter: buildOtlpTraceExporterOptions(config),
    batch: { ...config.traces.batch },
  };
}

export function buildOtlpTraceExporterOptions(config: ObservMeConfig): OtlpTraceExporterOptions {
  return {
    url: resolveTraceEndpoint(config),
    headers: { ...config.otlp.headers },
    timeoutMillis: config.otlp.timeoutMs,
    httpAgentOptions: buildOtlpHttpAgentOptions(config),
  };
}

export function resolveTraceEndpoint(config: ObservMeConfig): string {
  return config.otlp.signalEndpoints?.traces ?? appendOtlpSignalPath(config.otlp.endpoint, OTLP_TRACE_SIGNAL_PATH);
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
