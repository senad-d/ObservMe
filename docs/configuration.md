# ObservMe configuration

ObservMe creates a project-local starter config automatically during trusted Pi session-start lifecycles.

## Automatic project config

When Pi emits `session_start` in a trusted project, ObservMe creates:

```text
.pi/observme.yaml
```

Pi emits `session_start` for startup, `/reload`, new-session, resume, and fork flows. ObservMe intentionally runs the same idempotent bootstrap for each trusted flow so session replacement and reloads converge on the same project-local config state. The file is created only when it is missing; existing project config is never overwritten and no repeat notification is shown. Bootstrap is skipped when the project is untrusted or Pi does not provide a project `ctx.cwd`. The generated file is privacy-preserving: raw prompt, response, thinking, tool, bash, and file-path capture starts disabled, redaction starts enabled, and unsafe capture starts disabled.

## What to edit

Edit `.pi/observme.yaml` in the project where you run Pi:

- `otlp.endpoint` and `otlp.signalEndpoints` — your OpenTelemetry Collector URLs.
- `resource.attributes` — service name, project name, tenant, and deployment environment labels.
- `capture` — whether prompts, responses, thinking, tool data, bash data, and file paths are exported. For local debugging, set only the specific fields you need to `true`.
- `privacy` — redaction, unsafe-capture acknowledgement, insecure transport, hash salt env var, and path handling. Keep `redactionEnabled: true`; set `allowUnsafeCapture: true` only when you intentionally accept unredacted sensitive-content export from this trusted project. Live telemetry and `/obs backfill` use the same policy: disabled capture omits content, enabled redaction redacts then truncates, redaction failures drop content, and `redactionEnabled: false` with `allowUnsafeCapture: true` exports raw truncated content.
- `query.grafana` — Grafana URL, datasource UIDs, TLS, and IPv4 transport settings for `/obs` query commands.
- `query.links.traceUrlTemplate` — the Grafana Explore trace-link template used by `/obs trace` and `/obs link`.

Keep credentials out of YAML. Reference environment variables such as `OBSERVME_OTLP_TOKEN`, `OBSERVME_GRAFANA_TOKEN`, `OBSERVME_GRAFANA_PASSWORD`, and `OBSERVME_HASH_SALT`, then set those values in the shell or a trusted project `.env` file.

## Precedence

Configuration is merged in this order:

```text
defaults → global ~/.pi/agent/observme.yaml → trusted project .pi/observme.yaml → trusted project .env → system environment variables → runtime options
```

Use `~/.pi/agent/observme.yaml` for global defaults that should apply across projects. Use `.pi/observme.yaml` for per-project setup.
