# ObservMe Production Documentation

**ObservMe** is a production-grade Pi extension for observability. It captures Pi session, turn, tool, LLM, branch, compaction, and error events, translates them into OpenTelemetry telemetry, and exports them to a durable external observability stack such as OpenTelemetry Collector, Grafana Tempo, Grafana Loki, Prometheus, Mimir, or Grafana Cloud.

ObservMe is intentionally **not** a local analytics database. Pi agents are ephemeral. Observability data must leave the Pi agent process quickly, safely, and reliably. When multiple Pi agents or subagents are running, ObservMe must also preserve workflow and agent-tree lineage so operators can see which parent agent spawned each child agent and how the full orchestrated workload behaved.

## Core Design

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

## Document Set

| File | Purpose |
|---|---|
| `01-requirements-and-scope.md` | Product goals, non-goals, personas, requirements, rollout phases |
| `02-reference-architecture.md` | Full system architecture and component responsibilities |
| `03-pi-event-and-session-model.md` | Pi session/event sources and how ObservMe interprets them |
| `04-telemetry-semantic-conventions.md` | ObservMe attribute, metric, log, and span naming specification |
| `05-otel-pipeline-and-collector.md` | OTLP exporter strategy and production Collector configurations |
| `06-security-privacy-redaction.md` | Prompt safety, secret redaction, PII handling, tenant isolation |
| `07-extension-implementation-blueprint.md` | TypeScript implementation architecture, modules, lifecycle, code patterns |
| `08-query-grafana-integration.md` | `/obs` commands, Grafana/Tempo/Loki/Prometheus query integration |
| `09-dashboards-alerts-slos.md` | Dashboard pack, PromQL, LogQL, TraceQL, alerts, SLOs |
| `10-testing-release-operations.md` | Test strategy, chaos testing, performance validation, release process |
| `11-deployment-runbooks.md` | Local, Docker Compose, Kubernetes, and production runbooks |
| `12-configuration-reference.md` | Complete ObservMe configuration schema and examples |
| `13-source-notes.md` | Official documentation cross-check notes and external assumptions |
| `pi-session-format.md` | Pi session JSONL reference copied and adapted from Pi's official session-format documentation |

## Production Principles

1. **OTLP-first.** ObservMe emits OpenTelemetry traces, metrics, and logs.
2. **No durable local telemetry storage.** Only bounded in-memory queues are allowed.
3. **Fail open.** If observability fails, Pi must continue operating.
4. **Privacy by default.** Prompt and response content capture is disabled by default.
5. **Pi-native and OTEL-compatible semantics.** ObservMe uses `observme.*` and `pi.*` for Pi-specific concepts and official OpenTelemetry `gen_ai.*` attributes where they fit; it does not depend on OpenInference.
6. **Agent lineage by design.** Agent and subagent telemetry carries `pi.agent.*` lineage attributes and, where possible, W3C trace context so parent/child relationships survive process boundaries.
7. **Workflow/tree observability.** Orchestrator workloads are modeled as agent trees with `pi.workflow.*` correlation, depth, fan-out, wait/join, orphan, and critical-path signals so operators can understand both single-agent and multi-agent execution.
8. **Collector recommended.** Direct-to-backend export is allowed only for development or constrained environments.
9. **Backend-neutral.** Tempo/Loki/Prometheus are reference backends, not hard dependencies.

## Minimum Viable Production Release

A production-ready `1.0.0` release must include:

- Extension load and health checks
- Session, workflow, agent-run, turn, LLM, tool, subagent-spawn, agent wait/join, compaction, branch, model-change telemetry
- Multi-agent tree metrics for active agents, depth, fan-out, orphan agents, trace-context propagation failures, child failures, and workflow duration
- OTLP trace exporter
- OTLP metric exporter
- OTLP log exporter
- Configurable redaction and capture controls
- Bounded queues and exporter timeouts
- Grafana dashboard JSON
- Collector reference configs
- Tests for event mapping, redaction, exporter failure, and cardinality
- `/obs status`, `/obs health`, `/obs session`, `/obs cost`, `/obs trace`, `/obs agents` commands

## Source References

This document set assumes:

- Pi extensions provide documented lifecycle hooks, commands, tools, custom entries, session events, and queryable session state.
- Pi can run multiple extension instances or spawn additional Pi processes through tools/subagent patterns; cross-process workflow and parent/child lineage requires explicit ObservMe correlation and trace-context propagation.
- Pi sessions are JSONL files with typed entries such as `message`, `compaction`, `branch_summary`, `model_change`, `thinking_level_change`, `custom`, `custom_message`, `label`, and `session_info`.
- OpenTelemetry Collector receives, processes, and exports telemetry via pipelines.
- OpenTelemetry GenAI semantic conventions are the official OTEL namespace for GenAI client/agent spans, attributes, and metrics, but many GenAI fields are still experimental/evolving in SDK packages; ObservMe extends them for Pi-specific workflow concepts.
- Grafana Tempo, Loki, and Prometheus/Mimir are reference storage systems for traces, logs, and metrics.
