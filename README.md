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
  <br />Turns Pi session, turn, tool, LLM, branch, compaction, and agent-lineage events into OTLP traces, metrics, and logs for an external observability stack.
</p>

---

> **Status: preparation stage.** This repository has been bootstrapped from the Pi extension template and given ObservMe project identity, but the actual telemetry, redaction, and `/obs` command behavior described below is **planned, not yet implemented**. See `specs/spec-tasks.md` for the checkbox-driven implementation plan and `ObservMe-Production-Docs/` for the full production design. Do not install this package expecting working telemetry export yet.

ObservMe is a Pi extension for **observability of Pi agent sessions**. It reads Pi session/turn/tool/LLM/branch/compaction lifecycle events through Pi's extension API, maps them to OpenTelemetry semantics (`pi.*`/`observme.*` namespaces plus official `gen_ai.*` attributes where they fit), exports them via OTLP to an OpenTelemetry Collector, and is **privacy-preserving by default**: prompts, responses, thinking content, tool arguments/results, bash commands/output, and file paths are never captured unless explicitly enabled and redacted.

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
- **Privacy by default:** all optional content capture (prompts, responses, tool args/results, bash, paths) starts disabled and passes through a redaction pipeline when enabled.
- **Agent lineage aware:** propagates parent/child/root agent identity and W3C trace context across subagent process boundaries without adding high-cardinality identifiers to metric labels.
- **Pi-native:** designed to be used as a Pi package (global, project-local, git install, or source checkout).

> **Security:** pi packages run with your full system permissions. ObservMe reads Pi session/event data through Pi's extension API, does not execute shell commands itself, and sends telemetry only to configured OTLP endpoints (Collector by default). Read [`SECURITY.md`](SECURITY.md).

## Table of Contents

