#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const hiddenEnvironmentFilePattern = /^\.env(?:$|\.)/;

const forbiddenChecks = [
  { label: "environment files", test: (path) => hiddenEnvironmentFilePattern.test(path) },
  { label: "project-local pi state", test: (path) => path === ".pi" || path.startsWith(".pi/") },
  { label: "node_modules", test: (path) => path.startsWith("node_modules/") || path.includes("/node_modules/") },
  { label: "planning specs", test: (path) => path.startsWith("specs/") || path.includes("/specs/") },
  { label: "local caches", test: (path) => /(^|\/)(\.cache|\.local|\.trivycache)(\/|$)/.test(path) },
  { label: "generated reports", test: (path) => /(^|\/)(coverage|trivy-reports|odc-reports)(\/|$)/.test(path) },
  { label: "npm tarballs", test: (path) => path.endsWith(".tgz") },
  { label: "OS/editor files", test: (path) => path.endsWith(".DS_Store") || path.endsWith(".log") },
];

function readPackFiles() {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const output = execFileSync(npmCommand, ["pack", "--dry-run", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(output);
  const pack = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!pack || !Array.isArray(pack.files)) {
    throw new Error("Unexpected npm pack --dry-run --json output.");
  }
  return pack.files.map((file) => file.path).sort((a, b) => a.localeCompare(b));
}

const files = readPackFiles();
const violations = [];
for (const file of files) {
  for (const check of forbiddenChecks) {
    if (check.test(file)) violations.push({ file, label: check.label });
  }
}

console.log(`${pkg.name} package dry-run contains ${files.length} file(s).`);
for (const file of files) console.log(`- ${file}`);

if (violations.length > 0) {
  console.error("\nForbidden package contents detected:");
  for (const violation of violations) {
    console.error(`- ${violation.file} (${violation.label})`);
  }
  process.exitCode = 1;
}
