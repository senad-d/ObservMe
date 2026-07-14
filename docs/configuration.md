# ObservMe configuration

Use this guide for routine project setup. For every supported key and environment variable, see the [complete configuration reference](reference/12-configuration-reference.md). For the supported local profile, see the [example guide](../examples/README.md).

ObservMe creates a project-local starter config automatically during trusted Pi session-start lifecycles.

## Automatic project config

When Pi emits `session_start` in a trusted project, ObservMe creates `observme.yaml` under Pi's exported project config directory:

```text
<CONFIG_DIR_NAME>/observme.yaml
```

The standard Pi distribution currently resolves this to `.pi/observme.yaml`. ObservMe resolves the absolute target under the trusted project root and serializes the complete existence-check/create/write window through Pi's file-mutation queue. Pi emits `session_start` for startup, `/reload`, new-session, resume, and fork flows. ObservMe intentionally runs the same idempotent bootstrap for each trusted flow so session replacement and reloads converge on the same project-local config state. The file is created only when it is missing; concurrent starts create it at most once, existing project config is never overwritten, and no repeat notification is shown. Bootstrap is skipped when the project is untrusted or Pi does not provide a project `ctx.cwd`. The generated file is privacy-preserving: raw prompt, response, thinking, tool, bash, and file-path capture starts disabled, redaction starts enabled, and unsafe capture starts disabled.

## What to edit

Edit the project config file (`.pi/observme.yaml` in the standard distribution) where you run Pi:

- `otlp.endpoint` and `otlp.signalEndpoints` — absolute HTTP(S) OpenTelemetry Collector URLs. Base endpoints may include an intentional path; ObservMe appends one `/v1/{signal}` suffix with URL pathname semantics. Signal-specific endpoints must already end in the matching signal path. Keep credentials in `otlp.headers`; endpoint userinfo, unresolved placeholders, queries, and fragments are rejected.
- `resource.attributes` — service name, project name, tenant, and deployment environment labels.
- `capture` — whether prompts, responses, thinking, tool data, bash data, and file paths are exported. For local debugging, set only the specific fields you need to `true`.
- `privacy` — redaction, unsafe-capture acknowledgement, insecure transport, hash salt env var, and path handling. Keep `redactionEnabled: true`; set `allowUnsafeCapture: true` only when you intentionally accept unredacted sensitive-content export from this trusted project. Live telemetry and `/obs backfill` use the same policy: disabled capture omits content, enabled redaction redacts then truncates, redaction failures drop content, and `redactionEnabled: false` with `allowUnsafeCapture: true` exports raw truncated content.
- `query.grafana` — Grafana URL, datasource UIDs, TLS, and IPv4 transport settings for `/obs` query commands.
- `query.links.traceUrlTemplate` — the canonical Grafana Explore trace-link template used by `/obs session`, `/obs trace`, and `/obs link`; use `{traceId}`, `{{traceId}}`, `${traceId}`, or `%TRACE_ID%`, or keep the generated `...` structured fallback.
- `metrics.activeAgentLeaseDurationMillis` — how long the last exported active-agent lease remains valid. The default is `60000` ms, the supported range is `10000`–`300000` ms, and the value must be at least `(2 * metrics.exportIntervalMillis) + 5000` ms. `OBSERVME_ACTIVE_AGENT_LEASE_DURATION_MS` overrides YAML through the normal precedence rules.

The shipped dashboards and alerts combine a positive `observme_active_agents` lifecycle claim with a current lease; raw active-claim sums are diagnostic only after an ungraceful exit. Clean shutdown reaches zero after normal export/scrape propagation. Crash, `SIGKILL`, forced GitHub Actions cancellation, or runner loss converges within the lease plus up to 5 seconds of supported clock skew and one Prometheus scrape/evaluation interval, without restarting the Collector. Keep producer and Prometheus clocks synchronized within 5 seconds; GitHub-hosted runners meet this expectation, while self-hosted runners require reliable NTP or an equivalent time service.

Keep credentials out of YAML. Reference environment variables such as `OBSERVME_OTLP_TOKEN`, `OBSERVME_GRAFANA_TOKEN`, `OBSERVME_GRAFANA_PASSWORD`, and `OBSERVME_HASH_SALT`, then set those values in the shell or a trusted project `.env` file. When any content capture flag is enabled with `privacy.redactionEnabled: true`, `OBSERVME_HASH_SALT` must be set before the event occurs; otherwise content capture fails closed and emits `redaction.failed` diagnostics instead of conversation rows.

## Precedence

Configuration is merged in this order:

```text
defaults → global ~/.pi/agent/observme.yaml → trusted project .pi/observme.yaml → trusted project .env → system environment variables → runtime options
```

Use `~/.pi/agent/observme.yaml` for standard-distribution global defaults that should apply across projects. Use `<CONFIG_DIR_NAME>/observme.yaml` for per-project setup. Because `.env` and system environment variables have higher precedence than YAML, remove or update stale `OBSERVME_REDACTION_ENABLED`, `OBSERVME_ALLOW_UNSAFE_CAPTURE`, and `OBSERVME_CAPTURE_*` overrides when YAML privacy settings appear to be ignored.

Invalid or unsafe merged configuration falls back to safe defaults. `/obs status`, structured `config.rejected` telemetry, and Pi UI notifications when available report only bounded source and issue codes/counts; rejected values, paths, headers, regular expressions, and credentials are never rendered. Project `.env` remains a configuration layer only and cannot establish parent-agent lineage.

## Related documentation

- [Documentation index](README.md)
- [Example configurations](../examples/README.md)
- [Security, privacy, and redaction](reference/06-security-privacy-redaction.md)
- [Grafana and `/obs` validation flow](validation-flow.md)
- [Canonical active-agent queries and raw-query migration](reference/09-dashboards-alerts-slos.md#131-canonical-active-agent-promql)
- [Active-lease deployment and troubleshooting runbook](reference/11-deployment-runbooks.md)
