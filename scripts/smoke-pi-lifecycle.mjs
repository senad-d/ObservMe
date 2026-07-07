#!/usr/bin/env node
// Smoke check: register the extension in a Pi API harness and execute the
// session_start/session_shutdown lifecycle handlers without a real Pi process.
import assert from "node:assert/strict";
import { createSmokeContext, invokeLifecycleEvent, loadRegisteredExtension } from "./smoke-pi-harness.mjs";

const harness = await loadRegisteredExtension();
const eventNames = harness.eventNames();

assert.ok(eventNames.includes("session_start"), "session_start handler must be registered");
assert.ok(eventNames.includes("session_shutdown"), "session_shutdown handler must be registered");

const context = createSmokeContext();
await invokeLifecycleEvent(harness, "session_start", { smoke: true }, context);
await invokeLifecycleEvent(harness, "session_shutdown", { smoke: true }, context);

assert.ok(context.ui.statuses.length >= 2, "lifecycle handlers should update visible Pi status state");
assert.equal(context.ui.statuses.at(-1)?.value, undefined, "session_shutdown should clear extension status");

console.log("Pi lifecycle smoke passed: session_start and session_shutdown handlers executed successfully.");
