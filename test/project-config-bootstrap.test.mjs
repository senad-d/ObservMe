import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import {
  bootstrapProjectObservMeConfig,
  ensureProjectObservMeConfig,
  PROJECT_OBSERVME_YAML_TEMPLATE,
  registerProjectConfigBootstrap,
} from "../src/config/bootstrap-project-config.ts";
import {
  loadSessionConfigWithDiagnostics,
  parseObservMeConfigText,
} from "../src/config/load-config.ts";
import { registerHandlers } from "../src/pi/handlers.ts";

const anchoredCreateStallHelperPath = fileURLToPath(
  new URL("./fixtures/anchored-create-stall-helper.mjs", import.meta.url),
);
const anchoredCreateTestPhaseTimeoutMillis = 200;
const anchoredCreateTestShutdownTimeoutMillis = 50;

async function createTempProject() {
  return mkdtemp(join(tmpdir(), "observme-config-bootstrap-"));
}

async function removeTempProject(path) {
  await rm(path, { force: true, recursive: true });
}

function projectConfigPath(cwd) {
  return join(cwd, CONFIG_DIR_NAME, "observme.yaml");
}

function createStalledHelperHooks(cwd, phase, cleanupMode) {
  const pidFile = join(cwd, `anchored-helper-${phase}.pid`);
  return {
    pidFile,
    hooks: {
      anchoredCreateHelper: {
        modulePath: anchoredCreateStallHelperPath,
        arguments: cleanupMode ? [phase, pidFile, cleanupMode] : [phase, pidFile],
        phaseTimeoutMillis: anchoredCreateTestPhaseTimeoutMillis,
        shutdownStepTimeoutMillis: anchoredCreateTestShutdownTimeoutMillis,
      },
    },
  };
}

