#!/usr/bin/env node
// Smoke check: create one real npm tarball, install it into isolated parent and
// child projects, then verify package resources plus v2 parent/child identity compatibility.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const repositoryRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
const workspace = await mkdtemp(join(tmpdir(), "observme-packaged-install-"));
const parentDirectory = join(workspace, "parent");
const childDirectory = join(workspace, "child");
const packageRelativePath = join("node_modules", "@senad-d", "observme");
const parentPackageRoot = join(parentDirectory, packageRelativePath);
const childPackageRoot = join(childDirectory, packageRelativePath);
const parentRunnerPath = join(parentDirectory, "parent-smoke.mjs");
const childRunnerPath = join(childDirectory, "child-smoke.mjs");
const smokeHarnessPath = "smoke-harness.mjs";
const smokeConfig = `observme:
  enabled: true
  environment: development
  traces:
    enabled: false
  metrics:
    enabled: false
  logs:
    enabled: false
  query:
    enabled: false
`;
const smokeHarnessSource = `export class SmokeEventBus {
  #handlers = new Map();

  on(channel, handler) {
    const handlers = this.#handlers.get(channel) ?? [];
    handlers.push(handler);
    this.#handlers.set(channel, handlers);
    return this.unsubscribe.bind(this, channel, handler);
  }

  emit(channel, data) {
    const handlers = this.#handlers.get(channel) ?? [];
    for (const handler of [...handlers]) handler(data);
  }

  unsubscribe(channel, handler) {
    const handlers = this.#handlers.get(channel) ?? [];
    this.#handlers.set(channel, handlers.filter(candidate => candidate !== handler));
  }
}

export class SmokePiHarness {
  constructor() {
    this.handlers = new Map();
    this.commands = new Map();
    this.events = new SmokeEventBus();
    this.pi = {
      on: this.on.bind(this),
      registerCommand: this.registerCommand.bind(this),
      appendEntry: this.appendEntry.bind(this),
      getThinkingLevel: this.getThinkingLevel.bind(this),
      events: this.events,
    };
  }

  on(name, handler) {
    const handlers = this.handlers.get(name) ?? [];
    handlers.push(handler);
    this.handlers.set(name, handlers);
  }

  registerCommand(name, definition) {
    this.commands.set(name, definition);
  }

  appendEntry() {}

  getThinkingLevel() {
    return "medium";
  }

  async emitLifecycle(name, event, context) {
    const handlers = this.handlers.get(name) ?? [];
    for (const handler of handlers) await handler(event, context);
  }
}

export class SmokeUi {
  setStatus() {}

  notify() {}
}

export class SmokeContext {
  constructor(cwd) {
    this.cwd = cwd;
    this.hasUI = false;
    this.ui = new SmokeUi();
  }

  isProjectTrusted() {
    return true;
  }
}
`;

function localPackageDirectory(packageName) {
  return join(repositoryRoot, "node_modules", ...packageName.split("/"));
}

function installPackedArtifact(projectDirectory, tarballPath, peerDirectories) {
  execFileSync(npmCommand, ["init", "-y"], { cwd: projectDirectory, stdio: "pipe" });
  execFileSync(
    npmCommand,
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--legacy-peer-deps",
      "--install-links=true",
      tarballPath,
      ...peerDirectories,
    ],
    { cwd: projectDirectory, stdio: "pipe" },
  );
}

function createIsolatedParentEnvironment() {
  const environment = {
    HOME: parentDirectory,
    USERPROFILE: parentDirectory,
    TMPDIR: workspace,
    TEMP: workspace,
    TMP: workspace,
  };
  const systemKeys = ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"];

  for (const key of systemKeys) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return environment;
}