- [Current Status](#current-status)
- [Planned Quick Start](#planned-quick-start)
- [Installation](#installation)
- [Planned Commands](#planned-commands)
- [Architecture](#architecture)
- [Configuration and Privacy](#configuration-and-privacy)
- [Safety Model](#safety-model)
- [Documentation Set](#documentation-set)
- [Development](#development)
- [Publishing](#publishing)
- [License](#license)

---

## Current Status

This repository is in the **preparation phase** of Pi extension development:

- ✅ Bootstrapped from the Pi extension template.
- ✅ Project identity applied (`@senad-d/observme`, `senad-d/ObservMe`, MIT license).
- ✅ Production design docs (`ObservMe-Production-Docs/`) and a reference Grafana/Tempo/Loki/Prometheus/Collector stack (`observability-stack/`) already present.
- ✅ Three preparation specs written (`specs/project-definition-brief.md`, `specs/spec-architecture.md`, `specs/spec-guidelines.md`, `specs/spec-tasks.md`).
- ⏳ **Not yet implemented:** OTEL SDK wiring, Pi event-to-span mapping, redaction pipeline, agent-lineage propagation, and all `/obs` commands.

A future implementation session will work through `specs/spec-tasks.md` one checkbox at a time. See that file for the exact, ordered task list.

---

## Planned Quick Start

Once implemented, ObservMe is expected to work like this:

```bash
pi install npm:@senad-d/observme
cd /path/to/your/project
pi
```

```text
/obs status
/obs health
```

ObservMe will observe the current Pi session and export telemetry to the configured OTLP endpoint. It never blocks Pi execution when the backend is unavailable.

---

## Installation

| Scope | Command | Notes |
| --- | --- | --- |
| Global | `pi install npm:@senad-d/observme` | Loads in every trusted pi project. |
| Project-local | `pi install npm:@senad-d/observme -l` | Writes to `.pi/settings.json` in the current project. |
| One run | `pi -e npm:@senad-d/observme` | Try without changing settings. |
| Git | `pi install git:senad-d/ObservMe` | Pin a tag or commit. |
| Local checkout | `pi --no-extensions -e .` | Develop or test this repository. |

Source checkout:

```bash
git clone https://github.com/senad-d/ObservMe.git
cd ObservMe
npm ci
npm run validate
pi --no-extensions -e .
```

---

## Planned Commands

| Command | Description | Status |
| --- | --- | --- |
| `/obs status` | Show local ObservMe enablement, OTLP endpoint, capture flags, and queue-drop counters | Planned |
| `/obs health` | Check Collector and Grafana/datasource reachability | Planned |
| `/obs session` | Show current session's turn/LLM/tool-call counts and cost, with a trace link | Planned |
| `/obs cost` | Query Prometheus/Mimir for token/cost aggregates | Planned |
| `/obs trace` | Return a Grafana Tempo trace link for the current or a given session | Planned |
| `/obs tools` | Query tool call/failure rates | Planned |
| `/obs errors` | Query Loki for recent error events | Planned |
| `/obs logs` | Query Loki for the current session's structured logs | Planned |
| `/obs agents` | Show current agent identity and recent parent/child subagent lineage | Planned |
| `/obs link` | Direct Grafana link helper | Planned |
| `/obs backfill` | Optional, disabled-by-default historical telemetry replay | Planned, off by default |

Full command semantics are specified in `ObservMe-Production-Docs/08-query-grafana-integration.md`.

---

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

See `ObservMe-Production-Docs/02-reference-architecture.md` for the full architecture and `specs/spec-architecture.md` for the implementation-oriented module breakdown. A reference Docker Compose deployment of the Grafana/Tempo/Loki/Prometheus/Collector stack lives in `observability-stack/`.

---

## Configuration and Privacy

ObservMe is designed to be privacy-preserving by default. Planned default capture policy:

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
```

Metadata such as token counts, duration, status, model/provider, tool name, and agent role/depth is captured by default. High-cardinality identifiers (session IDs, agent IDs, trace/span IDs) are allowed on spans/logs for drill-down but must never become Prometheus metric labels. Full configuration schema: `ObservMe-Production-Docs/12-configuration-reference.md`. Full redaction/privacy design: `ObservMe-Production-Docs/06-security-privacy-redaction.md`.

---

## Safety Model

- ObservMe is designed to never execute shell commands itself; it only observes tool/bash execution events emitted by Pi.
- ObservMe never blocks Pi agent execution when the observability backend is degraded or unreachable (fail-open).
- ObservMe does not read the full Pi session file continuously; it uses Pi's real-time extension events, reading session state only on startup recovery, `/obs session`, or explicit `/obs backfill`.
- Optional content capture is disabled by default and passes through a mandatory redaction pipeline (secret detection, PII detection, path scrubbing, truncation, hashing) before export when enabled.
- `/obs` query commands are read-only and never a dependency of telemetry emission.

See [`SECURITY.md`](SECURITY.md) and `ObservMe-Production-Docs/06-security-privacy-redaction.md` for details.

---

## Documentation Set

The full production design lives in `ObservMe-Production-Docs/`:

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

Preparation specs live in `specs/`: `project-definition-brief.md`, `spec-architecture.md`, `spec-guidelines.md`, `spec-tasks.md`.

---

## Development

```bash
npm ci
npm run validate
```

Useful checks:

```bash
npm run typecheck
npm run lint        # ESLint for TypeScript and development scripts
npm run lint:fix    # optional auto-fix pass
npm run format:check
npm run test
npm run check:pack
pi --no-extensions -e .
```

---

## Publishing

ObservMe will publish to npm as `@senad-d/observme`. Run from a clean working tree after updating `CHANGELOG.md`. Publishing is not expected until the MVP scope in `ObservMe-Production-Docs/00-README.md` is implemented.

```bash
npm login
npm whoami
npm run validate
npm version <version>
npm publish --access public
```

Push the release commit and tag after the package is published.

---

## License

MIT
