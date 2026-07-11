# Plan: ObservMe Architecture

## Task Description

Define the target architecture for **ObservMe**, a TypeScript Pi extension that instruments Pi agent sessions and exports OpenTelemetry (OTLP) traces, metrics, and logs to an external, backend-neutral observability stack (OTel Collector → Tempo/Loki/Prometheus-Mimir → Grafana), while preserving multi-agent workflow/subagent lineage and staying privacy-preserving by default. This spec describes the architecture only. It is a preparation-phase artifact: it must not be implemented by this document, and no functional code changes accompany it.

## Objective

Produce a single authoritative architecture reference — module boundaries, Pi extension surfaces, data flow, state/config model, dependency policy, security boundaries, and validation strategy — that a later implementation session can follow checkbox-by-checkbox from `specs/spec-tasks.md` without re-deriving design decisions.

## Problem Statement

Pi agents are ephemeral processes. Without ObservMe, there is no durable, centralized way to see which sessions are running, which are expensive, which tools/models fail or run slowly, or how parent agents relate to spawned subagents once the Pi process exits. Pi's extension API provides rich lifecycle events but no built-in OTEL export, no built-in subagent-lineage event, and no built-in redaction. ObservMe must fill that gap without becoming a local telemetry database, without blocking Pi execution when the observability backend is degraded, and without leaking prompts, secrets, or file paths by default.

## Solution Approach

ObservMe registers Pi lifecycle event handlers and `/obs` commands from its extension factory (`src/extension.ts`), but defers all OpenTelemetry SDK startup (exporters, timers, sockets) to `session_start`, and tears it down in `session_shutdown`, per Pi's documented extension-factory constraints (factories may run in invocations that never start a session). Each Pi event is mapped through a semantic layer (`src/semconv/`) into OTEL spans/metrics/logs using `pi.*` and `observme.*` namespaces plus official `gen_ai.*` attributes where they fit — never a bare `agent.*` namespace, and never OpenInference. All optional content (prompts, responses, tool args/results, bash output, file paths) is disabled by default and passes through a mandatory redaction pipeline before export. Workflow and agent/subagent lineage is modeled explicitly (`pi.workflow.id`, `pi.agent.id/parent_id/root_id/depth`) and propagated across process boundaries via W3C `traceparent`/`tracestate` plus `OBSERVME_*` environment variables, because Pi has no native "subagent spawned" event. Telemetry is OTLP-first and Collector-first; direct-to-backend export is allowed only for development. Every export path fails open — Collector/backend outages must never block tool calls, model calls, or session continuation.

## Relevant Files

Use these files/directories as the architectural basis (already present from the template bootstrap and the ObservMe documentation set):

- `src/extension.ts` — current template entry point; will become the thin `observme(pi)` factory that only imports and registers feature modules.
- `src/constants.ts` — extension display name / status key; branding already updated to ObservMe naming.
- `docs/STRUCTURE.md` — template's file-layout convention (`commands/`, `tools/`, `events/`, `config/`, `utils/`) that this architecture extends with `otel/`, `pi/`, `semconv/`, `privacy/`, `query/`.
- `package.json` — `pi.extensions` entry point, `peerDependencies` (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `typebox`) vs `dependencies` (OpenTelemetry packages) boundary.
- `docs/reference/02-reference-architecture.md` — canonical high-level architecture, component responsibilities, data flow, trace shape, deployment topologies, failure modes.
- `docs/reference/03-pi-event-and-session-model.md` — canonical Pi event/session-entry to span mapping table; turn-id derivation; recovery/backfill rules.
- `docs/reference/04-telemetry-semantic-conventions.md` — canonical attribute/span/metric/log naming.
- `docs/reference/05-otel-pipeline-and-collector.md` — canonical OTLP exporter defaults and Collector configs.
- `docs/reference/06-security-privacy-redaction.md` — canonical redaction pipeline and data classification.
- `docs/reference/07-extension-implementation-blueprint.md` — canonical repository layout, runtime interfaces, span registry, event handler pseudo-code.
- `docs/reference/12-configuration-reference.md` — canonical config schema, env vars, precedence order.
- `docs/reference/13-source-notes.md` — explicit list of assumptions cross-checked against Pi/OTEL/Grafana official docs; source of truth for anything ambiguous in the other docs.
- `specs/project-definition-brief.md` — approved identity, scope, and integration-surface decisions for this project.

### New Files (created during a later implementation session, not during preparation)

