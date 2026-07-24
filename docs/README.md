# ObservMe documentation

This page is the entry point for ObservMe user, operator, and contributor documentation. Start with the task-oriented guides, then open the deeper reference only when you need implementation or telemetry-contract detail.

## Start here

| Goal | Read first | Then, if needed |
| --- | --- | --- |
| Install ObservMe and learn `/obs` commands | [`../README.md`](../README.md) | [`configuration.md`](configuration.md) |
| Configure a trusted project | [`configuration.md`](configuration.md) | [`reference/12-configuration-reference.md`](reference/12-configuration-reference.md) |
| Validate Grafana and `/obs` together | [`validation-flow.md`](validation-flow.md) | [`reference/11-deployment-runbooks.md`](reference/11-deployment-runbooks.md) |
| Check supported versions | [`compatibility-matrix.md`](compatibility-matrix.md) | [`reference/10-testing-release-operations.md`](reference/10-testing-release-operations.md) |
| Understand privacy and content capture | [`../SECURITY.md`](../SECURITY.md) | [`reference/06-security-privacy-redaction.md`](reference/06-security-privacy-redaction.md) |
| Configure an OTEL Collector | [`../examples/README.md`](../examples/README.md) | [`reference/05-otel-pipeline-and-collector.md`](reference/05-otel-pipeline-and-collector.md) |
| Understand metrics, spans, logs, and labels | [`../README.md#available-telemetry`](../README.md#available-telemetry) | [`reference/04-telemetry-semantic-conventions.md`](reference/04-telemetry-semantic-conventions.md) |
| Operate dashboards, alerts, and SLOs | [`../README.md#dashboards-and-examples`](../README.md#dashboards-and-examples) | [`reference/09-dashboards-alerts-slos.md`](reference/09-dashboards-alerts-slos.md) |
| Understand architecture and lifecycle | [`reference/02-reference-architecture.md`](reference/02-reference-architecture.md) | [`reference/03-pi-event-and-session-model.md`](reference/03-pi-event-and-session-model.md) |
| Integrate another Pi extension or orchestrator | [`extension-integration.md`](extension-integration.md) | [`agent-subagent-observability-requirements.md`](agent-subagent-observability-requirements.md) |
| Diagnose parent/subagent lineage (every agent shows as root) | [`extension-integration.md#troubleshooting-every-agent-appears-as-its-own-root`](extension-integration.md#troubleshooting-every-agent-appears-as-its-own-root) | [`agent-subagent-observability-requirements.md`](agent-subagent-observability-requirements.md) |

## User and operator guides

- [`configuration.md`](configuration.md) — project config creation, fields to edit, credentials, privacy defaults, and precedence.
- [`validation-flow.md`](validation-flow.md) — secret-safe troubleshooting when Grafana or `/obs` does not behave as expected.
- [`compatibility-matrix.md`](compatibility-matrix.md) — tested Pi, Node.js, OpenTelemetry, Collector, and Grafana-stack versions.
- [`../examples/README.md`](../examples/README.md) — purpose and safe use of the shipped configuration and integration examples.
- [`extension-integration.md`](extension-integration.md) — public event-bus API for orchestrators, subagent runners, and other Pi extensions.
- [`../SECURITY.md`](../SECURITY.md) — package trust model and vulnerability reporting.

## Technical reference

[`reference/00-README.md`](reference/00-README.md) is the reference index. Use it for architecture, Pi event mapping, telemetry semantics, Collector design, privacy rules, query behavior, dashboards, testing, deployment, and the complete configuration schema.

The reference set is detailed and may describe reserved contracts as well as live behavior. The telemetry tables in [`../README.md#available-telemetry`](../README.md#available-telemetry) identify signals that are reserved or registered but not currently recorded.

## Contributor and design notes

These documents support extension development and are not the shortest path for normal setup:

- [`STRUCTURE.md`](STRUCTURE.md) — repository structure conventions.
- [`agent-subagent-observability-requirements.md`](agent-subagent-observability-requirements.md) — complete orchestration and tmux lineage requirements beyond the public integration API.
- [`configuration-tui-design-standard.md`](configuration-tui-design-standard.md) — reusable configuration TUI visual design.
- [`review-validation.md`](review-validation.md) — repository review and release-validation evidence.

## Documentation precedence

Runtime code and shipped configuration are the behavioral source of truth. For documentation-only overlap, use this order:

1. [`../README.md`](../README.md) and the task-oriented guides in this directory for current user-facing behavior.
2. [`reference/12-configuration-reference.md`](reference/12-configuration-reference.md) for the documented configuration contract.
3. The remaining production reference documents for architecture and implementation detail.
4. Contributor/design notes for repository work and future integration requirements.

For an exact or disputed behavior, verify the owning source: `src/commands/` for `/obs`, `src/config/` for configuration, `src/semconv/` plus `src/pi/` recording points for telemetry, `src/privacy/` for capture/redaction, `src/integration.ts` plus `src/pi/integration-api.ts` for integration, and `observability-stack/` for the repository-only stack. If source and docs conflict, state the drift and correct the docs rather than silently combining them. Never include credentials, raw prompts, raw commands, or other sensitive values in examples or troubleshooting output.
