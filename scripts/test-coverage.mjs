#!/usr/bin/env node
// Coverage check: run the Node test runner with V8 coverage enabled, write the
// emitted text report, and generate SonarQube-readable LCOV output.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const includeIntegrationCoverage = process.env.OBSERVME_INCLUDE_INTEGRATION_COVERAGE === "1";

async function collectTestFiles(directory, options = { includeIntegration: false }) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && shouldCollectTestDirectory(path, options)) files.push(...(await collectTestFiles(path, options)));
    if (entry.isFile() && isTestFile(path)) files.push(path);
  }

  return files;
}

function shouldCollectTestDirectory(path, options) {
  return options.includeIntegration || !isIntegrationTestPath(path);
}

function isIntegrationTestPath(path) {
  return path.split(/[\\/]/u).includes("integration");
}

function isTestFile(path) {
  return path.endsWith(".test.mjs") || path.endsWith(".test.ts");
}

const testFiles = (await collectTestFiles("test", { includeIntegration: includeIntegrationCoverage })).sort((a, b) => a.localeCompare(b));
assert.ok(testFiles.length > 0, "coverage requires at least one test file");

const c8Bin = join("node_modules", "c8", "bin", "c8.js");
await access(c8Bin);

const nodeTestArgs = ["--experimental-test-coverage", "--test", ...testFiles];
const c8Args = [
  c8Bin,
  "--all",
  "--src",
  "src",
  "--include",
  "src/**/*.ts",
  "--reporter=lcovonly",
  "--report-dir=coverage",
  "--temp-directory=coverage/.tmp-c8",
  "--clean=true",
  process.execPath,
  ...nodeTestArgs,
];
const result = spawnSync(process.execPath, c8Args, { encoding: "utf8" });
const output = `${result.stdout}${result.stderr}`;

await mkdir("coverage", { recursive: true });
await writeFile(
  "coverage/node-test-coverage.txt",
  [`$ ${process.execPath} ${c8Args.join(" ")}`, "", output].join("\n"),
  "utf8",
);

if (result.status !== 0) {
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
} else {
  assert.ok(output.includes("start of coverage report"), "node test runner must emit a coverage report");
  await access("coverage/lcov.info");
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  console.log("Coverage reports written to coverage/node-test-coverage.txt and coverage/lcov.info.");
}
