#!/usr/bin/env node
// Coverage check: run the Node test runner with V8 coverage enabled and write
// the emitted coverage report to coverage/node-test-coverage.txt.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function collectTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectTestFiles(path)));
    if (entry.isFile() && (entry.name.endsWith(".test.mjs") || entry.name.endsWith(".test.ts"))) files.push(path);
  }

  return files;
}

const testFiles = (await collectTestFiles("test")).sort((a, b) => a.localeCompare(b));
assert.ok(testFiles.length > 0, "coverage requires at least one test file");

const args = ["--experimental-test-coverage", "--test", ...testFiles];
const result = spawnSync(process.execPath, args, { encoding: "utf8" });
const output = `${result.stdout}${result.stderr}`;

await mkdir("coverage", { recursive: true });
await writeFile(
  "coverage/node-test-coverage.txt",
  [`$ ${process.execPath} ${args.join(" ")}`, "", output].join("\n"),
  "utf8",
);

if (result.status !== 0) {
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
} else {
  assert.ok(output.includes("start of coverage report"), "node test runner must emit a coverage report");
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  console.log("Coverage report written to coverage/node-test-coverage.txt.");
}
