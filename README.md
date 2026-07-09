<p align="center">
  <img alt="ObservMe icon" src="img/icon.svg" width="128">
</p>

<p align="center">
  <a href="https://pi.dev"><img alt="pi package" src="https://img.shields.io/badge/pi-package-6f42c1?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/@senad-d/observme"><img alt="npm" src="https://img.shields.io/npm/v/%40senad-d%2Fobservme?style=flat-square" /></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
</p>

<p align="center">
  OpenTelemetry observability for <a href="https://pi.dev">pi</a> agent sessions.
  <br />Turns Pi session, turn, tool, LLM, bash, branch, compaction, model, thinking, and agent-lineage events into OTLP traces, metrics, and logs.
</p>

---

ObservMe is a Pi extension for **observability of Pi agent sessions**. It reads Pi extension lifecycle and session events, maps them to OpenTelemetry semantics (`pi.*`/`observme.*` namespaces plus official `gen_ai.*` attributes where they fit), exports them via OTLP to an OpenTelemetry Collector, and is **privacy-preserving by default**: prompts, responses, thinking content, tool arguments/results, bash commands/output, and file paths are not captured unless explicitly enabled and redacted.

<table align="center">
  <tr>
    <th>ObservMe</th>
  </tr>
  <tr>
    <td align="center">
      <img src="img/demo.gif" alt="ObservMe banner" title="ObservMe" width="760">
    </td>
  </tr>
</table>

- **OTLP-first:** emits OpenTelemetry traces, metrics, and logs; no durable local telemetry database.
- **Fail open:** if the Collector or backend is unreachable, Pi keeps running — telemetry is dropped, never blocking.
- **Privacy by default:** optional content capture starts disabled and passes through the redaction pipeline when enabled.
- **Agent lineage aware:** propagates parent/child/root agent identity and W3C trace context across subagent process boundaries without adding high-cardinality identifiers to metric labels.
- **Pi-native:** usable as a Pi package, project-local install, git install, or local source checkout.

> **Security:** Pi packages run with your full system permissions. ObservMe reads Pi session/event data through Pi's extension API, does not execute shell commands itself, and sends telemetry only to configured OTLP endpoints. Read [`SECURITY.md`](SECURITY.md).

## Table of Contents

