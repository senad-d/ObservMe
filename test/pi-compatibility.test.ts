import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  OBSERVME_CHILD_ROLES,
  OBSERVME_INTEGRATION_VERSION,
  OBSERVME_INTEGRATION_VERSION_V2,
  requestObservMeIntegration,
  requestObservMeIntegrationV2,
  type ObservMeChildDescriptor,
  type ObservMeChildRole,
  type ObservMeIntegrationApi,
  type ObservMeIntegrationApiV2,
  type ObservMeIntegrationContext,
  type ObservMeIntegrationContextRoleV2,
  type ObservMeIntegrationContextV2,
  type ObservMeIntegrationHost,
  type ObservMeIntegrationRequest,
  type ObservMeIntegrationRequestV2,
  type ObservMeIntegrationResponseV2,
  type ObservMeStartSubagentOptions,
  type ObservMeStartSubagentOptionsV2,
} from "../src/integration.ts";
import {
  EARLIEST_TESTED_PI_VERSION,
  PI_RUNTIME_COMPATIBILITY_POLICY,
  RELEASE_TESTED_PI_VERSION,
  assertObservMePiCapabilities,
} from "../src/pi/compatibility.ts";

function receiveV1IntegrationCompileFixture(api: ObservMeIntegrationApi): void {
  void api;
}

function receiveV2IntegrationCompileFixture(api: ObservMeIntegrationResponseV2): void {
  void api;
}

function assertIntegrationApiV2Types(
  v1Api: ObservMeIntegrationApi,
  v2Api: ObservMeIntegrationApiV2,
  host: ObservMeIntegrationHost,
): void {
  const discoveredV1: ObservMeIntegrationApi | undefined = requestObservMeIntegration(host);
  const discoveredV2: ObservMeIntegrationApiV2 | undefined = requestObservMeIntegrationV2(host);
  void discoveredV1;
  void discoveredV2;

  const v1Options: ObservMeStartSubagentOptions = {};
  v1Api.startSubagent();
  v1Api.startSubagent(v1Options);

  const role: ObservMeChildRole = OBSERVME_CHILD_ROLES[2];
  const child: ObservMeChildDescriptor = {
    displayName: "Compile Fixture",
    role,
    capability: "code-search",
  };
  const v2Options: ObservMeStartSubagentOptionsV2 = { child };
  v2Api.startSubagent(v2Options);

  const v1Context = v1Api.getContext();
  if (v1Context.ok) {
    const v1Role: ObservMeIntegrationContext["role"] = v1Context.context.role;
    void v1Role;
  }
  const v2Context = v2Api.getContext();
  if (v2Context.ok) {
    const roleCompleteContext: ObservMeIntegrationContextV2 = v2Context.context;
    const v2Role: ObservMeIntegrationContextRoleV2 = roleCompleteContext.role;
    void v2Role;
  }
  const v2Lead: Extract<ObservMeIntegrationContextV2["role"], "lead"> = "lead";
  void v2Lead;
  // @ts-expect-error The source-compatible v1 context does not expose the v2-only lead role.
  const v1Lead: Extract<ObservMeIntegrationContext["role"], "lead"> = "lead";
  void v1Lead;

  const v1Request: ObservMeIntegrationRequest = {
    supportedVersions: [OBSERVME_INTEGRATION_VERSION],
    respond: receiveV1IntegrationCompileFixture,
  };
  const v2Request: ObservMeIntegrationRequestV2 = {
    supportedVersions: [OBSERVME_INTEGRATION_VERSION_V2, OBSERVME_INTEGRATION_VERSION],
    respond: receiveV2IntegrationCompileFixture,
  };
  const v1Response: ObservMeIntegrationResponseV2 = v1Api;
  const v2Response: ObservMeIntegrationResponseV2 = v2Api;
  void v1Request;
  void v2Request;
  void v1Response;
  void v2Response;

  // @ts-expect-error API v2 requires start options.
  v2Api.startSubagent();
  // @ts-expect-error API v2 requires a complete child descriptor.
  v2Api.startSubagent({});
  // @ts-expect-error API v2 requires child capability.
  v2Api.startSubagent({ child: { displayName: "Compile Fixture", role: "worker" } });
  // @ts-expect-error The v2 role type is derived from the exact exported catalog.
  const invalidRole: ObservMeChildRole = "subagent";
  void invalidRole;
}

void assertIntegrationApiV2Types;

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

test("future OrcMe negotiation fixture has no production-module dependency", async () => {
  const source = await readFile(new URL("./fixtures/orcme-integration-consumer.mjs", import.meta.url), "utf8");

  assert.doesNotMatch(source, /^\s*import\b/mu);
  assert.doesNotMatch(source, /\brequire\s*\(/u);
  assert.doesNotMatch(source, /\bimport\s*\(/u);
  assert.match(source, /planned future OrcMe v2 adoption/u);
  assert.match(source, /does not describe current shipped OrcMe v2 behavior/u);
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
