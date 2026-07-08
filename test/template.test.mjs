import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const extensionModule = await import(new URL("../src/extension.ts", import.meta.url));

function createPiWithFailingCommandRegistration(error) {
  const commands = [];
  const events = [];

  return {
    commands,
    events,
    on(eventName, handler) {
      events.push({ eventName, handler });
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

test("package declares a Pi extension entry file", async () => {
  assert.deepEqual(packageJson.pi?.extensions, ["./src/extension.ts"]);
  await access(new URL("../src/extension.ts", import.meta.url));
});

test("extension default factory is named observme", () => {
  assert.equal(extensionModule.default.name, "observme");
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
  assert.match(error.message, /Pi ExtensionAPI does not expose unregister hooks for event handlers or slash commands/u);
  assert.deepEqual(pi.commands, ["obs"]);
  assert.ok(pi.events.length > 0);
  assert.equal(pi.events[0].eventName, "session_start");
  assert.equal(typeof pi.events[0].handler, "function");
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
