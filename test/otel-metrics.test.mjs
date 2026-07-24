import assert from "node:assert/strict";
import test from "node:test";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { startOtelSdk } from "../src/otel/sdk.ts";
import {
  DOCUMENTED_METRIC_EXPORT_DEFAULTS,
  ObservMeMetricSdk,
  buildMetricExporterWiring,
  resolveMetricEndpoint,
} from "../src/otel/metrics.ts";

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

function createHarness(config, options = {}) {
  const calls = {
    exporterOptions: undefined,
    readerOptions: undefined,
    providerOptions: undefined,
    forceFlushCalls: 0,
    shutdownCalls: 0,
  };
  const meter = createFakeMeter();
  const provider = createFakeMetricProvider(calls, meter, options.shutdown);
  const sdk = new ObservMeMetricSdk({
    config,
    exporterFactory: options => {
      calls.exporterOptions = options;
      return { export: () => undefined, forceFlush: () => undefined, shutdown: () => undefined };
    },
    readerFactory: (_exporter, options) => {
      calls.readerOptions = options;
      return { forceFlush: async () => undefined, shutdown: async () => undefined };
    },
    meterProviderFactory: options => {
      calls.providerOptions = options;
      return provider;
    },
  });

  return { sdk, calls, meter };
}

function createFakeMetricProvider(calls, meter, shutdownAction) {
  return {
    getMeter: () => meter,
    forceFlush: () => {
      calls.forceFlushCalls += 1;
    },
    shutdown: () => {
      calls.shutdownCalls += 1;
      return shutdownAction?.();
    },
  };
}

function createFakeMeter() {
  return {
    createCounter: () => ({ add: () => undefined }),
  };
}

test("metric exporter wiring matches documented OTLP endpoint and export defaults", () => {
  const config = cloneDefault({
    otlp: {
      endpoint: "http://collector:4318/",
      headers: { Authorization: "Bearer test-token" },
      signalEndpoints: undefined,
    },
  });

  const wiring = buildMetricExporterWiring(config);

  assert.equal(wiring.enabled, true);
  assert.deepEqual(wiring.reader, DOCUMENTED_METRIC_EXPORT_DEFAULTS);
  assert.deepEqual(wiring.exporter, {
    url: "http://collector:4318/v1/metrics",
    headers: { Authorization: "Bearer test-token" },
    timeoutMillis: 3000,
    httpAgentOptions: { rejectUnauthorized: true },
  });
});

test("explicit metric signal endpoint overrides the base OTLP endpoint", () => {
  const config = cloneDefault({
    otlp: {
      endpoint: "http://collector:4318",
      signalEndpoints: { metrics: "https://otel.example.test/custom/v1/metrics" },
    },
  });

  assert.equal(resolveMetricEndpoint(config), "https://otel.example.test/custom/v1/metrics");
});

test("metric exporter maps the retained OTLP TLS verification setting to its HTTP agent", () => {
  const config = cloneDefault({ otlp: { tls: { insecureSkipVerify: true } } });

  assert.deepEqual(buildMetricExporterWiring(config).exporter.httpAgentOptions, {
    rejectUnauthorized: false,
  });
});

test("meter provider and exporter are created only during enabled direct session startup", async () => {
  const { sdk, calls, meter } = createHarness(defaultObservMeConfig);

  assert.equal(calls.exporterOptions, undefined);
  assert.doesNotThrow(() => sdk.meter.createCounter("observme_pre_start_total").add(1));

  const controller = await startOtelSdk({
    config: defaultObservMeConfig,
    sdkFactory: () => sdk,
  });

  assert.equal(controller.state, "started");
  assert.equal(sdk.state, "started");
  assert.equal(sdk.meter, meter);
  assert.deepEqual(calls.readerOptions, DOCUMENTED_METRIC_EXPORT_DEFAULTS);
  assert.equal(calls.exporterOptions.url.endsWith("/v1/metrics"), true);
  assert.equal(calls.providerOptions.resource.attributes["observme.tenant.id"], "platform");
});

test("metric startup failure releases a reader created before provider construction fails", async () => {
  let readerShutdowns = 0;
  const sdk = new ObservMeMetricSdk({
    config: defaultObservMeConfig,
    exporterFactory: () => ({ export: () => undefined, forceFlush: () => undefined, shutdown: () => undefined }),
    readerFactory: () => ({
      forceFlush: async () => undefined,
      shutdown: async () => {
        readerShutdowns += 1;
      },
    }),
    meterProviderFactory: () => {
      throw new Error("metric provider construction failed");
    },
  });

  await assert.rejects(
    () => startOtelSdk({ config: defaultObservMeConfig, sdkFactory: () => sdk }),
    /metric provider construction failed/u,
  );

  assert.equal(readerShutdowns, 1);
  assert.equal(sdk.state, "shutdown");
});

test("failed metric provider shutdown remains owned and retryable", async () => {
  const { sdk, calls } = createHarness(defaultObservMeConfig, {
    shutdown: createRejectOnceShutdown("metric shutdown failed"),
  });
  await sdk.start();

  await assert.rejects(() => sdk.shutdown(), /metric shutdown failed/u);

  assert.equal(sdk.state, "shutdown_failed");
  assert.equal(calls.shutdownCalls, 1);

  await sdk.shutdown();
  await sdk.shutdown();

  assert.equal(sdk.state, "shutdown");
  assert.equal(calls.shutdownCalls, 2);
});

test("disabled metrics keep pre-start instruments safe and avoid exporter or provider factories", async () => {
  const config = cloneDefault({ metrics: { enabled: false } });
  const { sdk, calls } = createHarness(config);

  assert.doesNotThrow(() => sdk.meter.createCounter("observme_disabled_total").add(1));
  await sdk.start();
  assert.doesNotThrow(() => sdk.meter.createCounter("observme_still_disabled_total").add(1));

  assert.equal(sdk.state, "disabled");
  assert.equal(calls.exporterOptions, undefined);
  assert.equal(calls.readerOptions, undefined);
  assert.equal(calls.providerOptions, undefined);
});

function createRejectOnceShutdown(message) {
  let attempts = 0;
  return () => {
    attempts += 1;
    if (attempts === 1) throw new Error(message);
  };
}

test("top-level disablement keeps enabled metric settings from creating exporters or providers", async () => {
  const config = cloneDefault({ enabled: false, metrics: { enabled: true } });
  const { sdk, calls } = createHarness(config);

  await sdk.start();

  assert.equal(buildMetricExporterWiring(config).enabled, false);
  assert.equal(sdk.state, "disabled");
  assert.equal(calls.exporterOptions, undefined);
  assert.equal(calls.readerOptions, undefined);
  assert.equal(calls.providerOptions, undefined);
});