```text
src/config/{load-config,schema,defaults}.ts
src/otel/{sdk,traces,metrics,logs,shutdown}.ts
src/pi/{handlers,session,event-normalizer,agent-lineage,agent-tree-tracker,turn-tracker}.ts
src/semconv/{attributes,metrics,spans}.ts
src/privacy/{redact,secret-patterns,hash,truncate}.ts
src/commands/obs-{status,health,session,cost,agents,link,trace,tools,errors,logs,backfill}.ts
src/query/{grafana,tempo,loki,prometheus}.ts
src/util/{safe-json,time,trace-context,bounded-map}.ts
test/{redaction,event-mapping,metrics,exporter-failure,agent-lineage,cardinality}.test.ts
examples/{observme.yaml,collector.yaml}
dashboards/observme-*.json
```

## Implementation Phases

### Phase 1: Foundation (config, semantic conventions, privacy primitives)
Config loading/precedence, attribute/span/metric name constants, redaction pipeline, hashing/truncation utilities, bounded-map utility for span registries. No OTEL SDK wiring yet; pure/testable modules only.

### Phase 2: Core Implementation (OTEL runtime + Pi event mapping)
OTEL SDK bootstrap deferred to `session_start`; span registry; event handlers for session/agent-run/turn/LLM-request/tool-call/bash/model-change/thinking-change/compaction/branch/session-shutdown; agent-lineage context generation and propagation; metrics and structured logs per the semantic-convention doc.

### Phase 3: Integration & Polish (`/obs` commands, query clients, dashboards, tests)
`/obs status|health|session|cost|trace|tools|errors|logs|agents|link|backfill` commands; Grafana/Tempo/Loki/Prometheus query clients used only for the optional read path; dashboard JSON artifacts; Collector reference configs; full test suite (unit, event-mapping fixtures, redaction corpus, exporter-failure, agent-lineage, cardinality).

## Module Boundaries

```text
Pi Event Capture  →  Semantic Mapper  →  OTEL Emitters (traces | metrics | logs)
        │                    │                    │
        │                    │                    ├─ Collector (OTLP/HTTP or gRPC)
        │                    │                    │      → Tempo / Loki / Prometheus-Mimir → Grafana
        │                    │
        └──── /obs Query Commands ─── (read-only, optional, never blocks emission)
```

- **`src/extension.ts`** — imports and calls each `register*` function; no long-lived resources started here.
- **`src/events/lifecycle.ts` + `src/pi/handlers.ts`** — subscribe to Pi lifecycle events; safe-wrap every handler so it can never throw into Pi (`safeHandler` pattern).
- **`src/pi/session.ts`, `agent-lineage.ts`, `agent-tree-tracker.ts`, `turn-tracker.ts`** — session-scoped runtime state: span registry, workflow/agent identity, depth/fan-out/active-child tracking, derived turn IDs (`agent-run-XXXXXX-turn-XXXXXX`), all in-memory and bounded.
- **`src/semconv/`** — pure mapping functions from Pi event payloads to OTEL attribute objects; no I/O.
- **`src/privacy/`** — pure redaction/hash/truncate functions; every optional content field passes through this before reaching `src/otel/`.
- **`src/otel/`** — SDK lifecycle (start in `session_start`, flush/shutdown with timeout in `session_shutdown`), exporters, tracer/meter/logger accessors.
- **`src/commands/obs-*.ts`** — thin command handlers that read from the query layer or local runtime state; never mutate telemetry state as a side effect of a query.
- **`src/query/`** — Grafana/Tempo/Loki/Prometheus HTTP clients with timeouts and result-size limits; dependency direction is one-way (`emit telemetry` does not depend on `query` availability).
- **`src/config/`** — layered config loader; factory-safe subset (defaults + global + env) vs session-scoped subset (adds trusted project config via `ctx.isProjectTrusted()`).

## Pi Integration Surface (planned; see `specs/project-definition-brief.md` §4 for the full table)

- Commands: `/obs status`, `/obs health`, `/obs session`, `/obs cost`, `/obs trace`, `/obs tools`, `/obs errors`, `/obs logs`, `/obs agents`, `/obs link`, `/obs backfill` (backfill disabled by default).
- Events: `session_start`, `session_shutdown`, `agent_start`, `agent_end`, `turn_start`, `turn_end`, `before_provider_request`, `after_provider_response`, `message_start/update/end`, `tool_execution_start/update/end`, `tool_call`, `tool_result`, `user_bash`, `model_select`, `thinking_level_select`, `session_compact`, `session_tree`.
- Extension-level (no dedicated Pi event): subagent-spawn and wait/join wrapping at the point a tool/extension launches or waits for another Pi process — creates `pi.agent.spawn`, `pi.agent.wait`, and `pi.agent.join` spans/events, propagates trace context + workflow/lineage env vars to the child, and reports depth/fan-out/active-child/orphan/propagation-failure metrics.

