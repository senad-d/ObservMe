import assert from "node:assert/strict";
import test from "node:test";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { applyContentCapturePolicy } from "../src/privacy/content-capture.ts";
import { COMMON_SPAN_ATTRIBUTES } from "../src/semconv/attributes.ts";

const previousSalt = process.env.OBSERVME_HASH_SALT;
process.env.OBSERVME_HASH_SALT = "content-capture-policy-test-salt";

function cloneConfig(overrides = {}) {
  return mergeConfig(structuredClone(defaultObservMeConfig), overrides);
}

function mergeConfig(base, overlay) {
  for (const [key, value] of Object.entries(overlay)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      base[key] = mergeConfig(base[key] ?? {}, value);
      continue;
    }

    base[key] = value;
  }

  return base;
}

function assertCapturedSecretIsRedacted(kind) {
  const config = cloneConfig({ privacy: { redactionEnabled: true, allowUnsafeCapture: false } });
  const result = applyContentCapturePolicy({
    captureEnabled: true,
    value: `${kind} password=super-secret`,
    kind,
    config,
  });

  assert.equal(result.mode, "redacted");
  assert.equal(result.captured, true);
  assert.equal(result.redactionFailures, 0);
  assert.match(result.value, /\[REDACTED:/u);
  assert.doesNotMatch(result.value, /super-secret/u);
}

function assertUnsafeSecretIsCapturedRaw(kind, limitKey) {
  const config = cloneConfig({
    limits: { [limitKey]: 10 },
    privacy: { redactionEnabled: false, allowUnsafeCapture: true },
  });
  const result = applyContentCapturePolicy({
    captureEnabled: true,
    value: `${kind}-raw-secret`,
    kind,
    config,
  });

  assert.equal(result.mode, "unsafe");
  assert.equal(result.captured, true);
  assert.equal(result.value, `${kind}-raw-secret`.slice(0, 10));
  assert.equal(result.truncated, true);
  assert.equal(result.attributes[COMMON_SPAN_ATTRIBUTES.OBSERVME_TRUNCATED], true);
  assert.equal(result.attributes[COMMON_SPAN_ATTRIBUTES.OBSERVME_ORIGINAL_LENGTH], `${kind}-raw-secret`.length);
}

test.after(() => {
  if (previousSalt === undefined) delete process.env.OBSERVME_HASH_SALT;
  else process.env.OBSERVME_HASH_SALT = previousSalt;
});

test("content-capture policy redacts prompt, tool result, and bash output when redaction is enabled", () => {
  assertCapturedSecretIsRedacted("prompt");
  assertCapturedSecretIsRedacted("toolResult");
  assertCapturedSecretIsRedacted("bashOutput");
});

test("content-capture policy scrubs cross-platform absolute paths while preserving URLs", () => {
  const paths = [
    "/workspace/project/file.ts",
    "/etc/hosts",
    "C:\\Users\\alice\\secret.txt",
    "\\\\server\\share\\secret.txt",
  ];
  const url = "https://example.invalid/docs/setup";
  const result = applyContentCapturePolicy({
    captureEnabled: true,
    value: `${paths.join(" ")} ${url}`,
    kind: "prompt",
    config: cloneConfig({ privacy: { redactionEnabled: true, allowUnsafeCapture: false, pathMode: "hash" } }),
  });

  assert.equal(result.mode, "redacted");
  assert.equal(result.captured, true);
  assert.equal(result.value?.includes(url), true);
  for (const path of paths) assert.equal(result.value?.includes(path), false);
});

test("content-capture policy omits prompt, tool result, and bash output when capture is disabled", () => {
  const config = cloneConfig();

  for (const kind of ["prompt", "toolResult", "bashOutput"]) {
    const result = applyContentCapturePolicy({ captureEnabled: false, value: `${kind} password=super-secret`, kind, config });

    assert.equal(result.mode, "omitted");
    assert.equal(result.captured, false);
    assert.equal(result.value, undefined);
    assert.equal(result.redactionFailures, 0);
  }
});

test("content-capture policy captures truncated raw prompt, tool result, and bash output only in unsafe mode", () => {
  assertUnsafeSecretIsCapturedRaw("prompt", "maxPromptChars");
  assertUnsafeSecretIsCapturedRaw("toolResult", "maxToolResultChars");
  assertUnsafeSecretIsCapturedRaw("bashOutput", "maxBashOutputChars");
});

test("content-capture policy drops captured content when redaction fails", () => {
  const savedSalt = process.env.OBSERVME_HASH_SALT;
  delete process.env.OBSERVME_HASH_SALT;

  try {
    const result = applyContentCapturePolicy({
      captureEnabled: true,
      value: "password=super-secret",
      kind: "prompt",
      config: cloneConfig({ privacy: { redactionEnabled: true, allowUnsafeCapture: false } }),
    });

    assert.equal(result.mode, "dropped");
    assert.equal(result.captured, false);
    assert.equal(result.value, undefined);
    assert.equal(result.redactionFailures, 1);
    assert.match(result.errors.join("\n"), /tenant salt env var OBSERVME_HASH_SALT is not set/u);
  } finally {
    if (savedSalt === undefined) delete process.env.OBSERVME_HASH_SALT;
    else process.env.OBSERVME_HASH_SALT = savedSalt;
  }
});

test("content-capture policy drops invalid disabled-redaction capture without unsafe acknowledgement", () => {
  const result = applyContentCapturePolicy({
    captureEnabled: true,
    value: "password=super-secret",
    kind: "prompt",
    config: cloneConfig({ privacy: { redactionEnabled: false, allowUnsafeCapture: false } }),
  });

  assert.equal(result.mode, "dropped");
  assert.equal(result.captured, false);
  assert.equal(result.value, undefined);
  assert.equal(result.redactionFailures, 1);
});
