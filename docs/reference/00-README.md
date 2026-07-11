# ObservMe technical reference

This directory contains the detailed architecture, telemetry, privacy, operations, and implementation contracts for ObservMe. For installation or routine setup, start with [`../../README.md`](../../README.md) and the task-oriented [`../README.md`](../README.md) index instead.

ObservMe is a Pi extension that captures session, turn, tool, LLM, branch, compaction, and agent-lineage events, translates them into OpenTelemetry traces, metrics, and logs, and exports them to an external observability stack. It is not a local analytics database.

## Choose a document

### Product and architecture

| File | Use it for |
| --- | --- |
| [`01-requirements-and-scope.md`](01-requirements-and-scope.md) | Product goals, personas, hard requirements, non-goals, and success criteria. |
| [`02-reference-architecture.md`](02-reference-architecture.md) | Components, data flow, trace shape, deployment topologies, and failure boundaries. |
| [`03-pi-event-and-session-model.md`](03-pi-event-and-session-model.md) | Pi event mapping, session entries, branching, compaction, recovery, and agent lineage. |
| [`07-extension-implementation-blueprint.md`](07-extension-implementation-blueprint.md) | Extension modules, lifecycle, span registries, handlers, and implementation patterns. |
| [`pi-session-format.md`](pi-session-format.md) | Adapted Pi JSONL session reference used by ObservMe. |

### Telemetry and data handling

| File | Use it for |
| --- | --- |
| [`04-telemetry-semantic-conventions.md`](04-telemetry-semantic-conventions.md) | Span names, attributes, metrics, labels, logs, and cardinality rules. |
| [`05-otel-pipeline-and-collector.md`](05-otel-pipeline-and-collector.md) | OTLP exporters, Collector pipelines, routing, sampling, and backend notes. |
| [`06-security-privacy-redaction.md`](06-security-privacy-redaction.md) | Capture defaults, data classification, redaction, hashing, TLS, and tenant isolation. |

### Operation and configuration

| File | Use it for |
| --- | --- |
| [`08-query-grafana-integration.md`](08-query-grafana-integration.md) | `/obs` query behavior, Grafana access, safe queries, and trace links. |
| [`09-dashboards-alerts-slos.md`](09-dashboards-alerts-slos.md) | Dashboard map, variables, drill-downs, PromQL/LogQL, alerts, and SLOs. |
| [`10-testing-release-operations.md`](10-testing-release-operations.md) | Test levels, failure tests, performance, cardinality, releases, and support. |
| [`11-deployment-runbooks.md`](11-deployment-runbooks.md) | Local, Docker, CI, and production deployment checks plus common incidents. |
| [`12-configuration-reference.md`](12-configuration-reference.md) | Complete YAML schema, environment variables, precedence, defaults, and validation. |

### Source basis

| File | Use it for |
| --- | --- |
| [`13-source-notes.md`](13-source-notes.md) | Pi, OpenTelemetry, and Grafana assumptions used by this reference set. |

## Related task-oriented documentation

- [`../configuration.md`](../configuration.md) — quick project configuration.
- [`../extension-integration.md`](../extension-integration.md) — versioned integration API for orchestrators and other Pi extensions.
- [`../validation-flow.md`](../validation-flow.md) — secret-safe Grafana and `/obs` troubleshooting.
- [`../compatibility-matrix.md`](../compatibility-matrix.md) — currently tested versions.
- [`../../examples/README.md`](../../examples/README.md) — safe use of the shipped YAML examples.
- [`../../SECURITY.md`](../../SECURITY.md) — package trust and vulnerability reporting.

## Core design

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

## Reference principles

1. **OTLP-first.** ObservMe emits OpenTelemetry traces, metrics, and logs.
2. **No durable local telemetry storage.** Only bounded in-memory queues are allowed.
3. **Fail open.** Observability failure must not stop Pi.
4. **Privacy by default.** Prompt, response, thinking, tool, Bash, and path capture starts disabled.
5. **Pi-native and OTEL-compatible semantics.** ObservMe uses `observme.*`, `pi.*`, and applicable official `gen_ai.*` attributes.
6. **Agent lineage by design.** Parent and child telemetry uses `pi.agent.*` lineage and W3C context where an ObservMe-aware launcher can propagate it.
7. **Low-cardinality metrics.** Workflow, session, agent, trace, span, entry, and tool-call identifiers belong on traces and logs, not metric labels.
8. **Collector recommended.** Direct-to-backend export is for development or constrained environments.
9. **Backend-neutral.** Tempo, Loki, and Prometheus/Mimir are reference backends rather than hard runtime dependencies.

## How to interpret this reference

Some documents define reserved or future-facing contracts in addition to currently emitted behavior. Use the telemetry catalog in [`../../README.md#available-telemetry`](../../README.md#available-telemetry) to distinguish live signals from names marked reserved or registered but not yet recorded. If a detailed reference conflicts with the current user guides, report the discrepancy and prefer the current user-facing behavior until the reference is corrected.
