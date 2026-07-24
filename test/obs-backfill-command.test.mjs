import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { getObsRootCommandArgumentCompletions, registerObsCommand } from "../src/commands/obs.ts";
import {
  ObsBackfillLogExporter,
  buildObsBackfillRecords,
  createObsBackfillLogExporter,
  handleObsBackfillCommand,
  renderObsBackfillSummary,
  runObsBackfill,
} from "../src/commands/obs-backfill.ts";
import { ObservMeLogSdk } from "../src/otel/logs.ts";
import {
  emitUnrelatedGlobalTelemetry,
  installSentinelGlobalProviders,
  resetGlobalProviders,
} from "./otel-global-isolation-helpers.mjs";

const now = new Date("2026-07-07T12:00:00.000Z");
const bearerToken = `Authorization: Bearer ${"abc123._-".repeat(4)}`;
const backfillPrivateKeyBody = "QkFDS0ZJTExfU1lOVEhFVElDX1BSSVZBVEVfS0VZX0JPRFk=";
const backfillPrivateKeyBlock = `-----BEGIN ENCRYPTED PRIVATE KEY-----\n${backfillPrivateKeyBody}\n-----END ENCRYPTED PRIVATE KEY-----`;
process.env.OBSERVME_HASH_SALT = "obs-backfill-test-salt";

function cloneDefaultConfig() {
  return structuredClone(defaultObservMeConfig);
}

function createSessionManager(entries) {
  return {
    getBranch: () => entries,
    getEntries: () => entries,
    getHeader: () => ({
      type: "session",
      version: 3,
      id: "session-1",
      timestamp: "2026-07-07T11:00:00.000Z",
      cwd: "/workspace/demo",
    }),
    getSessionId: () => "session-1",
    getSessionFile: () => "/tmp/session.jsonl",
  };
}

function createContext(entries, notifications, confirmed = true) {
  return {
    cwd: "/workspace/demo",
    hasUI: true,
    ui: {
      notify: (message, type) => notifications.push({ message, type }),
      confirm: async (title, message) => {
        notifications.push({ title, message, type: "confirm" });
        return confirmed;
      },
    },
    waitForIdle: async () => undefined,
    isProjectTrusted: () => false,
    sessionManager: createSessionManager(entries),
  };
}

function createNonInteractiveBackfillContext(entries, notifications) {
  return {
    cwd: "/workspace/demo",
    hasUI: false,
    ui: {
      notify: (message, type) => notifications.push({ message, type }),
    },
    isProjectTrusted: () => false,
    sessionManager: createSessionManager(entries),
  };
}

function createBackfillContextWithoutSessionManager(notifications) {
  return {
    cwd: "/workspace/demo",
    hasUI: true,
    ui: {
      notify: (message, type) => notifications.push({ message, type }),
      confirm: async () => true,
    },
    waitForIdle: async () => undefined,
    isProjectTrusted: () => false,
  };
}

function createBackfillContextWithoutWaitForIdle(entries, notifications) {
  return {
    cwd: "/workspace/demo",
    hasUI: true,
    ui: {
      notify: (message, type) => notifications.push({ message, type }),
      confirm: async () => true,
    },
    isProjectTrusted: () => false,
    sessionManager: createSessionManager(entries),
  };
}

function createExporter(records) {
  return {
    emit: record => records.push(record),
    flush: () => records.push({ flushed: true }),
    shutdown: () => records.push({ shutdown: true }),
  };
}

function userEntry(id, timestamp, content) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp,
    message: {
      role: "user",
      content,
      timestamp: Date.parse(timestamp),
    },
  };
}

function assistantEntry(id, parentId, timestamp) {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private chain of thought" },
        { type: "text", text: "Done" },
        { type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "echo hi" } },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.01 } },
      stopReason: "stop",
      timestamp: Date.parse(timestamp),
    },
  };
}

function toolResultEntry(id, parentId, timestamp, content) {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "bash",
      content,
      timestamp: Date.parse(timestamp),
    },
  };
}

function bashEntry(id, parentId, timestamp, output) {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "bashExecution",
      command: "echo ok",
      output,
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: Date.parse(timestamp),
    },
  };
}

function hrTimeToEpochMilliseconds(hrTime) {
  return hrTime[0] * 1000 + hrTime[1] / 1_000_000;
}

