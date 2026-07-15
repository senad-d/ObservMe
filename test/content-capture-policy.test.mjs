import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { applyContentCapturePolicy } from "../src/privacy/content-capture.ts";
import { COMMON_SPAN_ATTRIBUTES } from "../src/semconv/attributes.ts";

const previousSalt = process.env.OBSERVME_HASH_SALT;
process.env.OBSERVME_HASH_SALT = "content-capture-policy-test-salt";

function buildSyntheticPemBlock(label, body) {
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
}

function cloneConfig(overrides = {}) {
  return mergeConfig(structuredClone(defaultObservMeConfig), overrides);
}

function runAdversarialCaptureInChild() {
  const configModuleUrl = new URL("../src/config/defaults.ts", import.meta.url).href;
  const captureModuleUrl = new URL("../src/privacy/content-capture.ts", import.meta.url).href;
  const script = `
    import { defaultObservMeConfig } from ${JSON.stringify(configModuleUrl)};
    import { applyContentCapturePolicy } from ${JSON.stringify(captureModuleUrl)};

    const rejectionCases = [
      { name: "nested", pattern: "^(a+)+$", rawValue: "a".repeat(4096) + "! nested-sentinel" },
      { name: "alternation", pattern: "^(?:a|aa)+$", rawValue: "a".repeat(4096) + "! alternation-sentinel" },
      { name: "adjacent", pattern: "^a+a+$", rawValue: "a".repeat(65536) + "! adjacent-sentinel" },
    ];
    const rejections = [];
    for (const rejectionCase of rejectionCases) {
      const config = structuredClone(defaultObservMeConfig);
      config.privacy.customRedactionPatterns = [{ name: rejectionCase.name, pattern: rejectionCase.pattern }];
      const result = applyContentCapturePolicy({
        captureEnabled: true,
        value: rejectionCase.rawValue,
        kind: "prompt",
        config,
      });
      rejections.push({
        name: rejectionCase.name,
        mode: result.mode,
        captured: result.captured,
        hasValue: result.value !== undefined,
        redactionFailures: result.redactionFailures,
        leakedRaw:
          result.value?.includes(rejectionCase.rawValue) === true
          || result.errors.some(error => error.includes(rejectionCase.rawValue)),
      });
    }

    const safeConfig = structuredClone(defaultObservMeConfig);
    safeConfig.privacy.customRedactionPatterns = [{ name: "safe", pattern: "(?i)(?:foo|bar)+" }];
    const safeResult = applyContentCapturePolicy({
      captureEnabled: true,
      value: "FOObar",
      kind: "prompt",
      config: safeConfig,
    });
    process.stdout.write(JSON.stringify({
      rejections,
      safe: {
        mode: safeResult.mode,
        captured: safeResult.captured,
        redactionFailures: safeResult.redactionFailures,
        redacted: /^\\[REDACTED:safe:[a-f0-9]{12}\\]$/u.test(safeResult.value ?? ""),
      },
    }));
  `;

  return spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    env: { ...process.env, OBSERVME_HASH_SALT: "adversarial-capture-child-test-salt" },
    timeout: 3_000,
  });
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

test("content-capture policy removes complete private-key material from live capture kinds", () => {
  const captureCases = [
    { kind: "prompt", label: "PRIVATE KEY", body: "UFJPTVBUX1NZTlRIRVRJQ19CT0RZ" },
    { kind: "toolResult", label: "RSA PRIVATE KEY", body: "VE9PTF9TWU5USEVUSUNfQk9EWQ==" },
    { kind: "bashOutput", label: "EC PRIVATE KEY", body: "QkFTSF9TWU5USEVUSUNfQk9EWQ==" },
  ];
  const config = cloneConfig({ privacy: { redactionEnabled: true, allowUnsafeCapture: false } });

  for (const captureCase of captureCases) {
    const input = buildSyntheticPemBlock(captureCase.label, captureCase.body);
    const result = applyContentCapturePolicy({ captureEnabled: true, value: input, kind: captureCase.kind, config });

    assert.equal(result.mode, "redacted");
    assert.equal(result.captured, true);
    assert.match(result.value, /^\[REDACTED:private_key_block:[a-f0-9]{12}\]$/u);
    assert.doesNotMatch(result.value, new RegExp(captureCase.body, "u"));
    assert.doesNotMatch(result.value, /-----BEGIN/u);
    assert.doesNotMatch(result.value, /-----END/u);
  }
});

test("content-capture policy fails closed for a truncated private-key block", () => {
  const body = "VFJVTkNBVEVEX0xJVkVfU1lOVEhFVElDX0JPRFk=";
  const result = applyContentCapturePolicy({
    captureEnabled: true,
    value: `safe prefix\n-----BEGIN ENCRYPTED PRIVATE KEY-----\n${body}`,
    kind: "prompt",
    config: cloneConfig({ privacy: { redactionEnabled: true, allowUnsafeCapture: false } }),
  });

  assert.equal(result.mode, "redacted");
  assert.equal(result.captured, true);
  assert.match(result.value, /^safe prefix\n\[REDACTED:private_key_block:[a-f0-9]{12}\]$/u);
  assert.doesNotMatch(result.value, new RegExp(body, "u"));
  assert.doesNotMatch(result.value, /-----BEGIN/u);
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

test("content-capture policy bounds unsafe regex rejection and preserves safe quantified alternatives", () => {
  const child = runAdversarialCaptureInChild();

  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    rejections: [
      {
        name: "nested",
        mode: "dropped",
        captured: false,
        hasValue: false,
        redactionFailures: 1,
        leakedRaw: false,
      },
      {
        name: "alternation",
        mode: "dropped",
        captured: false,
        hasValue: false,
        redactionFailures: 1,
        leakedRaw: false,
      },
      {
        name: "adjacent",
        mode: "dropped",
        captured: false,
        hasValue: false,
        redactionFailures: 1,
        leakedRaw: false,
      },
    ],
    safe: {
      mode: "redacted",
      captured: true,
      redactionFailures: 0,
      redacted: true,
    },
  });
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