async function assertHelperWasReaped(pidFile) {
  const pid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.equal(isProcessRunning(pid), false, `anchored-create helper ${pid} was not reaped`);
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function createdSetupGuideMessage(path) {
  return `ObservMe created an inactive project setup guide at ${path}. Uncomment only settings you want to override.`;
}

function adoptGeneratedProjectOverrides() {
  return PROJECT_OBSERVME_YAML_TEMPLATE
    .replace("# observme:", "observme:")
    .replace("#   enabled: true", "  enabled: true")
    .replace("#   environment: development", "  environment: development")
    .replace("#   otlp:", "  otlp:")
    .replace("#     endpoint: http://localhost:4318", "    endpoint: http://localhost:4318")
    .replace("#     tls:", "    tls:")
    .replace("#       insecureSkipVerify: false", "      insecureSkipVerify: false");
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
    const configPath = projectConfigPath(cwd);
    const text = await readFile(configPath, "utf8");

    assert.deepEqual(result, { path: configPath, status: "created" });
    assert.equal(text, PROJECT_OBSERVME_YAML_TEMPLATE);
    assert.match(text, /inactive until explicitly adopted/u);
    assert.match(text, /^# observme:$/mu);
    assert.match(text, /^# {3}capture:$/mu);
    assert.match(text, /^# {5}prompts: false$/mu);
    assert.match(text, /^# {5}responses: false$/mu);
    assert.match(text, /^# {5}thinking: false$/mu);
    assert.match(text, /^# {5}toolArguments: false$/mu);
    assert.match(text, /^# {5}toolResults: false$/mu);
    assert.match(text, /^# {5}bashCommands: false$/mu);
    assert.match(text, /^# {5}bashOutput: false$/mu);
    assert.match(text, /^# {5}filePaths: false$/mu);
    assert.match(text, /^# {5}redactionEnabled: true$/mu);
    assert.match(text, /^# {5}allowUnsafeCapture: false$/mu);
    assert.match(text, /^# {5}activeAgentLeaseDurationMillis: 60000$/mu);
    assert.match(text, /^# {7}token: \$\{OBSERVME_GRAFANA_TOKEN\}$/mu);
    assert.deepEqual(parseObservMeConfigText(text), {}, "untouched guidance is not an active config layer");
  } finally {
    await removeTempProject(cwd);
  }
});

test("concurrent ensureProjectObservMeConfig calls create once and never overwrite", async () => {
  const cwd = await createTempProject();
  const configPath = projectConfigPath(cwd);
  const existing = "observme:\n  tenant: existing\n";

  try {
    const results = await Promise.all(
      Array.from({ length: 16 }, () => ensureProjectObservMeConfig({ cwd, isProjectTrusted: true })),
    );
    const statuses = results.map(result => result.status);

    assert.equal(statuses.filter(status => status === "created").length, 1);
    assert.equal(statuses.filter(status => status === "exists").length, 15);
    assert.ok(results.every(result => result.path === configPath));
    assert.equal(await readFile(configPath, "utf8"), PROJECT_OBSERVME_YAML_TEMPLATE);

    await writeFile(configPath, existing, "utf8");
    const existingResults = await Promise.all(
      Array.from({ length: 16 }, () => ensureProjectObservMeConfig({ cwd, isProjectTrusted: true })),
    );

    assert.ok(existingResults.every(result => result.status === "exists"));
    assert.equal(await readFile(configPath, "utf8"), existing);
  } finally {
    await removeTempProject(cwd);
  }
});

test("ensureProjectObservMeConfig never overwrites an existing project file", async () => {
  const cwd = await createTempProject();
  const configPath = projectConfigPath(cwd);
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

    assert.deepEqual(result, { path: projectConfigPath(cwd), status: "skipped_untrusted" });
    await assert.rejects(readFile(projectConfigPath(cwd), "utf8"), { code: "ENOENT" });
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

test("ensureProjectObservMeConfig rejects project config directory symlinks outside the project root", async () => {
  const cwd = await createTempProject();
  const outsideDirectory = await createTempProject();
  const outsideConfigPath = join(outsideDirectory, "observme.yaml");

  try {
    await symlink(outsideDirectory, join(cwd, CONFIG_DIR_NAME), "dir");
    await assert.rejects(
      ensureProjectObservMeConfig({ cwd, isProjectTrusted: true }),
      /Unsafe ObservMe project config path/u,
    );
    await assert.rejects(readFile(outsideConfigPath, "utf8"), { code: "ENOENT" });
  } finally {
    await Promise.all([removeTempProject(cwd), removeTempProject(outsideDirectory)]);
  }
});

test("ensureProjectObservMeConfig rejects project config file symlinks outside the project root", async () => {
  const cwd = await createTempProject();
  const outsideDirectory = await createTempProject();
  const outsideConfigPath = join(outsideDirectory, "outside-observme.yaml");
  const outsideContent = "observme:\n  tenant: outside\n";

  try {
    await mkdir(join(cwd, CONFIG_DIR_NAME));
    await writeFile(outsideConfigPath, outsideContent, "utf8");
    await symlink(outsideConfigPath, projectConfigPath(cwd), "file");

    await assert.rejects(
      ensureProjectObservMeConfig({ cwd, isProjectTrusted: true }),
      /Unsafe ObservMe project config path/u,
    );
    assert.equal(await readFile(outsideConfigPath, "utf8"), outsideContent);
  } finally {
    await Promise.all([removeTempProject(cwd), removeTempProject(outsideDirectory)]);
  }
});

test("ensureProjectObservMeConfig does not overwrite a target created after validation", async () => {
  const cwd = await createTempProject();
  const configPath = projectConfigPath(cwd);
  const existing = "observme:\n  tenant: concurrent-existing\n";

  try {
    const result = await ensureProjectObservMeConfig({
      cwd,
      isProjectTrusted: true,
      projectFileOperationHooks: {
        beforeOpen: writeFile.bind(undefined, configPath, existing, "utf8"),
      },
    });

    assert.deepEqual(result, { path: configPath, status: "exists" });
    assert.equal(await readFile(configPath, "utf8"), existing);
  } finally {
    await removeTempProject(cwd);
  }
});

test("ensureProjectObservMeConfig never creates an outside target when an ancestor changes before create", async () => {
  const cwd = await createTempProject();
  const outsideDirectory = await createTempProject();
  const configDirectory = join(cwd, CONFIG_DIR_NAME);
  const stableConfigDirectory = join(cwd, "stable-config");
  const outsideConfigPath = join(outsideDirectory, "observme.yaml");

  try {
    await mkdir(configDirectory);

    await assert.rejects(
      ensureProjectObservMeConfig({
        cwd,
        isProjectTrusted: true,
        projectFileOperationHooks: {
          beforeOpen: async () => {
            await rename(configDirectory, stableConfigDirectory);
            await symlink(outsideDirectory, configDirectory, "dir");
          },
        },
      }),
      /Unsafe ObservMe project config path/u,
    );

    await assert.rejects(readFile(outsideConfigPath, "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(join(stableConfigDirectory, "observme.yaml"), "utf8"), { code: "ENOENT" });
  } finally {
    await Promise.all([removeTempProject(cwd), removeTempProject(outsideDirectory)]);
  }
});

test("ensureProjectObservMeConfig leaves no outside inode when interrupted after an ancestor swap", async () => {
  const cwd = await createTempProject();
  const outsideDirectory = await createTempProject();
  const configDirectory = join(cwd, CONFIG_DIR_NAME);
  const stableConfigDirectory = join(cwd, "stable-interrupted-config");
  const outsideConfigPath = join(outsideDirectory, "observme.yaml");

  try {
    await mkdir(configDirectory);

    await assert.rejects(
      ensureProjectObservMeConfig({
        cwd,
        isProjectTrusted: true,
        projectFileOperationHooks: {
          beforeOpen: async () => {
            await rename(configDirectory, stableConfigDirectory);
            await symlink(outsideDirectory, configDirectory, "dir");
          },
          afterOpen: async () => {
            await assert.rejects(readFile(outsideConfigPath, "utf8"), { code: "ENOENT" });
            throw new Error("injected interruption after anchored open");
          },
        },
      }),
      /injected interruption after anchored open/u,
    );

    await assert.rejects(readFile(outsideConfigPath, "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(join(stableConfigDirectory, "observme.yaml"), "utf8"), { code: "ENOENT" });
  } finally {
    await Promise.all([removeTempProject(cwd), removeTempProject(outsideDirectory)]);
  }
});

test("ensureProjectObservMeConfig surfaces anchored cleanup failure without creating outside", async () => {
  const cwd = await createTempProject();
  const outsideDirectory = await createTempProject();
  const configDirectory = join(cwd, CONFIG_DIR_NAME);
  const stableConfigDirectory = join(cwd, "stable-cleanup-failure-config");
  const stableConfigPath = join(stableConfigDirectory, "observme.yaml");
  const outsideConfigPath = join(outsideDirectory, "observme.yaml");

  try {
    await mkdir(configDirectory);

    await assert.rejects(
      ensureProjectObservMeConfig({
        cwd,
        isProjectTrusted: true,
        projectFileOperationHooks: {
          beforeOpen: async () => {
            await rename(configDirectory, stableConfigDirectory);
            await symlink(outsideDirectory, configDirectory, "dir");
          },
          afterOpen: async () => {
            await assert.rejects(readFile(outsideConfigPath, "utf8"), { code: "ENOENT" });
            await rm(stableConfigPath);
            await mkdir(stableConfigPath);
            throw new Error("injected interruption before failed cleanup");
          },
        },
      }),
      /anchored file cleanup failed/u,
    );

    await assert.rejects(readFile(outsideConfigPath, "utf8"), { code: "ENOENT" });
  } finally {
    await Promise.all([removeTempProject(cwd), removeTempProject(outsideDirectory)]);
  }
});

test("anchored create bounds and reaps stalled ready, open, write, and commit phases", async () => {
  for (const phase of ["ready", "open", "write", "commit"]) {
    const cwd = await createTempProject();
    const fault = createStalledHelperHooks(cwd, phase);
    const startedAt = Date.now();

    try {
      await assert.rejects(
        ensureProjectObservMeConfig({
          cwd,
          isProjectTrusted: true,
          projectFileOperationHooks: fault.hooks,
        }),
        { code: "ETIMEDOUT" },
      );

      assert.ok(Date.now() - startedAt < 2_500, `${phase} phase did not settle within its owned bound`);
      await assert.rejects(readFile(projectConfigPath(cwd), "utf8"), { code: "ENOENT" });
      await assertHelperWasReaped(fault.pidFile);
    } finally {
      await removeTempProject(cwd);
    }
  }
});

test("anchored create bounds abort and cancel cleanup phases", async () => {
  for (const phase of ["abort", "cancel"]) {
    const cwd = await createTempProject();
    const fault = createStalledHelperHooks(cwd, phase);
    const injectedFailure = new Error(`injected ${phase} cleanup`);
    const phaseHook = phase === "abort" ? { afterOpen: () => { throw injectedFailure; } } : {
      beforeOpen: () => { throw injectedFailure; },
    };
    const startedAt = Date.now();

    try {
      await assert.rejects(
        ensureProjectObservMeConfig({
          cwd,
          isProjectTrusted: true,
          projectFileOperationHooks: { ...fault.hooks, ...phaseHook },
        }),
        injectedFailure,
      );

      assert.ok(Date.now() - startedAt < 2_500, `${phase} phase did not settle within its owned bound`);
      await assert.rejects(readFile(projectConfigPath(cwd), "utf8"), { code: "ENOENT" });
      await assertHelperWasReaped(fault.pidFile);
    } finally {
      await removeTempProject(cwd);
    }
  }
});

test("anchored create fails closed when timeout cleanup cannot be verified", async () => {
  const cwd = await createTempProject();
  const fault = createStalledHelperHooks(cwd, "write", "skip-cleanup");

  try {
    await assert.rejects(
      ensureProjectObservMeConfig({
        cwd,
        isProjectTrusted: true,
        projectFileOperationHooks: fault.hooks,
      }),
      error => {
        assert.equal(error.code, "OBSERVME_UNSAFE_PROJECT_PATH_CLEANUP_FAILED");
        assert.match(error.message, /anchored file cleanup failed/u);
        assert.doesNotMatch(error.message, new RegExp(cwd.replaceAll("/", "\\/"), "u"));
        return true;
      },
    );

    await assertHelperWasReaped(fault.pidFile);
    assert.equal(await readFile(projectConfigPath(cwd), "utf8"), "");
  } finally {
    await removeTempProject(cwd);
  }
});

test("serialized lifecycle work continues after an anchored helper timeout", async () => {
  const cwd = await createTempProject();
  const fault = createStalledHelperHooks(cwd, "ready");
  const pi = createFakePi();
  const lifecycleStarts = [];
  let ensureCalls = 0;

  try {
    registerHandlers(pi, {
      ensureProjectConfig: async options => {
        ensureCalls += 1;
        return ensureProjectObservMeConfig({
          ...options,
          projectFileOperationHooks: ensureCalls === 1 ? fault.hooks : undefined,
        });
      },
      loadConfig: async () => defaultObservMeConfig,
      startTelemetry: async () => {
        lifecycleStarts.push(ensureCalls);
        throw new Error("stop after bounded project bootstrap");
      },
      onHandlerError: () => undefined,
    });

    const context = createContext(cwd, true);
    const event = pi.events.find(entry => entry.eventName === "session_start");
    await Promise.all([
      event.handler({ reason: "startup" }, context),
      event.handler({ reason: "reload" }, context),
    ]);

    assert.equal(ensureCalls, 2);
    assert.deepEqual(lifecycleStarts, [1, 2]);
    assert.equal(await readFile(projectConfigPath(cwd), "utf8"), PROJECT_OBSERVME_YAML_TEMPLATE);
    await assertHelperWasReaped(fault.pidFile);
    const warning = context.notifications.find(notification => notification.level === "warning");
    assert.match(warning.message, /protocol timed out/u);
    assert.doesNotMatch(warning.message, new RegExp(cwd.replaceAll("/", "\\/"), "u"));
  } finally {
    await removeTempProject(cwd);
  }
});

test("ensureProjectObservMeConfig supports a project config directory symlink that stays in root", async () => {
  const cwd = await createTempProject();
  const inRootDirectory = join(cwd, "config-target");

  try {
    await mkdir(inRootDirectory);
    await symlink(inRootDirectory, join(cwd, CONFIG_DIR_NAME), "dir");

    const result = await ensureProjectObservMeConfig({ cwd, isProjectTrusted: true });

    assert.deepEqual(result, { path: projectConfigPath(cwd), status: "created" });
    assert.equal(await readFile(join(inRootDirectory, "observme.yaml"), "utf8"), PROJECT_OBSERVME_YAML_TEMPLATE);
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
      message: createdSetupGuideMessage(expectedPath),
      level: "info",
    },
  ]);
});

test("bootstrapProjectObservMeConfig preserves creation results when notifications throw or reject", async () => {
  const notificationFailures = [
    () => {
      throw new Error("notification failed");
    },
    () => Promise.reject(new Error("notification rejected")),
  ];
  const expected = { path: projectConfigPath("/workspace/demo"), status: "created" };

  for (const failNotification of notificationFailures) {
    const result = await bootstrapProjectObservMeConfig(
      {
        cwd: "/workspace/demo",
        isProjectTrusted: () => true,
        ui: { notify: failNotification },
      },
      { ensureProjectConfig: async () => expected },
    );

    assert.deepEqual(result, expected);
  }
});

test("bootstrapProjectObservMeConfig skips safely without trust or UI capabilities", async () => {
  const cwd = await createTempProject();

  try {
    const result = await bootstrapProjectObservMeConfig({ cwd });

    assert.deepEqual(result, { path: projectConfigPath(cwd), status: "skipped_untrusted" });
    await assert.rejects(readFile(projectConfigPath(cwd), "utf8"), { code: "ENOENT" });
  } finally {
    await removeTempProject(cwd);
  }
});

test("bootstrapProjectObservMeConfig skips untrusted project contexts without creating or notifying", async () => {
  const cwd = await createTempProject();

  try {
    const context = createContext(cwd, false);
    const result = await bootstrapProjectObservMeConfig(context);

    assert.deepEqual(result, { path: projectConfigPath(cwd), status: "skipped_untrusted" });
    assert.deepEqual(context.notifications, []);
    await assert.rejects(readFile(projectConfigPath(cwd), "utf8"), { code: "ENOENT" });
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
        return { path: projectConfigPath("/workspace/demo"), status: "created" };
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
      return { path: projectConfigPath("/workspace/demo"), status: "created" };
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
      message: createdSetupGuideMessage(projectConfigPath("/workspace/demo")),
      level: "info",
    },
  ]);
});

test("real lifecycle keeps global settings active until the generated project guide is edited", async () => {
  const cwd = await createTempProject();
  const globalConfigPath = join(cwd, "global-observme.yaml");
  const pi = createFakePi();
  const loadedConfigs = [];
  const telemetryStarts = [];

  try {
    await writeFile(
      globalConfigPath,
      [
        "observme:",
        "  enabled: false",
        "  environment: test",
        "  otlp:",
        "    endpoint: https://global.example.test:4318",
        "    tls:",
        "      insecureSkipVerify: true",
      ].join("\n"),
      "utf8",
    );

    registerHandlers(pi, {
      loadConfig: async options => {
        const loaded = await loadSessionConfigWithDiagnostics({
          ...options,
          env: {},
          globalConfigPath,
          loadEnvFile: false,
        });
        loadedConfigs.push(loaded);
        return loaded;
      },
      startTelemetry: async options => {
        telemetryStarts.push(options.config);
        throw new Error("stop after observing adopted project config");
      },
      onHandlerError: () => undefined,
    });

    const context = createContext(cwd, true);
    const event = pi.events.find(entry => entry.eventName === "session_start");

    await event.handler({ reason: "startup" }, context);
    await event.handler({ reason: "reload" }, context);

    assert.equal(loadedConfigs.length, 2);
    for (const loaded of loadedConfigs) {
      assert.equal(loaded.config.enabled, false);
      assert.equal(loaded.config.environment, "test");
      assert.equal(loaded.config.otlp.endpoint, "https://global.example.test:4318");
      assert.equal(loaded.config.otlp.tls.insecureSkipVerify, true);
      assert.equal(loaded.diagnostics.effectiveSource, "global");
    }
    assert.equal(telemetryStarts.length, 0, "global disablement remains effective on start and reload");
    assert.equal(await readFile(projectConfigPath(cwd), "utf8"), PROJECT_OBSERVME_YAML_TEMPLATE);
    assert.deepEqual(context.notifications, [
      { message: createdSetupGuideMessage(projectConfigPath(cwd)), level: "info" },
    ]);

    await writeFile(projectConfigPath(cwd), adoptGeneratedProjectOverrides(), "utf8");
    await event.handler({ reason: "reload" }, context);

    assert.equal(loadedConfigs.length, 3);
    assert.equal(loadedConfigs[2].diagnostics.effectiveSource, "trusted_project");
    assert.equal(loadedConfigs[2].config.enabled, true);
    assert.equal(loadedConfigs[2].config.environment, "development");
    assert.equal(loadedConfigs[2].config.otlp.endpoint, "http://localhost:4318");
    assert.equal(loadedConfigs[2].config.otlp.tls.insecureSkipVerify, false);
    assert.equal(telemetryStarts.length, 1, "edited project settings intentionally override global disablement");
  } finally {
    await removeTempProject(cwd);
  }
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
        path: projectConfigPath("/workspace/demo"),
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
      message: createdSetupGuideMessage(projectConfigPath("/workspace/demo")),
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
      observed.push(await readFile(projectConfigPath(cwd), "utf8"));
    });

    const context = createContext(cwd, true);

    for (const event of pi.events) await event.handler({ reason: "startup" }, context);

    assert.equal(observed.length, 1);
    assert.equal(observed[0], PROJECT_OBSERVME_YAML_TEMPLATE);
    assert.deepEqual(context.notifications, [
      {
        message: createdSetupGuideMessage(projectConfigPath(cwd)),
        level: "info",
      },
    ]);
  } finally {
    await removeTempProject(cwd);
  }
});
