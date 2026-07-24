import type { Logger } from "@opentelemetry/api-logs";
import { createNoopLogger } from "@opentelemetry/api-logs";
import type { Resource } from "@opentelemetry/resources";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import type { LogRecordExporter, LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import type { LogsBatchConfig, ObservMeConfig } from "../config/schema.ts";
import { appendOtlpSignalPath } from "./otlp-endpoint.ts";
import { buildOtlpHttpAgentOptions, type OtlpHttpAgentOptions } from "./otlp-http-options.ts";
import type { StartOtelSdkFactoryOptions } from "./sdk.ts";

export const OBSERVME_LOGGER_NAME = "@senad-d/observme";
export const OTLP_LOG_SIGNAL_PATH = "/v1/logs";

export const DOCUMENTED_LOG_BATCH_DEFAULTS = {
  maxQueueSize: 2048,
  maxExportBatchSize: 512,
  scheduledDelayMillis: 1000,
} satisfies LogsBatchConfig;

export type LogPipelineState =
  | "idle"
  | "disabled"
  | "started"
  | "shutting_down"
  | "shutdown_failed"
  | "shutdown";

export interface OtlpLogExporterOptions {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly timeoutMillis: number;
  readonly httpAgentOptions: OtlpHttpAgentOptions;
}

export interface LogProviderOptions {
  readonly resource: Resource;
  readonly processors: LogRecordProcessor[];
  readonly forceFlushTimeoutMillis: number;
}

export interface LogProviderLike {
  getLogger: (name: string) => Logger;
  forceFlush?: () => Promise<void> | void;
  shutdown?: () => Promise<void> | void;
}

export type LogExporterFactory = (options: OtlpLogExporterOptions) => LogRecordExporter;
export type LogRecordProcessorFactory = (exporter: LogRecordExporter, options: LogsBatchConfig) => LogRecordProcessor;
export type LogProviderFactory = (options: LogProviderOptions) => LogProviderLike;

export interface ObservMeLogSdkOptions {
  readonly config: ObservMeConfig;
  readonly loggerName?: string;
  readonly exporterFactory?: LogExporterFactory;
  readonly processorFactory?: LogRecordProcessorFactory;
  readonly loggerProviderFactory?: LogProviderFactory;
}

export interface LogExporterWiring {
  readonly enabled: boolean;
  readonly exporter: OtlpLogExporterOptions;
  readonly batch: LogsBatchConfig;
}

const noopLogger = createNoopLogger();

export class ObservMeLogSdk {
  readonly #config: ObservMeConfig;
  readonly #loggerName: string;
  readonly #exporterFactory: LogExporterFactory;
  readonly #processorFactory: LogRecordProcessorFactory;
  readonly #loggerProviderFactory: LogProviderFactory;
  #exporter?: LogRecordExporter;
  #processor?: LogRecordProcessor;
  #provider?: LogProviderLike;
  #logger: Logger = noopLogger;
  #shutdownPromise?: Promise<void>;
  #state: LogPipelineState = "idle";

  constructor(options: ObservMeLogSdkOptions) {
    this.#config = options.config;
    this.#loggerName = options.loggerName ?? OBSERVME_LOGGER_NAME;
    this.#exporterFactory = options.exporterFactory ?? createOtlpLogExporter;
    this.#processorFactory = options.processorFactory ?? createBatchLogRecordProcessor;
    this.#loggerProviderFactory = options.loggerProviderFactory ?? createLogProvider;
  }

  get state(): LogPipelineState {
    return this.#state;
  }

  get logger(): Logger {
    return this.#logger;
  }

  start(): void {
    if (this.#state === "started" || this.#state === "disabled") return;
    if (!this.#config.enabled || !this.#config.logs.enabled) {
      this.#state = "disabled";
      return;
    }

    const wiring = buildLogExporterWiring(this.#config);
    this.#exporter = this.#exporterFactory(wiring.exporter);
    this.#processor = this.#processorFactory(this.#exporter, wiring.batch);
    this.#provider = this.#loggerProviderFactory({
      resource: createLogResource(this.#config),
      processors: [this.#processor],
      forceFlushTimeoutMillis: this.#config.shutdown.flushTimeoutMs,
    });

    this.#logger = this.#provider.getLogger(this.#loggerName);
    this.#state = "started";
  }

  async forceFlush(): Promise<void> {
    await this.#provider?.forceFlush?.();
  }

  async shutdown(): Promise<void> {
    if (this.#state === "shutdown") return;
    if (this.#state === "shutting_down" && this.#shutdownPromise) return this.#shutdownPromise;

    this.#state = "shutting_down";
    this.#logger = noopLogger;
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
      else if (this.#processor) await this.#processor.shutdown();
      else await this.#exporter?.shutdown();
      this.#provider = undefined;
      this.#processor = undefined;
      this.#exporter = undefined;
      this.#state = "shutdown";
    } catch (error) {
      this.#state = "shutdown_failed";
      throw error;
    }
  }
}

export function createLogSessionScopedOtelSdk(options: StartOtelSdkFactoryOptions): ObservMeLogSdk {
  return new ObservMeLogSdk({ config: options.config });
}

export function buildLogExporterWiring(config: ObservMeConfig): LogExporterWiring {
  return {
    enabled: config.enabled && config.logs.enabled,
    exporter: buildOtlpLogExporterOptions(config),
    batch: { ...config.logs.batch },
  };
}

export function buildOtlpLogExporterOptions(config: ObservMeConfig): OtlpLogExporterOptions {
  return {
    url: resolveLogEndpoint(config),
    headers: { ...config.otlp.headers },
    timeoutMillis: config.otlp.timeoutMs,
    httpAgentOptions: buildOtlpHttpAgentOptions(config),
  };
}

export function resolveLogEndpoint(config: ObservMeConfig): string {
  return config.otlp.signalEndpoints?.logs ?? appendOtlpSignalPath(config.otlp.endpoint, OTLP_LOG_SIGNAL_PATH);
}

function createOtlpLogExporter(options: OtlpLogExporterOptions): LogRecordExporter {
  return new OTLPLogExporter(options);
}

function createBatchLogRecordProcessor(exporter: LogRecordExporter, options: LogsBatchConfig): LogRecordProcessor {
  return new BatchLogRecordProcessor({ exporter, ...options });
}

function createLogProvider(options: LogProviderOptions): LogProviderLike {
  return new LoggerProvider(options);
}

function createLogResource(config: ObservMeConfig): Resource {
  return resourceFromAttributes(config.resource.attributes);
}
