import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("package declares a Pi extension entry file", async () => {
  assert.deepEqual(packageJson.pi?.extensions, ["./src/extension.ts"]);
  await access(new URL("../src/extension.ts", import.meta.url));
});

test("package keeps template rename instructions near project metadata until real features exist", () => {
  assert.equal(typeof packageJson._template?.comment, "string");
  assert.ok(packageJson._template.renameChecklist.some((item) => item.includes("Replace name")));
});

test("package metadata reflects the ObservMe project identity", () => {
  assert.equal(packageJson.name, "@senad-d/observme");
  assert.ok(packageJson.keywords.includes("pi-package"));
  assert.ok(packageJson.keywords.includes("observability"));
  assert.ok(packageJson.keywords.includes("opentelemetry"));
});
