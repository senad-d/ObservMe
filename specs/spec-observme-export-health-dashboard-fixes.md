# Plan: Repair ObservMe Export Health Dashboard

## Task Description

Create the implementation path to make the **ObservMe Export Health** Grafana dashboard useful in the confirmed local-debug setup where `/obs status` and `/obs health` work, the project is trusted, Pi is not running in Docker, and the OTLP endpoint is correct. The issue is isolated to `dashboards/observme-export-health.json`: healthy/failure-only panels render empty, and several documented self-observability metrics/log events used by the dashboard are currently defined but not emitted or not emitted consistently.

Task type: fix
Complexity: medium

## Objective

When this plan is implemented, the Export Health dashboard should show a meaningful healthy zero state plus populated failure panels when failures are induced, without changing the working local configuration, `/obs status`, `/obs health`, trust behavior, or the user's intentionally unsafe local debug capture settings.

## Problem Statement

The dashboard currently queries these self-observability signals:

- `observme_telemetry_dropped_total`
- `observme_redaction_failures_total`
- `observme_export_errors_total`
- `observme_active_spans`
- `observme_events_observed_total`
- `observme_handler_errors_total`
- Loki events: `redaction.failed`, `telemetry.dropped`, `trace_context.propagation_failed`

Several panels are expected to be quiet when the system is healthy, but Grafana shows empty panels instead of a clear zero/healthy state. More importantly, `observme_events_observed_total`, `observme_active_spans`, and some failure log events are documented and dashboarded but are not currently emitted through normal handlers. That makes the dashboard look broken even though ingestion, local config, and command health are working.

## Solution Approach

Fix the issue in two layers:

1. **Telemetry contract layer:** emit the documented self-observability counters, histograms, gauges, and logs from the Pi handler lifecycle using bounded low-cardinality labels only.
2. **Dashboard presentation layer:** make the dashboard resilient to healthy empty vectors by adding liveness/zero-state panels and PromQL fallbacks, while keeping failure panels useful when local failures are induced.

Do not alter `.pi/observme.yaml`, local OTLP endpoint selection, project trust behavior, Grafana auth/profile, or content-capture policy as part of this fix.

## Relevant Files

- `src/pi/handlers.ts` — central session lifecycle, handler registration, metrics creation, exporter-error recording, bounded registry creation, and active span start/end sites.
- `src/pi/handler-internals.ts` — child-span helper, redaction-failure increments, span eviction helpers, and duration bookkeeping.
- `src/pi/subagent-spawn.ts` — subagent trace propagation failure logs and additional span/drop lifecycle paths.
- `src/semconv/metrics.ts` — documented metric and log-event constants already include the target names.
- `dashboards/observme-export-health.json` — dashboard to fix with zero-state/liveness panels and aligned queries.
- `dashboards/observme-slos.yaml` — export-health SLO depends on `observme_events_observed_total` and should stay aligned.
- `ObservMe-Production-Docs/04-telemetry-semantic-conventions.md` — source of truth for metric/log names and allowed labels.
- `ObservMe-Production-Docs/09-dashboards-alerts-slos.md` — dashboard documentation to update with healthy zero-state expectations.
- `ObservMe-Production-Docs/10-testing-release-operations.md` — operational metric requirements to keep aligned.
- `test/dashboards.test.mjs` — dashboard structure, metric-name, datasource, and Loki-label contract tests.
- `test/exporter-failure.test.ts` — exporter failure and queue-drop behavior coverage.
- `test/chaos-failure.test.mjs` — induced queue-full and redaction-failure tests.
- `test/pi-handlers.test.mjs` and `test/event-mapping.test.ts` — central handler lifecycle/event contract coverage.
- `test/integration/grafana-stack.test.mjs` — local stack integration path for proving Prometheus/Loki visibility.
- `CHANGELOG.md` — record the spec and eventual implementation work.

## Implementation Phases

### Phase 1: Telemetry Contract Foundation

Define how each export-health signal should be emitted, including labels and healthy-state semantics. Add shared helpers so metric increments and matching structured logs stay in sync.

### Phase 2: Core Instrumentation

Instrument handler observation, handler durations, active span accounting, telemetry-drop logs, and redaction-failure logs. Keep every added label low-cardinality and avoid raw prompts, paths, IDs, or secrets.

