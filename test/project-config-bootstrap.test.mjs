import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import {
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
    assert.match(text, /capture:\n {4}prompts: true/u);
    assert.match(text, /redactionEnabled: false/u);
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
