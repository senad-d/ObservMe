import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const lifecycleSmokeScript = readFileSync(new URL("../scripts/smoke-pi-lifecycle.mjs", import.meta.url), "utf8");
const coverageScript = readFileSync(new URL("../scripts/test-coverage.mjs", import.meta.url), "utf8");
const gitignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");

test("Pi lifecycle smoke uses an explicit offline telemetry config", () => {
  assert.match(lifecycleSmokeScript, /createOfflineLifecycleConfig/u);
  assert.match(lifecycleSmokeScript, /traces:\s*\{\s*\.\.\.config\.traces,\s*enabled:\s*false\s*\}/u);
  assert.match(lifecycleSmokeScript, /metrics:\s*\{\s*\.\.\.config\.metrics,\s*enabled:\s*false\s*\}/u);
  assert.match(lifecycleSmokeScript, /logs:\s*\{\s*\.\.\.config\.logs,\s*enabled:\s*false\s*\}/u);
  assert.doesNotMatch(lifecycleSmokeScript, /otel-collector\.example\.com|grafana\.example\.com/u);
});

test("coverage generation writes only to ignored coverage artifacts", () => {
  assert.match(coverageScript, /coverage\/node-test-coverage\.txt/u);
  assert.match(coverageScript, /coverage\/lcov\.info/u);
  assert.match(gitignore, /^coverage\/$/mu);
});

test("coverage generation keeps Docker integration tests opt-in", () => {
  assert.match(coverageScript, /OBSERVME_INCLUDE_INTEGRATION_COVERAGE/u);
  assert.match(coverageScript, /isIntegrationTestPath/u);
});
