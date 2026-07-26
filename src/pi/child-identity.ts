import {
  OBSERVME_CHILD_ROLES,
  type ObservMeChildDescriptor,
  type ObservMeChildRole,
} from "../integration.ts";

export const OBSERVME_CHILD_DISPLAY_NAME_MAX_CODE_POINTS = 128;
export const OBSERVME_CHILD_CAPABILITY_MAX_CHARACTERS = 64;

export type ObservMeChildDescriptorValidationResult =
  | { readonly ok: true; readonly descriptor: ObservMeChildDescriptor }
  | { readonly ok: false; readonly reason: "invalid_child_descriptor" };

interface ChildDescriptorProperties {
  readonly displayName: unknown;
  readonly role: unknown;
  readonly capability: unknown;
}

const childCapabilityPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const invalidChildDescriptorResult = Object.freeze({
  ok: false,
  reason: "invalid_child_descriptor",
} as const);

export function validateObservMeChildDescriptor(value: unknown): ObservMeChildDescriptorValidationResult {
  const properties = readChildDescriptorProperties(value);
  if (!properties) return invalidChildDescriptorResult;
  if (!isValidChildDisplayName(properties.displayName)) return invalidChildDescriptorResult;
  if (!isObservMeChildRole(properties.role)) return invalidChildDescriptorResult;
  if (!isValidChildCapability(properties.capability)) return invalidChildDescriptorResult;

  const descriptor = Object.freeze({
    displayName: properties.displayName,
    role: properties.role,
    capability: properties.capability,
  });
  return Object.freeze({ ok: true, descriptor });
}

function readChildDescriptorProperties(value: unknown): ChildDescriptorProperties | undefined {
  if (!value || typeof value !== "object") return undefined;
  try {
    if (Array.isArray(value)) return undefined;
    return {
      displayName: Reflect.get(value, "displayName"),
      role: Reflect.get(value, "role"),
      capability: Reflect.get(value, "capability"),
    };
  } catch {
    return undefined;
  }
}

function isValidChildDisplayName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    hasCodePointLengthWithinBound(value, OBSERVME_CHILD_DISPLAY_NAME_MAX_CODE_POINTS) &&
    hasOnlyUnicodeScalarValues(value) &&
    !containsUnicodeControlCharacter(value)
  );
}

function hasCodePointLengthWithinBound(value: string, maximum: number): boolean {
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > maximum) return false;
  }
  return count > 0;
}

function hasOnlyUnicodeScalarValues(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || !isUnicodeScalarValue(codePoint)) return false;
  }
  return true;
}

function isUnicodeScalarValue(codePoint: number): boolean {
  return codePoint >= 0 && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff);
}

function containsUnicodeControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && isUnicodeControlCharacter(codePoint)) return true;
  }
  return false;
}

function isUnicodeControlCharacter(codePoint: number): boolean {
  return (codePoint >= 0 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f);
}

function isObservMeChildRole(value: unknown): value is ObservMeChildRole {
  if (typeof value !== "string") return false;
  for (const role of OBSERVME_CHILD_ROLES) {
    if (value === role) return true;
  }
  return false;
}

function isValidChildCapability(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= OBSERVME_CHILD_CAPABILITY_MAX_CHARACTERS &&
    childCapabilityPattern.test(value)
  );
}
