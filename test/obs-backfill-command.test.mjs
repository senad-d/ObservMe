import assert from "node:assert/strict";
import test from "node:test";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { getObsRootCommandArgumentCompletions, registerObsCommand } from "../src/commands/obs.ts";
import {
  buildObsBackfillRecords,
  runObsBackfill,
} from "../src/commands/obs-backfill.ts";

const now = new Date("2026-07-07T12:00:00.000Z");
const bearerToken = `Authorization: Bearer ${"abc123._-".repeat(4)}`;

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
