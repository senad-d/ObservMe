# Security Policy

ObservMe is a Pi extension that instruments Pi agent sessions and exports OpenTelemetry traces, metrics, and logs to an external observability stack (OTel Collector, Grafana Tempo/Loki/Prometheus). This policy describes ObservMe's trust model at the current preparation stage; see `ObservMe-Production-Docs/06-security-privacy-redaction.md` for the full production security/privacy/redaction specification.

## Trust model

Pi packages and extensions run with the full local permissions of the user account that starts Pi. Review extension source before installing it, pin versions in sensitive environments, and install only from trusted sources.

```bash
pi install npm:@senad-d/observme@<version>
pi install git:senad-d/ObservMe@<tag>
```

When implemented, ObservMe is designed to:

- Never execute shell commands itself (it only observes tool/bash execution events).
- Read Pi session/event data only through documented Pi extension APIs; no continuous file tailing.
- Send telemetry only to configured OTLP endpoints (OTel Collector by default, direct backend only in development).
- Disable prompt, response, thinking, tool-argument, tool-result, bash-command, bash-output, and file-path capture by default.
- Redact secrets, PII, and paths before any optional content export.
- Fail open: Pi must keep running even if the observability backend is unreachable.

## Reporting vulnerabilities

Please report suspected security vulnerabilities privately by email: <senad.dizdarevic@proton.me>.

For non-sensitive issues, use the repository issue tracker:

<https://github.com/senad-d/ObservMe/issues>

Do not open public issues for security-sensitive reports that include exploit details, private repository contents, secrets, or credentials.

## Secure development checklist

- Do not commit secrets, tokens, local `.pi/` state, or generated artifacts.
- Document any file, shell, network, or credential access added by the extension.
- Avoid starting background resources (OTEL SDK, exporters, timers) in the extension factory; start them from `session_start` and stop them from `session_shutdown`.
- Keep package contents minimal with `npm run check:pack`.
- Use isolated smoke tests with `pi --no-extensions -e .`.
- Keep default telemetry capture settings privacy-preserving; changing any default capture flag to `true` requires explicit review.
