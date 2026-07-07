#!/usr/bin/env node
// Smoke check: create a real npm tarball, install it into a temporary project,
// then verify the installed package exposes the declared Pi extension entry.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const workspace = await mkdtemp(join(tmpdir(), "observme-packaged-install-"));
const packageDirectory = join(workspace, "package");

try {
  await mkdir(packageDirectory);
  execFileSync(npmCommand, ["pack", "--pack-destination", workspace], { stdio: "pipe" });
  const tarballName = `${packageJson.name.replace("/", "-").replace("@", "")}-${packageJson.version}.tgz`;
  const tarballPath = join(workspace, tarballName);

  execFileSync(npmCommand, ["init", "-y"], { cwd: packageDirectory, stdio: "pipe" });
  execFileSync(
    npmCommand,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", "--legacy-peer-deps", tarballPath],
    { cwd: packageDirectory, stdio: "pipe" },
  );

  const installedPackageJsonPath = join(packageDirectory, "node_modules", "@senad-d", "observme", "package.json");
  const installedPackageJson = JSON.parse(await readFile(installedPackageJsonPath, "utf8"));
  const extensionEntries = installedPackageJson.pi?.extensions ?? [];

  assert.equal(installedPackageJson.name, packageJson.name, "installed package name should match package.json");
  assert.deepEqual(extensionEntries, packageJson.pi.extensions, "installed Pi extension entries should match package.json");

  for (const entry of extensionEntries) {
    const installedEntryPath = join(packageDirectory, "node_modules", "@senad-d", "observme", entry.replace(/^\.\//, ""));
    await readFile(installedEntryPath, "utf8");
  }

  console.log(`Packaged install smoke passed for ${packageJson.name}@${packageJson.version}.`);
} finally {
  await rm(workspace, { recursive: true, force: true });
}
