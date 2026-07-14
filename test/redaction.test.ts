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
const syntheticPemCases = [
  { label: "PRIVATE KEY", body: "UEtDUzhfU1lOVEhFVElDX0JPRFk=" },
  { label: "RSA PRIVATE KEY", body: "UlNBX1NZTlRIRVRJQ19CT0RZ" },
  { label: "EC PRIVATE KEY", body: "RUNfU1lOVEhFVElDX0JPRFk=" },
  { label: "ENCRYPTED PRIVATE KEY", body: "RU5DUllQVEVEX1NZTlRIRVRJQ19CT0RZ" },
];
const tenantSaltSource = {
  secureRuntimeConfig: {
    tenantSalt: "redaction-test-salt",
  },
};

function buildSyntheticPemBlock(label: string, body: string): string {
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
}

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
  ...syntheticPemCases.map(pemCase => ({
    name: `${pemCase.label} blocks`,
    input: buildSyntheticPemBlock(pemCase.label, pemCase.body),
    sensitiveValues: [`-----BEGIN ${pemCase.label}-----`, pemCase.body, `-----END ${pemCase.label}-----`],
  })),
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
    tenantSaltSource,
    ...overrides,
  };
}

function assertNoSensitiveValuesExported(output: string | undefined, sensitiveValues: readonly string[]): void {
  assert.ok(output, "redaction output should be present");
  assert.match(output, /\[REDACTED:/u);
  for (const sensitiveValue of sensitiveValues) assert.doesNotMatch(output, escapeForRegExp(sensitiveValue));
}

function escapeForRegExp(value: string): RegExp {
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

test("redaction pipeline replaces complete private-key blocks with bounded metadata", () => {
  for (const pemCase of syntheticPemCases) {
    const result = redactValue(buildSyntheticPemBlock(pemCase.label, pemCase.body), defaultOptions());

    assert.equal(result.dropped, false);
    assert.match(result.value ?? "", /^\[REDACTED:private_key_block:[a-f0-9]{12}\]$/u);
  }
});

test("redaction pipeline fails closed for truncated or mismatched private-key blocks", () => {
  const malformedCases = [
    {
      input: "prefix\n-----BEGIN PRIVATE KEY-----\nVFJVTkNBVEVEX1NZTlRIRVRJQ19CT0RZ",
      sensitiveValues: ["-----BEGIN PRIVATE KEY-----", "VFJVTkNBVEVEX1NZTlRIRVRJQ19CT0RZ"],
    },
    {
      input:
        "prefix\n-----BEGIN RSA PRIVATE KEY-----\nTUlTTUFUQ0hFRF9TWU5USEVUSUNfQk9EWQ==\n-----END EC PRIVATE KEY-----\ntrailing text",
      sensitiveValues: [
        "-----BEGIN RSA PRIVATE KEY-----",
        "TUlTTUFUQ0hFRF9TWU5USEVUSUNfQk9EWQ==",
        "-----END EC PRIVATE KEY-----",
        "trailing text",
      ],
    },
  ];

  for (const malformedCase of malformedCases) {
    const result = redactValue(malformedCase.input, defaultOptions());

    assert.equal(result.dropped, false);
    assert.match(result.value ?? "", /^prefix\n\[REDACTED:private_key_block:[a-f0-9]{12}\]$/u);
    assertNoSensitiveValuesExported(result.value, malformedCase.sensitiveValues);
  }
});

test("redaction pipeline does not classify public-key PEM blocks as private keys", () => {
  const publicKey = "-----BEGIN PUBLIC KEY-----\nUFVCTElDX0tFWV9CT0RZ\n-----END PUBLIC KEY-----";
  const result = redactValue(publicKey, defaultOptions());

  assert.equal(result.dropped, false);
  assert.equal(result.value, publicKey);
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

test("redaction pipeline scrubs cross-platform filesystem paths without exporting raw prefixes", () => {
  const paths = [
    "/home/alice/projects/customer-x/app.ts",
    "/workspace/project/file.ts",
    "/etc/hosts",
    "C:\\Users\\alice\\secret.txt",
    "\\\\server\\share\\private\\README.md",
  ];
  const input = `open ${paths.join(" and ")}`;
  const result = redactValue(input, defaultOptions({ pathMode: "basename" }));

  assert.equal(result.dropped, false);
  assert.equal(result.value, "open app.ts and file.ts and hosts and secret.txt and README.md");
  for (const path of paths) assert.equal(result.value?.includes(path), false);
});

test("redaction pipeline does not mistake URLs or slash-separated prose for filesystem paths", () => {
  const input = "read https://example.invalid/docs/setup and compare yes/no with 1/2";
  const result = redactValue(input, defaultOptions({ pathMode: "drop" }));

  assert.equal(result.dropped, false);
  assert.equal(result.value, input);
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
  assert.match(result.value ?? "", /\[REDACTED:email:[a-f0-9]{12}\]/u);
  assert.doesNotMatch(result.value ?? "", /alice@example\.invalid/u);
});

test("redaction pipeline truncates oversized content before export", () => {
  const oversizedContent = `safe-prefix-${"x".repeat(64)}-sensitive-tail`;
  const result = redactValue(oversizedContent, defaultOptions({ maxOutputChars: 16 }));

  assert.equal(result.dropped, false);
  assert.equal(result.truncated, true);
  assert.equal(result.originalLength, oversizedContent.length);
  assert.equal(result.value?.length, 16);
  assert.doesNotMatch(result.value ?? "", /sensitive-tail/u);
  assert.match(result.hash ?? "", /^[a-f0-9]{64}$/u);
});
