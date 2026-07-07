import assert from "node:assert/strict";
import test from "node:test";
import {
  SECRET_PATTERN_DEFINITIONS,
  SECRET_TYPES,
  formatSecretRedaction,
  matchAllSecretPatterns,
  matchAnthropicLikeKeys,
  matchApiKeyAssignments,
  matchAwsAccessKeyIds,
  matchGenericBearerTokens,
  matchGitHubTokens,
  matchOpenAiLikeKeys,
  matchPasswordAssignments,
  matchPrivateKeyBlocks,
  matchSlackTokens,
  matchUrlCredentials,
} from "../src/privacy/secret-patterns.ts";

const syntheticAlphaNumeric = "A".repeat(20);
const syntheticTokenBody = "abc123_ABC".repeat(4);
const syntheticLongBearer = "abc123._-".repeat(4);
const syntheticSlackBody = "T".repeat(12);
const syntheticGitHubBody = "A".repeat(36);
const syntheticGitHubPatBody = "B".repeat(30);

const patternCases = [
  {
    name: "awsAccessKeyId",
    type: SECRET_TYPES.AWS_ACCESS_KEY_ID,
    matcher: matchAwsAccessKeyIds,
    positive: `credential AKIA${"1".repeat(16)} found`,
    negative: `credential AKIA${"1".repeat(15)} too-short`,
  },
  {
    name: "genericBearerToken",
    type: SECRET_TYPES.GENERIC_BEARER_TOKEN,
    matcher: matchGenericBearerTokens,
    positive: `Authorization: Bearer ${syntheticLongBearer}`,
    negative: "Authorization: Bearer short-token",
  },
  {
    name: "githubToken",
    type: SECRET_TYPES.GITHUB_TOKEN,
    matcher: matchGitHubTokens,
    positive: `github token ghp_${syntheticGitHubBody}`,
    negative: `github token ghp_${"A".repeat(12)}`,
  },
  {
    name: "openAiLikeKey",
    type: SECRET_TYPES.OPENAI_LIKE_KEY,
    matcher: matchOpenAiLikeKeys,
    positive: `openai key sk-${syntheticTokenBody}`,
    negative: "openai key sk-short",
  },
  {
    name: "anthropicLikeKey",
    type: SECRET_TYPES.ANTHROPIC_LIKE_KEY,
    matcher: matchAnthropicLikeKeys,
    positive: `anthropic key sk-ant-${syntheticTokenBody}`,
    negative: "anthropic key sk-ant-short",
  },
  {
    name: "slackToken",
    type: SECRET_TYPES.SLACK_TOKEN,
    matcher: matchSlackTokens,
    positive: `slack token xoxb-${syntheticSlackBody}`,
    negative: "slack token xoxb-short",
  },
  {
    name: "privateKeyBlock",
    type: SECRET_TYPES.PRIVATE_KEY_BLOCK,
    matcher: matchPrivateKeyBlocks,
    positive: "-----BEGIN PRIVATE KEY-----\nbody omitted",
    negative: "-----BEGIN PUBLIC KEY-----",
  },
  {
    name: "passwordAssignment",
    type: SECRET_TYPES.PASSWORD_ASSIGNMENT,
    matcher: matchPasswordAssignments,
    positive: "db password: synthetic-value",
    negative: "password field was intentionally omitted",
  },
  {
    name: "apiKeyAssignment",
    type: SECRET_TYPES.API_KEY_ASSIGNMENT,
    matcher: matchApiKeyAssignments,
    positive: "client_secret=synthetic-value",
    negative: "client identifier synthetic-value",
  },
  {
    name: "urlCredentials",
    type: SECRET_TYPES.URL_CREDENTIALS,
    matcher: matchUrlCredentials,
    positive: "remote https://user:synthetic-pass@example.invalid/repo.git",
    negative: "remote https://example.invalid/repo.git",
  },
];

const expectedPatternNames = patternCases.map(patternCase => patternCase.name).sort((left, right) =>
  left.localeCompare(right),
);

function assertPositiveMatch(patternCase) {
  const matches = patternCase.matcher(patternCase.positive);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].type, patternCase.type);
  assert.equal(matches[0].patternName, patternCase.name);
  assert.equal(patternCase.positive.slice(matches[0].start, matches[0].end), matches[0].value);
}

function assertNegativeMatch(patternCase) {
  assert.deepEqual(patternCase.matcher(patternCase.negative), []);
}

test("exports one named matcher definition for every documented pattern category", () => {
  const actualPatternNames = SECRET_PATTERN_DEFINITIONS.map(definition => definition.name).sort((left, right) =>
    left.localeCompare(right),
  );
  assert.deepEqual(actualPatternNames, expectedPatternNames);
});

test("positive corpus covers every documented pattern category", () => {
  for (const patternCase of patternCases) assertPositiveMatch(patternCase);
});

test("negative corpus covers every documented pattern category", () => {
  for (const patternCase of patternCases) assertNegativeMatch(patternCase);
});

test("GitHub token matcher covers github_pat tokens", () => {
  const matches = matchGitHubTokens(`github_pat_${syntheticGitHubPatBody}`);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].type, SECRET_TYPES.GITHUB_TOKEN);
});

test("combined matcher returns structured metadata for redaction replacements", () => {
  const value = `prefix token=${syntheticAlphaNumeric} suffix`;
  const matches = matchAllSecretPatterns(value);
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0], {
    type: SECRET_TYPES.API_KEY_ASSIGNMENT,
    patternName: "apiKeyAssignment",
    value: `token=${syntheticAlphaNumeric}`,
    start: "prefix ".length,
    end: `prefix token=${syntheticAlphaNumeric}`.length,
  });
  assert.equal(formatSecretRedaction(matches[0], "abcdef123456"), "[REDACTED:api_key_assignment:abcdef123456]");
});
