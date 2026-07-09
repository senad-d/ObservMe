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
const requiredPackagedFiles = [
  ".env.example",
  "README.md",
  "LICENSE",
  "SECURITY.md",
  "CHANGELOG.md",
  "docs/configuration.md",
  "docs/compatibility-matrix.md",
  "ObservMe-Production-Docs/00-README.md",
  "ObservMe-Production-Docs/12-configuration-reference.md",
  "dashboards/observme-overview.json",
  "dashboards/observme-trace-journey.json",
  "dashboards/observme-alerts.yaml",
  "dashboards/observme-slos.yaml",
  "examples/observme.yaml",
  "examples/collector.yaml",
  "img/icon.svg",
  "img/demo.gif",
];

const forbiddenChecks = [
  { label: "environment files", test: path => hiddenEnvironmentFilePattern.test(path) && !allowedEnvironmentExampleFiles.has(fileName(path)) },
  { label: "secret material", test: path => secretMaterialFilePattern.test(path) || secretDirectoryPattern.test(path) },
  { label: "project-local pi state", test: path => path === ".pi" || path.startsWith(".pi/") || path.includes("/.pi/") },
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

export function findMissingRequiredPackageFiles(files) {
  const packagedFiles = new Set(files);
  return requiredPackagedFiles.filter(file => !packagedFiles.has(file));
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
  const missingRequiredFiles = findMissingRequiredPackageFiles(files);

  log(`${pkg.name} package dry-run contains ${files.length} file(s).`);
  for (const file of files) log(`- ${file}`);

  if (missingRequiredFiles.length > 0) {
    error("\nRequired package contents are missing:");
    for (const file of missingRequiredFiles) error(`- ${file}`);
  }

  if (violations.length > 0) {
    error("\nForbidden package contents detected:");
    for (const violation of violations) {
      error(`- ${violation.file} (${violation.label})`);
    }
  }

  return { files, violations, missingRequiredFiles };
}

function isCliEntrypoint() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isCliEntrypoint()) {
  const result = runPackageContentsCheck();
  if (result.violations.length > 0 || result.missingRequiredFiles.length > 0) process.exitCode = 1;
}
