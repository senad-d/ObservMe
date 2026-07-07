import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const extensionModule = await import(new URL("../src/extension.ts", import.meta.url));

test("package declares a Pi extension entry file", async () => {
  assert.deepEqual(packageJson.pi?.extensions, ["./src/extension.ts"]);
  await access(new URL("../src/extension.ts", import.meta.url));
});

test("extension default factory is named observme", () => {
  assert.equal(extensionModule.default.name, "observme");
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
