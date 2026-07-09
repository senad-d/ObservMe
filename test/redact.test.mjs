import assert from "node:assert/strict";
import test from "node:test";
import {
  redactPath,
  redactValue,
  sha256Prefix,
} from "../src/privacy/redact.ts";
import { SECRET_TYPES } from "../src/privacy/secret-patterns.ts";

const tenantSaltSource = {
  secureRuntimeConfig: {
    tenantSalt: "redact-test-salt",
  },
};

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
    tenantSaltSource,
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
    `Authorization: [REDACTED:${SECRET_TYPES.GENERIC_BEARER_TOKEN}:${sha256Prefix(tokenValue, tenantSaltSource)}]`,
  );
});

test("path redaction hash mode matches documented home-path transformations", () => {
  assert.equal(
    redactPath("/home/alice/projects/customer-x/app.ts", "hash", tenantSaltSource),
    `/<home>/${sha256Prefix("/home/alice/projects/customer-x", tenantSaltSource)}/app.ts`,
  );
  assert.equal(
    redactPath("/Users/alice/work/acme-secret/main.py", "hash", tenantSaltSource),
    `/<home>/${sha256Prefix("/Users/alice/work/acme-secret", tenantSaltSource)}/main.py`,
  );
});

test("standalone path redaction uses Windows semantics for drive and UNC paths", () => {
  const drivePath = "C:\\Users\\alice\\secret.txt";
  const uncPath = "\\\\server\\share\\secret.txt";

  assert.equal(redactPath(drivePath, "basename"), "secret.txt");
  assert.equal(redactPath(uncPath, "basename"), "secret.txt");
  assert.equal(
    redactPath(drivePath, "hash", tenantSaltSource),
    `/<home>/${sha256Prefix("C:\\Users\\alice", tenantSaltSource)}/secret.txt`,
  );
  assert.equal(
    redactPath(uncPath, "hash", tenantSaltSource),
    `/<home>/${sha256Prefix("\\\\server\\share\\", tenantSaltSource)}/secret.txt`,
  );
});

test("redaction replacement hashes are tenant salted and fail closed when salt is missing", () => {
  const first = redactValue("secret token", defaultOptions({
    piiEnabled: true,
    piiDetector: () => [{ type: "token", value: "secret", start: 0, end: 6 }],
  }));
  const second = redactValue("secret token", defaultOptions({
    piiEnabled: true,
    piiDetector: () => [{ type: "token", value: "secret", start: 0, end: 6 }],
    tenantSaltSource: { secureRuntimeConfig: { tenantSalt: "other-redact-test-salt" } },
  }));
  const missing = redactValue("secret token", {
    pathMode: "hash",
    customRedactionPatterns: [],
    piiEnabled: true,
    piiDetector: () => [{ type: "token", value: "secret", start: 0, end: 6 }],
  });

  assert.notEqual(first.value, second.value);
  assert.equal(missing.dropped, true);
  assert.equal(missing.value, undefined);
  assert.match(missing.errors[0], /tenant salt source is required/u);
});

test("path redaction supports basename, full, and drop modes", () => {
  const path = "/Users/alice/work/acme-secret/main.py";

  assert.equal(redactPath(path, "basename"), "main.py");
  assert.equal(redactPath(path, "full"), path);
  assert.equal(redactPath(path, "drop"), undefined);
});

test("path scrubber applies every configured mode to cross-platform embedded paths", () => {
  const paths = [
    "/workspace/project/file.ts",
    "/etc/hosts",
    "C:\\Users\\alice\\secret.txt",
    "\\\\server\\share\\secret.txt",
    "/home/alice/projects/customer-x/app.ts",
  ];
  const input = `open ${paths[0]}, inspect ${paths[1]}; read ${paths[2]}, copy ${paths[3]}, edit ${paths[4]}.`;
  const basenameResult = redactValue(input, defaultOptions({ pathMode: "basename" }));
  const dropResult = redactValue(input, defaultOptions({ pathMode: "drop" }));
  const hashResult = redactValue(input, defaultOptions({ pathMode: "hash" }));
  const fullResult = redactValue(input, defaultOptions({ pathMode: "full" }));

  assert.equal(basenameResult.value, "open file.ts, inspect hosts; read secret.txt, copy secret.txt, edit app.ts.");
  assert.equal(
    dropResult.value,
    "open [REDACTED:path], inspect [REDACTED:path]; read [REDACTED:path], copy [REDACTED:path], edit [REDACTED:path].",
  );
  assert.equal(fullResult.value, input);
  for (const path of paths) {
    assert.doesNotMatch(basenameResult.value ?? "", new RegExp(escapeForRegExp(path), "u"));
    assert.doesNotMatch(dropResult.value ?? "", new RegExp(escapeForRegExp(path), "u"));
    assert.doesNotMatch(hashResult.value ?? "", new RegExp(escapeForRegExp(path), "u"));
  }
});

test("path hashing is deterministic, tenant salted, and fails closed without a salt", () => {
  const path = "C:\\Users\\alice\\secret.txt";
  const first = redactPath(path, "hash", tenantSaltSource);
  const second = redactPath(path, "hash", tenantSaltSource);
  const otherTenant = redactPath(path, "hash", {
    secureRuntimeConfig: { tenantSalt: "other-path-redaction-salt" },
  });
  const missingSalt = redactValue(`open ${path}`, { pathMode: "hash", customRedactionPatterns: [] });

  assert.equal(first, second);
  assert.notEqual(first, otherTenant);
  assert.equal(missingSalt.dropped, true);
  assert.equal(missingSalt.value, undefined);
  assert.match(missingSalt.errors[0], /tenant salt source is required/u);
});

test("path scrubber leaves URLs and harmless slash-separated prose intact", () => {
  const input = "visit https://example.invalid/docs/setup, compare docs/setup and ratio 1/2.";
  const result = redactValue(input, defaultOptions({ pathMode: "basename" }));

  assert.equal(result.value, input);
});

test("URL credentials are secret-redacted without corrupting the remaining URL path", () => {
  const result = redactValue(
    "remote https://deploy:synthetic-pass@example.invalid/repo.git",
    defaultOptions({ pathMode: "basename" }),
  );

  assert.match(
    result.value ?? "",
    /remote \[REDACTED:url_credentials:[a-f0-9]{12}\]example\.invalid\/repo\.git/u,
  );
  assert.doesNotMatch(result.value ?? "", /deploy|synthetic-pass|REDACTED:path/u);
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

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

test("truncation happens before hashing and records original length", () => {
  const result = redactValue("abcdef", defaultOptions({ maxOutputChars: 3 }));

  assert.equal(result.value, "abc");
  assert.equal(result.truncated, true);
  assert.equal(result.originalLength, 6);
  assert.equal(result.hash, sha256Prefix("abc", tenantSaltSource) + result.hash?.slice(12));
});
