# Project Definition Brief — ObservMe

## 1. Bootstrap
- Template source: `/Users/senad/Documents/Code/Moj_git/pi-tmp`
- Target directory: `/Users/senad/Documents/Code/Moj_git/pi-observme` (current directory)
- Copy status: **Done.** Template copied via `rsync` (excluding `.git/`, `node_modules/`, `.pi/`, `.agents/`, caches, build output). Pre-existing `docs/reference/` and `observability-stack/` were untouched by the copy (rsync only adds/overwrites template-owned paths).

## 2. Project identity
- Package name: `@senad-d/observme`
- Display name: **ObservMe**
- Exported extension function: `observme(pi: ExtensionAPI)` (replaces template's `piExtensionTemplate`)
- Repository: `senad-d/ObservMe` → `https://github.com/senad-d/ObservMe`
- License: MIT, author "Senad Dizdarević", copyright year 2026 (kept from template defaults)
- Starting version: `0.1.0` (pre-implementation prep state; docs define `1.0.0` as the future MVP production release target — versioning is not accelerated during prep)
- Sonar project key: `senad-d_observme` (org `senad-d` kept as-is)
- `dev-shims/pi-coding-agent` package name: renamed to `@observme/pi-coding-agent-dev-shim` — private, unpublished, dev-only typecheck shim; does not affect published extension identity

## 3. Users and use cases
Primary users (from `01-requirements-and-scope.md`):
- **Platform Engineering** — centralized observability, retention, SLOs, alerts, tenant isolation.
- **AI Platform Owner** — cost, model usage, prompt efficiency, failure analysis, quality signals.
- **Developer using Pi** — quick session diagnostics via `/obs` commands.
- **Security/Compliance** — prompt capture off by default, redaction controls, audit trails.

Primary use cases:
- Turn Pi session/turn/tool/LLM/branch/compaction/error events into OpenTelemetry traces, metrics, and logs.
- Export telemetry via OTLP to an OTel Collector, which fans out to Tempo (traces), Loki (logs), Prometheus/Mimir (metrics), visualized in Grafana.
- Preserve workflow and agent/subagent lineage (workflow/root/parent/child/depth/fan-out/wait/join/orphan state) across process boundaries using W3C trace context plus `pi.workflow.*` and `pi.agent.*` attributes, without polluting metric label cardinality.
- Provide in-Pi `/obs` query commands for status, health, session summary, cost, trace links, tool/error diagnostics, and workflow/agent lineage.

Non-goals (explicit in docs):
- Not a local trace/telemetry database (no SQLite/JSONL/parquet durable storage).
- Not a replacement for Grafana, OTel Collector, or official OTel GenAI semantic conventions.
- Not an OpenInference implementation, vendor-specific AI observability SDK, prompt evaluation framework, policy enforcement extension, or default session-replay system.

## 4. Pi integration surface (all PLANNED — none implemented during prep)

| Surface | Name | Purpose | Notes |
| --- | --- | --- | --- |
| Command | `/obs status` | Show local ObservMe enablement/config state | Planned |
| Command | `/obs health` | Check Collector/Grafana/datasource reachability | Planned |
| Command | `/obs session` | Session telemetry summary (turns, LLM calls, tool calls, cost, trace link) | Planned |
| Command | `/obs cost` | PromQL-backed cost query | Planned |
| Command | `/obs trace` | Grafana Tempo trace link for current/last-turn/given session | Planned |
| Command | `/obs tools` | Tool call/failure PromQL summary | Planned |
| Command | `/obs errors` | Loki LogQL error query | Planned |
| Command | `/obs logs` | Loki LogQL session log query | Planned |
| Command | `/obs link` | Direct Grafana link helper | Planned |
| Command | `/obs agents` | Current agent identity + parent/child lineage summary | Planned |
| Command | `/obs backfill` | Optional, disabled-by-default historical replay | Planned, off by default |
| Event | `session_start` / `session_shutdown` | Start/stop session-scoped OTEL SDK, root `pi.session` span | Planned |
| Event | `agent_start` / `agent_end` | `pi.agent.run` span per user-prompt lifecycle | Planned |
| Event | `turn_start` / `turn_end` | `pi.turn` span | Planned |
| Event | `before_provider_request` / `after_provider_response` / `message_*` | `pi.llm.request` GenAI span, usage/cost metrics | Planned |
| Event | `tool_execution_start` / `tool_call` / `tool_result` / `tool_execution_end` | `pi.tool.call` span, tool metrics | Planned |
| Event | `user_bash` + `bashExecution` | `pi.bash.execution` telemetry | Planned |
| Event | `model_select` / `thinking_level_select` | Model/thinking-level change logs+metrics | Planned |
| Event | `session_compact` | `pi.compaction` span/log/metric | Planned |
| Event | `session_tree` | `pi.branch` span/log/metric | Planned |
| (extension-level, no dedicated Pi event) | subagent spawn wrapper | `pi.agent.spawn` span + W3C trace-context + workflow/lineage env var propagation to child Pi processes | Planned; Pi has no built-in "subagent spawned" event, so ObservMe must wrap spawn points itself |
| (extension-level, no dedicated Pi event) | agent-tree wait/join tracking | `pi.agent.wait` / `pi.agent.join` spans/events plus depth, fan-out, active-child, orphan, and propagation-failure metrics | Planned; implemented at the same ObservMe-aware spawn/wait/join wrapping points |
| Resource | Grafana dashboards (JSON) | `dashboards/observme-*.json` (overview, cost, latency, tools, agents, models, errors, branches/compactions, export-health) | Planned artifacts, not built during prep |
| Resource | Collector reference configs | Minimal debug config + production Grafana-stack config (`examples/collector.yaml`) | Planned artifacts |
| Config | `observme.yaml` (global `~/.pi/agent/`, project `<CONFIG_DIR_NAME>/observme.yaml`) + env vars (`OBSERVME_*`) | Full schema defined in `12-configuration-reference.md` | Planned; precedence: defaults → global → trusted project → env → runtime options |

## 5. Architecture

Planned repository layout (per `07-extension-implementation-blueprint.md`, mapped onto the template's `src/` convention):

```text
src/
├── extension.ts                # renamed entry: registers all modules, no long-lived resources
├── constants.ts                 # EXTENSION_DISPLAY_NAME="ObservMe", status key, etc.
├── config/
│   ├── load-config.ts           # bootstrap vs session-scoped loading, precedence order
│   ├── schema.ts
│   └── defaults.ts
├── otel/
│   ├── sdk.ts / traces.ts / metrics.ts / logs.ts / shutdown.ts
├── pi/
│   ├── handlers.ts / session.ts / event-normalizer.ts
│   ├── agent-lineage.ts / agent-tree-tracker.ts / turn-tracker.ts
├── semconv/
│   ├── attributes.ts / metrics.ts / spans.ts
├── privacy/
│   ├── redact.ts / secret-patterns.ts / hash.ts / truncate.ts
├── commands/
│   ├── obs-status.ts / obs-health.ts / obs-session.ts / obs-cost.ts / obs-agents.ts / obs-link.ts / ...
├── query/
│   ├── grafana.ts / tempo.ts / loki.ts / prometheus.ts
├── events/
│   └── lifecycle.ts             # session_start/session_shutdown registration
├── tools/                       # none required by current docs; template example tool removed/replaced only during implementation
└── util/
    ├── safe-json.ts / time.ts / trace-context.ts / bounded-map.ts

test/
├── redaction.test.ts / event-mapping.test.ts / metrics.test.ts
├── exporter-failure.test.ts / agent-lineage.test.ts / cardinality.test.ts
```

Module boundaries: event capture → semantic mapper → OTEL emitters (traces/metrics/logs), with `/obs` query commands as a separate read path that must never block telemetry emission (`Pi event -> emit telemetry` is independent of `/obs command -> optional query`).

Dependencies (to be added in a later implementation session, not during prep):
```text
@opentelemetry/api, api-logs, sdk-node, sdk-trace-node, sdk-metrics, sdk-logs,
exporter-trace-otlp-proto, exporter-metrics-otlp-proto, exporter-logs-otlp-proto,
resources, semantic-conventions
```
Per template convention: Pi core packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `typebox`) stay in `peerDependencies: "*"`; OpenTelemetry packages go in `dependencies`; dev-only tooling stays in `devDependencies`.

## 6. Config, state, and persistence
- Config source: layered — built-in defaults → global `~/.pi/agent/observme.yaml` → project `<CONFIG_DIR_NAME>/observme.yaml` (only when `ctx.isProjectTrusted()`) → env vars (`OBSERVME_*`) → explicit runtime options.
- Session state: in-memory only — span registry (bounded maps for active agent runs/turns/tool calls/LLM requests/subagent spawns/agent waits/agent joins), agent-tree counters, OTEL SDK metric instruments, bounded exporter retry queue. No SQLite, JSONL archives, or parquet files.
- Files written: none by default. Optional disabled-by-default single-line `custom` session correlation entry (`writeCorrelationEntry: false` by default), never `custom_message`.
- Cleanup behavior: `session_shutdown` ends all open spans, flushes OTEL SDK with a bounded timeout (`shutdown.flushTimeoutMs`), never blocks Pi shutdown indefinitely.

## 7. Security and privacy
- Shell execution: none directly by ObservMe; it wraps subagent spawn points that *other* tools/commands initiate, propagating trace context/env vars only — never raw command lines.
- File access/mutation: read-only session header access on startup/`/obs session`/explicit `/obs backfill`; no continuous tailing; no local telemetry persistence.
- Network access: OTLP HTTP/gRPC export to Collector (default) or direct backend (dev-only); optional Grafana/Tempo/Loki/Prometheus query APIs for `/obs` commands.
- Credentials/secrets: OTLP headers (`Authorization: Bearer ${OBSERVME_OTLP_TOKEN}`) and Grafana token from env/secure runtime config only, never hardcoded.
- Telemetry/retention: ObservMe itself does not retain data; retention is a backend responsibility. Fail-open on export/collector failure — Pi must keep running.
- User confirmations: none required for normal operation (telemetry is metadata-only by default); unsafe capture mode requires explicit `allowUnsafeCapture: true` and displays a runtime warning.
- Redaction: mandatory pipeline (size guard → secret detector → PII detector → path scrubber → custom regex → truncation → hashing) before any optional content export; default capture policy is entirely `false` for prompts/responses/thinking/tool args/tool results/bash commands/bash output/file paths.
- Cardinality safety: high-cardinality identifiers (`pi.workflow.id`, `pi.agent.id`, `pi.session.id`, trace/span IDs, spawn IDs) are span/log attributes only, never Prometheus metric labels.

## 8. Documentation and packaging
- README changes (later implementation phase): replace all `{{PLACEHOLDER}}` tokens with ObservMe-specific content — tagline, quick start, `/obs` command table, agent tool table (if any), safety model reflecting fail-open/privacy-by-default, troubleshooting matching `11-deployment-runbooks.md` common incidents.
- SECURITY.md: replace template note with ObservMe's actual trust model (already well-specified in `06-security-privacy-redaction.md`), keep security contact `senad.dizdarevic@proton.me`, update repo links to `senad-d/ObservMe`.
- CHANGELOG.md: replace template note; start real `0.1.0 - Unreleased` entry describing "prepared repository from template; specs added; no feature implementation yet."
- package.json: `name` → `@senad-d/observme`; `description` → ObservMe's one-line pitch; `repository`/`bugs`/`homepage` → `senad-d/ObservMe`; keep `pi.extensions: ["./src/extension.ts"]`; update `pi.image` URL to the new repo; keep or drop `_template` block per your preference (recommend keeping until first real command/tool exists, then remove); keywords stay largely the same (`pi-package`, `pi-extension`, etc.) plus maybe `observability`, `opentelemetry`.
- sonar-project.properties: `sonar.projectKey=senad-d_observme` (org unchanged).
- npm/git distribution plan: npm scoped package `@senad-d/observme`, public access, via existing `.github/workflows/publish.yml` (workflow already generic/template-safe, only needs default branch + npm trusted publishing already configured — no functional change needed).
- `observability-stack/` and `docs/reference/`: **left completely untouched**, confirmed by you as reference/companion assets, not part of the extension package itself (not in package.json `files[]`).

## 9. Validation plan
- Typecheck: `npm run typecheck`
- Tests: `npm run test` (template's existing `test/template.test.mjs` will need updates once identity changes — done in Phase 5 as metadata-only test updates, not feature tests)
- Lint: `npm run lint` (eslint + format + check)
- Package dry-run: `npm run check:pack` / `npm run pack:dry-run`
- Isolated Pi smoke test: `pi --no-extensions -e .` (manual, on request — not run automatically)
- Full validate: `npm run validate` (after `npm install`, only if you want dependency install run now)

## 10. Open questions and assumptions
- Assumption: `_template` block in `package.json` stays for now since no real command/tool exists yet; will be removed once ObservMe's first real command/tool is implemented in a later session.
- Assumption: template's example command/tool/lifecycle files stay conceptually as-is (rename identity constants only) since implementing real `/obs` commands and OTEL wiring is explicitly out of scope for this preparation session.
- Decision (confirmed): `dev-shims/pi-coding-agent/package.json` name renamed from `@micme/pi-coding-agent-dev-shim` to `@observme/pi-coding-agent-dev-shim` (private/unpublished, dev-only).
- Decision (confirmed): `_template` block in `package.json` stays for now; removed only once a real command/tool is implemented in a later session.
- Decision (confirmed): template example files (`src/commands/example-command.ts`, `src/tools/example-tool.ts`, `src/events/lifecycle.ts`, `src/constants.ts`) remain generic template examples during prep; only branding constants (`EXTENSION_DISPLAY_NAME`, status key) are renamed to ObservMe. No real `/obs` command or OTEL logic is implemented during this preparation session.
- Decision (confirmed): package `@senad-d/observme`, repo `senad-d/ObservMe`, version `0.1.0`, MIT/2026/Senad Dizdarević, Sonar key `senad-d_observme`.
- Open: none blocking — ready to proceed to specs (Phase 4) pending your approval of this brief.