### Phase 3: Dashboard, Tests, and Documentation

Update the dashboard to show meaningful zero/healthy values, extend unit/integration coverage for induced failures and healthy state, and update docs/changelog.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Define the Export Health telemetry contract

- [x] Document the expected dashboard behavior for a healthy local session and for induced failure scenarios.

#### Why

The dashboard combines normal liveness and failure-only signals. Without an explicit contract, empty panels can be mistaken for ingestion failure, and implementation can drift from dashboards/SLOs.

#### How

- Decide the exact healthy-state behavior:
  - liveness panel shows recent ObservMe event/session activity;
  - failure counters render as `0` when no failures happened;
  - collector/export health renders as healthy when events are observed and no local drops occur;
  - log tables remain empty unless matching failures occur.
- Define the low-cardinality labels for self-observability metrics:
  - `operation` for handler/span/export/redaction operation names;
  - `reason` for bounded drop/export failure reasons;
  - `error_class` for bounded/sanitized error classes;
  - `status` only when needed.
- Keep high-cardinality values in spans/logs only, not Prometheus labels.

#### Where

- `ObservMe-Production-Docs/04-telemetry-semantic-conventions.md`
- `ObservMe-Production-Docs/09-dashboards-alerts-slos.md`
- `ObservMe-Production-Docs/10-testing-release-operations.md`

#### Acceptance criteria

- Docs describe why failure-only panels may be quiet but should not make the whole dashboard blank.
- Docs state which signals populate Export Health and which labels are allowed.
- No contract requires changing `/obs status`, `/obs health`, project trust, local URL, or debug capture settings.

### 2. Emit handler observation and duration metrics

- [x] Add instrumentation so handled Pi events increment `observme_events_observed_total` and record `observme_handler_duration_ms`.

#### Why

`observme_events_observed_total` is documented and used by the Export Health dashboard/SLO, but it is not currently emitted by normal handler execution. `observme_handler_duration_ms` is also documented and should show handler pressure.

#### How

- Add a small handler-observation helper that records:
  - `eventsObserved.add(1, { operation })` when an event is handled while a telemetry session exists;
  - `handlerDurationMs.record(duration, { operation, status })` after the handler finishes.
- Special-case `session_start` so the current session can count its startup event after telemetry is initialized.
- Preserve existing `safeHandler` error behavior and continue to emit `handler.failed` on exceptions.
- Keep operation names normalized with the existing metric normalization behavior.
- Avoid adding raw event names beyond the bounded known Pi handler names already registered.

#### Where

- `src/pi/handlers.ts`
- `src/pi/handler-internals.ts` if normalization/duration helpers belong there
- `test/pi-handlers.test.mjs`
- `test/event-mapping.test.ts`

#### Acceptance criteria

- A representative session emits `observme_events_observed_total` for session, agent, turn, LLM, tool, bash, branch/compaction, and shutdown handler paths where applicable.
- Handler duration records are emitted with bounded labels and without high-cardinality IDs.
- Handler errors still increment `observme_handler_errors_total` and emit `handler.failed` logs.
- Tests prove the new metrics are emitted without changing command behavior.

### 3. Add active span accounting for `observme_active_spans`

- [x] Track active span gauge increments/decrements for spans shown by the Export Health dashboard.

#### Why

The dashboard queries `observme_active_spans`, but the metric is currently only created, not updated. This makes the SDK pressure panel permanently empty.

#### How

- Introduce session-aware helpers for active span lifecycle:
  - increment on span start with `operation` label;
  - decrement exactly once on span end/eviction/shutdown;
  - use an idempotency guard such as a `WeakMap`/`WeakSet` keyed by span to prevent double decrement.
- Cover the root `pi.session` span and child spans started through `startChildSpan` or equivalent session-aware wrappers.
- Update explicit end paths including agent end, turn end, LLM response/failure, tool end, bash completion, branch/compaction spans, subagent wait/join/spawn spans, eviction, and `endAllActiveSpans`.
- Keep operation labels bounded, e.g. `session`, `agent_run`, `turn`, `llm_request`, `tool_call`, `bash_execution`, `branch`, `compaction`, `subagent_spawn`, `agent_wait`, `agent_join`.

#### Where