test("production backfill exporter confirms records only after flush and preserves source occurrence times", async t => {
  const config = cloneDefaultConfig();
  const exported = [];
  const retainingExporter = {
    export: (records, callback) => {
      exported.push(...records);
      callback({ code: 0 });
    },
    shutdown: async () => undefined,
  };
  const sdk = new ObservMeLogSdk({
    config,
    exporterFactory: () => retainingExporter,
    processorFactory: exporter => new SimpleLogRecordProcessor({ exporter }),
  });
  sdk.start();

  const exporter = new ObsBackfillLogExporter(sdk, 100);
  t.after(async () => exporter.shutdown());
  const entries = [
    userEntry("a1", "2026-07-07T11:10:00.000Z", "one"),
    userEntry("a2", "2026-07-07T11:20:00.000Z", "two"),
    userEntry("a3", "not-a-timestamp", "three"),
    userEntry("a4", undefined, "four"),
  ];

  const replayStartedMs = Date.now();
  const summary = await runObsBackfill(createContext(entries, []), { currentSession: true }, {
    loadConfig: async () => config,
    createExporter: () => exporter,
    maxRecords: 10,
  });
  const replayFinishedMs = Date.now();
  const occurrenceTimes = exported.map(record => hrTimeToEpochMilliseconds(record.hrTime));

  assert.equal(summary.status, "completed");
  assert.equal(summary.recordsAttempted, 4);
  assert.equal(summary.recordsQueued, 4);
  assert.equal(summary.recordsConfirmed, 4);
  assert.equal(summary.recordsUnknown, 0);
  assert.equal(summary.recordsNotAttempted, 0);
  assert.equal(exported.length, 4);
  assert.deepEqual(occurrenceTimes.slice(0, 2), [
    Date.parse("2026-07-07T11:10:00.000Z"),
    Date.parse("2026-07-07T11:20:00.000Z"),
  ]);
  assert.ok(occurrenceTimes[0] < occurrenceTimes[1]);
  assert.deepEqual(exported[2].hrTime, exported[2].hrTimeObserved);
  assert.deepEqual(exported[3].hrTime, exported[3].hrTimeObserved);
  assert.ok(occurrenceTimes.slice(2).every(timestamp => timestamp >= replayStartedMs && timestamp <= replayFinishedMs));
});

test("backfill keeps pre-existing process-global providers untouched", { concurrency: false }, async t => {
  const sentinel = installSentinelGlobalProviders();
  const config = cloneDefaultConfig();
  config.otlp.timeoutMs = 10;
  let exporter;

  t.after(async () => {
    await exporter?.shutdown();
    resetGlobalProviders();
  });

  exporter = createObsBackfillLogExporter(config, { timeoutMs: 100 });

  assert.equal(trace.getTracer("unrelated-during-backfill"), sentinel.tracer);
  assert.equal(metrics.getMeter("unrelated-during-backfill"), sentinel.meter);
  assert.equal(logs.getLogger("unrelated-during-backfill"), sentinel.logger);

  emitUnrelatedGlobalTelemetry();
  assert.deepEqual(sentinel.records, {
    spans: [{ name: "unrelated.span" }],
    metrics: [{ name: "unrelated.counter", value: 1 }],
    logs: [{ body: "unrelated.log" }],
  });

  await exporter.shutdown();
  exporter = undefined;
  assert.equal(logs.getLogger("unrelated-after-backfill"), sentinel.logger);
});

test("/obs backfill requires confirmation before exporting replayed telemetry", async () => {
  const notifications = [];
  const records = [];
  const config = cloneDefaultConfig();
  config.capture.prompts = true;

  const summary = await runObsBackfill(createContext([userEntry("a1", "2026-07-07T11:30:00.000Z", bearerToken)], notifications, false), {
    currentSession: true,
    since: "1h",
    sinceMs: 60 * 60 * 1000,
  }, {
    loadConfig: async () => config,
    createExporter: () => createExporter(records),
    now: () => now,
    maxRecords: 10,
  });

  assert.equal(summary.status, "cancelled");
  assert.equal(summary.recordsAttempted, 0);
  assert.equal(summary.recordsConfirmed, 0);
  assert.equal(records.length, 0);
  assert.equal(notifications[0].type, "confirm");
  assert.match(notifications[0].message, /observme\.replayed=true/u);
});

