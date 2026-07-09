export interface ObsCommandCompletion {
  readonly value: string;
  readonly label: string;
}

export interface ObsSubcommandArgsParseResult {
  readonly matched: boolean;
  readonly values: readonly string[];
}

export function tokenizeObsCommandArgs(args: string): string[] {
  // /obs uses deterministic whitespace tokenization only; quoted-like text is not shell-parsed.
  return args.trim().split(/\s+/u).filter(isNonEmptyString);
}

export function firstObsCommandToken(args: string): string | undefined {
  return tokenizeObsCommandArgs(args)[0]?.toLowerCase();
}

export function parseObsSubcommandArgs(args: string, subcommand: string): ObsSubcommandArgsParseResult {
  const [rawSubcommand, ...values] = tokenizeObsCommandArgs(args);
  return { matched: rawSubcommand?.toLowerCase() === subcommand, values };
}

export function isExactObsSubcommandRequest(args: string, subcommand: string, options: { allowEmpty?: boolean } = {}): boolean {
  const tokens = tokenizeObsCommandArgs(args);
  if (tokens.length === 0) return options.allowEmpty === true;
  const [rawSubcommand, ...rest] = tokens;
  return rawSubcommand.toLowerCase() === subcommand && rest.length === 0;
}

export function completeObsSubcommands(prefix: string, subcommands: readonly string[]): ObsCommandCompletion[] | null {
  const normalizedPrefix = prefix.trim().toLowerCase();
  const completions = subcommands
    .filter(subcommand => subcommand.startsWith(normalizedPrefix))
    .map(subcommand => ({ value: subcommand, label: subcommand }));

  return completions.length > 0 ? completions : null;
}

export function completeObsSubcommand(prefix: string, subcommand: string): ObsCommandCompletion[] | null {
  return completeObsSubcommands(prefix, [subcommand]);
}

export function obsUsageWithError(usage: string, error: string | undefined): string {
  return error ? `${usage}\n${error}` : usage;
}

export function unknownObsArgumentMessage(token: string): string {
  return `Unknown argument: ${token}.`;
}

export function unknownObsOptionMessage(token: string): string {
  return `Unknown option: ${token}.`;
}

export function missingObsOptionValueMessage(option: string): string {
  return `Missing value for ${option}.`;
}

function isNonEmptyString(value: string): boolean {
  return value.length > 0;
}
