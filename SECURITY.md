# Security Policy

ObservMe is a Pi extension that instruments Pi agent sessions and exports OpenTelemetry traces, metrics, and logs to an external observability stack such as an OpenTelemetry Collector, Grafana Tempo, Loki, Prometheus, Mimir, or Grafana Cloud. This policy summarizes the implemented trust model; see `docs/reference/06-security-privacy-redaction.md` for the full security, privacy, and redaction specification.

## Trust model

Pi packages and extensions run with the full local permissions of the user account that starts Pi. Review extension source before installing it, pin versions in sensitive environments, and install only from trusted sources.

```bash
pi install npm:@senad-d/observme@<version>
pi install git:senad-d/ObservMe@<tag>
```

ObservMe is implemented to:

- Never execute shell commands itself; it only observes tool/bash execution events emitted by Pi.
- Read Pi session/event data through Pi extension APIs, with no continuous full-session-file tailing.
- Start OTEL exporters only from `session_start` and stop them from `session_shutdown` with bounded flush/shutdown timeouts.
- Send telemetry only to configured OTLP endpoints, with an OpenTelemetry Collector recommended for production.
- Disable prompt, response, thinking, tool-argument, tool-result, bash-command, bash-output, and file-path capture by default.
- Redact secrets, optional PII, POSIX/Windows-drive/UNC absolute paths, URL credentials, custom configured patterns, and oversized content before optional content export; normal URLs and harmless slash-separated prose are not treated as filesystem paths. Custom regex redactors are bounded and reject unsupported risky constructs such as nested quantified groups, lookaround, named groups, and backreferences.
- Accept child-agent lineage only from a complete validated Pi process-environment envelope (or controlled runtime override), never from trusted project `.env`; malformed, partial, oversized, or stale values fail open without exposing inherited values.
- Keep session IDs, workflow IDs, agent IDs, trace/span IDs, raw paths, raw commands, raw prompts, and raw errors out of Prometheus metric labels.
- Fail open: Pi keeps running if the Collector, Grafana, Tempo, Loki, or Prometheus backend is unreachable.
- Require explicit user confirmation for `/obs backfill` historical replay and mark replayed telemetry with `observme.replayed=true`.

## Reporting vulnerabilities

Please report suspected security vulnerabilities privately by email: <senad.dizdarevic@proton.me>.

For non-sensitive issues, use the repository issue tracker:

<https://github.com/senad-d/ObservMe/issues>

Do not open public issues for security-sensitive reports that include exploit details, private repository contents, secrets, or credentials.

## Secure development checklist

- Do not commit secrets, tokens, local `.pi/` state, or generated artifacts.
- Document any file, shell, network, or credential access added by the extension.
- Avoid starting background resources in the extension factory; start them from `session_start` and stop them from `session_shutdown`.
- Keep package contents minimal with `npm run check:pack`.
- Use isolated smoke tests with `pi --no-extensions -e .`.
- Keep default telemetry capture settings privacy-preserving; changing any default capture flag to `true` requires explicit review.
- Run `npm run validate` before release and after security-sensitive changes.
