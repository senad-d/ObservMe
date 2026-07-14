import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MINIMUM_SUPPORTED_PI_VERSION,
  RELEASE_TESTED_PI_VERSION,
  SUPPORTED_PI_VERSION_RANGE,
  assertObservMePiCompatibility,
} from "../src/pi/compatibility.ts";

function createCompatibleApi() {
  return {
    on: () => undefined,
    registerCommand: () => undefined,
    appendEntry: () => undefined,
    getThinkingLevel: () => "medium",
  };
}

test("Pi compatibility policy accepts the declared minimum and release-resolved versions", () => {
  const pi = createCompatibleApi();

  assert.doesNotThrow(() => assertObservMePiCompatibility(pi, MINIMUM_SUPPORTED_PI_VERSION));
  assert.doesNotThrow(() => assertObservMePiCompatibility(pi, RELEASE_TESTED_PI_VERSION));
  assert.equal(SUPPORTED_PI_VERSION_RANGE, ">=0.80.5 <0.81.0");
});

test("package metadata pins release tooling while retaining Pi-mandated wildcard peers", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    devDependencies?: Record<string, string>;
    observmeCompatibility?: { pi?: Record<string, string> };
    peerDependencies?: Record<string, string>;
  };

  assert.deepEqual(packageJson.observmeCompatibility?.pi, {
    minimumVersion: MINIMUM_SUPPORTED_PI_VERSION,
    releaseTestedVersion: RELEASE_TESTED_PI_VERSION,
    supportedRange: SUPPORTED_PI_VERSION_RANGE,
  });
  assert.equal(packageJson.devDependencies?.["@earendil-works/pi-coding-agent"], RELEASE_TESTED_PI_VERSION);
  assert.equal(packageJson.devDependencies?.["@earendil-works/pi-ai"], RELEASE_TESTED_PI_VERSION);
  assert.equal(packageJson.peerDependencies?.["@earendil-works/pi-coding-agent"], "*");
  assert.equal(packageJson.peerDependencies?.["@earendil-works/pi-ai"], "*");
});

test("Pi compatibility policy rejects versions outside the supported minor line", () => {
  const pi = createCompatibleApi();

  assert.throws(
    () => assertObservMePiCompatibility(pi, "0.80.2"),
    /requires @earendil-works\/pi-coding-agent >=0\.80\.5 <0\.81\.0; detected Pi 0\.80\.2/u,
  );
  assert.throws(
    () => assertObservMePiCompatibility(pi, "0.81.0"),
    /requires @earendil-works\/pi-coding-agent >=0\.80\.5 <0\.81\.0; detected Pi 0\.81\.0/u,
  );
});

test("Pi compatibility policy reports required APIs once without inspecting unsafe values", () => {
  const unsafeValue = "token=private-compatibility-value";
  let error: unknown;

  try {
    assertObservMePiCompatibility({ on: () => undefined, registerCommand: unsafeValue }, RELEASE_TESTED_PI_VERSION);
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof TypeError);
  assert.match(error.message, /missing required API method\(s\): registerCommand, appendEntry, getThinkingLevel/u);
  assert.match(error.message, /No ObservMe event handlers or commands were registered/u);
  assert.doesNotMatch(error.message, /private-compatibility-value/u);
});
