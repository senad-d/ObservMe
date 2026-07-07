import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { createOtelSdkController, startOtelSdk } from "../src/otel/sdk.ts";
import { runBoundedOtelOperation } from "../src/otel/shutdown.ts";

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

async function measure(action) {
  const startedAt = performance.now();
  const result = await action();
  return { result, elapsedMs: performance.now() - startedAt };
}

function trackSetTimeout(...args) {
  timerCalls += 1;
  return originalSetTimeout(...args);
}

function throwingOperation() {
  throw new Error("exporter failed");
}