function createParentRunnerSource() {
  return `import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { SmokeContext, SmokePiHarness } from "./${smokeHarnessPath}";

const parentDirectory = ${JSON.stringify(parentDirectory)};
const childDirectory = ${JSON.stringify(childDirectory)};
const childRunnerPath = ${JSON.stringify(childRunnerPath)};
const packageRoot = realpathSync(fileURLToPath(new URL("./${packageRelativePath}/", import.meta.url)));
const extensionPath = realpathSync(join(packageRoot, "src", "extension.ts"));
const resolvedExtension = realpathSync(fileURLToPath(import.meta.resolve("@senad-d/observme")));
assert.equal(resolvedExtension, extensionPath);

const jiti = createJiti(import.meta.url);
const observme = await jiti.import(extensionPath, { default: true });
const integration = await jiti.import(join(packageRoot, "src", "integration.ts"));
const { OBSERVME_CHILD_IDENTITY_ENVELOPE_VERSION, requestObservMeIntegrationV2 } = integration;
const harness = new SmokePiHarness();
observme(harness.pi);
const context = new SmokeContext(parentDirectory);
await harness.emitLifecycle("session_start", { type: "session_start", reason: "startup" }, context);

const api = requestObservMeIntegrationV2({ events: harness.events });
assert.ok(api, "packed parent should negotiate ObservMe integration API v2");
assert.equal(api.childIdentityEnvelopeVersion, OBSERVME_CHILD_IDENTITY_ENVELOPE_VERSION);

const descriptor = Object.freeze({
  displayName: "Packed child",
  role: "worker",
  capability: "code-search",
});
const staleParentIdentity = {
  displayName: "Stale parent",
  role: "lead",
  capability: "parent-capability",
};
const childBaseEnvironment = {
  HOME: childDirectory,
  USERPROFILE: childDirectory,
  TMPDIR: childDirectory,
  TEMP: childDirectory,
  TMP: childDirectory,
  OBSERVME_CHILD_IDENTITY_ENVELOPE_VERSION: "99",
  OBSERVME_AGENT_DISPLAY_NAME: staleParentIdentity.displayName,
  OBSERVME_AGENT_ROLE: staleParentIdentity.role,
  OBSERVME_AGENT_CAPABILITY: staleParentIdentity.capability,
};
for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) {
  if (process.env[key]) childBaseEnvironment[key] = process.env[key];
}

const started = api.startSubagent({
  spawnId: "packed-parent-child-smoke",
  childAgentId: "packed-child-agent",
  command: process.execPath,
  args: [childRunnerPath],
  spawnType: "extension",
  spawnReason: "delegated_task",
  env: childBaseEnvironment,
  child: descriptor,
});
assert.equal(started.ok, true, "packed parent should start v2 child telemetry");
assert.equal(started.env.OBSERVME_CHILD_IDENTITY_ENVELOPE_VERSION, String(OBSERVME_CHILD_IDENTITY_ENVELOPE_VERSION));
assert.equal(started.env.OBSERVME_AGENT_DISPLAY_NAME, descriptor.displayName);
assert.equal(started.env.OBSERVME_AGENT_ROLE, descriptor.role);
assert.equal(started.env.OBSERVME_AGENT_CAPABILITY, descriptor.capability);
assert.notEqual(started.env.OBSERVME_AGENT_DISPLAY_NAME, staleParentIdentity.displayName);
assert.notEqual(started.env.OBSERVME_AGENT_ROLE, staleParentIdentity.role);
assert.notEqual(started.env.OBSERVME_AGENT_CAPABILITY, staleParentIdentity.capability);

const childEnvironment = Object.fromEntries(
  Object.entries(started.env).filter(entry => typeof entry[1] === "string"),
);
const childOutput = execFileSync(process.execPath, [childRunnerPath], {
  cwd: childDirectory,
  env: childEnvironment,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
const childReport = JSON.parse(childOutput);
assert.deepEqual(childReport, {
  "pi.agent.display_name": descriptor.displayName,
  "pi.agent.role": descriptor.role,
  "pi.agent.capability": descriptor.capability,
});

const completed = api.completeSubagent(started.spawnId, {
  childAgentId: started.childAgentId,
  childStatus: "completed",
});
assert.equal(completed.ok, true);
await harness.emitLifecycle("session_shutdown", { type: "session_shutdown", reason: "exit" }, context);
`;
}

function createChildRunnerSource() {
  return `import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { SmokeContext, SmokePiHarness } from "./${smokeHarnessPath}";

const childDirectory = ${JSON.stringify(childDirectory)};
const packageRoot = realpathSync(fileURLToPath(new URL("./${packageRelativePath}/", import.meta.url)));
const extensionPath = realpathSync(join(packageRoot, "src", "extension.ts"));
const resolvedExtension = realpathSync(fileURLToPath(import.meta.resolve("@senad-d/observme")));
assert.equal(resolvedExtension, extensionPath);

const jiti = createJiti(import.meta.url);
const observme = await jiti.import(extensionPath, { default: true });
const agentsRuntime = await jiti.import(join(packageRoot, "src", "commands", "obs-agents-runtime.ts"));
const agentLineage = await jiti.import(join(packageRoot, "src", "pi", "agent-lineage.ts"));
const attributesModule = await jiti.import(join(packageRoot, "src", "semconv", "attributes.ts"));
const { getLocalObsAgentsRuntimeSnapshot } = agentsRuntime;
const { buildLineageAttributes } = agentLineage;
const { AGENT_LINEAGE_ATTRIBUTES, RESOURCE_ATTRIBUTES } = attributesModule;
const harness = new SmokePiHarness();
observme(harness.pi);
const context = new SmokeContext(childDirectory);
await harness.emitLifecycle("session_start", { type: "session_start", reason: "startup" }, context);

const lineage = getLocalObsAgentsRuntimeSnapshot().lineage;
assert.ok(lineage, "explicitly loaded packed child extension should start one lineage");
const attributes = buildLineageAttributes(lineage);
const report = {
  [RESOURCE_ATTRIBUTES.PI_AGENT_DISPLAY_NAME]: attributes[RESOURCE_ATTRIBUTES.PI_AGENT_DISPLAY_NAME],
  [RESOURCE_ATTRIBUTES.PI_AGENT_ROLE]: attributes[RESOURCE_ATTRIBUTES.PI_AGENT_ROLE],
  [AGENT_LINEAGE_ATTRIBUTES.PI_AGENT_CAPABILITY]: attributes[AGENT_LINEAGE_ATTRIBUTES.PI_AGENT_CAPABILITY],
};
for (const value of Object.values(report)) assert.equal(typeof value, "string");

await harness.emitLifecycle("session_shutdown", { type: "session_shutdown", reason: "exit" }, context);
process.stdout.write(JSON.stringify(report));
`;
}

