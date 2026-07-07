#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const hiddenEnvironmentFilePattern = /(^|\/)\.env(?:$|\.)/u;
const secretMaterialFilePattern = /(?:^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:pem|key|p12|pfx|jks|keystore))(?:$|\/)$/iu;
const secretDirectoryPattern = /(^|\/)(?:secrets?|credentials?)(?:\/|$)/iu;
const allowedEnvironmentExampleFiles = new Set([".env.example"]);

const forbiddenChecks = [
  { label: "environment files", test: path => hiddenEnvironmentFilePattern.test(path) && !allowedEnvironmentExampleFiles.has(fileName(path)) },
  { label: "secret material", test: path => secretMaterialFilePattern.test(path) || secretDirectoryPattern.test(path) },
  { label: "project-local pi state", test: path => path === ".pi" || path.startsWith(".pi/") },
  { label: "node_modules", test: path => path.startsWith("node_modules/") || path.includes("/node_modules/") },
  { label: "planning specs", test: path => path.startsWith("specs/") || path.includes("/specs/") },
  { label: "local caches", test: path => /(^|\/)(\.cache|\.local|\.trivycache)(\/|$)/u.test(path) },
  { label: "generated reports", test: path => /(^|\/)(coverage|trivy-reports|odc-reports)(\/|$)/u.test(path) },
  { label: "npm tarballs", test: path => path.endsWith(".tgz") },
  { label: "OS/editor files", test: path => path.endsWith(".DS_Store") || path.endsWith(".log") },
];

function fileName(path) {
  return path.split("/").at(-1) ?? path;
}

export function findForbiddenPackageFiles(files) {
  const violations = [];

  for (const file of files) {
    for (const check of forbiddenChecks) {
      if (check.test(file)) violations.push({ file, label: check.label });
    }
  }

  return violations;
}

export function readPackFiles() {
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

export function runPackageContentsCheck(log = console.log, error = console.error) {
  const files = readPackFiles();
  const violations = findForbiddenPackageFiles(files);

  log(`${pkg.name} package dry-run contains ${files.length} file(s).`);
  for (const file of files) log(`- ${file}`);

  if (violations.length > 0) {
    error("\nForbidden package contents detected:");
    for (const violation of violations) {
      error(`- ${violation.file} (${violation.label})`);
    }
  }

  return { files, violations };
}

function isCliEntrypoint() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isCliEntrypoint()) {
  const result = runPackageContentsCheck();
  if (result.violations.length > 0) process.exitCode = 1;
}
