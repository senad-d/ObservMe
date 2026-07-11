import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const skillFile = resolve(repositoryRoot, "skills/observme-docs/SKILL.md");
const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
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

test("documentation skill has valid routing frontmatter and existing targets", () => {
  assert.match(skill, /^---\nname: observme-docs\ndescription: .+\n---\n/u);

  const paths = extractSkillDocumentPaths(skill);
  assert.ok(paths.length >= 20, "skill should route the documented ObservMe topic areas");
  assertReferencesExist(repositoryRoot, paths);
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