test("/obs backfill cancels safely when Pi runs without interactive UI", async () => {
  const notifications = [];
  const records = [];
  const config = cloneDefaultConfig();

  await handleObsBackfillCommand(
    "backfill --current-session --since 1h",
    createNonInteractiveBackfillContext([userEntry("a1", "2026-07-07T11:30:00.000Z", "one")], notifications),
    {
      loadConfig: async () => config,
      createExporter: () => createExporter(records),
      now: () => now,
      maxRecords: 10,
    },
  );

  assert.equal(records.length, 0);
  assert.equal(notifications.at(-1).type, "warning");
  assert.match(notifications.at(-1).message, /ObservMe backfill cancelled: interactive confirmation is required/u);
});

test("/obs backfill skips safely when current session state is unavailable", async () => {
  const notifications = [];
  const records = [];
  const config = cloneDefaultConfig();

  await handleObsBackfillCommand("backfill --current-session --since 1h", createBackfillContextWithoutSessionManager(notifications), {
    loadConfig: async () => config,
    createExporter: () => createExporter(records),
    now: () => now,
    maxRecords: 10,
  });

  assert.equal(records.length, 0);
  assert.equal(notifications.at(-1).type, "warning");
  assert.match(notifications.at(-1).message, /ObservMe backfill skipped: current session state is unavailable/u);
});

test("/obs backfill proceeds when Pi has no waitForIdle command capability", async () => {
  const notifications = [];
  const records = [];
  const config = cloneDefaultConfig();

  const summary = await runObsBackfill(createBackfillContextWithoutWaitForIdle([
    userEntry("a1", "2026-07-07T11:30:00.000Z", "one"),
  ], notifications), {
    currentSession: true,
    since: "1h",
    sinceMs: 60 * 60 * 1000,
  }, {
    loadConfig: async () => config,
    createExporter: () => createExporter(records),
    now: () => now,
    maxRecords: 10,
  });

  assert.equal(summary.status, "completed");
  assert.equal(summary.recordsAttempted, 1);
  assert.equal(summary.recordsQueued, 1);
  assert.equal(summary.recordsConfirmed, 1);
  assert.equal(summary.recordsUnknown, 0);
  assert.equal(summary.recordsNotAttempted, 0);
  assert.equal(records.filter(record => record.eventName).length, 1);
});

