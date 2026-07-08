import assert from "node:assert/strict";
import test from "node:test";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { handleObsBackfillCommand } from "../src/commands/obs-backfill.ts";
import { handleObsHealthCommand } from "../src/commands/obs-health.ts";
import { handleObsTraceCommand } from "../src/commands/obs-trace.ts";
import {
  getObsRootCommandArgumentCompletions,
  getObsRootSubcommands,
  getObsRootUsage,
  registerObsCommand,
} from "../src/commands/obs.ts";

function createCommandContext(notifications) {
  return {
    cwd: "/workspace/demo",
    ui: {
      notify: (message, type) => notifications.push({ message, type }),
    },
    isProjectTrusted: () => false,
  };
}

function createFakeCommandPi() {
  const commands = new Map();
  return {
    commands,
    registerCommand: (name, options) => commands.set(name, options),
  };
}

function createRootDispatchOptions(calls) {
  return {
    status: { getStatus: () => recordObsStatus(calls) },
    health: { getHealth: () => recordObsHealth(calls) },
    session: { getSession: () => recordObsSession(calls) },
    cost: { getCost: () => recordObsCost(calls) },
    trace: { getTrace: (_ctx, request) => recordObsTrace(calls, "trace", request.scope) },
    tools: { getTools: () => recordObsTools(calls) },
    agents: { getAgents: () => recordObsAgents(calls) },
    backfill: { runBackfill: (_ctx, request) => recordObsBackfill(calls, request.since) },
    errors: { getErrors: () => recordObsErrors(calls) },
    logs: { getLogs: () => recordObsLogs(calls) },
    link: { getLink: (_ctx, request) => recordObsTrace(calls, "link", request.scope) },
  };
}

function recordObsStatus(calls) {
  calls.push("status");
  return { config: structuredClone(defaultObservMeConfig), queueDrops: 0 };
}

function recordObsHealth(calls) {
  calls.push("health");
  return { timeoutMs: 50, checks: [{ label: "Collector", kind: "service", status: "ok" }] };
}

function recordObsSession(calls) {
  calls.push("session");
  return { turns: 0, llmCalls: 0, toolCalls: 0, costUsd: 0 };
}

function recordObsCost(calls) {
  calls.push("cost");
  return { window: "24h", query: "cost-query", rows: [] };
}

function recordObsTrace(calls, subcommand, scope) {
  calls.push(subcommand);
  return {
    scope,
    source: "runtime",
    sessionId: "session-root",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    traceLink: "https://grafana.local/explore?trace=4bf92f3577b34da6a3ce929d0e0e4736",
  };
}

function recordObsTools(calls) {
  calls.push("tools");
  return { window: "1h", callQuery: "calls", failureQuery: "failures", calls: [], failures: [] };
}

function recordObsAgents(calls) {
  calls.push("agents");
  return {
    workflowId: "workflow-root",
    workflowRootAgentId: "agent-root",
    agentId: "agent-root",
    rootAgentId: "agent-root",
    role: "root",
    depth: 0,
    orphaned: false,
    sessionId: "session-root",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    activeChildren: 0,
    fanoutCount: 0,
    treeDepth: 0,
    treeWidth: 0,
    orphanCount: 0,
    children: [],
    waitJoinHints: [],
    aggregateQueries: [],
    aggregateRows: { spawned: [], fanoutP95: [], orphaned: [] },
    tempoSearchAttributes: {},
    traces: [],
  };
}

function recordObsBackfill(calls, since) {
  calls.push("backfill");
  return {
    status: "completed",
    sessionId: "session-root",
    since,
    entriesScanned: 0,
    entriesEligible: 0,
    recordsExported: 0,
    recordsSkipped: 0,
    rateLimited: false,
    contentCaptured: false,
    redactionFailures: 0,
  };
}

function recordObsErrors(calls) {
  calls.push("errors");
  return { window: "1h", query: "errors-query", maxLogs: 10, logs: [] };
}

function recordObsLogs(calls) {
  calls.push("logs");
  return { sessionId: "session-root", window: "1h", query: "logs-query", maxLogs: 10, logs: [] };
}

function obsRootArgsForSubcommand(subcommand) {
  if (subcommand === "backfill") return "backfill --current-session --since 1h";
  return subcommand;
}

