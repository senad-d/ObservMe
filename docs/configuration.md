# ObservMe configuration

ObservMe creates a project-local starter config automatically on startup.

## Automatic project config

When the extension starts in a trusted Pi project, it creates:

```text
.pi/observme.yaml
```

The file is created only when it is missing. Existing project config is never overwritten. The generated file mirrors the local debug profile, including content-capture settings, so review `capture` and `privacy` before sharing the file or using it in production.

## What to edit

Edit `.pi/observme.yaml` in the project where you run Pi:

- `otlp.endpoint` and `otlp.signalEndpoints` — your OpenTelemetry Collector URLs.
- `resource.attributes` — service name, project name, tenant, and deployment environment labels.
- `capture` — whether prompts, responses, thinking, tool data, bash data, and file paths are exported.
- `privacy` — redaction, unsafe-capture acknowledgement, insecure transport, hash salt env var, and path handling.
- `query.grafana` — Grafana URL, datasource UIDs, TLS, and IPv4 transport settings for `/obs` query commands.
- `query.links.traceUrlTemplate` — the Grafana Explore trace-link template used by `/obs trace` and `/obs link`.

Keep credentials out of YAML. Reference environment variables such as `OBSERVME_OTLP_TOKEN`, `OBSERVME_GRAFANA_TOKEN`, `OBSERVME_GRAFANA_PASSWORD`, and `OBSERVME_HASH_SALT`, then set those values in the shell or a trusted project `.env` file.

## Precedence

Configuration is merged in this order:

```text
defaults → global ~/.pi/agent/observme.yaml → trusted project .pi/observme.yaml → trusted project .env → system environment variables → runtime options
```

Use `~/.pi/agent/observme.yaml` for global defaults that should apply across projects. Use `.pi/observme.yaml` for per-project setup.
