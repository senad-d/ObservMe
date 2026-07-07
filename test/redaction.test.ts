import assert from "node:assert/strict";
import test from "node:test";
import type { RedactionOptions } from "../src/privacy/redact.ts";
import { redactValue } from "../src/privacy/redact.ts";

const syntheticAwsKey = `AKIA${"1".repeat(16)}`;
const syntheticBearerToken = "abc123._-".repeat(4);
const syntheticGitHubToken = `ghp_${"A".repeat(36)}`;
const syntheticOpenAiKey = `sk-${"abc123_ABC".repeat(4)}`;
const syntheticAnthropicKey = `sk-ant-${"abc123_ABC".repeat(4)}`;
const syntheticSlackToken = `xoxb-${"T".repeat(12)}`;

const secretCategoryCases = [
  {
    name: "AWS keys",
    input: `AWS_ACCESS_KEY_ID=${syntheticAwsKey}`,
    sensitiveValues: [syntheticAwsKey],
  },
  {
    name: "GitHub tokens",
    input: `GITHUB_TOKEN=${syntheticGitHubToken}`,
    sensitiveValues: [syntheticGitHubToken],
  },
  {
    name: "bearer tokens",
    input: `Authorization: Bearer ${syntheticBearerToken}`,
    sensitiveValues: [`Bearer ${syntheticBearerToken}`, syntheticBearerToken],
  },
  {
    name: "OpenAI-like keys",
    input: `OPENAI_API_KEY=${syntheticOpenAiKey}`,
    sensitiveValues: [syntheticOpenAiKey],
  },
  {
    name: "Anthropic-like keys",
    input: `ANTHROPIC_API_KEY=${syntheticAnthropicKey}`,
    sensitiveValues: [syntheticAnthropicKey],
  },
  {
    name: "Slack tokens",
    input: `SLACK_BOT_TOKEN=${syntheticSlackToken}`,
    sensitiveValues: [syntheticSlackToken],
  },
  {
    name: "password assignments",
    input: "database password: synthetic-password-value",
    sensitiveValues: ["synthetic-password-value"],
  },
  {
    name: "private key blocks",
    input: "-----BEGIN PRIVATE KEY-----\nprivate-key-body\n-----END PRIVATE KEY-----",
    sensitiveValues: ["-----BEGIN PRIVATE KEY-----"],
  },
  {
    name: "URL credentials",
    input: "remote https://deploy:synthetic-pass@example.invalid/repo.git",
    sensitiveValues: ["deploy:synthetic-pass", "synthetic-pass"],
  },
];

function defaultOptions(overrides: Partial<RedactionOptions> = {}): RedactionOptions {
  return {
    pathMode: "hash",
    customRedactionPatterns: [],
    ...overrides,
  };
}

function assertNoSensitiveValuesExported(output, sensitiveValues) {
  assert.ok(output, "redaction output should be present");
  assert.match(output, /\[REDACTED:/u);
  for (const sensitiveValue of sensitiveValues) assert.doesNotMatch(output, escapeForRegExp(sensitiveValue));
}

function escapeForRegExp(value) {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u");
}

test("redaction pipeline covers every documented secret category without exporting raw secrets", () => {
  for (const redactionCase of secretCategoryCases) {
    const result = redactValue(redactionCase.input, defaultOptions());

    assert.equal(result.dropped, false, `${redactionCase.name} should redact without dropping the field`);
    assert.equal(result.failureMetrics.redactionFailures, 0, `${redactionCase.name} should not fail redaction`);
    assertNoSensitiveValuesExported(result.value, redactionCase.sensitiveValues);
  }
});

test("redaction pipeline sanitizes environment variable dumps", () => {
  const envDump = [
    `AWS_ACCESS_KEY_ID=${syntheticAwsKey}`,
    `GITHUB_TOKEN=${syntheticGitHubToken}`,
    "DATABASE_PASSWORD=synthetic-env-password",
    `OPENAI_API_KEY=${syntheticOpenAiKey}`,
    "APP_CONFIG=/Users/alice/work/acme-secret/.env",
  ].join("\n");

  const result = redactValue(envDump, defaultOptions());

  assert.equal(result.dropped, false);
  assertNoSensitiveValuesExported(result.value, [
    syntheticAwsKey,
    syntheticGitHubToken,
    "synthetic-env-password",
    syntheticOpenAiKey,
    "/Users/alice/work/acme-secret",
  ]);
});

test("redaction pipeline scrubs filesystem paths without exporting raw path prefixes", () => {
  const input = "open /home/alice/projects/customer-x/app.ts and /Users/bob/work/private-repo/README.md";
  const result = redactValue(input, defaultOptions({ pathMode: "basename" }));

  assert.equal(result.dropped, false);
  assert.equal(result.value, "open app.ts and README.md");
  assert.doesNotMatch(result.value, /\/home\/alice/u);
  assert.doesNotMatch(result.value, /\/Users\/bob/u);
});

test("redaction pipeline applies PII detection when explicitly enabled", () => {
  const email = "alice@example.invalid";
  const result = redactValue(
    `contact ${email} for support`,
    defaultOptions({
      piiEnabled: true,
      piiDetector: value => {
        const start = value.indexOf(email);
        return [{ type: "email", value: email, start, end: start + email.length }];
      },
    }),
  );

  assert.equal(result.dropped, false);
  assert.match(result.value, /\[REDACTED:email:[a-f0-9]{12}\]/u);
  assert.doesNotMatch(result.value, /alice@example\.invalid/u);
});

test("redaction pipeline truncates oversized content before export", () => {
  const oversizedContent = `safe-prefix-${"x".repeat(64)}-sensitive-tail`;
  const result = redactValue(oversizedContent, defaultOptions({ maxOutputChars: 16 }));

  assert.equal(result.dropped, false);
  assert.equal(result.truncated, true);
  assert.equal(result.originalLength, oversizedContent.length);
  assert.equal(result.value?.length, 16);
  assert.doesNotMatch(result.value, /sensitive-tail/u);
  assert.match(result.hash ?? "", /^[a-f0-9]{64}$/u);
});