## Data Flow (canonical, from `02-reference-architecture.md` §3)

```text
session_start        → pi.session root span, session.started log, session counter++
agent_start/turn_*    → pi.agent.run span (child of session) → pi.turn span (child of agent.run)
before_provider_request → pi.llm.request GenAI span (child of turn)
message_end (assistant) → finalize LLM span: usage, cost, stop_reason, end span, update metrics
tool_execution_start  → pi.tool.call span (child of turn)
tool_result/tool_execution_end → close tool span, update tool metrics
subagent spawn point  → pi.agent.spawn span; propagate traceparent/tracestate + OBSERVME_WORKFLOW_ID + OBSERVME_* env vars
parent wait/join      → pi.agent.wait / pi.agent.join spans/events for child critical-path timing and result status
session_compact       → pi.compaction span/log/metric from compactionEntry
session_tree          → pi.branch span/log/metric, includes summaryEntry when present
session_shutdown      → end all open spans, flush OTEL SDK with bounded timeout, no infinite blocking
```

Canonical trace shape:

```text
pi.session
├── pi.agent.run 1
│   ├── pi.turn 1
│   │   ├── pi.llm.request
│   │   ├── pi.tool.call bash
│   │   ├── pi.tool.call read
│   │   └── event: llm.request.completed
│   └── pi.turn 2
│       ├── pi.llm.request
│       ├── pi.tool.call subagent
│       ├── pi.agent.spawn
│       ├── pi.agent.wait
│       └── pi.agent.join
├── pi.compaction
└── pi.branch
```

## Multi-Agent Workflow Visibility Additions

The implementation must expose agent-tree visibility for orchestrator workloads without making workflow IDs or agent IDs metric labels. Required additions are `pi.workflow.*` correlation attributes, `pi.agent.wait` / `pi.agent.join` spans/events, active-agent tracking, fan-out/depth/width histograms, orphan-agent and trace-context propagation failure counters, child-agent failure/recovery counters, and `/obs agents` summaries. Per-workflow drill-down uses Tempo/Loki attributes; aggregate dashboards and alerts use only low-cardinality labels such as `agent_role`, `agent_capability`, `subagent_depth`, `spawn_type`, `spawn_reason`, and `status`.

## Config, State, and Persistence

- **Config precedence:** defaults → global (`~/.pi/agent/observme.yaml`) → project (`<CONFIG_DIR_NAME>/observme.yaml`, only when `ctx.isProjectTrusted()`) → environment variables (`OBSERVME_*`) → explicit runtime options. Factory-safe loading may only use defaults/global/env; session-scoped loading (on `session_start`) may add trusted project config, then reapply env/runtime overrides so precedence stays correct.
- **In-memory state only:** span registry (bounded maps — `maxActiveAgentRuns: 16`, `maxActiveTurns: 128`, `maxActiveToolCalls: 1024`, `maxActiveLlmRequests: 128`, `maxActiveSubagentSpawns: 128`, `maxActiveAgentWaits: 128`, `maxActiveAgentJoins: 128`), OTEL metric instruments, bounded SDK retry/export queues. No SQLite, JSONL archives, or parquet files.
- **No default file writes.** Optional `writeCorrelationEntry` (disabled by default) may append one minimal `custom` session entry for lineage recovery — never `custom_message`, which participates in LLM context.
- **Recovery on startup in an existing session:** read session header only, set `pi.session.id`/`pi.agent.id`/resource attributes; do not continuously tail the session file; do not replay old telemetry unless `replayOnStart: true` is explicitly set (off by default), and mark replayed telemetry `observme.replayed=true`.
- **Span registry eviction:** when a bounded map is full, end the oldest span with `observme.evicted=true` and increment `observme_telemetry_dropped_total{reason="span_registry_full"}`.

## Dependencies

