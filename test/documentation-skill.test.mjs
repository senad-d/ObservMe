import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getObsRootSubcommands } from "../src/commands/obs.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const skillFile = resolve(repositoryRoot, "skills/observme-docs/SKILL.md");
const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
const readme = readFileSync(resolve(repositoryRoot, "README.md"), "utf8");
const skill = readFileSync(skillFile, "utf8");

function extractSkillDocumentPaths(markdown) {
  return Array.from(markdown.matchAll(/`package:(?<path>[^`<]+)`/gu), match => match.groups.path);
}

function extractLocalMarkdownLinks(markdown) {
  return Array.from(markdown.matchAll(/\[[^\]]+\]\((?<path>[^):]+\.md(?:#[^)]*)?)\)/gu), match => match.groups.path);
}

function pathWithoutFragment(path) {
  return path.split("#", 1)[0];
}

function assertReferencesExist(baseDirectory, paths) {
  const missing = paths.filter(path => !existsSync(resolve(baseDirectory, pathWithoutFragment(path))));
  assert.deepEqual(missing, []);
}

test("package declares the ObservMe documentation skill", () => {
  assert.deepEqual(packageJson.pi.skills, ["./skills"]);
  assert.equal(packageJson.exports["./integration"], "./src/integration.ts");
  assert.ok(packageJson.files.includes("skills/**/*.md"));
});

test("documentation skill has valid source-aware routing and existing targets", () => {
  assert.match(skill, /^---\nname: observme-docs\ndescription: .+\n---\n/u);
  assert.match(skill, /implementation for exact current behavior/u);
  assert.match(skill, /source of truth/u);
  assert.match(skill, /capture[.]filePaths.*no direct live recording point/u);
  assert.match(skill, /backfill.*OTEL log records/u);
  assert.match(skill, /Do not claim live PII removal/u);

  const paths = extractSkillDocumentPaths(skill);
  assert.ok(paths.length >= 30, "skill should route documentation and owning source slices");
  assertReferencesExist(repositoryRoot, paths);
});

test("README command catalog follows the live /obs registry", () => {
  for (const subcommand of getObsRootSubcommands()) {
    assert.ok(readme.includes(`| \`/obs ${subcommand}\` |`), `README is missing /obs ${subcommand}`);
  }
});

test("documentation and example indexes contain no broken local Markdown links", () => {
  for (const relativePath of [
    "docs/README.md",
    "docs/extension-integration.md",
    "examples/README.md",
    "docs/reference/00-README.md",
  ]) {
    const absolutePath = resolve(repositoryRoot, relativePath);
    const markdown = readFileSync(absolutePath, "utf8");
    assertReferencesExist(dirname(absolutePath), extractLocalMarkdownLinks(markdown));
  }
});
