import assert from "node:assert/strict";
import test from "node:test";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { startOtelSdk } from "../src/otel/sdk.ts";
import {
  DOCUMENTED_TRACE_BATCH_DEFAULTS,
  ObservMeTraceSdk,
  buildTraceExporterWiring,
  resolveTraceEndpoint,
} from "../src/otel/traces.ts";

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
    registerCalls: 0,
    forceFlushCalls: 0,
    shutdownCalls: 0,
  };
  const tracer = { name: "fake-observme-tracer" };
  const provider = createFakeTraceProvider(calls, tracer);
  const sdk = new ObservMeTraceSdk({
    config,
    exporterFactory: options => {
      calls.exporterOptions = options;
      return { export: () => undefined, shutdown: () => undefined };
    },
    spanProcessorFactory: (_exporter, options) => {
      calls.batchOptions = options;
      return createFakeSpanProcessor();
    },
    tracerProviderFactory: options => {
      calls.providerOptions = options;
      return provider;
    },
  });

  return { sdk, calls, tracer };
}

function createFakeTraceProvider(calls, tracer) {
  return {
    register: () => {
      calls.registerCalls += 1;
    },
    getTracer: () => tracer,
    forceFlush: () => {
      calls.forceFlushCalls += 1;
    },
    shutdown: () => {
      calls.shutdownCalls += 1;
    },
  };
}

function createFakeSpanProcessor() {
  return {
    forceFlush: async () => undefined,
    onStart: () => undefined,
    onEnd: () => undefined,
    shutdown: async () => undefined,
  };
}

test("trace exporter wiring matches documented OTLP endpoint and batch defaults", () => {
  const config = cloneDefault({
    otlp: {
      endpoint: "http://collector:4318/",
      headers: { Authorization: "Bearer test-token" },
      signalEndpoints: undefined,
    },
  });

  const wiring = buildTraceExporterWiring(config);

  assert.equal(wiring.enabled, true);
  assert.deepEqual(wiring.batch, DOCUMENTED_TRACE_BATCH_DEFAULTS);
  assert.deepEqual(wiring.exporter, {
    url: "http://collector:4318/v1/traces",
    headers: { Authorization: "Bearer test-token" },
    timeoutMillis: 3000,
    httpAgentOptions: { rejectUnauthorized: true },
  });
});

test("explicit trace signal endpoint overrides the base OTLP endpoint", () => {
  const config = cloneDefault({
    otlp: {
      endpoint: "http://collector:4318",
      signalEndpoints: { traces: "https://otel.example.test/custom/v1/traces" },
    },
  });

  assert.equal(resolveTraceEndpoint(config), "https://otel.example.test/custom/v1/traces");
});

test("trace exporter maps the retained OTLP TLS verification setting to its HTTP agent", () => {
  const config = cloneDefault({ otlp: { tls: { insecureSkipVerify: true } } });

  assert.deepEqual(buildTraceExporterWiring(config).exporter.httpAgentOptions, {
    rejectUnauthorized: false,
  });
});

test("tracer provider and exporter are created only during enabled direct session startup", async () => {
  const { sdk, calls, tracer } = createHarness(defaultObservMeConfig);

  assert.notEqual(sdk.tracer, tracer);
  assert.equal(calls.exporterOptions, undefined);

  const controller = await startOtelSdk({
    config: defaultObservMeConfig,
    sdkFactory: () => sdk,
  });

  assert.equal(controller.state, "started");
  assert.equal(sdk.state, "started");
  assert.equal(sdk.tracer, tracer);
  assert.deepEqual(calls.batchOptions, DOCUMENTED_TRACE_BATCH_DEFAULTS);
  assert.equal(calls.exporterOptions.url.endsWith("/v1/traces"), true);
  assert.equal(calls.providerOptions.resource.attributes["observme.tenant.id"], "platform");
  assert.equal(calls.registerCalls, 0);
});

test("trace startup failure releases a processor created before provider construction fails", async () => {
  let processorShutdowns = 0;
  const sdk = new ObservMeTraceSdk({
    config: defaultObservMeConfig,
    exporterFactory: () => ({ export: () => undefined, shutdown: () => undefined }),
    spanProcessorFactory: () => ({
      forceFlush: async () => undefined,
      onStart: () => undefined,
      onEnd: () => undefined,
      shutdown: async () => {
        processorShutdowns += 1;
      },
    }),
    tracerProviderFactory: () => {
      throw new Error("trace provider construction failed");
    },
  });

  await assert.rejects(
    () => startOtelSdk({ config: defaultObservMeConfig, sdkFactory: () => sdk }),
    /trace provider construction failed/u,
  );

  assert.equal(processorShutdowns, 1);
  assert.equal(sdk.state, "shutdown");
});

test("disabled traces resolve to a safe no-op without exporter or provider factories", async () => {
  const config = cloneDefault({ traces: { enabled: false } });
  const { sdk, calls, tracer } = createHarness(config);

  await sdk.start();

  assert.equal(sdk.state, "disabled");
  assert.notEqual(sdk.tracer, tracer);
  assert.equal(calls.exporterOptions, undefined);
  assert.equal(calls.batchOptions, undefined);
  assert.equal(calls.providerOptions, undefined);
});

test("top-level disablement keeps enabled trace settings from creating exporters or providers", async () => {
  const config = cloneDefault({ enabled: false, traces: { enabled: true } });
  const { sdk, calls, tracer } = createHarness(config);

  await sdk.start();

  assert.equal(buildTraceExporterWiring(config).enabled, false);
  assert.equal(sdk.state, "disabled");
  assert.notEqual(sdk.tracer, tracer);
  assert.equal(calls.exporterOptions, undefined);
  assert.equal(calls.batchOptions, undefined);
  assert.equal(calls.providerOptions, undefined);
  assert.equal(calls.registerCalls, 0);
});
