import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createEventBus,
  discoverAndLoadExtensions,
  ExtensionRunner,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { OBSERVME_INTEGRATION_CHANNEL } from "../src/integration.ts";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const extensionModule = await import(new URL("../src/extension.ts", import.meta.url));
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const extensionPath = fileURLToPath(new URL("../src/extension.ts", import.meta.url));
const failingExtensionPath = fileURLToPath(
  new URL("./fixtures/extension-command-registration-failure.ts", import.meta.url),
);
const emptyAgentDirectory = fileURLToPath(new URL("./fixtures/empty-agent-directory", import.meta.url));

function createPiWithFailingCommandRegistration(error) {
  const commands = [];
  const events = [];

  return {
    commands,
    events,
    on(eventName, handler) {
      events.push({ eventName, handler });
    },
    appendEntry() {},
    getThinkingLevel() {
      return "medium";
    },
    registerCommand(name) {
      commands.push(name);
      throw error;
    },
  };
}

function captureThrownError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }

  assert.fail("Expected function to throw");
}

class TrackedPiEventBus {
  constructor() {
    this.delegate = createEventBus();
    this.listenerCounts = new Map();
  }

  emit(channel, data) {
    this.delegate.emit(channel, data);
  }

  on(channel, handler) {
    const subscription = { active: true, unsubscribe: this.delegate.on(channel, handler) };
    this.listenerCounts.set(channel, this.listenerCount(channel) + 1);
    return removeTrackedPiListener.bind(undefined, this, channel, subscription);
  }

  listenerCount(channel) {
    return this.listenerCounts.get(channel) ?? 0;
  }

  recordRemoval(channel) {
    const remaining = this.listenerCount(channel) - 1;
    if (remaining === 0) this.listenerCounts.delete(channel);
    else this.listenerCounts.set(channel, remaining);
  }
}

function removeTrackedPiListener(eventBus, channel, subscription) {
  if (!subscription.active) return;
  subscription.active = false;
  eventBus.recordRemoval(channel);
  subscription.unsubscribe();
}

function collectIntegrationResponses(eventBus) {
  const responses = [];
  eventBus.emit(OBSERVME_INTEGRATION_CHANNEL, {
    supportedVersions: [2, 1],
    respond: responses.push.bind(responses),
  });
  return responses;
}

test("package declares a Pi extension entry file", async () => {
  assert.deepEqual(packageJson.pi?.extensions, ["./src/extension.ts"]);
  await access(new URL("../src/extension.ts", import.meta.url));
});

test("extension default factory is named observme", () => {
  assert.equal(extensionModule.default.name, "observme");
});

test("production extension enables only the process-environment parent lineage boundary", async () => {
  const source = await readFile(new URL("../src/extension.ts", import.meta.url), "utf8");

  assert.match(source, /registerHandlers\(pi, \{ trustedParentContext: true \}\)/u);
  assert.match(source, /Only the Pi process environment is eligible/u);
});

test("extension capability preflight fails before partial registration", () => {
  const events = [];
  const pi = {
    on: (eventName, handler) => events.push({ eventName, handler }),
  };

  assert.throws(
    () => extensionModule.default(pi),
    /ObservMe\/Pi API capability error: ObservMe requires ExtensionAPI method\(s\): registerCommand\. Pi version is not used as a startup gate/u,
  );
  assert.deepEqual(events, []);
});

test("extension initialization reports partial command registration failures", () => {
  const registrationError = new Error("Pi command registry unavailable");
  const pi = createPiWithFailingCommandRegistration(registrationError);

  const error = captureThrownError(() => extensionModule.default(pi));

  assert.ok(error && typeof error === "object");
  assert.equal(error.cause, registrationError);
  assert.match(
    String(error.message),
    /ObservMe extension initialization failed while registering \/obs after Pi event handlers were already registered\./u,
  );
  assert.match(error.message, /rolled back its shared integration listener/u);
  assert.deepEqual(pi.commands, ["obs"]);
  assert.ok(pi.events.length > 0);
  assert.equal(pi.events[0].eventName, "session_start");
  assert.equal(typeof pi.events[0].handler, "function");
});

test("real Pi loader rolls back shared integration registration when command registration fails", async () => {
  const eventBus = new TrackedPiEventBus();
  const baselineListenerCount = eventBus.listenerCount(OBSERVME_INTEGRATION_CHANNEL);
  const successfulLoad = await discoverAndLoadExtensions(
    [extensionPath],
    projectRoot,
    emptyAgentDirectory,
    eventBus,
  );

  assert.deepEqual(successfulLoad.errors, []);
  assert.equal(successfulLoad.extensions.length, 1);
  assert.equal(eventBus.listenerCount(OBSERVME_INTEGRATION_CHANNEL), baselineListenerCount + 1);
  const successfulResponses = collectIntegrationResponses(eventBus);
  assert.equal(successfulResponses.length, 1);
  assert.deepEqual(successfulResponses[0].getContext(), { ok: false, reason: "session_unavailable" });

  const runner = new ExtensionRunner(
    successfulLoad.extensions,
    successfulLoad.runtime,
    projectRoot,
    SessionManager.inMemory(projectRoot),
    {},
  );
  await runner.emit({ type: "session_shutdown", reason: "quit" });

  assert.equal(eventBus.listenerCount(OBSERVME_INTEGRATION_CHANNEL), baselineListenerCount);
  assert.deepEqual(collectIntegrationResponses(eventBus), []);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const failedLoad = await discoverAndLoadExtensions(
      [failingExtensionPath],
      projectRoot,
      emptyAgentDirectory,
      eventBus,
    );

    assert.deepEqual(failedLoad.extensions, []);
    assert.equal(failedLoad.errors.length, 1);
    assert.match(failedLoad.errors[0].error, /failed while registering \/obs/u);
    assert.equal(eventBus.listenerCount(OBSERVME_INTEGRATION_CHANNEL), baselineListenerCount);
    assert.deepEqual(collectIntegrationResponses(eventBus), []);
  }
});

test("package metadata no longer includes template scaffolding instructions", () => {
  assert.equal(packageJson._template, undefined);
});

test("package metadata reflects the ObservMe project identity", () => {
  assert.equal(packageJson.name, "@senad-d/observme");
  assert.ok(packageJson.keywords.includes("pi-package"));
  assert.ok(packageJson.keywords.includes("observability"));
  assert.ok(packageJson.keywords.includes("opentelemetry"));
});
