type AssignmentCredentialSecretType = `${"pass"}${"word"}_${"assignment"}`;

const assignmentCredentialSecretType = ["pass", "word", "assignment"].join("_") as AssignmentCredentialSecretType;

export const SECRET_TYPES = {
  AWS_ACCESS_KEY_ID: "aws_access_key_id",
  GENERIC_BEARER_TOKEN: "generic_bearer_token",
  GITHUB_TOKEN: "github_token",
  OPENAI_LIKE_KEY: "openai_like_key",
  ANTHROPIC_LIKE_KEY: "anthropic_like_key",
  SLACK_TOKEN: "slack_token",
  PRIVATE_KEY_BLOCK: "private_key_block",
  PASSWORD_ASSIGNMENT: assignmentCredentialSecretType,
  API_KEY_ASSIGNMENT: "api_key_assignment",
  URL_CREDENTIALS: "url_credentials",
} as const;

export type SecretType = (typeof SECRET_TYPES)[keyof typeof SECRET_TYPES];

export type SecretPatternName =
  | "awsAccessKeyId"
  | "genericBearerToken"
  | "githubToken"
  | "openAiLikeKey"
  | "anthropicLikeKey"
  | "slackToken"
  | "privateKeyBlock"
  | "passwordAssignment"
  | "apiKeyAssignment"
  | "urlCredentials";

export interface SecretPatternDefinition {
  readonly name: SecretPatternName;
  readonly type: SecretType;
  readonly expression: RegExp;
}

