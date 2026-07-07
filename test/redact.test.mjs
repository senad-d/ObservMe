import assert from "node:assert/strict";
import test from "node:test";
import {
  redactPath,
  redactValue,
  sha256Prefix,
} from "../src/privacy/redact.ts";
import { SECRET_TYPES } from "../src/privacy/secret-patterns.ts";

const expectedPipelineStages = [
  "size_guard",
  "secret_detector",
  "pii_detector",
  "path_scrubber",
  "custom_regex_redactors",
  "truncation",
  "hashing",
  "export",
];

function defaultOptions(overrides = {}) {
  return {
    pathMode: "hash",
    customRedactionPatterns: [],
    ...overrides,
  };
}

test("redaction pipeline runs stages in the documented order", () => {
  const observedStages = [];
  const result = redactValue("safe value", defaultOptions({ onStage: stage => observedStages.push(stage) }));

  assert.equal(result.dropped, false);
  assert.deepEqual(result.stages, expectedPipelineStages);
  assert.deepEqual(observedStages, expectedPipelineStages);
});

test("detector failure drops field, increments failure metric, and exports no raw value", () => {
  const rawValue = "raw value must not be exported";
  const result = redactValue(
    rawValue,
    defaultOptions({
      secretMatcher: () => {
        throw new Error("synthetic detector failure");
      },
    }),
  );

  assert.equal(result.dropped, true);
  assert.equal(result.value, undefined);
  assert.deepEqual(result.failureMetrics, { redactionFailures: 1 });
  assert.deepEqual(result.stages, ["size_guard", "secret_detector"]);
  assert.equal(result.errors[0], "synthetic detector failure");
});

test("built-in secret detector redacts values with documented replacement shape", () => {
  const tokenValue = `bearer ${"a".repeat(24)}`;
  const result = redactValue(`Authorization: ${tokenValue}`, defaultOptions());

  assert.equal(result.dropped, false);
  assert.equal(
    result.value,
    `Authorization: [REDACTED:${SECRET_TYPES.GENERIC_BEARER_TOKEN}:${sha256Prefix(tokenValue)}]`,
  );
});

test("path redaction hash mode matches documented home-path transformations", () => {
  assert.equal(
    redactPath("/home/alice/projects/customer-x/app.ts", "hash"),
    `/<home>/${sha256Prefix("/home/alice/projects/customer-x")}/app.ts`,
  );
  assert.equal(
    redactPath("/Users/alice/work/acme-secret/main.py", "hash"),
    `/<home>/${sha256Prefix("/Users/alice/work/acme-secret")}/main.py`,
  );
});

test("path redaction supports basename, full, and drop modes", () => {
  const path = "/Users/alice/work/acme-secret/main.py";

  assert.equal(redactPath(path, "basename"), "main.py");
  assert.equal(redactPath(path, "full"), path);
  assert.equal(redactPath(path, "drop"), undefined);
});

test("path scrubber applies the configured mode to embedded paths", () => {
  const result = redactValue("open /home/alice/projects/customer-x/app.ts", defaultOptions({ pathMode: "basename" }));

  assert.equal(result.value, "open app.ts");
});

test("custom regex redactors from config are applied in addition to built-in patterns", () => {
  const result = redactValue(
    `Authorization: bearer ${"b".repeat(24)} customerCredential(abc-123)`,
    defaultOptions({
      customRedactionPatterns: [
        {
          name: "internal-token",
          pattern: "(?i)customercredential\\([a-z0-9-]+\\)",
        },
      ],
    }),
  );

  assert.match(result.value, /Authorization: \[REDACTED:generic_bearer_token:[a-f0-9]{12}\]/u);
  assert.match(result.value, /\[REDACTED:internal_token:[a-f0-9]{12}\]/u);
});

test("unsafe custom regex redactors fail closed without exporting raw content", () => {
  const result = redactValue(
    "secret value aaaab must not export",
    defaultOptions({
      customRedactionPatterns: [{ name: "unsafe", pattern: "(a+)+b" }],
    }),
  );

  assert.equal(result.dropped, true);
  assert.equal(result.value, undefined);
  assert.equal(result.failureMetrics.redactionFailures, 1);
  assert.match(result.errors[0], /must not repeat a group/u);
});

test("invalid custom regex redactors fail closed without exporting raw content", () => {
  const result = redactValue(
    "secret value must not export",
    defaultOptions({
      customRedactionPatterns: [{ name: "broken", pattern: "(" }],
    }),
  );

  assert.equal(result.dropped, true);
  assert.equal(result.value, undefined);
  assert.equal(result.failureMetrics.redactionFailures, 1);
  assert.match(result.errors[0], /not a valid regular expression/u);
});

test("truncation happens before hashing and records original length", () => {
  const result = redactValue("abcdef", defaultOptions({ maxOutputChars: 3 }));

  assert.equal(result.value, "abc");
  assert.equal(result.truncated, true);
  assert.equal(result.originalLength, 6);
  assert.equal(result.hash, sha256Prefix("abc") + result.hash?.slice(12));
});