- `src/pi/handlers.ts`
- `src/pi/handler-internals.ts`
- `src/pi/subagent-spawn.ts`
- `test/pi-handlers.test.mjs`
- `test/chaos-failure.test.mjs`
- `test/cardinality.test.ts`

#### Acceptance criteria

- Starting spans increments `observme_active_spans` by operation.
- Normal span completion, eviction, and session shutdown decrement the gauge exactly once.
- Tests cover normal completion and queue-full eviction without negative double-decrement behavior.
- Cardinality tests confirm no high-cardinality labels are introduced.

### 4. Emit structured logs for telemetry drops and redaction failures

- [x] Refactor drop/redaction failure paths so metric increments and Loki-visible structured logs are emitted together.

#### Why

The dashboard includes Loki panels for `telemetry.dropped` and `redaction.failed`, but the current code increments some counters without emitting matching log events. The tables therefore remain empty even when failures are induced.

#### How

- Add helper functions such as `recordTelemetryDrop(session, reason, attributes)` and `recordRedactionFailure(session, operation, attributes)`.
- Use the helpers for:
  - bounded span registry evictions;
  - agent-tree evictions;
  - redaction drops in LLM, tool, and bash content capture;
  - any future local drop path discovered during implementation.
- Emit logs using the existing canonical events:
  - `LOG_EVENT_NAMES.TELEMETRY_DROPPED` / `telemetry.dropped`;
  - `LOG_EVENT_NAMES.REDACTION_FAILED` / `redaction.failed`.
- Include safe structured attributes only: bounded `reason`, `operation`, `event.category`, and existing safe lineage attributes if available.
- Continue to update `/obs status` queue-drop state via `recordObsStatusQueueDrop()`.

#### Where

- `src/pi/handlers.ts`
- `src/pi/handler-internals.ts`
- `src/pi/subagent-spawn.ts` if a drop path exists there
- `test/exporter-failure.test.ts`
- `test/chaos-failure.test.mjs`
- `test/redact.test.mjs` or `test/redaction.test.ts` if helper behavior is isolated

#### Acceptance criteria

- Queue-full/eviction tests assert both `observme_telemetry_dropped_total` and a `telemetry.dropped` log.
- Redaction-failure tests assert both `observme_redaction_failures_total` and a `redaction.failed` log.
- No raw content is emitted in the new failure logs.
- Existing export-failure logs remain unchanged and continue to populate `export.failed` panels.

### 5. Update the Export Health dashboard for healthy zero-state rendering

- [x] Adjust `dashboards/observme-export-health.json` so the dashboard is informative when the system is healthy and quiet.

#### Why

Failure-only PromQL often returns no series when no failure occurred. Grafana then shows “No data,” which looks broken even though it can mean “healthy.”

#### How

- Add or adjust top-level liveness panels, for example:
  - recent observed event rate from `observme_events_observed_total`;
  - sessions started/shutdown total or recent rate;
  - export health stat based on events observed and drops.
- Add `or vector(0)` fallbacks where a zero is more useful than an empty result, especially for:
  - telemetry drops;
  - redaction failures;
  - export failures;
  - handler errors.
- Keep log tables empty for no matching failures, but update descriptions to say empty means no matching failure logs in the selected time range.
- Rename or clarify the active-span panel if needed so it reflects active spans/SDK pressure rather than a queue metric that does not exist.
- Preserve provisioned datasource UIDs: `prometheus` and `loki`.

#### Where

- `dashboards/observme-export-health.json`
- `test/dashboards.test.mjs`

#### Acceptance criteria

- Dashboard JSON remains valid and imports through provisioning.
- Healthy local telemetry shows at least one liveness/health panel instead of an entirely empty dashboard.
- Failure counters render as zero when no failure series exists.
- Existing dashboard validation tests pass and are extended to protect the zero-state behavior where practical.

### 6. Add deterministic tests for dashboard-driving signals

- [x] Add/extend tests that prove the exact signals queried by the dashboard are emitted.

#### Why

The repository already validates metric names and dashboard shape, but it did not catch that documented metrics were created but never updated. Tests should cover the dashboard-driving signal path, not only constants.

#### How

- Add focused unit tests with the fake meter/logger to assert emission for:
  - `observme_events_observed_total`;
  - `observme_handler_duration_ms`;
  - `observme_active_spans` increments/decrements;
  - `telemetry.dropped` logs;
  - `redaction.failed` logs.
