#!/usr/bin/env node
// Smoke check: register the extension in a Pi API harness and execute one
// registered command so command handler paths fail fast during validation.
import assert from "node:assert/strict";
import { executeFirstCommand, executeFirstTool, loadRegisteredExtension } from "./smoke-pi-harness.mjs";

const harness = await loadRegisteredExtension();
const commandSmoke = await executeFirstCommand(harness);

assert.ok(commandSmoke.context.ui.notifications.length > 0, `command ${commandSmoke.name} should produce a user-visible result`);

let toolSummary = "no agent-facing tools registered";
if (harness.tools.size > 0) {
  const toolSmoke = await executeFirstTool(harness);
  assert.ok(Array.isArray(toolSmoke.result.content), `tool ${toolSmoke.name} should return content`);
  toolSummary = `tool ${toolSmoke.name} executed successfully`;
}

console.log(`Handler execution smoke passed: command ${commandSmoke.name} executed successfully; ${toolSummary}.`);
