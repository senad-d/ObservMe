# Changelog

## Unreleased

### Added

- Added Loki-backed friendly-name identity tables and Trace Journey spawn-name columns that keep display names as presentation metadata while correlating by agent, workflow, and trace IDs.
- Added exporter-enabled Tempo/Loki/Prometheus integration assertions for retained trace/log identity metadata and absent metric identity labels, plus native Loki OTLP ingestion that keeps friendly identity as structured metadata and indexes only bounded selector attributes.
- Added a one-tarball packaged parent/child compatibility smoke that negotiates API v2 from an isolated parent install and explicitly loads the same release in a real child process to verify envelope-version-1 identity without exposing environment contents.
- Extended the dependency-free future OrcMe fixture with direct Pi RPC environment tombstones, one-shot technical-ID retry, nested identity propagation, and exactly-once lifecycle-order contracts.
- Added a dependency-free structural fixture for planned future OrcMe v2 negotiation, exact four-role identity mapping, and unchanged definition-name capabilities without claiming current OrcMe v2 support.
- Added consistent v2 child identity semantic attributes across parent spawn/terminal traces and logs plus child runtime resources, spans, and logs, while preserving explicit v1 and historical roles.
- Added deterministic synchronous multi-provider package negotiation with highest-version selection, Pi load-order tie-breaking, late-response fencing, and structural v2 guards.
- Added explicit frozen v1 and v2 session-backed integration provider adapters with highest-mutual-version response selection and atomic v2 child-descriptor validation.
- Added configurable, collision-validated environment key names for child-identity envelope version, display name, role, and the existing capability contract.
- Added one atomic, observability-free child descriptor validator with bounded value-free failures and exact display-name, role, and capability checks.
- Added source-compatible v2 integration API types for explicit child display names, fixed roles, capabilities, and identity-envelope metadata while retaining every v1 export unchanged.
- Added a 17-step, session-sized implementation plan for a versioned ObservMe child display-name, capability, and four-role contract, aligned with OrcMe's implemented API-v1 behavior, planned `lead`/`helper`/`worker`/`validator` model, and package-decoupled compatibility requirements.
- Lease-based active-agent accounting: a session-scoped lease controller renewed from the SDK metric cycle, the `observme_agent_lease_expires_unixtime_seconds` gauge, bounded `metrics.activeAgentLeaseDurationMillis` / `OBSERVME_ACTIVE_AGENT_LEASE_DURATION_MS` configuration, and Docker-backed CI coverage for clean shutdown, `SIGTERM`, and `SIGKILL`.
- Versioned `@senad-d/observme/integration` event-bus API and a transport-agnostic child-runner example for parent-side spawn/wait/join telemetry and child process lineage propagation.
- Packaged `observme-docs` Pi skill that routes natural-language ObservMe questions to focused documentation, resolves references from its installed package root, and verifies answers against the current implementation.
- W3C trace continuation for launcher-propagated parent contexts, with sanitized lineage validation and fail-safe span-link/log fallbacks.
- Correlated, content-safe telemetry for tool results, agent runs, workflows, subagent lifecycle events, interactive Bash executions, and configuration failures.
- New Grafana dashboards (SLO Health, Trace Journey, Agent Node Graphs, LLM Conversations) plus richer multi-agent, cost, latency, tool, model, log, and export-health views.
- README tables cataloging available metrics, trace spans, and structured log events, including opt-in and reserved signals.

### Changed

