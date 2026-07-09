import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import {
  bootstrapProjectObservMeConfig,
  ensureProjectObservMeConfig,
  PROJECT_OBSERVME_YAML_TEMPLATE,
  registerProjectConfigBootstrap,
} from "../src/config/bootstrap-project-config.ts";
import { registerHandlers } from "../src/pi/handlers.ts";

async function createTempProject() {
  return mkdtemp(join(tmpdir(), "observme-config-bootstrap-"));
}

async function removeTempProject(path) {
  await rm(path, { force: true, recursive: true });
}

function createFakePi() {
  const events = [];
  return {
    events,
    on: (eventName, handler) => events.push({ eventName, handler }),
  };
}

function createContext(cwd, projectTrusted = true) {
  const notifications = [];
  return {
    cwd,
    notifications,
    isProjectTrusted: () => projectTrusted,
    ui: {
      notify: (message, level) => notifications.push({ message, level }),
    },
  };
}

test("ensureProjectObservMeConfig creates the trusted project starter file", async () => {
  const cwd = await createTempProject();

  try {
    const result = await ensureProjectObservMeConfig({ cwd, isProjectTrusted: true });
    const configPath = join(cwd, ".pi", "observme.yaml");
    const text = await readFile(configPath, "utf8");

    assert.deepEqual(result, { path: configPath, status: "created" });
    assert.equal(text, PROJECT_OBSERVME_YAML_TEMPLATE);
    assert.match(text, /capture:\n(?: {4}#.*\n){3} {4}prompts: false/u);
    assert.match(text, /responses: false/u);
    assert.match(text, /thinking: false/u);
    assert.match(text, /toolArguments: false/u);
    assert.match(text, /toolResults: false/u);
    assert.match(text, /bashCommands: false/u);
    assert.match(text, /bashOutput: false/u);
    assert.match(text, /filePaths: false/u);
    assert.match(text, /redactionEnabled: true/u);
    assert.match(text, /allowUnsafeCapture: false/u);
    assert.match(text, /token: \$\{OBSERVME_GRAFANA_TOKEN\}/u);
  } finally {
    await removeTempProject(cwd);
  }
});

test("ensureProjectObservMeConfig never overwrites an existing project file", async () => {
  const cwd = await createTempProject();
  const configPath = join(cwd, ".pi", "observme.yaml");
  const existing = "observme:\n  tenant: existing\n";

  try {
    await ensureProjectObservMeConfig({ cwd, isProjectTrusted: true });
    await writeFile(configPath, existing, "utf8");

    const result = await ensureProjectObservMeConfig({ cwd, isProjectTrusted: true });
    const text = await readFile(configPath, "utf8");

    assert.deepEqual(result, { path: configPath, status: "exists" });
    assert.equal(text, existing);
  } finally {
    await removeTempProject(cwd);
  }
});

test("ensureProjectObservMeConfig skips untrusted projects", async () => {
  const cwd = await createTempProject();

  try {
    const result = await ensureProjectObservMeConfig({ cwd, isProjectTrusted: false });

    assert.deepEqual(result, { path: join(cwd, ".pi", "observme.yaml"), status: "skipped_untrusted" });
    await assert.rejects(readFile(join(cwd, ".pi", "observme.yaml"), "utf8"), { code: "ENOENT" });
  } finally {
    await removeTempProject(cwd);
  }
});

test("ensureProjectObservMeConfig rejects traversal and absolute config directories", async () => {
  const cwd = await createTempProject();

  try {
    await assert.rejects(
      ensureProjectObservMeConfig({ cwd, configDirName: "../outside", isProjectTrusted: true }),
      /Unsafe ObservMe project config path/u,
    );
    await assert.rejects(
      ensureProjectObservMeConfig({ cwd, configDirName: join(cwd, "absolute-pi"), isProjectTrusted: true }),
      /Unsafe ObservMe project config path/u,
    );
    await assert.rejects(readFile(join(cwd, "..", "outside", "observme.yaml"), "utf8"), { code: "ENOENT" });
  } finally {
    await removeTempProject(cwd);
  }
});

test("bootstrapProjectObservMeConfig reports unsafe project paths without sensitive path details", async () => {
  const context = createContext("/workspace/private-demo", true);
  const result = await bootstrapProjectObservMeConfig(context, { configDirName: "../outside-secret" });

  assert.equal(result, undefined);
  assert.equal(context.notifications.length, 1);
  assert.equal(context.notifications[0].level, "warning");
  assert.match(context.notifications[0].message, /Unsafe ObservMe project config path/u);
  assert.doesNotMatch(context.notifications[0].message, /private-demo|outside-secret|workspace/u);
});

test("bootstrapProjectObservMeConfig centralizes project path, trust, and notification behavior", async () => {
  const context = createContext("/workspace/demo", true);
  const calls = [];
  const expectedPath = join(context.cwd, "custom-pi", "observme.yaml");

  const result = await bootstrapProjectObservMeConfig(context, {
    configDirName: "custom-pi",
    ensureProjectConfig: async options => {
      calls.push(options);
      return { path: expectedPath, status: "created" };
    },
  });

  assert.deepEqual(result, { path: expectedPath, status: "created" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, context.cwd);
  assert.equal(calls[0].configDirName, "custom-pi");
  assert.equal(calls[0].isProjectTrusted, context.isProjectTrusted);
  assert.deepEqual(context.notifications, [
    {
      message: `ObservMe created ${expectedPath}. Edit this file for custom setup.`,
      level: "info",
    },
  ]);
});

test("bootstrapProjectObservMeConfig skips safely without trust or UI capabilities", async () => {
  const cwd = await createTempProject();

  try {
    const result = await bootstrapProjectObservMeConfig({ cwd });

    assert.deepEqual(result, { path: join(cwd, ".pi", "observme.yaml"), status: "skipped_untrusted" });
    await assert.rejects(readFile(join(cwd, ".pi", "observme.yaml"), "utf8"), { code: "ENOENT" });
  } finally {
    await removeTempProject(cwd);
  }
});

test("bootstrapProjectObservMeConfig skips untrusted project contexts without creating or notifying", async () => {
  const cwd = await createTempProject();

  try {
    const context = createContext(cwd, false);
    const result = await bootstrapProjectObservMeConfig(context);

    assert.deepEqual(result, { path: join(cwd, ".pi", "observme.yaml"), status: "skipped_untrusted" });
    assert.deepEqual(context.notifications, []);
    await assert.rejects(readFile(join(cwd, ".pi", "observme.yaml"), "utf8"), { code: "ENOENT" });
  } finally {
    await removeTempProject(cwd);
  }
});

test("bootstrapProjectObservMeConfig skips automatic creation when Pi context has no cwd", async () => {
  const calls = [];
  const notifications = [];
  const result = await bootstrapProjectObservMeConfig(
    {
      isProjectTrusted: () => true,
      ui: {
        notify: (message, level) => notifications.push({ message, level }),
      },
    },
    {
      ensureProjectConfig: async options => {
        calls.push(options);
        return { path: "/workspace/demo/.pi/observme.yaml", status: "created" };
      },
    },
  );

  assert.equal(result, undefined);
  assert.deepEqual(calls, []);
  assert.deepEqual(notifications, []);
});

test("bootstrapProjectObservMeConfig sanitizes failure notifications", async () => {
  const context = createContext("/workspace/demo", true);
  const result = await bootstrapProjectObservMeConfig(context, {
    ensureProjectConfig: async () => {
      throw new Error(
        "Authorization: Bearer bootstrap-token password=bootstrap-password /Users/senad/private.env npm run secret OBSERVME_TOKEN=env-secret",
      );
    },
  });

  assert.equal(result, undefined);
  assert.equal(context.notifications.length, 1);
  assert.equal(context.notifications[0].level, "warning");
  assert.match(context.notifications[0].message, /ObservMe could not create the project config file/u);
  assert.doesNotMatch(
    context.notifications[0].message,
    /bootstrap-token|bootstrap-password|private\.env|npm run secret|env-secret/u,
  );
});

test("registerHandlers creates the project file before loading session config", async () => {
  const pi = createFakePi();
  const order = [];

  registerHandlers(pi, {
    ensureProjectConfig: async () => {
      order.push("ensure");
      return { path: "/workspace/demo/.pi/observme.yaml", status: "created" };
    },
    loadConfig: async () => {
      order.push("load");
      return defaultObservMeConfig;
    },
    startTelemetry: async () => {
      order.push("start");
      throw new Error("stop after config bootstrap");
    },
    onHandlerError: () => undefined,
  });

  const context = createContext("/workspace/demo", true);
  const event = pi.events.find(entry => entry.eventName === "session_start");

  await event.handler({ reason: "startup" }, context);

  assert.deepEqual(order, ["ensure", "load", "start"]);
  assert.deepEqual(context.notifications, [
    {
      message: "ObservMe created /workspace/demo/.pi/observme.yaml. Edit this file for custom setup.",
      level: "info",
    },
  ]);
});

test("registerHandlers bootstraps trusted project config on every Pi session_start reason", async () => {
  const pi = createFakePi();
  const calls = [];
  const reasons = ["startup", "reload", "new", "resume", "fork"];
  let currentReason;

  registerHandlers(pi, {
    ensureProjectConfig: async options => {
      const trusted = await options.isProjectTrusted();
      calls.push({ reason: currentReason, cwd: options.cwd, trusted });
      return {
        path: "/workspace/demo/.pi/observme.yaml",
        status: calls.length === 1 ? "created" : "exists",
      };
    },
    loadConfig: async () => defaultObservMeConfig,
    startTelemetry: async () => {
      throw new Error("stop after config bootstrap");
    },
    onHandlerError: () => undefined,
  });

  const context = createContext("/workspace/demo", true);
  const event = pi.events.find(entry => entry.eventName === "session_start");

  for (const reason of reasons) {
    currentReason = reason;
    await event.handler({ reason }, context);
  }

  assert.deepEqual(calls, reasons.map(reason => ({ reason, cwd: "/workspace/demo", trusted: true })));
  assert.deepEqual(context.notifications, [
    {
      message: "ObservMe created /workspace/demo/.pi/observme.yaml. Edit this file for custom setup.",
      level: "info",
    },
  ]);
});

test("registerProjectConfigBootstrap creates the file before later session_start handlers", async () => {
  const cwd = await createTempProject();
  const pi = createFakePi();
  const observed = [];

  try {
    registerProjectConfigBootstrap(pi);
    pi.on("session_start", async () => {
      observed.push(await readFile(join(cwd, ".pi", "observme.yaml"), "utf8"));
    });

    const context = createContext(cwd, true);

    for (const event of pi.events) await event.handler({ reason: "startup" }, context);

    assert.equal(observed.length, 1);
    assert.equal(observed[0], PROJECT_OBSERVME_YAML_TEMPLATE);
    assert.deepEqual(context.notifications, [
      {
        message: `ObservMe created ${join(cwd, ".pi", "observme.yaml")}. Edit this file for custom setup.`,
        level: "info",
      },
    ]);
  } finally {
    await removeTempProject(cwd);
  }
});