test("root /obs parser reports unknown subcommands with usage and keeps completions stable", async () => {
  const pi = createFakeCommandPi();
  registerObsCommand(pi);

  const notifications = [];
  await pi.commands.get("obs").handler("unknown --flag", createCommandContext(notifications));

  assert.deepEqual(getObsRootCommandArgumentCompletions("tr"), [{ value: "trace", label: "trace" }]);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "warning");
  assert.match(notifications[0].message, /^Usage: \/obs <status\|health\|session\|cost\|trace\|tools\|agents\|backfill\|errors\|logs\|link>/u);
  assert.match(notifications[0].message, /Unknown subcommand: unknown\./u);
});

test("root /obs registry keeps usage, completions, and dispatch aligned", async () => {
  const pi = createFakeCommandPi();
  const calls = [];
  const notifications = [];
  const subcommands = getObsRootSubcommands();

  registerObsCommand(pi, createRootDispatchOptions(calls));
  const command = pi.commands.get("obs");

  assert.equal(getObsRootUsage(), `Usage: /obs <${subcommands.join("|")}>`);
  assert.equal(command.description, `Run ObservMe commands. ${getObsRootUsage()}`);
  assert.deepEqual(
    getObsRootCommandArgumentCompletions(""),
    subcommands.map(subcommand => ({ value: subcommand, label: subcommand })),
  );

  await command.handler("", createCommandContext(notifications));
  assert.deepEqual(calls, ["status"]);
  calls.length = 0;
  notifications.length = 0;

  for (const subcommand of subcommands) {
    await command.handler(obsRootArgsForSubcommand(subcommand), createCommandContext(notifications));
  }

  assert.deepEqual(calls, subcommands);
  assert.equal(notifications.length, subcommands.length);
  assert.equal(notifications.some(notification => notification.type === "error"), false);
});

test("simple /obs subcommands reject unknown extra arguments before resolving snapshots", async () => {
  const notifications = [];
  let snapshotCalls = 0;

  await handleObsHealthCommand("health --verbose", createCommandContext(notifications), {
    getHealth: () => {
      snapshotCalls += 1;
      throw new Error("should not resolve invalid health command");
    },
  });

  assert.equal(snapshotCalls, 0);
  assert.deepEqual(notifications, [{ message: "Usage: /obs health", type: "warning" }]);
});

test("/obs trace parser reports unknown options, missing values, and repeated options without querying", async () => {
  const notifications = [];
  let traceCalls = 0;
  const options = {
    getTrace: () => {
      traceCalls += 1;
      throw new Error("should not resolve invalid trace command");
    },
  };

  await handleObsTraceCommand("trace --bogus", createCommandContext(notifications), options);
  await handleObsTraceCommand("trace --session", createCommandContext(notifications), options);
  await handleObsTraceCommand("trace --session one --last-turn", createCommandContext(notifications), options);

  assert.equal(traceCalls, 0);
  assert.equal(notifications.length, 3);
  assert.ok(notifications.every(notification => notification.type === "warning"));
  assert.match(notifications[0].message, /^Usage: \/obs trace \[--last-turn\|--session <session-id>\]/u);
  assert.match(notifications[0].message, /Unknown option: --bogus\./u);
  assert.match(notifications[1].message, /Missing value for --session\./u);
  assert.match(notifications[2].message, /Repeated or conflicting option: --last-turn\./u);
});

test("/obs backfill parser reports unknown options, missing values, and repeated options without running replay", async () => {
  const notifications = [];
  let runCalls = 0;
  const options = {
    runBackfill: () => {
      runCalls += 1;
      throw new Error("should not run invalid backfill command");
    },
  };

  await handleObsBackfillCommand("backfill --bogus", createCommandContext(notifications), options);
  await handleObsBackfillCommand("backfill --current-session --since", createCommandContext(notifications), options);
  await handleObsBackfillCommand("backfill --current-session --since 1h --since 2h", createCommandContext(notifications), options);

  assert.equal(runCalls, 0);
  assert.equal(notifications.length, 3);
  assert.ok(notifications.every(notification => notification.type === "warning"));
  assert.ok(notifications.every(notification => notification.message.startsWith("Usage: /obs backfill --current-session --since 1h")));
  assert.match(notifications[0].message, /Unknown option: --bogus\./u);
  assert.match(notifications[1].message, /Missing value for --since\./u);
  assert.match(notifications[2].message, /Repeated option: --since\./u);
});
