# Changelog

## Unreleased

### Added

- Added a bounded GitHub-hosted Linux CI job for active-agent lease contracts and cancellation-oriented Docker integration coverage, with resource-labeled unconditional cleanup.
- Added Docker-backed active-agent lease integration coverage for clean shutdown, `SIGTERM`, and `SIGKILL`, proving cached raw claims outlive lease-aware activity without a Collector restart.
- Added a session-scoped active-agent lease controller that renews from the SDK metric collection cycle with an injectable wall clock and deterministic disposal.
- Added the `observme_agent_lease_expires_unixtime_seconds` asynchronous gauge contract with unit metadata and deterministic observable callback test support.
- Added bounded `metrics.activeAgentLeaseDurationMillis` configuration with layered `OBSERVME_ACTIVE_AGENT_LEASE_DURATION_MS` loading, fail-safe validation, and generated/example configuration coverage.
- Added a production-readiness task plan for lease-based active-agent accounting that remains accurate after crashes, forced termination, and cancelled GitHub Actions jobs.
- Added a packaged `observme-docs` Pi skill that routes natural-language ObservMe questions to focused user, operator, reference, example, and contributor documentation through Pi's normal skill discovery, without an ObservMe system-prompt hook.
- Added a versioned `@senad-d/observme/integration` event-bus API and transport-agnostic child-runner example for parent-side spawn/wait/join telemetry and child process lineage propagation.
- Added README tables cataloging available metrics, trace spans, and structured log events, including opt-in and reserved signals.
- Expanded the Grafana suite with SLO Health, Trace Journey, Agent Node Graphs, and LLM Conversations dashboards, plus richer multi-agent, cost, latency, tool, model, log, and export-health views.
- Added correlated, content-safe telemetry for tool results, agent runs, workflows, subagent lifecycle events, interactive Bash executions, and configuration failures.
- Added W3C trace continuation for launcher-propagated parent contexts, with sanitized lineage validation and fail-safe span-link/log fallbacks.
- Added deterministic Pi runtime, Collector, Grafana-stack, dashboard, lifecycle, packaging, and configuration validation coverage.
- Added SonarQube-compatible LCOV output and focused tests for partial Pi runtimes, lifecycle races, fallback paths, privacy controls, and telemetry contracts.

### Changed

- Established a typed Pi event registration contract, removed non-event legacy registrations, pinned the release-resolved Pi API, and added minimum/release compatibility validation with pre-registration diagnostics.
- Completed production active-agent lease documentation, raw-query migration guidance, GitHub Actions/self-hosted clock and cleanup runbooks, missing/expired-lease troubleshooting, Collector restart semantics, and sanitized release-validation evidence.
- Reframed the Collector's five-minute Prometheus `metric_expiration` as exporter-wide stale-series/cardinality cleanup, longer than the default active-agent lease and independent of leased liveness.
- Migrated active-agent dashboard totals, bounded breakdowns, aggregate topology inputs, and stuck-high alerts to leased activity, with raw/expired-claim diagnostics and a deployment-tunable stale-claim alert.
- Defined and enforced canonical lease-aware active-agent PromQL for totals, bounded breakdowns, topology inputs, and alerts, including replica deduplication, future-lease rejection, and zero-safe idle states.
- Documented the production active-agent lease, clock, convergence, instance-join, failure-mode, and backward-compatibility contract used by upcoming runtime and dashboard integration.
- Moved the detailed technical reference into `docs/reference/` and updated package, documentation, examples, dashboards, tests, and skill routes to use the new location.
- Made the packaged `observme-docs` skill resolve routed references from its installed package root instead of the caller's working directory or a repository checkout.
- Reorganized documentation around `docs/README.md`, a categorized technical-reference index, and an example guide with explicit usage and safety notes.
- Split Pi event handling into focused lifecycle, agent/turn, LLM, tool/Bash, and session modules while preserving the `registerHandlers()` facade.
- Centralized telemetry conventions, content-capture policy, sensitive-value rejection, diagnostic sanitization, Grafana transport, `/obs` command plumbing, and trusted-project configuration bootstrap.
- Improved all dashboards with emitted-label-safe queries, selected-range calculations, zero/no-data states, bounded tables, canonical SLO formulas, and time-preserving Loki/Tempo drill-downs.
- Updated the Cost dashboard to aggregate spend across providers and models, preserve token totals from short-lived sessions, and display sub-cent values accurately.
- Updated README, dashboard, integration, and operator documentation to match the current command surface, package contents, privacy defaults, and validation workflows.
- Made strict TypeScript checks, offline coverage, deterministic fixtures, and Docker-backed integration validation more reliable in CI.

### Fixed

- Validated OTLP endpoints as secret-free absolute HTTP(S) URLs and constructed signal exporter paths with deterministic URL pathname semantics.
- Implemented opt-in, versioned, active-branch correlation persistence with bounded validation and idempotent reload recovery, and removed unsupported automatic replay configuration and synthetic duplicate startup telemetry.
- Bound live telemetry, query commands, and backfill correlation to Pi's typed session manager, preserved identity across reload, adopted replacement-session identity, and refreshed active metadata on session rename.
- Bounded and sanitized backend-derived `/obs cost`, `/obs tools`, and `/obs agents` labels, rows, and notification output with visible Unicode-safe truncation.
- Unified `/obs session`, `/obs trace`, and `/obs link` on one validated trace-link builder with canonical placeholders, structured Grafana fallback URLs, and bounded configuration diagnostics.
- Made multi-signal OpenTelemetry startup transactional with bounded rollback, a terminal failed controller state, sanitized Pi diagnostics, and clean later-session recovery.
- Preserved malformed environment and file configuration as bounded rejection diagnostics, with source-specific `/obs status` reporting and strict trusted `.env` parsing.
- Enforced coherent terminal subagent transitions across the integration API, agent tree, spans, events, metrics, runtime state, waits, and joins.
- Enforced production acknowledgement for Grafana and OTLP certificate-verification bypasses, wired retained OTLP TLS behavior into every exporter, and exposed effective transport security in `/obs status` and `/obs health`.
- Kept live-session and backfill OpenTelemetry providers scoped to ObservMe instead of replacing process-global providers.
- Redacted complete supported PEM private-key blocks, including malformed/truncated input, across live and backfilled content capture.
- Bounded all Grafana health and datasource response bodies before JSON parsing across default, custom Node, and injected fetch transports.
- Enforced top-level ObservMe disablement across lifecycle startup, runtime state, integration availability, and all OpenTelemetry signal factories.
- Restored clean npm dependency resolution by pinning TypeScript to the latest release supported by `typescript-eslint`.
- Integrated active-agent lease activation and deactivation with clean shutdown, duplicate/reload replacement, resume, and failed-start cleanup so final flushes cannot renew stale activity.
- Fixed session, workflow, agent, turn, LLM, tool, Bash, histogram, active-span, failure/recovery, and session-count telemetry accuracy.
- Fixed lifecycle serialization, duplicate session replacement, bounded shutdown/flush behavior, backfill cancellation, parallel tool correlation, and bounded agent-tree state cleanup.
- Hardened configuration validation, project-root path confinement, endpoint security, custom redaction patterns, tenant-salted hashing, and environment propagation.
- Hardened integration discovery and lifecycle mutations against malformed providers, unsafe or oversized runtime inputs, and duplicate active spawn/wait/join identifiers.
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