- Extend dashboard tests to assert the Export Health dashboard uses zero-safe PromQL for failure-only panels.
- Extend local stack integration only if it can stay deterministic and secret-safe:
  - generate representative telemetry;
  - query Prometheus for the dashboard-driving metrics;
  - query Loki for induced failure log labels.

#### Where

- `test/pi-handlers.test.mjs`
- `test/exporter-failure.test.ts`
- `test/chaos-failure.test.mjs`
- `test/dashboards.test.mjs`
- `test/integration/grafana-stack.test.mjs` if needed

#### Acceptance criteria

- Tests fail before implementation for at least one missing Export Health signal and pass after implementation.
- Tests assert dashboard-driving metrics are emitted, not only defined.
- Tests remain secret-safe and do not require reading `.env` or secret files.
- Tests avoid shell redirection such as `2>/dev/null` in validation instructions.

### 7. Validate locally and update release notes

- [x] Run validation and update documentation/changelog after implementation.

#### Why

The fix spans metrics, logs, dashboards, docs, and tests. A full validation pass is needed to prove it does not regress the already-working local stack, `/obs status`, or `/obs health`.

#### How

- Run targeted tests first, then the normal validation pipeline.
- If using Docker inspection commands, do not use shell redirection that GuardMe blocks; run commands directly and inspect output.
- Manually verify the dashboard in the running local Grafana stack after new telemetry is emitted:
  - healthy state shows liveness/zero values;
  - induced queue-full or redaction failure shows failure panels/log rows.
- Update `CHANGELOG.md` with the implementation summary.

#### Where

- `CHANGELOG.md`
- `docs/validation-flow.md` if the manual dashboard check should be documented
- `README.md` only if user-facing troubleshooting guidance changes

#### Acceptance criteria

- `/obs status` and `/obs health` still work with the trusted local project.
- Export Health dashboard displays meaningful healthy state in the local stack.
- Induced telemetry drops/redaction/export failures populate the expected panels.
- Changelog documents the fix.

## Testing Strategy

Use layered coverage:

1. **Unit tests** with fake meter/logger for exact metric/log emission paths.
2. **Dashboard contract tests** for Grafana JSON shape, datasource UID stability, documented metric names, Loki labels, and zero-state PromQL expectations.
3. **Integration tests** against the existing Grafana stack only for deterministic Prometheus/Loki visibility checks.
4. **Manual local verification** in Grafana for the exact `ObservMe Export Health` dashboard after generating new telemetry.

## Acceptance Criteria

- `observme_events_observed_total` is emitted during normal session handling and used by the dashboard/SLO.
- `observme_handler_duration_ms` records handler timing with safe low-cardinality labels.
- `observme_active_spans` increments/decrements accurately and does not leak or double decrement.
- Telemetry drops emit both counter increments and `telemetry.dropped` logs.
- Redaction failures emit both counter increments and `redaction.failed` logs.
- `dashboards/observme-export-health.json` has a clear healthy/zero state and remains provisioned with `prometheus`/`loki` datasource UIDs.
- Existing working areas remain unchanged: project trust, local OTLP URL, `/obs status`, `/obs health`, and local debug capture configuration.

## Validation Commands

Execute these commands to validate the task is complete:

- `npm run typecheck` — TypeScript source validation.
- `npm run typecheck:test` — TypeScript test validation.
- `node --test test/dashboards.test.mjs test/exporter-failure.test.ts test/chaos-failure.test.mjs test/pi-handlers.test.mjs` — targeted Export Health signal/dashboard coverage.
- `npm run test` — full unit test suite.
- `npm run test:integration:grafana-stack` — local Grafana stack integration coverage when Docker is available.
- `npm run validate` — full repository validation.

Optional stack inspection without shell redirection:

- `docker compose -f observability-stack/docker-compose.yml ps --format json` — confirm local stack services are running if manual verification is needed.

## Notes

- The user's current local debug capture settings are intentionally permissive and are out of scope for this fix.
- Do not change the local OTLP endpoint from `http://localhost:4318`; Pi is not running inside Docker in this scenario.
- Do not treat empty failure log tables as inherently bad; they are healthy when no matching failure was emitted in the selected range.
- Any new metric labels must stay within the documented low-cardinality allowlist.
