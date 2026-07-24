import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { CUSTOM_REDACTION_PATTERN_NAME_MAX_CHARS } from "../src/config/schema.ts";
import {
  DEFAULT_MAX_INPUT_CHARS,
  formatCustomReplacement,
  MAX_CUSTOM_REDACTION_INTERMEDIATE_CHARS,
  MAX_CUSTOM_REDACTION_MATCHES,
  MAX_CUSTOM_REDACTION_REPLACEMENT_CHARS,
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

function runWorstCaseBroadPatternInChild() {
  const redactionModuleUrl = new URL("../src/privacy/redact.ts", import.meta.url).href;
  const script = `
    import { DEFAULT_MAX_INPUT_CHARS, redactValue } from ${JSON.stringify(redactionModuleUrl)};

    const startedAt = Date.now();
    const result = redactValue("x".repeat(DEFAULT_MAX_INPUT_CHARS), {
      pathMode: "full",
      customRedactionPatterns: [{ name: "broad", pattern: "." }],
      tenantSaltSource: { secureRuntimeConfig: { tenantSalt: "broad-pattern-budget-test-salt" } },
    });
    process.stdout.write(JSON.stringify({
      dropped: result.dropped,
      hasValue: result.value !== undefined,
      failures: result.failureMetrics.redactionFailures,
      errors: result.errors,
      elapsedMs: Date.now() - startedAt,
    }));
  `;

  return spawnSync(process.execPath, ["--max-old-space-size=128", "--input-type=module", "--eval", script], {
    encoding: "utf8",
    timeout: 3_000,
  });
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
    `Authorization: bearer ${"b".repeat(24)} customerCredential(abc-123) tenantLabel(XYZ-789) FOObar`,
    defaultOptions({
      customRedactionPatterns: [
        {
          name: "internal-token",
          pattern: "(?i)customercredential\\([a-z0-9-]+\\)",
        },
        {
          name: "safe-alternation",
          pattern: "(?i)(?:customer|tenant)label\\([a-z0-9-]+\\)",
        },
        {
          name: "safe-quantified-alternation",
          pattern: "(?i)(?:foo|bar)+",
        },
      ],
    }),
  );

  assert.match(result.value, /Authorization: \[REDACTED:generic_bearer_token:[a-f0-9]{12}\]/u);
  assert.match(result.value, /\[REDACTED:internal_token:[a-f0-9]{12}\]/u);
  assert.match(result.value, /\[REDACTED:safe_alternation:[a-f0-9]{12}\]/u);
  assert.match(result.value, /\[REDACTED:safe_quantified_alternation:[a-f0-9]{12}\]/u);
});