test("/obs backfill marks exported records as replayed and redacts captured content", async () => {
  const notifications = [];
  const records = [];
  const config = cloneDefaultConfig();
  config.capture.prompts = true;

  const summary = await runObsBackfill(createContext([userEntry("a1", "2026-07-07T11:30:00.000Z", bearerToken)], notifications), {
    currentSession: true,
    since: "1h",
    sinceMs: 60 * 60 * 1000,
  }, {
    loadConfig: async () => config,
    createExporter: () => createExporter(records),
    now: () => now,
    maxRecords: 10,
  });
  const exported = records.filter(record => record.eventName);

  assert.equal(summary.status, "completed");
  assert.equal(summary.recordsConfirmed, 1);
  assert.equal(exported.length, 1);
  assert.equal(exported[0].timestamp.getTime(), Date.parse("2026-07-07T11:30:00.000Z"));
  assert.equal(exported[0].attributes["observme.replayed"], true);
  assert.match(exported[0].attributes["pi.llm.prompt.redacted"], /\[REDACTED:/u);
  assert.doesNotMatch(exported[0].attributes["pi.llm.prompt.redacted"], /abc123/u);
});

test("/obs backfill redacts complete private-key headers, bodies, and footers", async () => {
  const records = [];
  const config = cloneDefaultConfig();
  config.capture.prompts = true;

  const summary = await runObsBackfill(createContext([
    userEntry("a1", "2026-07-07T11:30:00.000Z", backfillPrivateKeyBlock),
  ], []), {
    currentSession: true,
    since: "1h",
    sinceMs: 60 * 60 * 1000,
  }, {
    loadConfig: async () => config,
    createExporter: () => createExporter(records),
    now: () => now,
    maxRecords: 10,
  });
  const exportedPrompt = records.find(record => record.attributes?.["pi.llm.prompt.redacted"] !== undefined)?.attributes[
    "pi.llm.prompt.redacted"
  ];

  assert.equal(summary.status, "completed");
  assert.match(exportedPrompt, /^\[REDACTED:private_key_block:[a-f0-9]{12}\]$/u);
  assert.doesNotMatch(exportedPrompt, /-----BEGIN ENCRYPTED PRIVATE KEY-----/u);
  assert.doesNotMatch(exportedPrompt, new RegExp(backfillPrivateKeyBody, "u"));
  assert.doesNotMatch(exportedPrompt, /-----END ENCRYPTED PRIVATE KEY-----/u);
});

test("/obs backfill omits historical content when capture flags are disabled", async () => {
  const records = [];
  const config = cloneDefaultConfig();

  const summary = await runObsBackfill(createContext([userEntry("a1", "2026-07-07T11:30:00.000Z", bearerToken)], []), {
    currentSession: true,
    since: "1h",
    sinceMs: 60 * 60 * 1000,
  }, {
    loadConfig: async () => config,
    createExporter: () => createExporter(records),
    now: () => now,
    maxRecords: 10,
  });
  const exported = records.filter(record => record.eventName);
  const serializedAttributes = JSON.stringify(exported[0].attributes);

  assert.equal(summary.contentCaptured, false);
  assert.equal(exported[0].attributes["pi.llm.prompt.redacted"], undefined);
  assert.doesNotMatch(serializedAttributes, /abc123/u);
});

test("/obs backfill unsafe capture uses the shared raw truncation policy for prompt, tool result, and bash output", () => {
  const config = cloneDefaultConfig();
  config.capture.prompts = true;
  config.capture.toolResults = true;
  config.capture.bashOutput = true;
  config.privacy.redactionEnabled = false;
  config.privacy.allowUnsafeCapture = true;
  config.limits.maxPromptChars = 12;
  config.limits.maxToolResultChars = 12;
  config.limits.maxBashOutputChars = 12;

  const result = buildObsBackfillRecords([
    userEntry("a1", "2026-07-07T11:10:00.000Z", "password=prompt-secret"),
    toolResultEntry("a2", "a1", "2026-07-07T11:20:00.000Z", "api_key=tool-secret"),
    bashEntry("a3", "a2", "2026-07-07T11:30:00.000Z", "token=bash-secret"),
  ], config, {
    currentSession: true,
    since: "1h",
    sinceMs: 60 * 60 * 1000,
  }, "session-1", {
    maxRecords: 10,
    now: () => now,
  });

  assert.equal(result.contentCaptured, true);
  assert.equal(result.redactionFailures, 0);
  assert.equal(result.records[0].attributes["pi.llm.prompt.redacted"], "password=pro");
  assert.equal(result.records[1].attributes["pi.tool.result.redacted"], "api_key=tool");
  assert.equal(result.records[2].attributes["pi.bash.output.redacted"], "token=bash-s");
  assert.equal(result.records[0].attributes["observme.truncated"], true);
  assert.equal(result.records[1].attributes["observme.truncated"], true);
  assert.equal(result.records[2].attributes["observme.truncated"], true);
});

test("/obs backfill redaction-failure records are secret-free when the configured tenant salt is missing", () => {
  const tenantSaltEnv = "PRIVATE_BACKFILL_CAPTURE_SALT";
  const previousSalt = process.env[tenantSaltEnv];
  delete process.env[tenantSaltEnv];

  try {
    const config = cloneDefaultConfig();
    config.capture.prompts = true;
    config.capture.toolResults = true;
    config.capture.bashOutput = true;
    config.privacy.tenantSaltEnv = tenantSaltEnv;

    const result = buildObsBackfillRecords([
      userEntry("a1", "2026-07-07T11:10:00.000Z", "password=prompt-secret"),
      toolResultEntry("a2", "a1", "2026-07-07T11:20:00.000Z", "api_key=tool-secret"),
      bashEntry("a3", "a2", "2026-07-07T11:30:00.000Z", "token=bash-secret"),
    ], config, {
      currentSession: true,
      since: "1h",
      sinceMs: 60 * 60 * 1000,
    }, "session-1", {
      maxRecords: 10,
      now: () => now,
    });

    assert.equal(result.contentCaptured, false);
    assert.equal(result.redactionFailures, 3);
    assert.equal(result.records[0].attributes["pi.llm.prompt.redacted"], undefined);
    assert.equal(result.records[1].attributes["pi.tool.result.redacted"], undefined);
    assert.equal(result.records[2].attributes["pi.bash.output.redacted"], undefined);
    assert.doesNotMatch(
      JSON.stringify(result),
      /PRIVATE_BACKFILL_CAPTURE_SALT|prompt-secret|tool-secret|bash-secret/u,
    );
  } finally {
    if (previousSalt === undefined) delete process.env[tenantSaltEnv];
    else process.env[tenantSaltEnv] = previousSalt;
  }
});

test("backfill record building enforces export rate limits", () => {
  const config = cloneDefaultConfig();
  const entries = [
    userEntry("a1", "2026-07-07T11:10:00.000Z", "one"),
    assistantEntry("a2", "a1", "2026-07-07T11:20:00.000Z"),
    userEntry("a3", "2026-07-07T11:30:00.000Z", "three"),
  ];

  const result = buildObsBackfillRecords(entries, config, {
    currentSession: true,
    since: "1h",
    sinceMs: 60 * 60 * 1000,
  }, "session-1", {
    maxRecords: 2,
    now: () => now,
  });

  assert.equal(result.records.length, 2);
  assert.equal(result.entriesScanned, 3);
  assert.equal(result.entriesEligible, 3);
  assert.equal(result.rateLimited, true);
  assert.equal(result.recordsSkipped, 1);
});

test("/obs backfill keeps rate-limit skips separate from confirmed delivery outcomes", async () => {
  const records = [];
  const config = cloneDefaultConfig();
  const summary = await runObsBackfill(createContext([
    userEntry("a1", "2026-07-07T11:10:00.000Z", "one"),
    userEntry("a2", "2026-07-07T11:20:00.000Z", "two"),
    userEntry("a3", "2026-07-07T11:30:00.000Z", "three"),
  ], []), { currentSession: true }, {
    loadConfig: async () => config,
    createExporter: () => createExporter(records),
    maxRecords: 2,
  });

  assert.equal(summary.status, "completed");
  assert.equal(summary.recordsAttempted, 2);
  assert.equal(summary.recordsQueued, 2);
  assert.equal(summary.recordsConfirmed, 2);
  assert.equal(summary.recordsUnknown, 0);
  assert.equal(summary.recordsNotAttempted, 0);
  assert.equal(summary.recordsSkipped, 1);
  assert.equal(summary.rateLimited, true);
  assert.match(renderObsBackfillSummary(summary), /Rate limit: applied; skipped 1 eligible record\(s\)/u);
});

test("/obs backfill rejects oversized --since before scanning session entries", async () => {
  const notifications = [];
  let runCalls = 0;

  const options = {
    runBackfill: () => {
      runCalls += 1;
      throw new Error("should not scan or export for oversized --since");
    },
  };

  await handleObsBackfillCommand(
    "backfill --current-session --since 31d",
    createContext([userEntry("a1", "2026-07-07T11:30:00.000Z", "one")], notifications),
    options,
  );
  await handleObsBackfillCommand(
    "backfill --current-session --since 2592000001ms",
    createContext([userEntry("a2", "2026-07-07T11:40:00.000Z", "two")], notifications),
    options,
  );

  assert.equal(runCalls, 0);
  assert.equal(notifications.length, 2);
  assert.ok(notifications.every(notification => notification.type === "warning"));
  assert.match(notifications[0].message, /Invalid --since duration: 31d/u);
  assert.match(notifications[1].message, /Invalid --since duration: 2592000001ms/u);
  assert.ok(notifications.every(notification => /positive duration up to 30d/u.test(notification.message)));
});

test("/obs backfill accepts maximum --since boundary durations", async () => {
  const notifications = [];
  const requests = [];
  const options = {
    runBackfill: (_ctx, request) => {
      requests.push(request);
      return {
        status: "completed",
        sessionId: "session-1",
        since: request.since,
        entriesScanned: 0,
        entriesEligible: 0,
        recordsAttempted: 0,
        recordsQueued: 0,
        recordsConfirmed: 0,
        recordsUnknown: 0,
        recordsNotAttempted: 0,
        recordsSkipped: 0,
        rateLimited: false,
        contentCaptured: false,
        redactionFailures: 0,
      };
    },
  };

  await handleObsBackfillCommand("backfill --current-session --since 30d", createContext([], notifications), options);
  await handleObsBackfillCommand("backfill --current-session --since 720h", createContext([], notifications), options);

  assert.deepEqual(requests.map(request => request.since), ["30d", "720h"]);
  assert.deepEqual(requests.map(request => request.sinceMs), [30 * 24 * 60 * 60 * 1000, 720 * 60 * 60 * 1000]);
  assert.ok(notifications.every(notification => notification.type === "info"));
});

test("/obs backfill cancellation before confirmation does not export", async () => {
  const notifications = [];
  const records = [];
  const config = cloneDefaultConfig();
  const controller = new AbortController();
  controller.abort();
  const ctx = {
    ...createContext([userEntry("a1", "2026-07-07T11:30:00.000Z", "one")], notifications),
    signal: controller.signal,
  };

  const summary = await runObsBackfill(ctx, {
    currentSession: true,
    since: "1h",
    sinceMs: 60 * 60 * 1000,
  }, {
    loadConfig: async () => config,
    createExporter: () => createExporter(records),
    now: () => now,
    maxRecords: 10,
  });

  assert.equal(summary.status, "cancelled");
  assert.equal(summary.reason, "operation cancelled");
  assert.equal(summary.recordsAttempted, 0);
  assert.equal(summary.recordsConfirmed, 0);
  assert.equal(records.length, 0);
  assert.equal(notifications.length, 0);
});

test("/obs backfill cancellation after scanning preserves exact not-attempted counts", async () => {
  const config = cloneDefaultConfig();
  const controller = new AbortController();
  const entries = [
    userEntry("a1", "2026-07-07T11:20:00.000Z", "one"),
    userEntry("a2", "2026-07-07T11:30:00.000Z", "two"),
  ];
  const sessionManager = createSessionManager(entries);
  const ctx = {
    ...createContext(entries, []),
    signal: controller.signal,
    sessionManager: {
      ...sessionManager,
      getBranch: () => {
        controller.abort();
        return entries;
      },
    },
  };
  let exporterCalls = 0;

  const summary = await runObsBackfill(ctx, { currentSession: true }, {
    loadConfig: async () => config,
    createExporter: () => {
      exporterCalls += 1;
      return createExporter([]);
    },
  });

  assert.equal(summary.status, "cancelled");
  assert.equal(summary.recordsAttempted, 0);
  assert.equal(summary.recordsQueued, 0);
  assert.equal(summary.recordsConfirmed, 0);
  assert.equal(summary.recordsUnknown, 0);
  assert.equal(summary.recordsNotAttempted, 2);
  assert.equal(summary.recordsSkipped, 0);
  assert.equal(exporterCalls, 0);
});

test("/obs backfill cancellation during export attempts shutdown and reports partial summary", async () => {
  const notifications = [];
  const records = [];
  const config = cloneDefaultConfig();
  const controller = new AbortController();
  const ctx = {
    ...createContext([
      userEntry("a1", "2026-07-07T11:10:00.000Z", "one"),
      userEntry("a2", "2026-07-07T11:20:00.000Z", "two"),
    ], notifications),
    signal: controller.signal,
  };
  let emitCalls = 0;

  const summary = await runObsBackfill(ctx, {
    currentSession: true,
    since: "1h",
    sinceMs: 60 * 60 * 1000,
  }, {
    loadConfig: async () => config,
    createExporter: () => ({
      emit: (record, options) => {
        emitCalls += 1;
        if (emitCalls === 2) {
          controller.abort();
          return new Promise((resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
          });
        }

        records.push(record);
        return undefined;
      },
      shutdown: () => records.push({ shutdown: true }),
    }),
    now: () => now,
    maxRecords: 10,
    exportOperationTimeoutMs: 100,
  });

  assert.equal(summary.status, "cancelled");
  assert.equal(summary.reason, "operation cancelled");
  assert.equal(summary.entriesEligible, 2);
  assert.equal(summary.recordsAttempted, 2);
  assert.equal(summary.recordsQueued, 1);
  assert.equal(summary.recordsConfirmed, 0);
  assert.equal(summary.recordsUnknown, 2);
  assert.equal(summary.recordsNotAttempted, 0);
  assert.equal(summary.recordsSkipped, 0);
  assert.equal(records.filter(record => record.eventName).length, 1);
  assert.equal(records.at(-1).shutdown, true);
});

test("/obs backfill aborts timed-out emit work and preserves the original timeout", async () => {
  const notifications = [];
  const records = [];
  const config = cloneDefaultConfig();
  let emitSignalAborted = false;
  let shutdownCalls = 0;

  const summary = await runObsBackfill(createContext([userEntry("a1", "2026-07-07T11:30:00.000Z", "one")], notifications), {
    currentSession: true,
    since: "1h",
    sinceMs: 60 * 60 * 1000,
  }, {
    loadConfig: async () => config,
    createExporter: () => ({
      emit: (record, options) => new Promise(resolve => {
        options.signal.addEventListener("abort", () => {
          emitSignalAborted = options.signal.aborted;
          resolve();
        }, { once: true });
        setTimeout(() => {
          if (!options.signal.aborted) records.push(record);
          resolve();
        }, 30).unref?.();
      }),
      shutdown: () => {
        shutdownCalls += 1;
        throw new Error("shutdown should not mask emit timeout");
      },
    }),
    now: () => now,
    maxRecords: 10,
    exportOperationTimeoutMs: 10,
  });

  await delay(40);

  assert.equal(summary.status, "partial");
  assert.match(summary.reason, /export emit timed out/u);
  assert.equal(summary.recordsAttempted, 1);
  assert.equal(summary.recordsQueued, 0);
  assert.equal(summary.recordsConfirmed, 0);
  assert.equal(summary.recordsUnknown, 1);
  assert.equal(summary.recordsNotAttempted, 0);
  assert.equal(summary.recordsSkipped, 0);
  assert.equal(emitSignalAborted, true);
  assert.equal(shutdownCalls, 1);
  assert.equal(records.filter(record => record.eventName).length, 0);
});

test("/obs backfill aborts timed-out exporter setup and counts all records unexported", async () => {
  const notifications = [];
  const records = [];
  const config = cloneDefaultConfig();
  let setupSignalAborted = false;

  const summary = await runObsBackfill(createContext([
    userEntry("a1", "2026-07-07T11:20:00.000Z", "one"),
    userEntry("a2", "2026-07-07T11:30:00.000Z", "two"),
  ], notifications), {
    currentSession: true,
    since: "1h",
    sinceMs: 60 * 60 * 1000,
  }, {
    loadConfig: async () => config,
    createExporter: (_config, _ctx, options) => new Promise(resolve => {
      options.signal.addEventListener("abort", () => {
        setupSignalAborted = options.signal.aborted;
        resolve(createExporter(records));
      }, { once: true });
    }),
    now: () => now,
    maxRecords: 10,
    exportOperationTimeoutMs: 10,
  });

  assert.equal(summary.status, "partial");
  assert.match(summary.reason, /exporter setup timed out/u);
  assert.equal(summary.recordsAttempted, 0);
  assert.equal(summary.recordsQueued, 0);
  assert.equal(summary.recordsConfirmed, 0);
  assert.equal(summary.recordsUnknown, 0);
  assert.equal(summary.recordsNotAttempted, 2);
  assert.equal(summary.recordsSkipped, 0);
  assert.equal(setupSignalAborted, true);
  assert.equal(records.length, 0);
});

test("/obs backfill reports queued records as unknown when flush fails", async () => {
  const notifications = [];
  const records = [];
  const config = cloneDefaultConfig();
  let shutdownCalls = 0;

  const summary = await runObsBackfill(createContext([
    userEntry("a1", "2026-07-07T11:20:00.000Z", "one"),
    userEntry("a2", "2026-07-07T11:30:00.000Z", "two"),
  ], notifications), {
    currentSession: true,
    since: "1h",
    sinceMs: 60 * 60 * 1000,
  }, {
    loadConfig: async () => config,
    createExporter: () => ({
      emit: record => records.push(record),
      flush: () => {
        throw new Error("flush failed");
      },
      shutdown: () => {
        shutdownCalls += 1;
      },
    }),
    now: () => now,
    maxRecords: 10,
  });

  const rendered = renderObsBackfillSummary(summary);
  assert.equal(summary.status, "partial");
  assert.equal(summary.reason, "export flush failed");
  assert.equal(summary.recordsAttempted, 2);
  assert.equal(summary.recordsQueued, 2);
  assert.equal(summary.recordsConfirmed, 0);
  assert.equal(summary.recordsUnknown, 2);
  assert.equal(summary.recordsNotAttempted, 0);
  assert.equal(summary.recordsSkipped, 0);
  assert.match(rendered, /Records confirmed exported: 0/u);
  assert.match(rendered, /Records with unknown delivery: 2/u);
  assert.match(rendered, /retrying because replay may create duplicates/u);
  assert.doesNotMatch(rendered, /Records exported: 2/u);
  assert.equal(records.filter(record => record.eventName).length, 2);
  assert.equal(shutdownCalls, 1);
});

test("/obs backfill reports shutdown-only failures after successful emits", async () => {
  const notifications = [];
  const records = [];
  const config = cloneDefaultConfig();
  let shutdownCalls = 0;

  const summary = await runObsBackfill(createContext([userEntry("a1", "2026-07-07T11:30:00.000Z", "one")], notifications), {
    currentSession: true,
    since: "1h",
    sinceMs: 60 * 60 * 1000,
  }, {
    loadConfig: async () => config,
    createExporter: () => ({
      emit: record => records.push(record),
      flush: () => undefined,
      shutdown: () => {
        shutdownCalls += 1;
        throw new Error("shutdown failed");
      },
    }),
    now: () => now,
    maxRecords: 10,
  });

  const rendered = renderObsBackfillSummary(summary);
  assert.equal(summary.status, "partial");
  assert.equal(summary.reason, "export shutdown failed");
  assert.equal(summary.recordsAttempted, 1);
  assert.equal(summary.recordsQueued, 1);
  assert.equal(summary.recordsConfirmed, 1);
  assert.equal(summary.recordsUnknown, 0);
  assert.equal(summary.recordsNotAttempted, 0);
  assert.equal(summary.recordsSkipped, 0);
  assert.match(rendered, /do not replay them solely because exporter shutdown failed/u);
  assert.equal(shutdownCalls, 1);
});

test("/obs backfill exporter errors are reported without secret-bearing details", async () => {
  const notifications = [];
  const config = cloneDefaultConfig();
  const records = [];

  await handleObsBackfillCommand("backfill --current-session --since 1h", createContext([
    userEntry("a1", "2026-07-07T11:20:00.000Z", bearerToken),
    userEntry("a2", "2026-07-07T11:30:00.000Z", "not attempted"),
  ], notifications), {
    loadConfig: async () => config,
    createExporter: () => ({
      emit: () => {
        throw new Error(`collector failed for ${bearerToken} /tmp/private.env OBSERVME_TOKEN=secret prompt text`);
      },
      shutdown: () => records.push({ shutdown: true }),
    }),
    now: () => now,
    maxRecords: 10,
  });

  assert.equal(notifications.at(-1).type, "warning");
  assert.match(notifications.at(-1).message, /ObservMe backfill incomplete: export emit failed/u);
  assert.match(notifications.at(-1).message, /Records attempted: 1/u);
  assert.match(notifications.at(-1).message, /Records without queue acknowledgement: 1/u);
  assert.match(notifications.at(-1).message, /Records with unknown delivery: 1/u);
  assert.match(notifications.at(-1).message, /Records not attempted: 1/u);
  assert.match(notifications.at(-1).message, /inspect the destination before retrying because replay may create duplicates/u);
  assert.doesNotMatch(notifications.at(-1).message, /abc123|private\.env|OBSERVME_TOKEN|prompt text/u);
  assert.equal(records.at(-1).shutdown, true);
});

test("root obs command dispatches explicit backfill subcommand", async () => {
  const pi = {
    commands: new Map(),
    registerCommand: (name, options) => pi.commands.set(name, options),
  };
  registerObsCommand(pi, {
    backfill: {
      runBackfill: () => ({
        status: "completed",
        sessionId: "session-1",
        since: "1h",
        entriesScanned: 1,
        entriesEligible: 1,
        recordsAttempted: 1,
        recordsQueued: 1,
        recordsConfirmed: 1,
        recordsUnknown: 0,
        recordsNotAttempted: 0,
        recordsSkipped: 0,
        rateLimited: false,
        contentCaptured: false,
        redactionFailures: 0,
      }),
    },
  });

  const notifications = [];
  await pi.commands.get("obs").handler("backfill --current-session --since 1h", createContext([], notifications));

  assert.deepEqual(getObsRootCommandArgumentCompletions("ba"), [{ value: "backfill", label: "backfill" }]);
  assert.equal(notifications[0].type, "info");
  assert.match(notifications[0].message, /Backfilled session: session-1/u);
});
