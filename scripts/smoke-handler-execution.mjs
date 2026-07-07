#!/usr/bin/env node
// Smoke check: register the extension in a Pi API harness and execute one
// registered command and tool so handler paths fail fast during validation.
import assert from "node:assert/strict";
import { executeFirstCommand, executeFirstTool, loadRegisteredExtension } from "./smoke-pi-harness.mjs";

const harness = await loadRegisteredExtension();
const commandSmoke = await executeFirstCommand(harness);
const toolSmoke = await executeFirstTool(harness);

assert.ok(commandSmoke.context.ui.notifications.length > 0, `command ${commandSmoke.name} should produce a user-visible result`);
assert.ok(Array.isArray(toolSmoke.result.content), `tool ${toolSmoke.name} should return content`);

console.log(
  `Handler execution smoke passed: command ${commandSmoke.name} and tool ${toolSmoke.name} executed successfully.`,
);