try {
  await Promise.all([mkdir(parentDirectory), mkdir(childDirectory)]);
  execFileSync(npmCommand, ["pack", "--pack-destination", workspace], {
    cwd: repositoryRoot,
    stdio: "pipe",
  });
  const tarballName = `${packageJson.name.replace("/", "-").replace("@", "")}-${packageJson.version}.tgz`;
  const tarballPath = join(workspace, tarballName);
  const peerDirectories = Object.keys(packageJson.peerDependencies ?? {}).map(localPackageDirectory);
  const jitiDirectory = join(
    localPackageDirectory("@earendil-works/pi-coding-agent"),
    "node_modules",
    "jiti",
  );
  const runtimePackageDirectories = [...peerDirectories, jitiDirectory];

  for (const packageDirectory of runtimePackageDirectories) {
    await readFile(join(packageDirectory, "package.json"), "utf8");
  }
  installPackedArtifact(parentDirectory, tarballPath, runtimePackageDirectories);
  installPackedArtifact(childDirectory, tarballPath, runtimePackageDirectories);

  const installedPackageJsonPath = join(parentPackageRoot, "package.json");
  const installedPackageJson = JSON.parse(await readFile(installedPackageJsonPath, "utf8"));
  const childInstalledPackageJson = JSON.parse(await readFile(join(childPackageRoot, "package.json"), "utf8"));
  const extensionEntries = installedPackageJson.pi?.extensions ?? [];
  const skillEntries = installedPackageJson.pi?.skills ?? [];

  assert.equal(installedPackageJson.name, packageJson.name, "installed package name should match package.json");
  assert.equal(installedPackageJson.version, packageJson.version, "installed parent package version should match package.json");
  assert.equal(childInstalledPackageJson.name, packageJson.name, "installed child package name should match package.json");
  assert.equal(childInstalledPackageJson.version, packageJson.version, "installed child package version should match package.json");
  assert.notEqual(await realpath(parentPackageRoot), await realpath(childPackageRoot), "parent and child package roots must be isolated");
  assert.deepEqual(extensionEntries, packageJson.pi.extensions, "installed Pi extension entries should match package.json");
  assert.deepEqual(skillEntries, packageJson.pi.skills, "installed Pi skill entries should match package.json");
  assert.equal(installedPackageJson.exports?.["./integration"], "./src/integration.ts", "installed integration export should be declared");

  for (const entry of extensionEntries) {
    const relativeEntry = entry.replace(/^\.\//, "");
    await readFile(join(parentPackageRoot, relativeEntry), "utf8");
    await readFile(join(childPackageRoot, relativeEntry), "utf8");
  }

  await readFile(join(parentPackageRoot, "skills", "observme-docs", "SKILL.md"), "utf8");
  await readFile(join(parentPackageRoot, "src", "integration.ts"), "utf8");
  await readFile(join(parentPackageRoot, "examples", "integrations", "subagent-runner.ts"), "utf8");

  for (const projectDirectory of [parentDirectory, childDirectory]) {
    await mkdir(join(projectDirectory, ".pi"));
    await writeFile(join(projectDirectory, ".pi", "observme.yaml"), smokeConfig);
    await writeFile(join(projectDirectory, smokeHarnessPath), smokeHarnessSource);
  }
  await writeFile(parentRunnerPath, createParentRunnerSource());
  await writeFile(childRunnerPath, createChildRunnerSource());

  execFileSync(process.execPath, [parentRunnerPath], {
    cwd: parentDirectory,
    env: createIsolatedParentEnvironment(),
    stdio: "pipe",
  });

  console.log(
    `Packaged install and isolated parent/child envelope smoke passed for ${packageJson.name}@${packageJson.version}.`,
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}
