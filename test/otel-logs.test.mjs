import assert from "node:assert/strict";
import test from "node:test";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { startOtelSdk } from "../src/otel/sdk.ts";
import {
  DOCUMENTED_LOG_BATCH_DEFAULTS,
  ObservMeLogSdk,
  buildLogExporterWiring,
  resolveLogEndpoint,
} from "../src/otel/logs.ts";

function cloneDefault(overrides = {}) {
  return merge(structuredClone(defaultObservMeConfig), overrides);
}

function merge(base, overlay) {
  for (const [key, value] of Object.entries(overlay)) {
    if (isPlainObject(base[key]) && isPlainObject(value)) {
      merge(base[key], value);
      continue;
    }
    base[key] = value;
  }
  return base;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createHarness(config) {
  const calls = {
    exporterOptions: undefined,
    batchOptions: undefined,
    providerOptions: undefined,
    forceFlushCalls: 0,
    shutdownCalls: 0,
  };
  const logger = createFakeLogger();
  const provider = createFakeLogProvider(calls, logger);
  const sdk = new ObservMeLogSdk({
    config,
    exporterFactory: options => {
      calls.exporterOptions = options;
      return { export: () => undefined, shutdown: () => undefined };
    },
    processorFactory: (_exporter, options) => {
      calls.batchOptions = options;
      return createFakeLogRecordProcessor();
    },
    loggerProviderFactory: options => {
      calls.providerOptions = options;
      return provider;
    },
  });

  return { sdk, calls, logger };
}

function createFakeLogProvider(calls, logger) {
  return {
    getLogger: () => logger,
    forceFlush: () => {
      calls.forceFlushCalls += 1;
    },
    shutdown: () => {
      calls.shutdownCalls += 1;
    },
  };
}

function createFakeLogger() {
  const records = [];
  return {
    records,
    emit: record => {
      records.push(record);
    },
    enabled: () => true,
  };
}

function createFakeLogRecordProcessor() {
  return {
    forceFlush: async () => undefined,
    onEmit: () => undefined,
    shutdown: async () => undefined,
  };
}

test("log exporter wiring matches documented OTLP endpoint and batch defaults", () => {
  const config = cloneDefault({
    otlp: {
      endpoint: "http://collector:4318/",
      headers: { Authorization: "Bearer test-token" },
      signalEndpoints: undefined,
    },
  });

  const wiring = buildLogExporterWiring(config);

  assert.equal(wiring.enabled, true);
  assert.deepEqual(wiring.batch, DOCUMENTED_LOG_BATCH_DEFAULTS);
  assert.deepEqual(wiring.exporter, {
    url: "http://collector:4318/v1/logs",
    headers: { Authorization: "Bearer test-token" },
    timeoutMillis: 3000,
    httpAgentOptions: { rejectUnauthorized: true },
  });
});

test("explicit log signal endpoint overrides the base OTLP endpoint", () => {
  const config = cloneDefault({
    otlp: {
      endpoint: "http://collector:4318",
      signalEndpoints: { logs: "https://otel.example.test/custom/v1/logs" },
    },
  });

  assert.equal(resolveLogEndpoint(config), "https://otel.example.test/custom/v1/logs");
});

test("log exporter maps the retained OTLP TLS verification setting to its HTTP agent", () => {
  const config = cloneDefault({ otlp: { tls: { insecureSkipVerify: true } } });

  assert.deepEqual(buildLogExporterWiring(config).exporter.httpAgentOptions, {
    rejectUnauthorized: false,
  });
});

test("logger provider and exporter are created only during enabled direct session startup", async () => {
  const { sdk, calls, logger } = createHarness(defaultObservMeConfig);

  assert.equal(calls.exporterOptions, undefined);
  assert.doesNotThrow(() => sdk.logger.emit({ body: "pre-start" }));

  const controller = await startOtelSdk({
    config: defaultObservMeConfig,
    sdkFactory: () => sdk,
  });

  assert.equal(controller.state, "started");
  assert.equal(sdk.state, "started");
  assert.equal(sdk.logger, logger);
  assert.deepEqual(calls.batchOptions, DOCUMENTED_LOG_BATCH_DEFAULTS);
  assert.equal(calls.exporterOptions.url.endsWith("/v1/logs"), true);
  assert.equal(calls.providerOptions.resource.attributes["observme.tenant.id"], "platform");
});

test("log startup failure releases a processor created before provider construction fails", async () => {
  let processorShutdowns = 0;
  const sdk = new ObservMeLogSdk({
    config: defaultObservMeConfig,
    exporterFactory: () => ({ export: () => undefined, shutdown: () => undefined }),
    processorFactory: () => ({
      forceFlush: async () => undefined,
      onEmit: () => undefined,
      shutdown: async () => {
        processorShutdowns += 1;
      },
    }),
    loggerProviderFactory: () => {
      throw new Error("log provider construction failed");
    },
  });

  await assert.rejects(
    () => startOtelSdk({ config: defaultObservMeConfig, sdkFactory: () => sdk }),
    /log provider construction failed/u,
  );

  assert.equal(processorShutdowns, 1);
  assert.equal(sdk.state, "shutdown");
});

test("disabled logs keep pre-start emission safe and avoid exporter or provider factories", async () => {
  const config = cloneDefault({ logs: { enabled: false } });
  const { sdk, calls } = createHarness(config);

  assert.doesNotThrow(() => sdk.logger.emit({ body: "disabled-before-start" }));
  await sdk.start();
  assert.doesNotThrow(() => sdk.logger.emit({ body: "disabled-after-start" }));

  assert.equal(sdk.state, "disabled");
  assert.equal(calls.exporterOptions, undefined);
  assert.equal(calls.batchOptions, undefined);
  assert.equal(calls.providerOptions, undefined);
});

test("top-level disablement keeps enabled log settings from creating exporters or providers", async () => {
  const config = cloneDefault({ enabled: false, logs: { enabled: true } });
  const { sdk, calls } = createHarness(config);

  await sdk.start();

  assert.equal(buildLogExporterWiring(config).enabled, false);
  assert.equal(sdk.state, "disabled");
  assert.equal(calls.exporterOptions, undefined);
  assert.equal(calls.batchOptions, undefined);
  assert.equal(calls.providerOptions, undefined);
});
