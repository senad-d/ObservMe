import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { findForbiddenPackageFiles, findMissingRequiredPackageFiles } from "../scripts/check-package-contents.mjs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

function extractDevelopmentSection(markdown) {
  const sectionMatch = /## Development\n(?<body>[\s\S]*?)\n## /u.exec(markdown);
  return sectionMatch?.groups?.body ?? "";
}

function extractNpmRunCommands(markdown) {
  return Array.from(markdown.matchAll(/\bnpm run ([\w:-]+)/gu), match => match[1]);
}

function extractLocalNodeScriptPaths(command) {
  return Array.from(command.matchAll(/\bnode(?:\s+--check)?\s+(scripts\/[^\s&|;]+)/gu), match => match[1]);
}

function localScriptExists(scriptPath) {
  return existsSync(new URL(`../${scriptPath}`, import.meta.url));
}

test("package content checks reject environment files, secret material, and local state", () => {
  const violations = findForbiddenPackageFiles([
    ".env.example",
    ".env",
    ".env.local",
    "config/.env.production",
    "secrets/grafana_admin_password",
    "certs/private.key",
    "certs/client.pem",
    "ssh/id_rsa",
    "observability-stack/secrets/grafana_admin_password",
    "observability-stack/secrets/observability.local.key",
    "observability-stack/.pi/agent/guardme-state.jsonl",
    "specs/spec-review.md",
    "coverage/node-test-coverage.txt",
    "coverage/lcov.info",
    "observme-0.1.0.tgz",
    "README.md",
  ]);

  assert.deepEqual(
    violations.map(violation => `${violation.file}:${violation.label}`),
    [
      ".env:environment files",
      ".env.local:environment files",
      "config/.env.production:environment files",
      "secrets/grafana_admin_password:secret material",
      "certs/private.key:secret material",
      "certs/client.pem:secret material",
      "ssh/id_rsa:secret material",
      "observability-stack/secrets/grafana_admin_password:secret material",
      "observability-stack/secrets/observability.local.key:secret material",
      "observability-stack/.pi/agent/guardme-state.jsonl:project-local pi state",
      "specs/spec-review.md:planning specs",
      "coverage/node-test-coverage.txt:generated reports",
      "coverage/lcov.info:generated reports",
      "observme-0.1.0.tgz:npm tarballs",
    ],
  );
});

const requiredPackagedAssetFiles = [
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

test("package content checks require README-promised assets and examples", () => {
  assert.deepEqual(findMissingRequiredPackageFiles(requiredPackagedAssetFiles), []);
});

test("package content checks report omitted README-promised assets", () => {
  const missingRequiredFiles = findMissingRequiredPackageFiles(requiredPackagedAssetFiles.filter(file => !file.startsWith("dashboards/")));

  assert.deepEqual(missingRequiredFiles, [
    "dashboards/observme-overview.json",
    "dashboards/observme-trace-journey.json",
    "dashboards/observme-alerts.yaml",
    "dashboards/observme-slos.yaml",
  ]);
});

test("README Development npm run commands exist in package scripts", () => {
  const developmentCommands = extractNpmRunCommands(extractDevelopmentSection(readme));
  const missingCommands = developmentCommands.filter(command => packageJson.scripts[command] === undefined);

  assert.deepEqual(missingCommands, []);
});

test("package scripts do not reference missing local node scripts", () => {
  const missingScriptReferences = Object.entries(packageJson.scripts).flatMap(([scriptName, command]) =>
    extractLocalNodeScriptPaths(command)
      .filter(scriptPath => !localScriptExists(scriptPath))
      .map(scriptPath => `${scriptName}:${scriptPath}`),
  );

  assert.deepEqual(missingScriptReferences, []);
});