- [Implementation Status](#implementation-status)
- [Quick Start](#quick-start)
- [Installation](#installation)
- [Commands](#commands)
- [Architecture](#architecture)
- [Configuration and Privacy](#configuration-and-privacy)
- [Safety Model](#safety-model)
- [Dashboards and Examples](#dashboards-and-examples)
- [Documentation Set](#documentation-set)
- [Development](#development)
- [Publishing](#publishing)
- [License](#license)

---

## Implementation Status

This checkout implements the ObservMe MVP scope from the packaged `ObservMe-Production-Docs/00-README.md` design overview:

- Extension load checks and `/obs health` backend checks.
- Session, workflow, agent-run, turn, LLM, tool, bash, subagent-spawn, wait/join, compaction, branch, model-change, and thinking-level telemetry.
- Multi-agent tree metrics for active agents, depth, fan-out, orphan agents, trace-context propagation failures, child failures, and workflow duration.
- Session-scoped OTLP trace, metric, and log exporters with bounded queues, timeouts, and shutdown flushing.
- Configurable capture controls, redaction, path scrubbing, hashing, truncation, and high-cardinality metric-label guards.
- Grafana dashboard JSON, alert rules, SLO definitions, Collector examples, and compatibility matrix artifacts.
- Unit, contract, integration, chaos/failure, performance, package, and smoke-test coverage in the validation pipeline.

The repository version is currently `0.1.0`. Run the validation commands below before publishing or deploying a release build.

## Quick Start

```bash
pi install npm:@senad-d/observme
cd /path/to/your/project
pi
```

Inside Pi:

```text
/obs status
/obs health
/obs session
```

Local source checkout:

```bash
git clone https://github.com/senad-d/ObservMe.git
cd ObservMe
npm ci
npm run validate
pi --no-extensions -e .
```

ObservMe observes the current Pi session and exports telemetry to the configured OTLP endpoint. It never blocks Pi execution when the backend is unavailable.

On the first trusted Pi `session_start` for a project, ObservMe creates `.pi/observme.yaml` if the file is missing. This includes startup, reload, new-session, resume, and fork lifecycles; the bootstrap is idempotent, never overwrites an existing file, skips untrusted or missing project contexts, and notifies only when it creates the starter. Use that project-local file for local-stack setup, then edit the OTLP, resource, capture/privacy, and Grafana query sections for your environment. The starter keeps raw prompt, response, thinking, tool, bash, and path capture disabled by default; opt in only to the specific redacted capture fields you need.

## Installation

| Scope | Command | Notes |
| --- | --- | --- |
| Global | `pi install npm:@senad-d/observme` | Loads in every trusted Pi project. |
| Project-local | `pi install npm:@senad-d/observme -l` | Writes to `.pi/settings.json` in the current project. |
| One run | `pi -e npm:@senad-d/observme` | Try without changing settings. |
| Git | `pi install git:senad-d/ObservMe` | Pin a tag or commit. |
| Local checkout | `pi --no-extensions -e .` | Develop or test this repository. |

## Commands

All commands are registered under `/obs`.

| Command | Description | Backend access |
| --- | --- | --- |
| `/obs status` | Shows local ObservMe enablement, OTLP endpoint, config source/trust status, Grafana query URL/readiness, signal enablement, capture flags, queue drops, and last export error. | Local state only |
| `/obs health` | Checks Collector, Grafana, and configured datasource reachability with bounded timeouts. | Collector/Grafana |
| `/obs session` | Shows current-session turn, LLM-call, tool-call, cost, and trace-link state from runtime counters. | Local state only |
| `/obs cost` | Queries Prometheus/Mimir for safe model/provider token and cost aggregates. | Prometheus/Mimir via Grafana |
| `/obs trace` | Returns a Grafana Tempo trace link for current, last-turn, or safe session-id scopes. | Grafana link construction |
| `/obs link` | Direct Grafana trace-link helper using the configured URL template. | Grafana link construction |
| `/obs tools` | Queries tool-call and tool-failure aggregates using only safe tool/error labels. | Prometheus/Mimir via Grafana |
| `/obs errors` | Queries Loki for recent failed/dropped/orphan event names and renders a capped summary. | Loki via Grafana |
| `/obs logs` | Queries Loki for the current session's normalized `pi_session_id` label and renders a capped summary. | Loki via Grafana |
| `/obs agents` | Shows current workflow/agent identity, lineage, fan-out/depth, active children, orphan status, and wait/join hints. | Local state plus safe Tempo/Prometheus drill-downs |
| `/obs backfill` | Optional historical replay for the current session with explicit confirmation, replay markers, redaction, export rate limits, and a bounded `--since` window up to 30d. | OTLP export when confirmed |

Query-backed commands enforce configured timeouts and result limits and reject raw prompt, command, path, or other sensitive query inputs.

Trace visibility note: `/obs trace` and `/obs session` can link to the current trace as soon as `session_start` creates it. During an active Pi session, Tempo may show ended child spans before the long-lived root `pi.session` span appears; the canonical root span is ended, flushed, and visible after `session_shutdown`.

## Architecture

```text
Pi Agent
  └── ObservMe Pi Extension
        ├── OTEL Traces  ──► OTEL Collector ──► Tempo
        ├── OTEL Metrics ──► OTEL Collector ──► Prometheus / Mimir
        └── OTEL Logs    ──► OTEL Collector ──► Loki

Grafana
  ├── Tempo datasource
  ├── Loki datasource
  └── Prometheus/Mimir datasource
```

The extension factory in `src/extension.ts` only registers handlers and commands. OTEL SDK startup happens from `session_start`, and bounded flush/shutdown happens from `session_shutdown`, so importing or registering the extension does not open exporters, timers, or sockets.

See the packaged `ObservMe-Production-Docs/02-reference-architecture.md` for the full architecture. Implementation planning specs are repository-only and live at <https://github.com/senad-d/ObservMe/tree/main/specs>. A reference Docker Compose deployment of the Grafana/Tempo/Loki/Prometheus/Collector stack is also repository-only at <https://github.com/senad-d/ObservMe/tree/main/observability-stack> because it contains generated local credentials and state placeholders.

## Configuration and Privacy

ObservMe supports layered configuration with this precedence:

```text
defaults → global ~/.pi/agent/observme.yaml → trusted project config → trusted project .env → system environment variables → runtime options
```

The extension automatically creates `<project>/.pi/observme.yaml` the first time Pi emits `session_start` in a trusted project and the file does not already exist. Pi emits that lifecycle for startup, `/reload`, new-session, resume, and fork flows; ObservMe attempts the same idempotent bootstrap for each trusted flow, skips untrusted projects or contexts without `ctx.cwd`, and never overwrites an existing file. Edit this file for project-specific setup: `otlp.endpoint` / `otlp.signalEndpoints` for your Collector, `resource.attributes` for service/project/tenant/environment identity, `capture` and `privacy` for content visibility, and `query.grafana` plus `query.links.traceUrlTemplate` for `/obs` Grafana commands. The generated starter keeps content-capture flags disabled, `privacy.redactionEnabled: true`, and `privacy.allowUnsafeCapture: false`; for local debugging, set only the needed `capture.*` flags to `true` and keep redaction enabled. Keep secrets out of YAML; use environment variables or a trusted project `.env` for values such as `OBSERVME_OTLP_TOKEN`, `OBSERVME_GRAFANA_TOKEN`, `OBSERVME_GRAFANA_PASSWORD`, and `OBSERVME_HASH_SALT`. See [`docs/configuration.md`](docs/configuration.md) for the quick configuration guide.

Factory-safe loading uses defaults/global/system-environment/runtime options only. Session-scoped loading can add trusted project config and a project-local `.env` when Pi marks the project trusted. `/obs status` reports the effective config source, whether project-local `.pi/observme.yaml` was loaded, skipped because the project is untrusted, or missing, plus the configured Grafana URL and query-readiness status without rendering tokens or passwords. In untrusted projects, ObservMe does not read project-local config or `.env` files and uses safe defaults/global/system-environment layers instead.

Default capture policy:

```yaml
capture:
  prompts: false
  responses: false
  thinking: false
  toolArguments: false
  toolResults: false
  bashCommands: false
  bashOutput: false
  filePaths: false
privacy:
  redactionEnabled: true
  allowUnsafeCapture: false
  allowInsecureTransport: false
workflow:
  enabled: true
```

When optional content capture is enabled, live telemetry and `/obs backfill` use the same policy. With `privacy.redactionEnabled: true`, the redaction pipeline applies size guards, secret detection, optional PII detection, path scrubbing (`hash`, `basename`, `full`, or `drop`), custom regex redactors, truncation metadata, and tenant-salted hashing before export. Redaction failures drop content and emit `redaction.failed` diagnostics. With `privacy.redactionEnabled: false` and `privacy.allowUnsafeCapture: true`, captured content is exported raw but still truncated to the configured limit. Hash salts are read from secure environment/runtime config, not hardcoded.

Metadata such as token counts, duration, status, model/provider, tool name, and agent role/depth is captured by default. High-cardinality identifiers (session IDs, workflow IDs, agent IDs, trace/span IDs, entry IDs) are allowed on spans/logs for drill-down but are blocked from Prometheus metric labels.

Grafana-backed query commands use the Grafana HTTP API, so browser login cookies are irrelevant. Configure either a Grafana service-account token (`OBSERVME_GRAFANA_TOKEN`) or local Basic auth (`OBSERVME_GRAFANA_USERNAME`/`OBSERVME_GRAFANA_PASSWORD`); token auth takes precedence and secrets are never rendered in command errors. You can supply these values as system environment variables before starting Pi, or copy `.env.example` to `.env` in a trusted project; system environment variables override `.env` values.

### Supported local-stack query profile

The repository-only local stack at <https://github.com/senad-d/ObservMe/tree/main/observability-stack> supports `/obs` query commands through authenticated Grafana behind nginx HTTPS at `https://observability.local`. The default Compose stack does not publish Grafana on `localhost:3000`; use that direct HTTP path only if you add your own override.

```yaml
query:
  enabled: true
  links:
    traceUrlTemplate: https://observability.local/explore?left=...
  grafana:
    url: https://observability.local
    token: ${OBSERVME_GRAFANA_TOKEN}
    username: admin
    password: ${OBSERVME_GRAFANA_PASSWORD}
    datasourceUids:
      tempo: tempo
      loki: loki
      prometheus: prometheus
    tls:
      insecureSkipVerify: true
    transport:
      preferIPv4: true
```

Create a Grafana service-account token in Grafana (Administration → Users and access → Service accounts → Add service account/token; Viewer is enough for read-only datasource queries) and export it as `OBSERVME_GRAFANA_TOKEN`, or for local-only Basic auth read the generated admin password from the repository-only local stack's secrets directory. If you prefer a project-local env file, run `cp .env.example .env`, fill either `OBSERVME_GRAFANA_TOKEN` or `OBSERVME_GRAFANA_PASSWORD`, then restart Pi from that project. The local Collector and Loki profile uses `service.name=observme-pi-extension`; Loki queries use normalized labels such as `service_name`, `pi_session_id`, `pi_agent_id`, `pi_agent_run_id`, `event_name`, and `event_category`. If data is visible in Grafana but `/obs` commands fail, run `/obs health` and check extension env loading, Grafana auth, datasource UIDs, TLS, and DNS details.

### Show LLM chat content in Grafana

LLM prompt, response, and thinking bodies are hidden by default. To display redacted chat content in Tempo span attributes and Loki log panels, restart Pi with explicit capture and a tenant hash salt:

```bash
export OBSERVME_CAPTURE_PROMPTS=true
export OBSERVME_CAPTURE_RESPONSES=true
export OBSERVME_CAPTURE_THINKING=true
export OBSERVME_REDACTION_ENABLED=true
export OBSERVME_HASH_SALT="$(openssl rand -hex 32)"
```

For intentionally raw local debugging only, set `OBSERVME_REDACTION_ENABLED=false` together with `OBSERVME_ALLOW_UNSAFE_CAPTURE=true`. Environment variables and trusted project `.env` values override `.pi/observme.yaml`, so remove stale overrides before relying on YAML privacy settings.

Only new LLM events emitted after these settings and the updated Collector are active can show content; older telemetry dropped by the Collector cannot be recovered. Open the **ObservMe LLM Conversations** dashboard for a dedicated opt-in chat timeline. Do not query Grafana with raw prompt or response text.

Full configuration schema: `ObservMe-Production-Docs/12-configuration-reference.md`. Full redaction/privacy design: `ObservMe-Production-Docs/06-security-privacy-redaction.md`.

## Safety Model

- ObservMe does not execute shell commands itself; it only observes tool/bash execution events emitted by Pi.
- ObservMe never blocks Pi agent execution when the observability backend is degraded or unreachable.
- ObservMe starts exporters only for a trusted session and shuts them down with bounded timeouts.
- ObservMe does not continuously tail the full Pi session file; startup recovery reads only minimal session/correlation state, and historical replay requires an explicit `/obs backfill` command.
- Optional content capture is disabled by default and must pass through the redaction pipeline before export when enabled.
- `/obs` query commands are read-only and are not imported by telemetry-emission code paths.
- Invalid or unsafe configuration falls back to safe defaults with a logged rejection reason; intentionally unsafe capture emits a visible warning.

See [`SECURITY.md`](SECURITY.md) and `ObservMe-Production-Docs/06-security-privacy-redaction.md` for details.

## Dashboards and Examples

These assets are included in the npm package:

- Grafana dashboards: `dashboards/observme-*.json`, including `dashboards/observme-trace-journey.json` for trace travel and agent lineage drill-downs.
- Alert rules: `dashboards/observme-alerts.yaml`.
- SLO definitions: `dashboards/observme-slos.yaml`.
- Supported local-stack ObservMe config: `examples/observme.yaml`.
- Production Collector config with high-cardinality and content-drop processors: `examples/collector.yaml`.
- Compatibility matrix: `docs/compatibility-matrix.md`.

The Docker Compose local stack is intentionally repository-only at <https://github.com/senad-d/ObservMe/tree/main/observability-stack> so packaged installs do not contain generated credentials, certificates, or local Pi state.

## Documentation Set

The full production design is included in the npm package under `ObservMe-Production-Docs/`:

| File | Purpose |
|---|---|
| `01-requirements-and-scope.md` | Product goals, non-goals, personas, requirements |
| `02-reference-architecture.md` | Full system architecture |
| `03-pi-event-and-session-model.md` | Pi session/event sources and interpretation |
| `04-telemetry-semantic-conventions.md` | Attribute, metric, log, and span naming |
| `05-otel-pipeline-and-collector.md` | OTLP exporter strategy and Collector configs |
| `06-security-privacy-redaction.md` | Redaction, PII handling, tenant isolation |
| `07-extension-implementation-blueprint.md` | TypeScript implementation architecture |
| `08-query-grafana-integration.md` | `/obs` commands and Grafana/Tempo/Loki/Prometheus integration |
| `09-dashboards-alerts-slos.md` | Dashboards, alerts, SLOs |
| `10-testing-release-operations.md` | Test strategy and release process |
| `11-deployment-runbooks.md` | Deployment runbooks |
| `12-configuration-reference.md` | Full configuration schema |
| `13-source-notes.md` | External documentation cross-check notes |

Implementation specs are repository-only at <https://github.com/senad-d/ObservMe/tree/main/specs>: `project-definition-brief.md`, `spec-architecture.md`, `spec-guidelines.md`, `spec-tasks.md`. User-facing configuration guidance is in [`docs/configuration.md`](docs/configuration.md). Review-task validation and current `*-2.md` review-spec ordering are documented in [`docs/review-validation.md`](docs/review-validation.md).

## Development

```bash
npm ci
npm run validate
```

Useful checks:

```bash
npm run typecheck
npm run typecheck:test
npm run lint        # TypeScript, test TypeScript, ESLint, formatting, and script syntax checks
npm run lint:fix    # ESLint auto-fix pass
npm run format:check
npm run test
npm run test:integration:collector
npm run test:integration:grafana-stack
npm run check:pack
npm run smoke:pi-runtime
npm run validate:grafana-obs
pi --no-extensions -e .
```

`npm run smoke:pi-lifecycle` runs lifecycle handlers with traces, metrics, logs, and query integration disabled through an explicit offline test config. `npm run smoke:pi-runtime` launches a real Pi RPC process against a temporary trusted project, verifies `/obs` discovery plus `/obs status` and `/obs session` routing after `session_start`, and exercises a bounded `/obs cost` timeout against a local deterministic Grafana backend.

`npm run test:coverage` writes `coverage/node-test-coverage.txt` and SonarQube-readable `coverage/lcov.info` for the default non-Docker test suite; `coverage/` is git-ignored, and `rm -rf coverage` removes generated coverage artifacts after review. Docker integration coverage is opt-in with `OBSERVME_INCLUDE_INTEGRATION_COVERAGE=1 npm run test:coverage`.

End-to-end troubleshooting flow: [`docs/validation-flow.md`](docs/validation-flow.md) provides a deterministic, secret-safe checklist and script for the common user-facing case where Grafana has data but `/obs` commands are failing.

## Publishing

ObservMe publishes to npm as `@senad-d/observme`. Run from a clean working tree after validation and a `CHANGELOG.md` update.

```bash
npm login
npm whoami
npm run validate
npm run validate:grafana-obs  # with the release-candidate stack and Grafana query env configured
npm version <version>
npm publish --access public
```

Push the release commit and tag after the package is published.

## License

MIT