- Removed the fixed-version Pi compatibility CI matrix; normal validation retains capability-based startup checks and real Pi runtime smoke coverage without reinstalling selected Pi releases.
- Published the integration API v2 wire and compatibility contract for helper-based and package-decoupled consumers, including the 0.1.8 child-envelope minimum, the unchanged metadata-free v1 path for legacy launchers and older children, and an explicit distinction between OrcMe's shipped API-v1 behavior and planned v2 adoption. Display identity and role remain non-authoritative supplementary telemetry, while raw prompts, commands, credentials, and environment contents retain the existing privacy boundaries.
- The transport-neutral subagent runner now requires a complete child descriptor, negotiates only the explicit v2 integration helper, preserves returned environment objects and tombstones unchanged, and remains transport-functional without falling back to v1 lifecycle calls.
- Role-aware dashboards now preserve exact v2 and legacy agent-role series, while the local Collector explicitly removes display-name and capability resource attributes before Prometheus label promotion.
- `/obs agents` now shows retained display names, exact roles, capabilities, and technical IDs in local rows while metric builders exclude display name and capability and bound role labels to the v2 catalog plus explicit legacy values.
- Parent-side v2 spawn state and synthetic child tree nodes now retain one immutable descriptor through lifecycle transitions and bounded eviction, while v1 synthetic children remain metadata-free.
- Child runtimes now hydrate display name, exact v2 role, and capability only from complete supported identity envelopes; malformed, partial, contradictory, or unknown-version identity fails open atomically with bounded value-free diagnostics, while v1 remains metadata-free.
- Child process propagation now scrubs all configured identity keys, writes complete version-1 envelopes only for explicit v2 children, and keeps v1 launches metadata-free without inheriting parent capability.
- Raised the release-tested Pi compatibility target to 0.82.0 (earliest validated remains 0.80.5) and updated `protobufjs` to 7.6.5, resolving GHSA-j3f2-48v5-ccww.
- A complete propagated lineage envelope without `traceparent` no longer fails open to an orphaned root: the child joins the parent workflow at the correct depth and starts a new trace with a bounded `trace_context.propagation_failed` fallback.
- Migrated active-agent dashboard totals, topology inputs, and alerts to lease-aware activity with canonical PromQL (replica deduplication, future-lease rejection, zero-safe idle states) plus raw/expired-claim diagnostics and runbooks.
- Reorganized documentation around `docs/README.md` and `docs/reference/`, reconciled all guidance with the current command registry, config loader, event handlers, and privacy pipeline, and added an "every agent appears as its own root" troubleshooting guide.
- Split Pi event handling into focused lifecycle, agent/turn, LLM, tool/Bash, and session modules behind the `registerHandlers()` facade, and centralized telemetry conventions, content-capture policy, Grafana transport, and `/obs` command plumbing.
- Improved all dashboards with emitted-label-safe queries, zero/no-data states, bounded tables, canonical SLO formulas, accurate cross-provider cost aggregation, and time-preserving Loki/Tempo drill-downs.
- Removed Pi version gating from extension startup; essential ExtensionAPI capabilities are checked before registration and optional APIs remain feature-detected.

### Fixed

