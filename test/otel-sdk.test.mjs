import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { createOtelSdkController, startOtelSdk } from "../src/otel/sdk.ts";
import { runBoundedOtelOperation } from "../src/otel/shutdown.ts";
import { createCompositeOtelSignalSdk } from "../src/pi/handlers.ts";

let originalSetTimeout = globalThis.setTimeout;
let timerCalls = 0;

test("importing the OTEL SDK module does not start timers, exporters, or SDK factories", async () => {
  originalSetTimeout = globalThis.setTimeout;
  timerCalls = 0;

  globalThis.setTimeout = trackSetTimeout;
  try {
    await import(`../src/otel/sdk.ts?import-safety=${Date.now()}`);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  assert.equal(timerCalls, 0);
});

test("creating a controller is side-effect free until session-scoped start is called", async () => {
  let factoryCalls = 0;
  let startCalls = 0;
  const controller = createOtelSdkController({
    config: defaultObservMeConfig,
    sdkFactory: () => {
      factoryCalls += 1;
      return {
        start: () => {
          startCalls += 1;
        },
      };
    },
  });

  assert.deepEqual(controller.snapshot(), { state: "idle", started: false, shutdown: false });
  assert.equal(factoryCalls, 0);
  assert.equal(startCalls, 0);

  await controller.start();

  assert.deepEqual(controller.snapshot(), { state: "started", started: true, shutdown: false });
  assert.equal(factoryCalls, 1);
  assert.equal(startCalls, 1);
});

test("startOtelSdk starts the session-scoped SDK exactly once", async () => {
  let startCalls = 0;
  const controller = await startOtelSdk({
    config: defaultObservMeConfig,
    sdkFactory: () => ({
      start: () => {
        startCalls += 1;
      },
    }),
  });

  await controller.start();

  assert.equal(startCalls, 1);
  assert.equal(controller.state, "started");
});

test("multi-signal startup rolls back trace resources when metric startup fails", async () => {
  await assertTransactionalSignalFailure("metric");
});

test("multi-signal startup rolls back trace and metric resources when log startup fails", async () => {
  await assertTransactionalSignalFailure("log");
});

test("multi-signal startup cleans the attempted trace signal when trace startup fails", async () => {
  await assertTransactionalSignalFailure("trace");
});

test("failed multi-signal startup bounds rollback timeout and leaves the controller non-retryable", async () => {
  const signals = createSignalHarness("metric", { traceShutdown: neverResolve });
  const config = structuredClone(defaultObservMeConfig);
  config.shutdown.flushTimeoutMs = 20;
  const composite = createCompositeOtelSignalSdk(signals.trace, signals.metric, signals.log, 20);
  const controller = createOtelSdkController({
    config,
    sdkFactory: () => composite,
  });

  const failure = await measureRejection(() => controller.start());

  assert.equal(failure.elapsedMs < 250, true);
  assert.match(failure.error.message, /Cleanup exceeded its timeout; restart Pi before retrying/u);
  assert.equal(controller.state, "failed");
  assert.equal(controller.sdk, undefined);
  assert.equal(composite.state, "failed");
  assert.deepEqual(signals.calls, {
    trace: { starts: 1, shutdowns: 1 },
    metric: { starts: 1, shutdowns: 1 },
    log: { starts: 0, shutdowns: 0 },
  });
  await assert.rejects(() => controller.start(), /cannot be restarted after failed startup/u);
});

test("failed multi-signal startup attempts every rollback when one cleanup fails", async () => {
  const signals = createSignalHarness("log", { metricShutdown: throwingCleanup });
  const composite = createCompositeOtelSignalSdk(signals.trace, signals.metric, signals.log, 100);
  const controller = createOtelSdkController({
    config: defaultObservMeConfig,
    sdkFactory: () => composite,
  });

  await assert.rejects(
    () => controller.start(),
    error => {
      assert.match(error.message, /Cleanup also failed; restart Pi before retrying/u);
      assert.doesNotMatch(error.message, /cleanup-token/u);
      return true;
    },
  );

  assert.equal(controller.state, "failed");
  assert.equal(composite.state, "failed");
  assert.deepEqual(signals.calls, {
    trace: { starts: 1, shutdowns: 1 },
    metric: { starts: 1, shutdowns: 1 },
    log: { starts: 1, shutdowns: 1 },
  });
});

test("controller sanitizes startup failures, cleans generic SDKs, and rejects reuse", async () => {
  let shutdownCalls = 0;
  const controller = createOtelSdkController({
    config: defaultObservMeConfig,
    sdkFactory: () => ({
      start: () => {
        throw new Error("Authorization: Bearer startup-token password=startup-password /tmp/private.env");
      },
      shutdown: () => {
        shutdownCalls += 1;
      },
    }),
  });

  await assert.rejects(
    () => controller.start(),
    error => {
      assert.match(error.message, /ObservMe OTEL startup failed/u);
      assert.match(error.message, /Started providers were cleaned up/u);
      assert.doesNotMatch(error.message, /startup-token|startup-password|private\.env/u);
      return true;
    },
  );

  assert.equal(shutdownCalls, 1);
  assert.equal(controller.state, "failed");
  assert.equal(controller.sdk, undefined);
  await assert.rejects(() => controller.start(), /cannot be restarted after failed startup/u);
  assert.equal(shutdownCalls, 1);
});

test("bounded flush and shutdown complete within the configured timeout for unresponsive SDKs", async () => {
  const warnings = [];
  const controller = await startOtelSdk({
    config: defaultObservMeConfig,
    logger: { warn: message => warnings.push(message) },
    sdkFactory: () => ({
      forceFlush: () => new Promise(() => {}),
      shutdown: () => new Promise(() => {}),
    }),
  });

  const flush = await measure(() => controller.flush(25));
  const shutdown = await measure(() => controller.shutdown(25));

  assert.equal(flush.result.operation, "flush");
  assert.equal(flush.result.timedOut, true);
  assert.equal(flush.elapsedMs < 250, true);
  assert.equal(shutdown.result.operation, "shutdown");
  assert.equal(shutdown.result.timedOut, true);
  assert.equal(shutdown.elapsedMs < 250, true);
  assert.equal(controller.state, "shutdown");
  assert.ok(warnings.some(message => message.includes("flush exceeded timeout")));
  assert.ok(warnings.some(message => message.includes("shutdown exceeded timeout")));
});

test("bounded OTEL operations report failures without throwing into Pi lifecycle handlers", async () => {
  const result = await runBoundedOtelOperation("shutdown", throwingOperation, 100);

  assert.equal(result.operation, "shutdown");
  assert.equal(result.completed, false);
  assert.equal(result.timedOut, false);
  assert.match(result.error.message, /exporter failed/u);
});

test("OTEL shutdown warnings sanitize exporter failure diagnostics", async () => {
  const warnings = [];
  const controller = await startOtelSdk({
    config: defaultObservMeConfig,
    logger: { warn: message => warnings.push(message) },
    sdkFactory: () => ({
      shutdown: () => {
        throw new Error(
          "Authorization: Bearer otel-token password=otel-password /tmp/private.env bash export OBSERVME_TOKEN=env-secret",
        );
      },
    }),
  });

  await controller.shutdown(100);

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ObservMe OTEL shutdown failed/u);
  assert.doesNotMatch(warnings[0], /otel-token|otel-password|private\.env|bash export|env-secret/u);
});

