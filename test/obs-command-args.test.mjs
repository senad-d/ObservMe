import assert from "node:assert/strict";
import test from "node:test";
import { handleObsBackfillCommand } from "../src/commands/obs-backfill.ts";
import { handleObsHealthCommand } from "../src/commands/obs-health.ts";
import { handleObsTraceCommand } from "../src/commands/obs-trace.ts";
import { getObsRootCommandArgumentCompletions, registerObsCommand } from "../src/commands/obs.ts";

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