- Resolved the active SonarCloud maintainability findings across lineage propagation, path redaction, and sensitive-input regular-expression construction without changing runtime behavior.
- Aligned the real Pi runtime smoke with its offline telemetry fixture so `/obs health` verifies disabled Collector signals and Grafana query health without requiring OTLP exporters.
- Kept bounded `/obs backfill` abort cleanup timers referenced while awaited so timed-out exporter setup settles reliably across supported Node.js releases.
- Kept the Pi handler facade below its enforced thin-module boundary after adding runtime ownership exports.
- Reconciled the public integration API environment-key limit at 128 characters across runtime validation, boundary tests, and integration documentation.
- Neutralized Unicode bidirectional controls in backend labels and final `/obs` notifications without stripping ordinary international text.
- Disposed custom backfill exporters that settle after setup timeout without letting late failures replace the bounded timeout result.
- Rolled back the shared integration event-bus listener when later extension factory initialization fails, preventing repeated failed Pi loads from accumulating stale providers.
- Aligned orphan-agent producers, `/obs agents`, dashboards, reference queries, fixtures, and contract tests on the emitted bounded `status` and `reason` metric labels, replacing misleading role/depth attribution.
- Recorded subagent spawn duration exactly once at usable launcher-handle acquisition or pre-handle failure, keeping delayed child completion, wait, and join time out of launcher-latency dashboards while preserving v1/v2 structural compatibility through an optional capability.
- Prevented late child failure and recovery observations from being recounted after bounded accounting eviction with a fixed-size archive of evicted transition fingerprints.
- Kept generated child, wait, and join lifecycle identifiers within the integration API's public bound so exact-boundary starts can echo every returned identity through completion while retaining deterministic duplicate detection.
- Preserved exact `lead`, `helper`, `worker`, and `validator` lineage roles in integration API v2 `getContext()` results while keeping the legacy v1 role mapping unchanged.
- Unified Grafana base-URL validation across config loading, status, readiness, health, and query transports, rejecting blank, unresolved, malformed, relative, credential-bearing, and non-HTTP(S) values with bounded diagnostics.
- Closed diagnostic sanitization gaps for API-key and client-secret assignment variants, root/relative/home/Windows/UNC paths, and username-only or otherwise incomplete URL userinfo across command, OTEL, and Grafana failures.
- Redacted complete POSIX, Windows drive, UNC, and local `file://` paths containing spaces in every non-`full` privacy path mode without changing ordinary URL or slash-separated prose handling.
- Bounded configuration and programmatic timer values to Node's signed 32-bit maximum before command, query, backfill, shutdown, OTLP, and OpenTelemetry scheduler use.
- Preserved full root `/obs` argument streams so `status`, `health`, and `session` reject unsupported extra, quoted, or repeated tokens before provider work.
- Preserved fulfilled `/obs tools` and `/obs agents` Prometheus sections during sibling query failures, with section-specific bounded warnings and explicit all-failed unavailable states.
- Required `/obs cost`, `/obs tools`, and `/obs agents` fixed Prometheus queries to return instant vectors, preserving valid empty vectors while surfacing scalar, string, and matrix contract failures.
- Aligned `/obs health` Collector probes with every enabled effective OTLP signal endpoint, exporter headers and TLS verification, and no-follow redirect handling that prevents credential forwarding.
- Bounded every anchored-create helper protocol response to two seconds and every disconnect/TERM/KILL reaping step to 250 ms, with identity-safe disconnect cleanup, forced termination, and fail-closed diagnostics for uncertain partial-file cleanup.
- Made Pi handler error recorders and startup/UI notifications best-effort so secondary diagnostics cannot block tool middleware, reject handlers, or abort telemetry startup.
- Guaranteed failed-start and session-shutdown controller cleanup despite throwing telemetry bookkeeping, retaining unresolved operations before best-effort export diagnostics so replacement startup remains fenced.
- Changed the automatic trusted-project starter into an inactive commented setup guide so first start and reload retain active global defaults until project overrides are explicitly adopted.
- Excluded every rejected configuration layer from merging and separated rejected-source provenance from the accepted effective source and whole-config fallback in logs, UI warnings, and `/obs status`.
- Preserved explicit ObservMe disablement when unrelated configuration is invalid, keeping real session startup telemetry-free while reporting bounded rejection diagnostics.
- Fixed dashboard and alert queries: removed a nonexistent lineage SLO matcher, guarded SLO indicators against empty-vector arithmetic, removed `for:` durations that prevented any-failure alerts from ever firing, and corrected node-graph value fields and label groupings.
- Made multi-signal OpenTelemetry startup transactional with bounded rollback and clean recovery, retained unresolved failed-start rollback behind a process-wide startup fence until late settlement or safe retry, kept failed signal shutdowns and timed-out flushes retryable, and integrated lease activation/deactivation with shutdown, reload, resume, and failed-start cleanup.
- Hardened configuration and file I/O: bounded config/`.env` reads, symlink- and ancestor-swap-safe project file handling, rejection of credentials embedded in Grafana base URLs, and secret-free OTLP endpoint validation.
- Bounded custom redaction names, matches, replacement size, and output so broad patterns fail closed, replaced regex heuristics with structural validation, and redacted complete PEM private-key blocks across live and backfilled capture.
- Corrected telemetry accuracy for sessions, workflows, agents, turns (including `turnIndex: 0`), LLM requests, tools, interactive Bash, histograms, and failure/cancellation outcomes derived from Pi's typed terminal payloads.
- Hardened the integration API: bound wait/join completion to the original spawn and child identity, rejected identifier collisions and malformed or oversized runtime inputs, enforced coherent terminal subagent transitions, and cancelled active spawn/wait/join telemetry exactly once at shutdown.
- Made `/obs` commands robust with bounded notification output, partial results when Grafana backends are disabled or failing, accurate `/obs backfill` delivery reporting, and one validated trace-link builder for `/obs session`, `/obs trace`, and `/obs link`.
- Corrected documentation that overstated file-path capture, live PII detection, or backfill scope, presented reserved telemetry as live, and removed stale repository-only local-stack guidance.
- Restored clean npm dependency resolution for `typescript-eslint` 8.65.0 by pinning TypeScript to the latest supported release.

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