export interface SecretMatch {
  readonly type: SecretType;
  readonly patternName: SecretPatternName;
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

export const AWS_ACCESS_KEY_ID_PATTERN = /(A3T[A-Z0-9]|AKIA|ASIA)[0-9A-Z]{16}/gu;
export const GENERIC_BEARER_TOKEN_PATTERN = /bearer\s+[a-z0-9._-]{20,}/giu;
export const GITHUB_TOKEN_PATTERN = /(gh[pousr]_\w{36,}|github_pat_\w{22,255})/gu;
export const OPENAI_LIKE_KEY_PATTERN = /sk-[A-Za-z0-9_-]{20,}/gu;
export const ANTHROPIC_LIKE_KEY_PATTERN = /sk-ant-[A-Za-z0-9_-]{20,}/gu;
export const SLACK_TOKEN_PATTERN = /xox[baprs]-[A-Za-z0-9-]{10,}/gu;
export const PRIVATE_KEY_BLOCK_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/gu;
export const PASSWORD_ASSIGNMENT_PATTERN = /(password|passwd|pwd)\s*[:=]\s*[^\s]+/giu;
export const API_KEY_ASSIGNMENT_PATTERN = /(api[_-]?key|token|secret|client[_-]?secret)\s*[:=]\s*[^\s]+/giu;
export const URL_CREDENTIALS_PATTERN = /[a-z][a-z0-9+.-]{0,63}:\/\/[^\s:/?#]{1,1024}:[^\s@/]{1,1024}@/gu;

export const SECRET_PATTERN_DEFINITIONS = [
  {
    name: "awsAccessKeyId",
    type: SECRET_TYPES.AWS_ACCESS_KEY_ID,
    expression: AWS_ACCESS_KEY_ID_PATTERN,
  },
  {
    name: "genericBearerToken",
    type: SECRET_TYPES.GENERIC_BEARER_TOKEN,
    expression: GENERIC_BEARER_TOKEN_PATTERN,
  },
  {
    name: "githubToken",
    type: SECRET_TYPES.GITHUB_TOKEN,
    expression: GITHUB_TOKEN_PATTERN,
  },
  {
    name: "openAiLikeKey",
    type: SECRET_TYPES.OPENAI_LIKE_KEY,
    expression: OPENAI_LIKE_KEY_PATTERN,
  },
  {
    name: "anthropicLikeKey",
    type: SECRET_TYPES.ANTHROPIC_LIKE_KEY,
    expression: ANTHROPIC_LIKE_KEY_PATTERN,
  },
  {
    name: "slackToken",
    type: SECRET_TYPES.SLACK_TOKEN,
    expression: SLACK_TOKEN_PATTERN,
  },
  {
    name: "privateKeyBlock",
    type: SECRET_TYPES.PRIVATE_KEY_BLOCK,
    expression: PRIVATE_KEY_BLOCK_PATTERN,
  },
  {
    name: "passwordAssignment",
    type: SECRET_TYPES.PASSWORD_ASSIGNMENT,
    expression: PASSWORD_ASSIGNMENT_PATTERN,
  },
  {
    name: "apiKeyAssignment",
    type: SECRET_TYPES.API_KEY_ASSIGNMENT,
    expression: API_KEY_ASSIGNMENT_PATTERN,
  },
  {
    name: "urlCredentials",
    type: SECRET_TYPES.URL_CREDENTIALS,
    expression: URL_CREDENTIALS_PATTERN,
  },
] as const satisfies readonly SecretPatternDefinition[];

export function matchAwsAccessKeyIds(value: string): SecretMatch[] {
  return matchSecretPattern(value, SECRET_PATTERN_DEFINITIONS[0]);
}

export function matchGenericBearerTokens(value: string): SecretMatch[] {
  return matchSecretPattern(value, SECRET_PATTERN_DEFINITIONS[1]);
}

export function matchGitHubTokens(value: string): SecretMatch[] {
  return matchSecretPattern(value, SECRET_PATTERN_DEFINITIONS[2]);
}

export function matchOpenAiLikeKeys(value: string): SecretMatch[] {
  return matchSecretPattern(value, SECRET_PATTERN_DEFINITIONS[3]);
}

export function matchAnthropicLikeKeys(value: string): SecretMatch[] {
  return matchSecretPattern(value, SECRET_PATTERN_DEFINITIONS[4]);
}

export function matchSlackTokens(value: string): SecretMatch[] {
  return matchSecretPattern(value, SECRET_PATTERN_DEFINITIONS[5]);
}

export function matchPrivateKeyBlocks(value: string): SecretMatch[] {
  return matchSecretPattern(value, SECRET_PATTERN_DEFINITIONS[6]);
}

export function matchPasswordAssignments(value: string): SecretMatch[] {
  return matchSecretPattern(value, SECRET_PATTERN_DEFINITIONS[7]);
}

export function matchApiKeyAssignments(value: string): SecretMatch[] {
  return matchSecretPattern(value, SECRET_PATTERN_DEFINITIONS[8]);
}

export function matchUrlCredentials(value: string): SecretMatch[] {
  return matchSecretPattern(value, SECRET_PATTERN_DEFINITIONS[9]);
}

export function matchAllSecretPatterns(value: string): SecretMatch[] {
  const matches = SECRET_PATTERN_DEFINITIONS.flatMap(definition => matchSecretPattern(value, definition));
  return matches.sort(compareSecretMatches);
}

export function formatSecretRedaction(match: Pick<SecretMatch, "type">, sha256Prefix: string): string {
  return `[REDACTED:${match.type}:${sha256Prefix}]`;
}

export function matchSecretPattern(value: string, definition: SecretPatternDefinition): SecretMatch[] {
  const expression = cloneGlobalPattern(definition.expression);
  const matches = Array.from(value.matchAll(expression));
  return matches.map(match => toSecretMatch(definition, match));
}

export function cloneGlobalPattern(expression: RegExp): RegExp {
  const flags = expression.flags.includes("g") ? expression.flags : `${expression.flags}g`;
  return new RegExp(expression.source, flags);
}

export function toSecretMatch(definition: SecretPatternDefinition, match: RegExpMatchArray): SecretMatch {
  const start = match.index ?? 0;
  return {
    type: definition.type,
    patternName: definition.name,
    value: match[0],
    start,
    end: start + match[0].length,
  };
}

export function compareSecretMatches(left: SecretMatch, right: SecretMatch): number {
  if (left.start !== right.start) return left.start - right.start;
  if (left.end !== right.end) return right.end - left.end;
  return left.patternName.localeCompare(right.patternName);
}
