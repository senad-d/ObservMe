# Changelog

## Unreleased

### Added

- Expanded the Grafana suite with SLO Health, Trace Journey, Agent Node Graphs, and LLM Conversations dashboards, plus richer multi-agent, cost, latency, tool, model, log, and export-health views.
- Added correlated, content-safe telemetry for tool results, agent runs, workflows, subagent lifecycle events, interactive Bash executions, and configuration failures.
- Added W3C trace continuation for launcher-propagated parent contexts, with sanitized lineage validation and fail-safe span-link/log fallbacks.
- Added deterministic Pi runtime, Collector, Grafana-stack, dashboard, lifecycle, packaging, and configuration validation coverage.
- Added SonarQube-compatible LCOV output and focused tests for partial Pi runtimes, lifecycle races, fallback paths, privacy controls, and telemetry contracts.

### Changed

- Split Pi event handling into focused lifecycle, agent/turn, LLM, tool/Bash, and session modules while preserving the `registerHandlers()` facade.
- Centralized telemetry conventions, content-capture policy, sensitive-value rejection, diagnostic sanitization, Grafana transport, `/obs` command plumbing, and trusted-project configuration bootstrap.
- Improved all dashboards with emitted-label-safe queries, selected-range calculations, zero/no-data states, bounded tables, canonical SLO formulas, and time-preserving Loki/Tempo drill-downs.
- Updated the Cost dashboard to aggregate spend across providers and models, preserve token totals from short-lived sessions, and display sub-cent values accurately.
- Updated README, dashboard, integration, and operator documentation to match the current command surface, package contents, privacy defaults, and validation workflows.
- Made strict TypeScript checks, offline coverage, deterministic fixtures, and Docker-backed integration validation more reliable in CI.

### Fixed

- Fixed session, workflow, agent, turn, LLM, tool, Bash, histogram, active-span, failure/recovery, and session-count telemetry accuracy.
- Fixed lifecycle serialization, duplicate session replacement, bounded shutdown/flush behavior, backfill cancellation, parallel tool correlation, and bounded agent-tree state cleanup.
- Hardened configuration validation, project-root path confinement, endpoint security, custom redaction patterns, tenant-salted hashing, and environment propagation.
- Restored trusted-project redacted LLM capture and OpenAI Responses-style prompt capture while keeping capture disabled and redaction enabled by default.
- Remediated SonarQube maintainability and security findings across parsing, regexes, fallback handling, diagnostics, and default assignment.
- Fixed npm/CI dependency installation, package contents, README command drift, Grafana/Loki schema handling, and dashboard provisioning/query validation.

## 0.1.0 - 2026-07-07

### Added

- Bootstrapped the `@senad-d/observme` Pi extension with layered configuration, semantic conventions, session-scoped OpenTelemetry exporters, and bounded lifecycle management.
- Instrumented sessions, workflows, agents, turns, LLM requests, tools, interactive Bash, subagents, model/thinking changes, compaction, and branches with traces, metrics, and structured logs.
- Added privacy-first redaction, salted hashing, truncation, path scrubbing, secret detection, opt-in content capture, and trusted-project `.env`/`.pi/observme.yaml` support.
- Added `/obs` commands for status, health, session details, cost, traces, links, tools, errors, logs, agents, and bounded current-session backfill.
- Added Grafana clients for Prometheus, Loki, and Tempo with authenticated, timeout-bounded, secret-safe transport and query validation.
- Added dashboards for overview, cost, latency, tools, models, errors, branches/compactions, agents/subagents, export health, logs/LLM I/O, conversations, trace journeys, and agent node graphs.
- Added Prometheus alerts, SLO definitions, Collector/Grafana-stack examples, compatibility documentation, and production/operator guidance.
- Added unit, contract, cardinality, privacy, exporter-failure, Pi RPC, Collector, Grafana-stack, chaos, lifecycle, packaging, and synthetic performance tests.

### Changed

- Reworked the original project specifications into session-sized tasks and reconciled production documentation with telemetry, privacy, lineage, validation, and packaging contracts.
- Replaced template scaffolding and metadata with the ObservMe extension factory, package identity, documentation, and shipped companion assets.

### Fixed

- Hardened duplicate session startup, exporter timeout behavior, command parsing, query readiness, dashboard datasource UIDs, Loki labels, active-session trace guidance, and integration-test isolation.
- Corrected latency/size histogram emission, short-window PromQL, content-capture visibility, configuration diagnostics, and local Grafana authentication/TLS handling.
