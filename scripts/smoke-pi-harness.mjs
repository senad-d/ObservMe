#!/usr/bin/env node
import assert from "node:assert/strict";

export class SmokePiHarness {
  constructor() {
    this.events = [];
    this.commands = new Map();
    this.tools = new Map();
    this.pi = {
      on: this.on.bind(this),
      registerCommand: this.registerCommand.bind(this),
      registerTool: this.registerTool.bind(this),
    };
  }

  on(name, handler) {
    assert.equal(typeof name, "string", "event name must be a string");
    assert.equal(typeof handler, "function", `event ${name} must provide a handler`);
    this.events.push({ name, handler });
  }

  registerCommand(name, definition) {
    assert.equal(typeof name, "string", "command name must be a string");
    assert.equal(typeof definition?.description, "string", `command ${name} must have a description`);
    assert.equal(typeof definition?.handler, "function", `command ${name} must provide a handler`);
    this.commands.set(name, definition);
  }

  registerTool(tool) {
    assert.equal(typeof tool?.name, "string", "tool name must be a string");
    assert.equal(typeof tool?.description, "string", `tool ${tool?.name ?? "unknown"} must have a description`);
    assert.equal(typeof tool?.execute, "function", `tool ${tool?.name ?? "unknown"} must provide execute`);
    this.tools.set(tool.name, tool);
  }

  eventNames() {
    return this.events.map(event => event.name);
  }
}

export class SmokeUi {
  constructor() {
    this.statuses = [];
    this.notifications = [];
  }

  setStatus(key, value) {
    this.statuses.push({ key, value });
  }

  notify(message, level) {
    this.notifications.push({ message, level });
  }
}

export function assertNonEmptyCollection(collection, label) {
  assert.ok(collection.size > 0 || collection.length > 0, `${label} must not be empty`);
}

export function createSmokeContext() {
  return { ui: new SmokeUi() };
}

export async function loadRegisteredExtension() {
  const extensionModule = await import(new URL("../src/extension.ts", import.meta.url));
  assert.equal(typeof extensionModule.default, "function", "extension must export a default factory function");

  const harness = new SmokePiHarness();
  extensionModule.default(harness.pi);
  return harness;
}

export async function invokeLifecycleEvent(harness, name, event = {}, context = createSmokeContext()) {
  const matches = harness.events.filter(registeredEvent => registeredEvent.name === name);
  assert.ok(matches.length > 0, `expected ${name} lifecycle handler to be registered`);

  for (const registeredEvent of matches) {
    await registeredEvent.handler(event, context);
  }

  return context;
}

export function sampleValueForSchema(schema) {
  if (!schema || typeof schema !== "object") return "smoke";
  if (schema.default !== undefined) return schema.default;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.type === "string") return "smoke";
  if (schema.type === "number" || schema.type === "integer") return 1;
  if (schema.type === "boolean") return true;
  if (schema.type === "array") return [];
  if (schema.type === "object") return sampleObjectForSchema(schema);
  return "smoke";
}

export function sampleObjectForSchema(schema) {
  const value = {};
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? Object.keys(properties));

  for (const [key, propertySchema] of Object.entries(properties)) {
    if (required.has(key)) value[key] = sampleValueForSchema(propertySchema);
  }

  return value;
}

export function ignoreToolUpdate() {}

export async function executeFirstCommand(harness) {
  assertNonEmptyCollection(harness.commands, "registered commands");
  const [name, command] = harness.commands.entries().next().value;
  const context = createSmokeContext();

  if (typeof command.getArgumentCompletions === "function") {
    const completions = await command.getArgumentCompletions("s");
    assert.ok(completions === null || Array.isArray(completions), `command ${name} completions must be null or an array`);
  }

  await command.handler("smoke", context);
  return { name, context };
}

export async function executeFirstTool(harness) {
  assertNonEmptyCollection(harness.tools, "registered tools");
  const [name, tool] = harness.tools.entries().next().value;
  const parameters = sampleObjectForSchema(tool.parameters);
  const context = createSmokeContext();
  const controller = new AbortController();
  const result = await tool.execute("smoke-tool-call", parameters, controller.signal, ignoreToolUpdate, context);

  assert.ok(result && typeof result === "object", `tool ${name} must return an object result`);
  return { name, result };
}
