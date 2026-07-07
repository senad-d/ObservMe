#!/usr/bin/env node
// Smoke check: verify package-level Pi extension discoverability and import the
// declared extension entry file.
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const packageJsonUrl = new URL("../package.json", import.meta.url);
const packageJson = JSON.parse(await readFile(packageJsonUrl, "utf8"));
const extensionEntries = packageJson.pi?.extensions ?? [];

assert.ok(Array.isArray(extensionEntries), "package pi.extensions must be an array");
assert.ok(extensionEntries.length > 0, "package must declare at least one Pi extension entry");

for (const entry of extensionEntries) {
  assert.equal(typeof entry, "string", "Pi extension entry must be a string");
  assert.ok(entry.startsWith("./src/"), `Pi extension entry ${entry} must stay inside src/`);
  const entryUrl = new URL(`../${entry.replace(/^\.\//, "")}`, import.meta.url);
  await access(entryUrl);
  const module = await import(entryUrl);
  assert.equal(typeof module.default, "function", `Pi extension entry ${entry} must export a default factory`);
}

console.log(`ObservMe discoverability smoke passed for ${extensionEntries.length} Pi extension entry file(s).`);
