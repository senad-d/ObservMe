import type { Meter } from "@opentelemetry/api";
import { createNoopMeter } from "@opentelemetry/api";
import type { Resource } from "@opentelemetry/resources";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import type { IMetricReader, PushMetricExporter } from "@opentelemetry/sdk-metrics";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import type { MetricsConfig, ObservMeConfig } from "../config/schema.ts";
import { appendOtlpSignalPath } from "./otlp-endpoint.ts";
import { buildOtlpHttpAgentOptions, type OtlpHttpAgentOptions } from "./otlp-http-options.ts";
import type { StartOtelSdkFactoryOptions } from "./sdk.ts";

export const OBSERVME_METER_NAME = "@senad-d/observme";
export const OTLP_METRIC_SIGNAL_PATH = "/v1/metrics";

export const DOCUMENTED_METRIC_EXPORT_DEFAULTS = {
  exportIntervalMillis: 15000,
  exportTimeoutMillis: 3000,
} satisfies Pick<MetricsConfig, "exportIntervalMillis" | "exportTimeoutMillis">;

export type MetricPipelineState =
  | "idle"
  | "disabled"
  | "started"
  | "shutting_down"
  | "shutdown_failed"
  | "shutdown";

export interface OtlpMetricExporterOptions {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly timeoutMillis: number;
  readonly httpAgentOptions: OtlpHttpAgentOptions;
}

export interface MetricReaderOptions {
  readonly exportIntervalMillis: number;
  readonly exportTimeoutMillis: number;
}

export interface MetricProviderOptions {
  readonly resource: Resource;
  readonly readers: IMetricReader[];
}

export interface MetricProviderLike {
  getMeter: (name: string) => Meter;
  forceFlush?: () => Promise<void> | void;
  shutdown?: () => Promise<void> | void;
}

export type MetricExporterFactory = (options: OtlpMetricExporterOptions) => PushMetricExporter;
export type MetricReaderFactory = (exporter: PushMetricExporter, options: MetricReaderOptions) => IMetricReader;
export type MetricProviderFactory = (options: MetricProviderOptions) => MetricProviderLike;

export interface ObservMeMetricSdkOptions {
  readonly config: ObservMeConfig;
  readonly meterName?: string;
  readonly exporterFactory?: MetricExporterFactory;
  readonly readerFactory?: MetricReaderFactory;
  readonly meterProviderFactory?: MetricProviderFactory;
}

export interface MetricExporterWiring {
  readonly enabled: boolean;
  readonly exporter: OtlpMetricExporterOptions;
  readonly reader: MetricReaderOptions;
}

const noopMeter = createNoopMeter();

export class ObservMeMetricSdk {
  readonly #config: ObservMeConfig;
  readonly #meterName: string;
  readonly #exporterFactory: MetricExporterFactory;
  readonly #readerFactory: MetricReaderFactory;
  readonly #meterProviderFactory: MetricProviderFactory;
  #exporter?: PushMetricExporter;
  #reader?: IMetricReader;
  #provider?: MetricProviderLike;
  #meter: Meter = noopMeter;
  #shutdownPromise?: Promise<void>;
  #state: MetricPipelineState = "idle";

  constructor(options: ObservMeMetricSdkOptions) {
    this.#config = options.config;
    this.#meterName = options.meterName ?? OBSERVME_METER_NAME;
    this.#exporterFactory = options.exporterFactory ?? createOtlpMetricExporter;
    this.#readerFactory = options.readerFactory ?? createPeriodicMetricReader;
    this.#meterProviderFactory = options.meterProviderFactory ?? createMetricProvider;
  }

  get state(): MetricPipelineState {
    return this.#state;
  }

  get meter(): Meter {
    return this.#meter;
  }

  start(): void {
    if (this.#state === "started" || this.#state === "disabled") return;
    if (!this.#config.enabled || !this.#config.metrics.enabled) {
      this.#state = "disabled";
      return;
    }

    const wiring = buildMetricExporterWiring(this.#config);
    this.#exporter = this.#exporterFactory(wiring.exporter);
    this.#reader = this.#readerFactory(this.#exporter, wiring.reader);
    this.#provider = this.#meterProviderFactory({
      resource: createMetricResource(this.#config),
      readers: [this.#reader],
    });

    this.#meter = this.#provider.getMeter(this.#meterName);
    this.#state = "started";
  }

  async forceFlush(): Promise<void> {
    await this.#provider?.forceFlush?.();
  }

  async shutdown(): Promise<void> {
    if (this.#state === "shutdown") return;
    if (this.#state === "shutting_down" && this.#shutdownPromise) return this.#shutdownPromise;

    this.#state = "shutting_down";
    this.#meter = noopMeter;
    const shutdownPromise = this.shutdownOwnedResources();
    this.#shutdownPromise = shutdownPromise;
    try {
      await shutdownPromise;
    } finally {
      if (this.#shutdownPromise === shutdownPromise) this.#shutdownPromise = undefined;
    }
  }

  private async shutdownOwnedResources(): Promise<void> {
    try {
      if (this.#provider?.shutdown) await this.#provider.shutdown();
      else if (this.#reader) await this.#reader.shutdown();
      else await this.#exporter?.shutdown();
      this.#provider = undefined;
      this.#reader = undefined;
      this.#exporter = undefined;
      this.#state = "shutdown";
    } catch (error) {
      this.#state = "shutdown_failed";
      throw error;
    }
  }
}

export function createMetricSessionScopedOtelSdk(options: StartOtelSdkFactoryOptions): ObservMeMetricSdk {
  return new ObservMeMetricSdk({ config: options.config });
}

export function buildMetricExporterWiring(config: ObservMeConfig): MetricExporterWiring {
  return {
    enabled: config.enabled && config.metrics.enabled,
    exporter: buildOtlpMetricExporterOptions(config),
    reader: {
      exportIntervalMillis: config.metrics.exportIntervalMillis,
      exportTimeoutMillis: config.metrics.exportTimeoutMillis,
    },
  };
}

export function buildOtlpMetricExporterOptions(config: ObservMeConfig): OtlpMetricExporterOptions {
  return {
    url: resolveMetricEndpoint(config),
    headers: { ...config.otlp.headers },
    timeoutMillis: config.otlp.timeoutMs,
    httpAgentOptions: buildOtlpHttpAgentOptions(config),
  };
}

export function resolveMetricEndpoint(config: ObservMeConfig): string {
  return config.otlp.signalEndpoints?.metrics ?? appendOtlpSignalPath(config.otlp.endpoint, OTLP_METRIC_SIGNAL_PATH);
}

function createOtlpMetricExporter(options: OtlpMetricExporterOptions): PushMetricExporter {
  return new OTLPMetricExporter(options);
}

function createPeriodicMetricReader(exporter: PushMetricExporter, options: MetricReaderOptions): IMetricReader {
  return new PeriodicExportingMetricReader({ exporter, ...options });
}

function createMetricProvider(options: MetricProviderOptions): MetricProviderLike {
  return new MeterProvider(options);
}

function createMetricResource(config: ObservMeConfig): Resource {
  return resourceFromAttributes(config.resource.attributes);
}