test("custom redaction budgets accept exact boundaries and fail closed one unit beyond them", () => {
  const maximumName = "n".repeat(CUSTOM_REDACTION_PATTERN_NAME_MAX_CHARS);
  const replacement = formatCustomReplacement(maximumName, "x", tenantSaltSource);
  assert.equal(replacement.length, MAX_CUSTOM_REDACTION_REPLACEMENT_CHARS);
  assert.equal(
    formatCustomReplacement(`${maximumName}sensitive-suffix`, "x", tenantSaltSource).length,
    MAX_CUSTOM_REDACTION_REPLACEMENT_CHARS,
  );

  const overNameResult = redactValue(
    "x",
    defaultOptions({
      pathMode: "full",
      customRedactionPatterns: [{ name: `${maximumName}n`, pattern: "x" }],
    }),
  );
  assert.equal(overNameResult.dropped, true);
  assert.equal(overNameResult.value, undefined);
  assert.deepEqual(overNameResult.failureMetrics, { redactionFailures: 1 });
  assert.deepEqual(overNameResult.errors, [
    `Custom redaction pattern at index 0 was rejected: Custom redaction pattern names are limited to ${CUSTOM_REDACTION_PATTERN_NAME_MAX_CHARS} characters.`,
  ]);

  const maximumInputResult = redactValue(
    "q".repeat(DEFAULT_MAX_INPUT_CHARS),
    defaultOptions({
      pathMode: "full",
      customRedactionPatterns: [{ name: maximumName, pattern: "x" }],
      maxOutputChars: DEFAULT_MAX_INPUT_CHARS,
    }),
  );
  assert.equal(maximumInputResult.dropped, false);
  assert.equal(maximumInputResult.value?.length, DEFAULT_MAX_INPUT_CHARS);

  const exactMatchResult = redactValue(
    "x".repeat(MAX_CUSTOM_REDACTION_MATCHES),
    defaultOptions({
      pathMode: "full",
      customRedactionPatterns: [{ name: maximumName, pattern: "x" }],
      maxOutputChars: MAX_CUSTOM_REDACTION_INTERMEDIATE_CHARS,
    }),
  );
  assert.equal(exactMatchResult.dropped, false);
  assert.equal(exactMatchResult.value?.length, MAX_CUSTOM_REDACTION_MATCHES * replacement.length);

  const truncatedMatchResult = redactValue(
    "xx",
    defaultOptions({
      pathMode: "full",
      customRedactionPatterns: [{ name: maximumName, pattern: "x" }],
      maxOutputChars: replacement.length,
    }),
  );
  assert.equal(truncatedMatchResult.dropped, false);
  assert.equal(truncatedMatchResult.truncated, true);
  assert.equal(truncatedMatchResult.originalLength, 2 * replacement.length);
  assert.equal(truncatedMatchResult.value?.length, replacement.length);

  const overMatchResult = redactValue(
    "x".repeat(MAX_CUSTOM_REDACTION_MATCHES + 1),
    defaultOptions({
      pathMode: "full",
      customRedactionPatterns: [{ name: maximumName, pattern: "x" }],
    }),
  );
  assert.equal(overMatchResult.dropped, true);
  assert.equal(overMatchResult.value, undefined);
  assert.deepEqual(overMatchResult.failureMetrics, { redactionFailures: 1 });
  assert.deepEqual(overMatchResult.errors, ["custom redaction budget exceeded"]);
  assert.equal(overMatchResult.stages.includes("hashing"), false);

  const exactOutputInputLength = MAX_CUSTOM_REDACTION_INTERMEDIATE_CHARS - replacement.length + 1;
  const exactOutputInput = `${"q".repeat(exactOutputInputLength - 1)}x`;
  const exactOutputResult = redactValue(
    exactOutputInput,
    defaultOptions({
      pathMode: "full",
      customRedactionPatterns: [{ name: maximumName, pattern: "x" }],
      maxOutputChars: MAX_CUSTOM_REDACTION_INTERMEDIATE_CHARS,
    }),
  );
  assert.equal(exactOutputResult.dropped, false);
  assert.equal(exactOutputResult.value?.length, MAX_CUSTOM_REDACTION_INTERMEDIATE_CHARS);

  const overOutputResult = redactValue(
    `q${exactOutputInput}`,
    defaultOptions({
      pathMode: "full",
      customRedactionPatterns: [{ name: maximumName, pattern: "x" }],
    }),
  );
  assert.equal(overOutputResult.dropped, true);
  assert.equal(overOutputResult.value, undefined);
  assert.deepEqual(overOutputResult.failureMetrics, { redactionFailures: 1 });
  assert.deepEqual(overOutputResult.errors, ["custom redaction budget exceeded"]);
});

test("worst-case broad custom redaction stays within explicit time, memory, and match budgets", () => {
  const child = runWorstCaseBroadPatternInChild();

  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
  const summary = JSON.parse(child.stdout);
  assert.deepEqual(summary, {
    dropped: true,
    hasValue: false,
    failures: 1,
    errors: ["custom redaction budget exceeded"],
    elapsedMs: summary.elapsedMs,
  });
  assert.ok(summary.elapsedMs < 3_000, `broad-pattern budget took ${summary.elapsedMs}ms`);
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

test("ambiguous quantified alternation redactors fail closed without evaluating captured content", () => {
  const rawValue = `${"a".repeat(64)}! raw content must not export`;
  const result = redactValue(
    rawValue,
    defaultOptions({
      customRedactionPatterns: [{ name: "ambiguous", pattern: "^(?:a|aa)+$" }],
    }),
  );

  assert.equal(result.dropped, true);
  assert.equal(result.value, undefined);
  assert.equal(result.failureMetrics.redactionFailures, 1);
  assert.match(result.errors[0], /alternatives must begin with provably disjoint characters/u);
  assert.equal(result.errors.some(error => error.includes(rawValue)), false);
});

test("overlapping sequential repetitions fail closed without exporting raw content", () => {
  const rawValue = `${"a".repeat(64)}! adjacent repetition content must not export`;
  const result = redactValue(
    rawValue,
    defaultOptions({
      customRedactionPatterns: [{ name: "overlapping", pattern: "^a+a+$" }],
    }),
  );

  assert.equal(result.dropped, true);
  assert.equal(result.value, undefined);
  assert.equal(result.failureMetrics.redactionFailures, 1);
  assert.match(result.errors[0], /repetitions with overlapping starting characters/u);
  assert.equal(result.errors.some(error => error.includes(rawValue)), false);
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
