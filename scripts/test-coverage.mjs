#!/usr/bin/env node
// Coverage check: run the Node test runner with V8 coverage enabled, write the
// emitted text report, and generate SonarQube-readable LCOV output.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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

function readLcovMetric(report, metric) {
  return [...report.matchAll(new RegExp(`^${metric}:(\\d+)$`, "gmu"))].reduce(
    (total, match) => total + Number(match[1]),
    0,
  );
}

async function assertSonarCoverage(reportPath) {
  const report = await readFile(reportPath, "utf8");
  const covered = readLcovMetric(report, "LH") + readLcovMetric(report, "BRH");
  const coverable = readLcovMetric(report, "LF") + readLcovMetric(report, "BRF");
  assert.ok(coverable > 0, "coverage report must contain coverable lines or conditions");

  const coverage = (covered / coverable) * 100;
  assert.ok(coverage > 80, `Sonar coverage must be above 80% (received ${coverage.toFixed(2)}%)`);
  return coverage;
}

const testFiles = (await collectTestFiles("test", { includeIntegration: includeIntegrationCoverage })).sort((a, b) => a.localeCompare(b));
assert.ok(testFiles.length > 0, "coverage requires at least one test file");

const c8Bin = join("node_modules", "c8", "bin", "c8.js");
await access(c8Bin);

const nodeTestArgs = ["--test", ...testFiles];
const c8Args = [
  c8Bin,
  "--experimental-monocart",
  "--src",
  "src",
  "--include",
  "src/**/*.ts",
  "--include",
  "src/**/*.mjs",
  "--reporter=console-summary",
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
  const lcovPath = "coverage/lcov.info";
  await access(lcovPath);
  const sonarCoverage = await assertSonarCoverage(lcovPath);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  console.log(`Sonar coverage: ${sonarCoverage.toFixed(2)}%.`);
  console.log("Coverage reports written to coverage/node-test-coverage.txt and coverage/lcov.info.");
}
