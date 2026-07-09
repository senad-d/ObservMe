import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { getObsRootCommandArgumentCompletions, registerObsCommand } from "../src/commands/obs.ts";
import {
  buildObsBackfillRecords,
  handleObsBackfillCommand,
  runObsBackfill,
} from "../src/commands/obs-backfill.ts";

const now = new Date("2026-07-07T12:00:00.000Z");
const bearerToken = `Authorization: Bearer ${"abc123._-".repeat(4)}`;
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
  assert.equal(summary.recordsExported, 0);
  assert.equal(records.length, 0);
  assert.equal(notifications[0].type, "confirm");
  assert.match(notifications[0].message, /observme\.replayed=true/u);
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
  assert.equal(summary.recordsExported, 1);
  assert.equal(exported.length, 1);
  assert.equal(exported[0].attributes["observme.replayed"], true);
  assert.match(exported[0].attributes["pi.llm.prompt.redacted"], /\[REDACTED:/u);
  assert.doesNotMatch(exported[0].attributes["pi.llm.prompt.redacted"], /abc123/u);
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

test("/obs backfill drops prompt, tool result, and bash output when redaction fails", () => {
  const previousSalt = process.env.OBSERVME_HASH_SALT;
  delete process.env.OBSERVME_HASH_SALT;

  try {
    const config = cloneDefaultConfig();
    config.capture.prompts = true;
    config.capture.toolResults = true;
    config.capture.bashOutput = true;

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
  } finally {
    if (previousSalt === undefined) delete process.env.OBSERVME_HASH_SALT;
    else process.env.OBSERVME_HASH_SALT = previousSalt;
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
        recordsExported: 0,
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
  assert.equal(summary.recordsExported, 0);
  assert.equal(records.length, 0);
  assert.equal(notifications.length, 0);
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
  assert.equal(summary.recordsExported, 1);
  assert.equal(summary.recordsSkipped, 1);
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

  assert.equal(summary.status, "cancelled");
  assert.match(summary.reason, /export emit timed out/u);
  assert.equal(summary.recordsExported, 0);
  assert.equal(summary.recordsSkipped, 1);
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

  assert.equal(summary.status, "cancelled");
  assert.match(summary.reason, /exporter setup timed out/u);
  assert.equal(summary.recordsExported, 0);
  assert.equal(summary.recordsSkipped, 2);
  assert.equal(setupSignalAborted, true);
  assert.equal(records.length, 0);
});

test("/obs backfill reports flush failures with emitted counts and one shutdown", async () => {
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

  assert.equal(summary.status, "cancelled");
  assert.equal(summary.reason, "export flush failed");
  assert.equal(summary.recordsExported, 2);
  assert.equal(summary.recordsSkipped, 0);
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

  assert.equal(summary.status, "cancelled");
  assert.equal(summary.reason, "export shutdown failed");
  assert.equal(summary.recordsExported, 1);
  assert.equal(summary.recordsSkipped, 0);
  assert.equal(shutdownCalls, 1);
});

test("/obs backfill exporter errors are reported without secret-bearing details", async () => {
  const notifications = [];
  const config = cloneDefaultConfig();
  const records = [];

  await handleObsBackfillCommand("backfill --current-session --since 1h", createContext([userEntry("a1", "2026-07-07T11:30:00.000Z", bearerToken)], notifications), {
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
  assert.match(notifications.at(-1).message, /ObservMe backfill cancelled: export emit failed/u);
  assert.match(notifications.at(-1).message, /Records not exported: 1/u);
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
        recordsExported: 1,
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