async function assertTransactionalSignalFailure(failingSignal) {
  const signals = createSignalHarness(failingSignal);
  const composite = createCompositeOtelSignalSdk(signals.trace, signals.metric, signals.log, 100);
  const controller = createOtelSdkController({
    config: defaultObservMeConfig,
    sdkFactory: () => composite,
  });

  await assert.rejects(() => controller.start(), new RegExp(`${failingSignal} startup failed`, "u"));

  const failingIndex = ["trace", "metric", "log"].indexOf(failingSignal);
  for (const [index, signal] of ["trace", "metric", "log"].entries()) {
    assert.equal(signals.calls[signal].starts, index <= failingIndex ? 1 : 0);
    assert.equal(signals.calls[signal].shutdowns, index <= failingIndex ? 1 : 0);
  }
  assert.equal(controller.state, "failed");
  assert.equal(controller.sdk, undefined);
  assert.equal(composite.state, "failed");
}

function createSignalHarness(failingSignal, options = {}) {
  const calls = {
    trace: { starts: 0, shutdowns: 0 },
    metric: { starts: 0, shutdowns: 0 },
    log: { starts: 0, shutdowns: 0 },
  };

  return {
    calls,
    trace: createFakeSignalSdk("trace", calls.trace, failingSignal, options.traceShutdown),
    metric: createFakeSignalSdk("metric", calls.metric, failingSignal, options.metricShutdown),
    log: createFakeSignalSdk("log", calls.log, failingSignal, options.logShutdown),
  };
}

function createFakeSignalSdk(name, calls, failingSignal, shutdownAction) {
  return {
    start: () => {
      calls.starts += 1;
      if (name === failingSignal) throw new Error(`${name} startup failed`);
    },
    forceFlush: async () => undefined,
    shutdown: async () => {
      calls.shutdowns += 1;
      await shutdownAction?.();
    },
  };
}

async function measure(action) {
  const startedAt = performance.now();
  const result = await action();
  return { result, elapsedMs: performance.now() - startedAt };
}

async function measureRejection(action) {
  const startedAt = performance.now();
  try {
    await action();
    assert.fail("expected action to reject");
  } catch (error) {
    return { error, elapsedMs: performance.now() - startedAt };
  }
}

function trackSetTimeout(...args) {
  timerCalls += 1;
  return originalSetTimeout(...args);
}

function throwingOperation() {
  throw new Error("exporter failed");
}

function throwingCleanup() {
  throw new Error("cleanup failed Authorization: Bearer cleanup-token");
}

function neverResolve() {
  return new Promise(() => undefined);
}
