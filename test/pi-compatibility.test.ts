import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  EARLIEST_TESTED_PI_VERSION,
  PI_RUNTIME_COMPATIBILITY_POLICY,
  RELEASE_TESTED_PI_VERSION,
  assertObservMePiCapabilities,
} from "../src/pi/compatibility.ts";

function createCompatibleApi() {
  return {
    on: () => undefined,
    registerCommand: () => undefined,
  };
}

test("Pi runtime preflight is version-independent", async () => {
  const pi = createCompatibleApi();
  const invokeWithIgnoredVersion = assertObservMePiCapabilities as unknown as (
    api: unknown,
    ignoredVersion: unknown,
  ) => void;

  for (const version of [
    "0.1.0",
    "0.81.1-rc.1",
    "1.0.0",
    "not-a-version",
    `future-${"x".repeat(512)}`,
    undefined,
  ]) {
    assert.doesNotThrow(() => invokeWithIgnoredVersion(pi, version));
  }

  const source = await readFile(new URL("../src/pi/compatibility.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /import\s*\{\s*VERSION/u);
  assert.doesNotMatch(source, /parsePiVersion|supportedRange|minimumVersion/u);
});

test("package metadata separates tested versions from the runtime capability policy", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    devDependencies?: Record<string, string>;
    observmeCompatibility?: { pi?: Record<string, string> };
    peerDependencies?: Record<string, string>;
  };

  assert.deepEqual(packageJson.observmeCompatibility?.pi, {
    earliestTestedVersion: EARLIEST_TESTED_PI_VERSION,
    releaseTestedVersion: RELEASE_TESTED_PI_VERSION,
    runtimePolicy: PI_RUNTIME_COMPATIBILITY_POLICY,
  });
  assert.equal(packageJson.devDependencies?.["@earendil-works/pi-coding-agent"], RELEASE_TESTED_PI_VERSION);
  assert.equal(packageJson.devDependencies?.["@earendil-works/pi-ai"], RELEASE_TESTED_PI_VERSION);
  assert.equal(packageJson.peerDependencies?.["@earendil-works/pi-coding-agent"], "*");
  assert.equal(packageJson.peerDependencies?.["@earendil-works/pi-ai"], "*");
});

test("optional Pi APIs do not block ObservMe startup", () => {
  assert.doesNotThrow(() => assertObservMePiCapabilities(createCompatibleApi()));
});

test("Pi capability preflight reports only essential missing methods without inspecting values", () => {
  const unsafeValue = "token=private-compatibility-value";
  let error: unknown;

  try {
    assertObservMePiCapabilities({ on: () => undefined, registerCommand: unsafeValue });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof TypeError);
  assert.match(error.message, /requires ExtensionAPI method\(s\): registerCommand/u);
  assert.match(error.message, /Pi version is not used as a startup gate/u);
  assert.match(error.message, /No ObservMe event handlers or commands were registered/u);
  assert.doesNotMatch(error.message, /appendEntry|getThinkingLevel/u);
  assert.doesNotMatch(error.message, /private-compatibility-value/u);
});