- **`peerDependencies` (keep `"*"`):** `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `typebox`.
- **`dependencies` (to add in implementation session):** `@opentelemetry/api`, `@opentelemetry/api-logs`, `@opentelemetry/sdk-node`, `@opentelemetry/sdk-trace-node`, `@opentelemetry/sdk-metrics`, `@opentelemetry/sdk-logs`, `@opentelemetry/exporter-trace-otlp-proto`, `@opentelemetry/exporter-metrics-otlp-proto`, `@opentelemetry/exporter-logs-otlp-proto`, `@opentelemetry/resources`, `@opentelemetry/semantic-conventions`. Pin exact versions; do not assume all `@opentelemetry/*` packages share one major version line.
- **`devDependencies`:** unchanged template tooling (`typescript`, `eslint`, `typescript-eslint`, `@types/node`, etc.) plus whatever test runner the implementation session confirms (template currently uses `node --test`; OTEL SDK testing may need fixtures/mocks rather than a new framework — decide in the implementation session, not here).

## Security Boundaries

- **Shell execution:** ObservMe never executes shell commands itself; it only wraps subagent-spawn points that other code initiates, and must not place raw command lines or inherited environment values into telemetry.
- **File access:** read-only, on-demand (session header on startup/`/obs session`, explicit `/obs backfill`); never continuous tailing; never persists parsed session data.
- **Network access:** OTLP export to Collector/backend; optional Grafana/Tempo/Loki/Prometheus query APIs for `/obs` commands only — the query path must never be a dependency of telemetry emission.
- **Credentials:** OTLP headers and Grafana tokens from environment/secure runtime config only, never hardcoded; production TLS required unless `allowInsecureTransport: true` is explicitly set (localhost/dev only).
- **Redaction is mandatory, not optional,** for every field that is not on the safe-by-default list (provider, model, token counts, cost, tool name, boolean success/failure, redacted error class, duration, agent role/depth). Pipeline order: size guard → secret detector → PII detector (if enabled) → path scrubber → custom regex → truncation → hashing → export.
- **Cardinality boundary:** `pi.workflow.id`, `pi.workflow.root_agent_id`, `pi.agent.id`, `pi.agent.parent_id`, `pi.agent.root_id`, `pi.agent.spawn.id`, `pi.session.id`, trace IDs, span IDs, entry IDs, tool-call IDs are span/log attributes only — never Prometheus metric labels. Config validation must reject any attempt to promote them to metric labels.
- **Fail-open boundary:** every exporter/collector/backend failure path must degrade to dropped telemetry + incremented drop/error counters, never to a blocked or crashed Pi session.

## Validation Plan

- **Typecheck:** `npm run typecheck` (`tsc --noEmit`).
- **Lint:** `npm run lint` (typecheck + eslint + format check + `check`).
- **Unit/contract tests (future implementation session):** config precedence, redaction pattern corpus, hashing stability, truncation, attribute mapping against JSON event fixtures (`test/fixtures/events/*.json`), metric-label cardinality checks, span-registry eviction, agent-lineage ID generation/propagation, safe-handler error isolation.
- **Package dry-run:** `npm run check:pack` / `npm run pack:dry-run`.
- **Isolated Pi smoke test:** `pi --no-extensions -e .` (manual, run only on request).
- **Full validate:** `npm run validate` (after `npm install`).
- Integration/backend/chaos tests (Collector debug config, Grafana-stack Docker Compose, collector-down/slow, queue-full, redaction-exception scenarios) are deferred to the implementation session per `docs/reference/10-testing-release-operations.md`.

## Acceptance Criteria

- This document accurately reflects `docs/reference/02, 03, 04, 05, 06, 07, 12, 13` without inventing new architecture not present in those sources.
- Every planned Pi surface listed here matches `specs/project-definition-brief.md` §4 exactly (no additions, no omissions).
- No source code implementing OTEL SDK wiring, redaction logic, or `/obs` command behavior is created as a side effect of this spec.
- The three specs (architecture, guidelines, tasks) are internally consistent — the task spec's file layout matches this architecture's module boundaries.

## Validation Commands

- `test -f specs/spec-architecture.md` — confirm the file exists.
- `npm run typecheck` — confirm the unmodified template still typechecks (this spec introduces no code changes).

## Notes

This is a preparation-phase architecture reference, not an implementation task list — see `specs/spec-tasks.md` for the checkbox-driven implementation plan and `specs/spec-guidelines.md` for coding/security/testing conventions to follow while implementing it. If `docs/reference/` and this spec ever disagree in a future revision, the production docs are the source of truth per the user's explicit instruction.
