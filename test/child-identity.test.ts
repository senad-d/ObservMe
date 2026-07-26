import assert from "node:assert/strict";
import test from "node:test";
import { OBSERVME_CHILD_ROLES } from "../src/integration.ts";
import {
  OBSERVME_CHILD_CAPABILITY_MAX_CHARACTERS,
  OBSERVME_CHILD_DISPLAY_NAME_MAX_CODE_POINTS,
  validateObservMeChildDescriptor,
} from "../src/pi/child-identity.ts";

const validDescriptor = {
  displayName: "Scout",
  role: OBSERVME_CHILD_ROLES[2],
  capability: "code-search",
} as const;
const invalidResult = { ok: false, reason: "invalid_child_descriptor" } as const;

function descriptorWith(overrides: Partial<Record<keyof typeof validDescriptor, unknown>>): unknown {
  return { ...validDescriptor, ...overrides };
}

test("accepts exact display-name and capability limits without rewriting values", () => {
  const displayName = "😀".repeat(OBSERVME_CHILD_DISPLAY_NAME_MAX_CODE_POINTS);
  const capability = `a${"b".repeat(OBSERVME_CHILD_CAPABILITY_MAX_CHARACTERS - 1)}`;
  const descriptor = { displayName, role: OBSERVME_CHILD_ROLES[0], capability } as const;

  const result = validateObservMeChildDescriptor(descriptor);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.descriptor, descriptor);
  assert.equal(result.descriptor.displayName.length, OBSERVME_CHILD_DISPLAY_NAME_MAX_CODE_POINTS * 2);
});

test("preserves display-name whitespace and Unicode normalization form", () => {
  const displayName = " Scout e\u0301 ";
  const result = validateObservMeChildDescriptor(descriptorWith({ displayName }));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.descriptor.displayName, displayName);
  assert.notEqual(result.descriptor.displayName, displayName.normalize("NFC").trim());
});

test("accepts every role from the public catalog", () => {
  assert.deepEqual(OBSERVME_CHILD_ROLES, ["lead", "helper", "worker", "validator"]);
  for (const role of OBSERVME_CHILD_ROLES) {
    const result = validateObservMeChildDescriptor(descriptorWith({ role }));
    assert.equal(result.ok, true, `expected the public ${role} role to be accepted`);
  }
});

test("rejects empty and oversized display names by Unicode code-point count", () => {
  const oversizedAstralName = "😀".repeat(OBSERVME_CHILD_DISPLAY_NAME_MAX_CODE_POINTS + 1);

  assert.deepEqual(validateObservMeChildDescriptor(descriptorWith({ displayName: "" })), invalidResult);
  assert.deepEqual(
    validateObservMeChildDescriptor(descriptorWith({ displayName: oversizedAstralName })),
    invalidResult,
  );
});

test("rejects lone surrogates while accepting valid astral Unicode", () => {
  assert.equal(validateObservMeChildDescriptor(descriptorWith({ displayName: "Scout 😀" })).ok, true);
  assert.deepEqual(validateObservMeChildDescriptor(descriptorWith({ displayName: "Scout\ud800" })), invalidResult);
  assert.deepEqual(validateObservMeChildDescriptor(descriptorWith({ displayName: "Scout\udc00" })), invalidResult);
});

test("rejects C0 and C1 display-name controls", () => {
  for (const displayName of ["Scout\0", "Scout\n", "Scout\u007f", "Scout\u0085"]) {
    assert.deepEqual(validateObservMeChildDescriptor(descriptorWith({ displayName })), invalidResult);
  }
});

test("rejects malformed capabilities and accepts the complete ASCII token alphabet", () => {
  assert.equal(validateObservMeChildDescriptor(descriptorWith({ capability: "a.Z_9:-" })).ok, true);

  const malformedCapabilities: unknown[] = [
    "",
    `a${"b".repeat(OBSERVME_CHILD_CAPABILITY_MAX_CHARACTERS)}`,
    ".hidden",
    "-prefixed",
    "contains space",
    "path/name",
    "café",
    42,
  ];
  for (const capability of malformedCapabilities) {
    assert.deepEqual(validateObservMeChildDescriptor(descriptorWith({ capability })), invalidResult);
  }
});

test("rejects unknown roles, missing fields, invalid field types, and non-objects atomically", () => {
  const invalidDescriptors: unknown[] = [
    descriptorWith({ role: "root" }),
    descriptorWith({ role: "Worker" }),
    descriptorWith({ displayName: 7 }),
    { displayName: "Scout", role: "worker" },
    null,
    [],
  ];

  for (const descriptor of invalidDescriptors) {
    assert.deepEqual(validateObservMeChildDescriptor(descriptor), invalidResult);
  }
});

test("failure results are bounded and contain no rejected values or partial descriptor", () => {
  const rejectedDisplayName = "private\nname";
  const rejectedCapability = "private capability";
  const result = validateObservMeChildDescriptor(
    descriptorWith({ displayName: rejectedDisplayName, role: "administrator", capability: rejectedCapability }),
  );
  const renderedResult = JSON.stringify(result);

  assert.deepEqual(result, invalidResult);
  assert.equal("descriptor" in result, false);
  assert.equal(renderedResult.includes(rejectedDisplayName), false);
  assert.equal(renderedResult.includes(rejectedCapability), false);
  assert.equal(renderedResult.includes("administrator"), false);
});

test("property access failures produce the same value-free rejection", () => {
  const descriptor = Object.defineProperty({}, "displayName", {
    get() {
      throw new Error("private getter value");
    },
  });
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();

  assert.deepEqual(validateObservMeChildDescriptor(descriptor), invalidResult);
  assert.deepEqual(validateObservMeChildDescriptor(proxy), invalidResult);
});
