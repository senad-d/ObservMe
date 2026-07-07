# Plan: ObservMe Implementation Tasks

## Task Description

This is the checkbox-driven implementation plan for a **later, separate implementation session** for ObservMe. Every task below is unchecked (`- [ ]`) and must stay unchecked during preparation. This spec must not be run through `subagent_tasks` or any implementation workflow during preparation, and no checkbox may be marked complete by the `prepare-pi-extension-project` skill.

Tasks are deliberately small: each targets one file, or a tightly coupled pair of files that cannot be tested independently (for example a start/stop lifecycle pair). This keeps each task completable and reviewable within a single focused implementation session, rather than bundling multiple unrelated files or Pi event families into one checkbox.

Every implementation task uses the project task format: a `### <number>. <task_name>` heading, one unchecked checkbox, then `Why`, `How`, `Where`, and `Acceptance criteria` subsections.

## Objective

Give a future implementation session an ordered, testable, incrementally-shippable, and session-sized path from the current prepared repository (template bootstrapped, identity renamed, docs untouched, three specs present) to a working ObservMe extension that satisfies `ObservMe-Production-Docs/00-README.md`'s "Minimum Viable Production Release" checklist.

## Relevant Files

- `specs/project-definition-brief.md` — approved identity/scope/integration-surface decisions.
- `specs/spec-architecture.md` — module boundaries, data flow, dependency policy, security boundaries.
- `specs/spec-guidelines.md` — coding/Pi/package/documentation/testing/security/smoke-test rules.
- `ObservMe-Production-Docs/*.md` — canonical source of truth for all semantics; consult before implementing any task below.
- `src/extension.ts`, `src/constants.ts`, `src/commands/`, `src/tools/`, `src/events/` — current template skeleton to be extended/replaced task by task.
- `package.json`, `docs/STRUCTURE.md` — current metadata and structure convention to extend.

## Step by Step Tasks

IMPORTANT: Execute every task in order, top to bottom. Each task must remain `- [ ]` until its acceptance criteria are met by real, tested code. The numbering is one continuous sequence, and each task carries its own Why/How/Where context so it can be executed independently during the later implementation session.

### 1. Fix the missing validate-pipeline scripts

- [x] Resolve `package.json`'s `scripts.check`/`scripts.validate` chain, which currently references `scripts/test-coverage.mjs`, `scripts/smoke-observability.mjs`, `scripts/smoke-packaged-install.mjs`, `scripts/smoke-handler-execution.mjs`, and `scripts/smoke-pi-lifecycle.mjs` — none of which exist in the bootstrapped template. Either implement these scripts with real (even minimal but functional) coverage/smoke behavior, or update `package.json` to remove/replace the missing references, so `npm run validate` succeeds end to end.

#### Why

This bootstrap task keeps the validation pipeline usable before any ObservMe feature work begins; otherwise every later task that says to run `npm run validate` is blocked by missing files rather than feature correctness.

#### How

Confirm with the user whether the implementation session should author the missing scripts or simplify the validate pipeline, then make the chosen change, document it, and run the full validation command.

#### Where

- Target: `package.json`, `scripts/`, and `CHANGELOG.md`.
- Validation source: current `scripts.check`/`scripts.validate` chain in `package.json`.

#### Acceptance criteria

- `npm run validate` completes successfully (exit code 0) with no reference to a missing file.
- If scripts are implemented, `smoke:packaged`, `smoke:handlers`, and `smoke:pi-lifecycle` each perform a real, documented check (not an empty stub) and `test:coverage` produces an actual coverage report.
- The resolution is documented in `CHANGELOG.md`.

### 2. Define config schema and safe defaults

- [x] Create `src/config/schema.ts` and `src/config/defaults.ts` implementing the full configuration shape and safe-by-default values from `ObservMe-Production-Docs/12-configuration-reference.md` §1 and §5 (privacy-preserving defaults: capture flags `false`, `redactionEnabled: true`, `allowUnsafeCapture: false`, `allowInsecureTransport: false`, `workflow.enabled: true`).

#### Why

The extension needs a typed, privacy-preserving configuration baseline before loaders, validation, handlers, exporters, and commands can depend on configuration values safely.

#### How

Translate the documented configuration fields and defaults into typed schema/default modules, include tests for default safety, and keep all content-capture behavior disabled unless explicitly enabled.

#### Where

- Target: `src/config/schema.ts`, `src/config/defaults.ts`, and related unit tests.
- Source docs: `ObservMe-Production-Docs/12-configuration-reference.md` §1 and §5.

#### Acceptance criteria

- `npm run typecheck` passes with the new schema/defaults modules.
- The default config object matches every default value listed in `12-configuration-reference.md` §1 and §5 exactly.
- A unit test snapshots the default config and asserts no capture flag is `true` by default.

### 3. Implement layered config loader and precedence

- [x] Create `src/config/load-config.ts` implementing the layered precedence order (defaults → global `~/.pi/agent/observme.yaml` → trusted project `<CONFIG_DIR_NAME>/observme.yaml` → env vars → runtime options) from `12-configuration-reference.md` §4. Split factory-safe loading (defaults/global/env only) from session-scoped loading (adds trusted project config) per `specs/spec-architecture.md` §Config, and include the `resource.attributes.observme.tenant.id`, `deployment.environment.name`, workflow (`OBSERVME_WORKFLOW_ID`), and agent capability (`OBSERVME_AGENT_CAPABILITY`) config keys from `12-configuration-reference.md` and `05-otel-pipeline-and-collector.md` §10.

#### Why

Correct precedence and trust boundaries prevent untrusted project files from changing telemetry behavior while still allowing global, environment, and runtime configuration to override defaults intentionally.

#### How

Implement separate factory-safe and session-scoped loaders, read only trusted project config during a session, merge layers in the documented order, and add precedence tests for the important resource/workflow/agent keys.

#### Where

- Target: `src/config/load-config.ts` and config loader tests.
- Source docs: `ObservMe-Production-Docs/12-configuration-reference.md` §4, `ObservMe-Production-Docs/05-otel-pipeline-and-collector.md` §10, and `specs/spec-architecture.md` §Config.

#### Acceptance criteria

- Unit tests cover precedence ordering: env vars override project config, project config overrides global config, global config overrides defaults.
- No project-local config is read when `ctx.isProjectTrusted()` is false (test asserts this explicitly).
- `observme.tenant.id`, `deployment.environment.name`, `workflow.idEnv`, and `agent.capabilityEnv` round-trip correctly through the loader.

### 4. Implement config validation rules and unsafe-capture warning

- [x] Extend `src/config/load-config.ts` (or add `src/config/validate.ts`) to reject invalid configuration per `12-configuration-reference.md` §8 (capture enabled without redaction unless `allowUnsafeCapture: true`, insecure transport in production, missing signal-specific OTLP paths, forbidden high-cardinality metric labels, untrusted project config, malformed lineage values, oversized queue sizes). When `allowUnsafeCapture: true` is active alongside any capture flag, surface a visible runtime warning (via `ctx.ui.notify` or equivalent) at session start per §7.

#### Why

Configuration validation is the guardrail that keeps ObservMe safe-by-default even when users supply incorrect, unsafe, or high-cardinality settings.

#### How

Implement the documented rejection rules, make invalid config fall back to safe defaults with a logged reason, and emit a visible warning only for the intentional unsafe-capture override.

#### Where

- Target: `src/config/load-config.ts` or `src/config/validate.ts`, session-start integration, and config validation tests.
- Source docs: `ObservMe-Production-Docs/12-configuration-reference.md` §7–8.

#### Acceptance criteria

- Unit tests cover every rejection rule in `12-configuration-reference.md` §8 with both a passing and a failing case.
- A test asserts a visible warning is emitted when `allowUnsafeCapture: true` and any capture flag is enabled.
- Invalid configuration never crashes the extension; it falls back to safe defaults and logs the rejection reason.

### 5. Define attribute name constants

- [x] Create `src/semconv/attributes.ts` exporting every resource, span, and log attribute key from `ObservMe-Production-Docs/04-telemetry-semantic-conventions.md` §2–3, §5–11, §14 as typed constants, including `observme.tenant.id`, `pi.workflow.*`, `pi.agent.wait.*`, `pi.agent.join.*`, `pi.agent.children.*`, and operational attributes such as `observme.replayed`, `observme.evicted`, `observme.truncated`, and `observme.original_length`.

#### Why

Centralized attribute constants keep handlers, exporters, tests, dashboards, and queries aligned to the canonical semantic conventions without string drift.

#### How

Enumerate every documented resource/span/log attribute as typed exports, group them by semantic area, and add a test or lint coverage check that prevents missing or incorrectly named attributes.

#### Where

- Target: `src/semconv/attributes.ts` and semantic-convention tests.
- Source docs: `ObservMe-Production-Docs/04-telemetry-semantic-conventions.md` §2–3, §5–11, and §14.

#### Acceptance criteria

- Every attribute key listed in `04-telemetry-semantic-conventions.md` §2–3, §5–11, §14 has a corresponding exported constant.
- `observme.tenant.id` is present as an exported resource-attribute constant.
- `npm run lint` passes (no unused exports, consistent type imports).

### 6. Define span name constants

- [x] Create `src/semconv/spans.ts` exporting every span name from `04-telemetry-semantic-conventions.md` §1 (`pi.session`, `pi.agent.run`, `pi.agent.spawn`, `pi.agent.wait`, `pi.agent.join`, `pi.turn`, `pi.llm.request`, `pi.tool.call`, `pi.bash.execution`, `pi.compaction`, `pi.branch`, `pi.model.change`, `pi.thinking.change`) as typed constants.

#### Why

Span name constants make the trace shape testable and prevent accidental introduction of non-canonical span namespaces.

#### How

Export each documented span name exactly once, type the exports consistently with the rest of the semantic-convention modules, and add a naming contract test.

#### Where

- Target: `src/semconv/spans.ts` and span-name tests.
- Source docs: `ObservMe-Production-Docs/04-telemetry-semantic-conventions.md` §1.

#### Acceptance criteria

- Every span name in `04-telemetry-semantic-conventions.md` §1 has a corresponding exported constant.
- A unit test asserts span names use dotted lowercase operation naming and no bare `agent.*` namespace is introduced.

### 7. Define metric name constants

- [x] Create `src/semconv/metrics.ts` exporting every ObservMe-owned metric name from `04-telemetry-semantic-conventions.md` §12 (counters, token/cost counters, histograms, gauges, including workflow/agent-tree metrics) and the optional official GenAI metric names from §12.5, plus the log event names from §14.

#### Why

Metric and log-event constants are the foundation for low-cardinality metrics, alert rules, dashboards, and query-backed commands.

#### How

Export every documented metric and event name, distinguish ObservMe-owned names from optional official GenAI names, and test ObservMe metric naming conventions.

#### Where

- Target: `src/semconv/metrics.ts` and metric-name tests.
- Source docs: `ObservMe-Production-Docs/04-telemetry-semantic-conventions.md` §12, §12.5, and §14.

#### Acceptance criteria

- Every metric name in `04-telemetry-semantic-conventions.md` §12 and every log event name in §14 has a corresponding exported constant.
- A unit test asserts ObservMe-owned metric names are snake_case and prefixed `observme_`.

### 8. Implement secret-detection patterns

- [x] Create `src/privacy/secret-patterns.ts` implementing every regex pattern from `ObservMe-Production-Docs/06-security-privacy-redaction.md` §5 (AWS access key, generic bearer token, GitHub token, OpenAI-like key, Anthropic-like key, Slack token, private key block, password assignment, API key assignment, URL credentials), each exported as a named, independently testable matcher.

#### Why

Secret detection must exist before content capture, redaction, truncation, handlers, or backfill can safely process potentially sensitive values.

#### How

Implement one named matcher per documented pattern, return enough match metadata for typed redaction replacements, and build a positive/negative corpus for every pattern category.

#### Where

- Target: `src/privacy/secret-patterns.ts` and privacy pattern tests.
- Source docs: `ObservMe-Production-Docs/06-security-privacy-redaction.md` §5.

#### Acceptance criteria

- A test corpus covers every pattern category in `06-security-privacy-redaction.md` §5 with at least one matching and one non-matching example.
- Matched values are structured so a caller can produce the `[REDACTED:<type>:<sha256-prefix>]` replacement format from §5.

### 9. Implement the redaction pipeline

- [x] Create `src/privacy/redact.ts` implementing the full pipeline from `06-security-privacy-redaction.md` §4 and §6 (size guard → secret detector from task 8 → PII detector if enabled → path scrubber → custom regex redactors → truncation → hashing → export), including the path-redaction modes (`pathMode: hash|basename|full|drop`) from §6.

#### Why

The redaction pipeline is the safety boundary that allows optional content capture without exporting raw secrets, paths, or oversized values.

#### How

Compose the pipeline stages in documented order, reuse the task 8 matchers, apply custom patterns from config, implement path modes exactly, and handle detector failures by dropping the field and emitting failure telemetry.

#### Where

- Target: `src/privacy/redact.ts` and redaction pipeline tests.
- Source docs: `ObservMe-Production-Docs/06-security-privacy-redaction.md` §4 and §6, plus `ObservMe-Production-Docs/10-testing-release-operations.md` §7.

#### Acceptance criteria

- A test asserts the pipeline runs stages in the documented order and short-circuits safely on detector failure (see `10-testing-release-operations.md` §7 "Redaction Exception": field dropped, failure metric incremented, no raw value exported).
- Path redaction produces the exact transformation examples in `06-security-privacy-redaction.md` §6 for each `pathMode`.
- Custom regex redactors from config (e.g. `privacy.customRedactionPatterns`) are applied in addition to the built-in patterns.

### 10. Implement hashing and truncation utilities

- [x] Create `src/privacy/hash.ts` implementing `sha256(tenant_salt + "\0" + value)` and `hmac_sha256(tenant_salt, value)` per `06-security-privacy-redaction.md` §7, with the salt read only from environment/secure runtime config; and `src/privacy/truncate.ts` implementing content-size limits from §9 (`maxPromptChars`, `maxResponseChars`, `maxToolArgumentChars`, `maxToolResultChars`, `maxBashOutputChars`, `maxLogBodyChars`), adding `observme.truncated=true` plus original-length attribute when content is truncated.

#### Why

Stable hashing and truncation provide privacy-preserving correlation and bounded export size without leaking raw high-cardinality content.

#### How

Read tenant salt only from secure runtime inputs, implement the exact hash formulas, enforce each documented size limit, and attach truncation metadata whenever content is shortened.

#### Where

- Target: `src/privacy/hash.ts`, `src/privacy/truncate.ts`, and privacy utility tests.
- Source docs: `ObservMe-Production-Docs/06-security-privacy-redaction.md` §7 and §9.

#### Acceptance criteria

- Hashing is stable (same input + salt always produces the same hash) and never accepts a hardcoded salt.
- Truncation enforces every limit in `06-security-privacy-redaction.md` §9 and adds the documented truncation attributes.

### 11. Implement the bounded-map utility

- [x] Create `src/util/bounded-map.ts`: a generic, reusable bounded `Map` wrapper that evicts the oldest entry when a configured maximum size is exceeded, invoking a caller-supplied eviction callback (used later to end evicted spans and increment drop counters).

#### Why

Bounded registries prevent long-running sessions from accumulating unbounded span, lineage, or child-agent state.

#### How

Implement a pure generic wrapper around `Map`, evict the oldest entry at capacity, call the eviction callback exactly once per eviction, and keep it independent of Pi and OTEL types.

#### Where

- Target: `src/util/bounded-map.ts` and bounded-map unit tests.
- Consumers: later span, lineage, and agent-tree registries.

#### Acceptance criteria

- A unit test asserts insertion beyond the configured limit evicts the oldest entry and invokes the eviction callback exactly once per eviction.
- The utility has no dependency on OTEL or Pi types; it is a pure, reusable data-structure module.

### 12. Implement workflow and agent-lineage context

- [x] Create `src/pi/agent-lineage.ts` and `src/pi/agent-tree-tracker.ts` implementing the `pi.workflow.id/root_agent_id` and `pi.agent.id/parent_id/root_id/depth/role/capability` lineage model from `ObservMe-Production-Docs/07-extension-implementation-blueprint.md` §5 and `03-pi-event-and-session-model.md` §8, using `src/util/bounded-map.ts` (task 11) for any lineage-scoped registries it needs.

#### Why

Workflow and agent lineage provide the correlation model for multi-agent traces, query commands, dashboards, SLOs, and orphan/propagation failure detection.

#### How

Generate IDs safely, accept only trusted parent context, track root/parent/depth/role/capability, record child tree state with bounded registries, and test malformed lineage rejection.

#### Where

- Target: `src/pi/agent-lineage.ts`, `src/pi/agent-tree-tracker.ts`, and lineage tests.
- Source docs: `ObservMe-Production-Docs/07-extension-implementation-blueprint.md` §5 and `ObservMe-Production-Docs/03-pi-event-and-session-model.md` §8.
- Dependency: `src/util/bounded-map.ts` from task 11.

#### Acceptance criteria

- Workflow IDs and agent IDs are generated (not derived from cwd/username/prompt/command line) unless supplied by a trusted parent context.
- Root agents get `pi.agent.root_id = pi.agent.id`, `pi.workflow.root_agent_id = pi.agent.id`, and `pi.agent.depth = 0`; subagents increment depth and preserve workflow/root/parent IDs.
- Agent-tree tracking records active children, fan-out count, tree depth, tree width, orphan state, and child status without exposing high-cardinality metric labels.
- A test asserts malformed or oversized propagated lineage values are rejected per `12-configuration-reference.md` §8.

### 13. Implement OTEL SDK bootstrap and shutdown

- [x] Create `src/otel/sdk.ts` and `src/otel/shutdown.ts` implementing OTEL SDK startup (only invoked from `session_start`, never from the extension factory) and bounded-timeout flush/shutdown (only invoked from `session_shutdown`), per `specs/spec-architecture.md` and `07-extension-implementation-blueprint.md` §1, §7.

#### Why

OTEL runtime lifecycle must be session-scoped so importing or registering the extension never opens exporters, timers, or sockets prematurely.

#### How

Expose explicit start and shutdown functions, keep module imports side-effect free, enforce the configured shutdown timeout, and add tests for import safety and unresponsive exporters.

#### Where

- Target: `src/otel/sdk.ts`, `src/otel/shutdown.ts`, and OTEL lifecycle tests.
- Source docs: `specs/spec-architecture.md` and `ObservMe-Production-Docs/07-extension-implementation-blueprint.md` §1 and §7.

#### Acceptance criteria

- A test/inspection confirms no exporter, timer, or socket is created by importing `src/otel/sdk.ts` alone without calling its start function.
- Shutdown always completes within `shutdown.flushTimeoutMs` even when the exporter is unresponsive (simulated in a test).

### 14. Implement trace exporter wiring

- [x] Create `src/otel/traces.ts` wiring the OTLP trace exporter and tracer provider using the SDK started in task 13, matching `05-otel-pipeline-and-collector.md` §3 defaults (`http/protobuf`, base endpoint + `/v1/traces`, batch settings).

#### Why

Trace exporter wiring is required before session, agent, turn, LLM, tool, bash, branch, and compaction spans can be emitted to an OTLP Collector.

#### How

Build the tracer provider/exporter from session config after SDK startup, apply the documented endpoint and batch defaults, and make disabled traces resolve to safe no-ops.

#### Where

- Target: `src/otel/traces.ts` and trace exporter tests.
- Source docs: `ObservMe-Production-Docs/05-otel-pipeline-and-collector.md` §3.
- Dependency: task 13 SDK startup.

#### Acceptance criteria

- Batch/queue settings (`maxQueueSize: 2048`, `maxExportBatchSize: 512`, `scheduledDelayMillis: 1000`, `exportTimeoutMillis: 3000`) match `05-otel-pipeline-and-collector.md` §3 defaults.
- A test confirms the tracer is only available after `traces.enabled: true` session-scoped startup.

### 15. Implement metrics exporter wiring

- [x] Create `src/otel/metrics.ts` wiring the OTLP metric exporter and meter provider, matching `05-otel-pipeline-and-collector.md` §3 defaults (`exportIntervalMillis: 15000`, `exportTimeoutMillis: 3000`, endpoint `/v1/metrics`).

#### Why

Metrics exporter wiring is needed for counters, histograms, gauges, alerts, SLOs, dashboards, and query-backed commands.

#### How

Create the meter provider/exporter only during enabled session startup, apply documented interval and timeout defaults, and provide no-op instruments before metrics are enabled.

#### Where

- Target: `src/otel/metrics.ts` and metrics exporter tests.
- Source docs: `ObservMe-Production-Docs/05-otel-pipeline-and-collector.md` §3.
- Dependency: task 13 SDK startup.

#### Acceptance criteria

- Exporter interval/timeout settings match `05-otel-pipeline-and-collector.md` §3 defaults.
- A test confirms metric instruments created before `metrics.enabled: true` startup do not throw and are no-ops.

### 16. Implement logs exporter wiring

- [x] Create `src/otel/logs.ts` wiring the OTLP log exporter and logger provider, matching `05-otel-pipeline-and-collector.md` §3 defaults (batch settings, endpoint `/v1/logs`).

#### Why

Logs exporter wiring provides structured session, workflow, model, thinking, error, branch, compaction, and command log events without requiring handlers to know exporter details.

#### How

Create the logger provider/exporter only during enabled session startup, match documented batch and endpoint defaults, and expose no-op logging when logs are disabled.

#### Where

- Target: `src/otel/logs.ts` and logs exporter tests.
- Source docs: `ObservMe-Production-Docs/05-otel-pipeline-and-collector.md` §3.
- Dependency: task 13 SDK startup.

#### Acceptance criteria

- Batch settings match `05-otel-pipeline-and-collector.md` §3 defaults.
- A test confirms log emission before `logs.enabled: true` startup does not throw and is a no-op.

### 17. Wire session_start/session_shutdown handlers and root span

- [x] Create `src/pi/handlers.ts` with `session_start` and `session_shutdown` handlers that start the OTEL SDK (tasks 13–16), create/close the root `pi.session` span with attributes from `04-telemetry-semantic-conventions.md` §4, emit `session.started`/`session.shutdown` and root-workflow `workflow.started`/`workflow.completed` or `workflow.failed` log events when applicable, and update active-agent/workflow metrics. Wrap every handler with the `safeHandler(name, fn)` pattern from `07-extension-implementation-blueprint.md` §10 so no handler can throw into Pi.

#### Why

The session lifecycle is the root of every trace and the safety boundary that ensures handler failures never break Pi.

#### How

Register safe session handlers, start configured OTEL signals on `session_start`, open/close the root session span, emit lifecycle logs/metrics, and flush with bounded timeout during `session_shutdown`.

#### Where

- Target: `src/pi/handlers.ts` and session handler tests.
- Source docs: `ObservMe-Production-Docs/04-telemetry-semantic-conventions.md` §3–4, `ObservMe-Production-Docs/07-extension-implementation-blueprint.md` §10.
- Dependencies: tasks 13–16.

#### Acceptance criteria

- A test simulates a throwing handler and asserts the error is caught, recorded via `observme_handler_errors_total`, and never propagated into Pi.
- The `pi.session` span attributes match `04-telemetry-semantic-conventions.md` §4 exactly and include common `pi.workflow.*` attributes from §3.
- `session_shutdown` ends the root span, decrements active-agent state, records workflow completion/error telemetry for root workflows, and triggers the bounded-timeout flush from task 13.

### 18. Wire agent-run and turn handlers

- [x] Extend `src/pi/handlers.ts` with `agent_start`, `agent_end`, `turn_start`, `turn_end` handlers creating/closing `pi.agent.run` (child of `pi.session`) and `pi.turn` (child of `pi.agent.run`) spans per the event-to-span mapping table in `03-pi-event-and-session-model.md` §6, using the bounded span registry from task 12/11 patterns.

#### Why

Agent-run and turn spans provide the core Pi trace hierarchy and the counters needed to understand session progress.

#### How

Add bounded registries for active agent and turn spans, derive turn IDs exactly as documented, enforce span parenting, and emit low-cardinality counters for started/completed events.

#### Where

- Target: `src/pi/handlers.ts` and event-mapping tests.
- Source docs: `ObservMe-Production-Docs/03-pi-event-and-session-model.md` §6 and §9, `specs/spec-architecture.md` trace-shape section.
- Dependencies: tasks 11–12 and 17.

#### Acceptance criteria

- Span parenting matches the canonical trace shape in `specs/spec-architecture.md` (`pi.turn` under `pi.agent.run` under `pi.session`).
- Turn IDs are derived as `agent-run-XXXXXX-turn-XXXXXX` per `03-pi-event-and-session-model.md` §9, and are never used as a metric label.
- `observme_agent_runs_total` and `observme_turns_started_total`/`observme_turns_completed_total` increment correctly.

### 19. Implement startup recovery and replay semantics

- [x] Extend the `session_start` handler from task 17 to implement the startup recovery rules from `03-pi-event-and-session-model.md` §10–11: on an existing (resumed) session, read the session header only (not the full entry log), set `pi.session.id`/`pi.workflow.id`/`pi.agent.id`/resource attributes, reconstruct workflow/agent lineage only from trusted environment variables or an explicit minimal `custom` correlation entry, never continuously tail the session file, and never replay historical telemetry unless `replayOnStart: true` is explicitly configured — in which case mark all replayed spans/logs `observme.replayed=true`.

#### Why

Recovery semantics prevent resumed sessions from duplicating history, leaking session-file content, or creating fake live telemetry.

#### How

Add resume detection to session start, read only the minimal session header/correlation data, gate replay behind `replayOnStart`, and mark all replayed telemetry explicitly.

#### Where

- Target: `src/pi/handlers.ts` and startup recovery tests.
- Source docs: `ObservMe-Production-Docs/03-pi-event-and-session-model.md` §10–11.
- Dependency: task 17.

#### Acceptance criteria

- A test simulates resuming an existing session and asserts no historical telemetry is emitted unless `replayOnStart: true`.
- When `replayOnStart: true`, replayed telemetry carries `observme.replayed=true`.
- A test asserts the extension never continuously tails the session file during normal operation.

### 20. Wire LLM request/response/usage handlers

- [x] Extend `src/pi/handlers.ts` (or add `src/pi/llm-tracker.ts`) to handle `before_provider_request`, `after_provider_response`, and assistant `message_end`, creating/finalizing `pi.llm.request` GenAI spans with usage/cost/stop-reason attributes per `04-telemetry-semantic-conventions.md` §7 and `07-extension-implementation-blueprint.md` §8.

#### Why

LLM spans and token/cost metrics are core MVP telemetry, but they must be based on finalized usage data and must not capture prompt/response content by default.

#### How

Track provider request lifecycle, finalize usage from assistant `message_end`, attach official GenAI and ObservMe attributes, update counters, and route optional content through the redaction pipeline only when enabled.

#### Where

- Target: `src/pi/handlers.ts` or `src/pi/llm-tracker.ts`, plus LLM handler tests.
- Source docs: `ObservMe-Production-Docs/04-telemetry-semantic-conventions.md` §7 and `ObservMe-Production-Docs/07-extension-implementation-blueprint.md` §8.
- Dependencies: tasks 8–10 and 17–18.

#### Acceptance criteria

- Span/metric updates happen from the finalized assistant `message_end` data, not from partial streaming updates alone.
- Official `gen_ai.*` attributes and ObservMe-specific `pi.llm.*` attributes are both present per the spec.
- Token/cost counters (`observme_llm_input_tokens_total`, `observme_llm_cost_usd_total`, etc.) update correctly in a test using a fixture assistant message with usage/cost data.
- No prompt/response/thinking content is attached to spans unless capture is explicitly enabled and redacted (using tasks 8–10).

### 21. Wire tool-call handlers

- [x] Extend `src/pi/handlers.ts` to handle `tool_execution_start`, `tool_call`, `tool_result`, `tool_execution_end`, creating `pi.tool.call` spans per `04-telemetry-semantic-conventions.md` §8.

#### Why

Tool-call telemetry is needed to understand agent behavior and failures while preserving privacy and metric-cardinality limits.

#### How

Track tool execution lifecycle, close spans with success/error status, attach low-cardinality labels, increment counters, and include arguments/results only when capture is enabled and redacted.

#### Where

- Target: `src/pi/handlers.ts` and tool handler tests.
- Source docs: `ObservMe-Production-Docs/04-telemetry-semantic-conventions.md` §8.
- Dependencies: tasks 8–10 and 17–18.

#### Acceptance criteria

- Tool spans close with correct success/error status and `pi.tool.error_class` on failure.
- Tool call/failure counters (`observme_tool_calls_total`, `observme_tool_failures_total`) use only low-cardinality labels (`tool_name`, `tool_category`) — a cardinality test asserts no `tool_call_id`, workflow ID, session ID, or agent ID leaks into metric labels.
- Tool arguments/results are absent from spans by default; present only when capture is enabled and redacted.

### 22. Wire bash-execution handler

- [x] Extend `src/pi/handlers.ts` to handle `user_bash`/`bashExecution`, creating `pi.bash.execution` spans per `04-telemetry-semantic-conventions.md` §9.

#### Why

Bash execution telemetry captures important agent/user operational events while commands and output remain sensitive by default.

#### How

Map bash events to spans, attach exit/cancel/truncation status, update execution/failure counters, and pass command/output content through redaction only when capture is enabled.

#### Where

- Target: `src/pi/handlers.ts` and bash handler tests.
- Source docs: `ObservMe-Production-Docs/04-telemetry-semantic-conventions.md` §9.
- Dependencies: tasks 8–10 and 17–18.

#### Acceptance criteria

- `pi.bash.exit_code`, `pi.bash.cancelled`, `pi.bash.truncated` attributes are correctly populated from the event/message data.
- Bash command/output are absent from spans by default; present only when capture is enabled and redacted.
- `observme_bash_executions_total` / `observme_bash_failures_total` increment correctly.

### 23. Implement subagent-spawn workflow propagation and wait/join tracking

- [x] Implement the subagent-spawn wrapper pattern from `07-extension-implementation-blueprint.md` §7 (Subagent Spawn) and `05-otel-pipeline-and-collector.md` §4: create a `pi.agent.spawn` span around the launch point; propagate W3C `traceparent`/`tracestate` plus `OBSERVME_WORKFLOW_ID`/`OBSERVME_PARENT_AGENT_ID`/`OBSERVME_ROOT_AGENT_ID`/`OBSERVME_PARENT_SESSION_ID`/`OBSERVME_AGENT_DEPTH`/`OBSERVME_SPAWN_ID` to the child process environment; and create `pi.agent.wait` / `pi.agent.join` spans/events when the parent waits for child completion or receives child results.

#### Why

Subagent propagation is required for multi-agent workflows to remain one correlated trace and for wait/join latency, fan-out, orphan, and propagation-failure signals to be observable.

#### How

Wrap spawn launch points, inject W3C and ObservMe lineage environment values, track wait/join lifecycle, update agent-tree metrics, and test both propagated and fallback/orphan scenarios without exporting raw command lines or inherited env values.

#### Where

- Target: subagent spawn/wait/join implementation modules, likely `src/pi/handlers.ts`, `src/pi/agent-lineage.ts`, and `src/pi/agent-tree-tracker.ts`.
- Source docs: `ObservMe-Production-Docs/07-extension-implementation-blueprint.md` §7 and `ObservMe-Production-Docs/05-otel-pipeline-and-collector.md` §4.
- Dependencies: tasks 11–12 and 17–18.

#### Acceptance criteria

- A test simulates a subagent spawn with trace-context propagation and asserts the child continues the same trace and preserves `pi.workflow.id`.
- A test simulates a subagent spawn without propagated trace context and asserts the child still records `pi.workflow.id`, `pi.agent.parent_id`/`pi.agent.root_id`, and a span link/log attribute fallback.
- A test simulates malformed or missing parent lineage and asserts `observme_orphan_agents_total` or `observme_trace_context_propagation_failures_total` increments as appropriate.
- Wait/join spans record child status, join status, propagated failure status, active-child count, and child count, so critical-path latency is visible.
- `observme_subagents_spawned_total`, `observme_subagent_spawn_failures_total`, `observme_agent_fanout_count`, `observme_agent_tree_depth`, `observme_agent_tree_width`, `observme_agent_wait_duration_ms`, and `observme_agent_join_duration_ms` update correctly; no raw command line or inherited env var value is exported.

### 24. Wire model-change and thinking-level-change handlers

- [x] Extend `src/pi/handlers.ts` to handle `model_select`/`model_change` and `thinking_level_select`/`thinking_level_change`, emitting `model.changed`/`thinking.changed` log events and metrics per `03-pi-event-and-session-model.md` §6 and `04-telemetry-semantic-conventions.md` §1, §12, and §14. If spans are emitted for these operations, use the documented `pi.model.change` and `pi.thinking.change` span names.

#### Why

Model and thinking-level changes explain later cost, latency, token, and behavior shifts without exposing conversation content.

#### How

Map selection/change events to structured logs and counters, include provider/model or thinking level only, and use the documented span names if these operations are represented as spans.

#### Where

- Target: `src/pi/handlers.ts` and model/thinking handler tests.
- Source docs: `ObservMe-Production-Docs/03-pi-event-and-session-model.md` §6 and `ObservMe-Production-Docs/04-telemetry-semantic-conventions.md` §1, §12, and §14.

#### Acceptance criteria

- `observme_model_changes_total` and `observme_thinking_level_changes_total` increment correctly in fixture-driven tests.
- Log events use `model.changed` / `thinking.changed` and include current provider/model or thinking level without leaking unrelated session content.
- Any spans emitted for these operations use `pi.model.change` / `pi.thinking.change`.

### 25. Wire compaction handler

- [x] Extend `src/pi/handlers.ts` to handle `session_compact`, emitting `pi.compaction` span/log/metric from the `compactionEntry` per `04-telemetry-semantic-conventions.md` §11 and `03-pi-event-and-session-model.md` §5.

#### Why

Compaction telemetry explains context-window management, token pressure, retries, and summary behavior across long-running sessions.

#### How

Map `session_compact` and `compactionEntry` fields to the canonical span attributes, log event, and metrics, then verify with fixtures.

#### Where

- Target: `src/pi/handlers.ts` and compaction handler tests.
- Source docs: `ObservMe-Production-Docs/04-telemetry-semantic-conventions.md` §11 and `ObservMe-Production-Docs/03-pi-event-and-session-model.md` §5.

#### Acceptance criteria

- Compaction telemetry includes `pi.compaction.first_kept_entry_id`, `pi.compaction.tokens_before`, `pi.compaction.summary.hash`, `pi.compaction.reason`, and `pi.compaction.will_retry` from the fixture `compactionEntry`.
- `observme_compactions_total` and `observme_compaction_tokens_before` histogram update correctly in a fixture-driven test.

### 26. Wire branch handler

- [x] Extend `src/pi/handlers.ts` to handle `session_tree`, emitting `pi.branch` span/log/metric per `04-telemetry-semantic-conventions.md` §10 and `03-pi-event-and-session-model.md` §4 and §6, including `summaryEntry` fields when present.

#### Why

Branch telemetry records session-tree changes and summary lineage needed to reconstruct navigation without exporting raw paths or content.

#### How

Map `session_tree` event data to branch span/log/metric attributes, hash or normalize sensitive fields per prior privacy utilities, and test both basic and `summaryEntry` cases.

#### Where

- Target: `src/pi/handlers.ts` and branch handler tests.
- Source docs: `ObservMe-Production-Docs/04-telemetry-semantic-conventions.md` §10 and `ObservMe-Production-Docs/03-pi-event-and-session-model.md` §4 and §6.

#### Acceptance criteria

- Branch telemetry includes `pi.branch.from_id`, `pi.branch.to_id`, `pi.branch.path_hash`, `pi.leaf.id`, `pi.branch.summary.hash`, and `pi.branch.common_ancestor_id` when available; it includes `summaryEntry` fields when present.
- `observme_branches_total` increments correctly in a fixture-driven test.

### 27. Implement `/obs status` command

- [x] Create `src/commands/obs-status.ts` implementing the read-only local-state command per `ObservMe-Production-Docs/08-query-grafana-integration.md` §4.

#### Why

A local status command lets users verify configuration, signal enablement, and export health without reaching out to external systems.

#### How

Read in-memory/local runtime state only, format a concise status report, and avoid any Collector, Grafana, Tempo, Loki, or Prometheus network call.

#### Where

- Target: `src/commands/obs-status.ts` and command tests.
- Source docs: `ObservMe-Production-Docs/08-query-grafana-integration.md` §4.

#### Acceptance criteria

- `/obs status` reports enabled/disabled state, OTLP endpoint, per-signal enablement, capture flags, queue drops, and last export error without making any network call.

### 28. Implement `/obs health` command

- [x] Create `src/commands/obs-health.ts` implementing the Collector/Grafana/datasource reachability check per `08-query-grafana-integration.md` §4.

#### Why

A health command gives users a quick operational check for the configured observability backend without needing to inspect logs manually.

#### How

Perform bounded-timeout reachability checks, summarize successes and failures, and ensure unreachable services report cleanly without throwing into Pi.

#### Where

- Target: `src/commands/obs-health.ts` and command tests.
- Source docs: `ObservMe-Production-Docs/08-query-grafana-integration.md` §4.

#### Acceptance criteria

- `/obs health` checks Collector and Grafana/datasource reachability with a configurable timeout and renders a concise summary.
- A test simulates an unreachable Collector and asserts the command reports failure without throwing.

### 29. Implement `/obs session` command

- [x] Create `src/commands/obs-session.ts` implementing the current-session telemetry summary per `08-query-grafana-integration.md` §4.

#### Why

Users need a quick view of current-session activity and cost without querying external observability storage.

#### How

Read only in-memory runtime counters and trace-link state, render the session summary, and keep the command independent from query clients.

#### Where

- Target: `src/commands/obs-session.ts` and command tests.
- Source docs: `ObservMe-Production-Docs/08-query-grafana-integration.md` §4.

#### Acceptance criteria

- `/obs session` shows the current session's turn/LLM-call/tool-call counts and cost from in-memory runtime state, plus a trace link when available.
- The command reads only in-memory runtime state; it does not query any external backend.

### 30. Implement Grafana query client

- [x] Create `src/query/grafana.ts` implementing the Grafana API client (health check, trace-link URL construction) per `08-query-grafana-integration.md` §3, §6.

#### Why

A dedicated Grafana client keeps query-backed commands separate from telemetry emission and centralizes timeout/link behavior.

#### How

Implement health checks and trace-link URL construction with configured timeout handling, block raw sensitive query inputs, and add dependency-direction tests.

#### Where

- Target: `src/query/grafana.ts` and Grafana client tests.
- Source docs: `ObservMe-Production-Docs/08-query-grafana-integration.md` §3 and §6.

#### Acceptance criteria

- The client enforces `query.timeoutMs` and never queries raw prompts/commands/paths per §7.
- A test confirms the client is not imported/instantiated by any telemetry-emission code path (one-way dependency direction).

### 31. Implement Tempo query client

- [x] Create `src/query/tempo.ts` implementing trace search by attributes per `08-query-grafana-integration.md` §6 (`searchTempo`).

#### Why

Tempo search enables trace drill-down by safe correlation attributes without using Prometheus for high-cardinality IDs.

#### How

Build bounded Tempo search requests from generated IDs or hashed fields only, enforce result limits, and reject raw prompt/command/path values.

#### Where

- Target: `src/query/tempo.ts` and Tempo client tests.
- Source docs: `ObservMe-Production-Docs/08-query-grafana-integration.md` §6 and §7.

#### Acceptance criteria

- Queries only use generated workflow IDs, generated agent IDs, session IDs, or hashed fields — never raw prompts/commands/paths, per §7.
- Result count is capped by `query.maxTraces`.

### 32. Implement Loki query client

- [ ] Create `src/query/loki.ts` implementing LogQL queries per `08-query-grafana-integration.md` §4, §6 (`queryLoki`), normalizing dotted attribute names to underscores for Loki queries per `13-source-notes.md`.

#### Why

Loki queries power logs/errors commands and must use the attribute-name normalization required by the production docs.

#### How

Implement bounded LogQL query construction, normalize dotted attributes to underscores, cap results, and test the normalization examples.

#### Where

- Target: `src/query/loki.ts` and Loki client tests.
- Source docs: `ObservMe-Production-Docs/08-query-grafana-integration.md` §4 and §6, `ObservMe-Production-Docs/13-source-notes.md`.

#### Acceptance criteria

- Result count is capped by `query.maxLogs`.
- A test confirms attribute name normalization (`event.name` → `event_name`, `pi.session.id` → `pi_session_id`).

### 33. Implement Prometheus query client

- [ ] Create `src/query/prometheus.ts` implementing PromQL queries per `08-query-grafana-integration.md` §4, §6 (`queryPrometheus`).

#### Why

Prometheus queries back cost, tool, agent, alert, and dashboard summaries while enforcing low-cardinality metric usage.

#### How

Implement bounded PromQL execution, enforce result caps, and add query-construction tests that reject forbidden high-cardinality labels.

#### Where

- Target: `src/query/prometheus.ts` and Prometheus client tests.
- Source docs: `ObservMe-Production-Docs/08-query-grafana-integration.md` §4 and §6, `ObservMe-Production-Docs/04-telemetry-semantic-conventions.md` §13.

#### Acceptance criteria

- Result count is capped by `query.maxMetricSeries`/`query.maxAgents` as applicable.
- A test asserts no query built by this client references a forbidden high-cardinality label per `04-telemetry-semantic-conventions.md` §13.

### 34. Implement `/obs cost` command

- [ ] Create `src/commands/obs-cost.ts` using the Prometheus client (task 33) to run the cost aggregate PromQL from `08-query-grafana-integration.md` §4.

#### Why

The cost command gives users a safe aggregate view of LLM spend without enabling session-scoped high-cardinality queries by default.

#### How

Use the Prometheus client to run documented aggregate PromQL, default to provider/model aggregation, and honor query timeout and result limits.

#### Where

- Target: `src/commands/obs-cost.ts` and command tests.
- Source docs: `ObservMe-Production-Docs/08-query-grafana-integration.md` §4.
- Dependency: task 33.

#### Acceptance criteria

- The default query aggregates by `model`/`provider` only; session-scoped cost queries are disabled by default per §4.
- Query timeout and result limits from task 33 are respected.

### 35. Implement `/obs trace` and `/obs link` commands

- [ ] Create `src/commands/obs-trace.ts` and `src/commands/obs-link.ts` using the Grafana client (task 30) to return trace links for the current session, last turn, or a given session ID, per `08-query-grafana-integration.md` §4, §5.

#### Why

Trace/link commands connect local Pi context to Grafana traces without sending raw prompt or command content in URLs.

#### How

Build links through the Grafana client and configurable URL template, support current/last/session-id scopes, and sanitize query-string inputs.

#### Where

- Target: `src/commands/obs-trace.ts`, `src/commands/obs-link.ts`, and command tests.
- Source docs: `ObservMe-Production-Docs/08-query-grafana-integration.md` §4 and §5.
- Dependency: task 30.

#### Acceptance criteria

- Both commands support a configurable URL template per §5, since Grafana URL encoding varies by version/organization.
- Neither command sends raw prompt/command content as part of the query string.

### 36. Implement `/obs tools` command

- [ ] Create `src/commands/obs-tools.ts` using the Prometheus client (task 33) to run the tool call/failure PromQL from `08-query-grafana-integration.md` §4.

#### Why

The tools command helps users identify tool usage and failure patterns using only safe aggregate labels.

#### How

Run the documented PromQL through the Prometheus client, aggregate only by allowed tool/error labels, and enforce client timeout/result limits.

#### Where

- Target: `src/commands/obs-tools.ts` and command tests.
- Source docs: `ObservMe-Production-Docs/08-query-grafana-integration.md` §4.
- Dependency: task 33.

#### Acceptance criteria

- Aggregations use only `tool_name`/`error_class` labels, never tool-call IDs.
- Query timeout and result limits from task 33 are respected.

### 37. Implement `/obs errors` and `/obs logs` commands

- [ ] Create `src/commands/obs-errors.ts` and `src/commands/obs-logs.ts` using the Loki client (task 32) to run the LogQL queries from `08-query-grafana-integration.md` §4.

#### Why

Error and log commands provide focused operational debugging while avoiding raw log dumps and respecting backend query limits.

#### How

Build the documented Loki queries through the Loki client, filter errors/session logs with normalized labels, cap results, and render concise summaries.

#### Where

- Target: `src/commands/obs-errors.ts`, `src/commands/obs-logs.ts`, and command tests.
- Source docs: `ObservMe-Production-Docs/08-query-grafana-integration.md` §4.
- Dependency: task 32.

#### Acceptance criteria

- `/obs errors` filters on `event_category="error"`; `/obs logs` filters on the current session's normalized `pi_session_id`.
- Result rendering is a concise summary, not a raw log dump; result count is capped by `query.maxLogs`.

### 38. Implement `/obs agents` command

- [ ] Create `src/commands/obs-agents.ts` using the workflow/agent-lineage context (task 12) and the Prometheus/Tempo clients (tasks 31/33) to show current workflow/agent identity, recent parent/child relationships, depth, fan-out, active children, orphan status, and wait/join hints per `08-query-grafana-integration.md` §4.

#### Why

The agents command exposes multi-agent workflow state and safe drill-downs, which are central to ObservMe's agent-tree observability goal.

#### How

Combine in-memory lineage context with Prometheus aggregates and Tempo/Loki drill-downs, use low-cardinality labels for aggregate PromQL, and keep workflow/agent IDs out of metric labels.

#### Where

- Target: `src/commands/obs-agents.ts` and command tests.
- Source docs: `ObservMe-Production-Docs/08-query-grafana-integration.md` §4.
- Dependencies: tasks 12, 31, and 33.

#### Acceptance criteria

- Aggregate PromQL examples used by this command reference only low-cardinality labels such as `agent_role`/`agent_capability`/`subagent_depth`/`spawn_type`/`spawn_reason`, never workflow IDs or agent IDs, per §4.
- Per-agent/per-workflow drill-down uses Tempo/Loki attributes, not Prometheus labels, per §4.

### 39. Implement optional `/obs backfill` command

- [ ] Create `src/commands/obs-backfill.ts` implementing the disabled-by-default historical replay command per `07-extension-implementation-blueprint.md` §12, marking replayed telemetry `observme.replayed=true` and requiring explicit user confirmation before sending historical content.

#### Why

Backfill can help users recover historical observability, but it is privacy-sensitive and must never run automatically.

#### How

Implement an explicit command-only replay flow with user confirmation, rate limits, replay markers, and the same redaction/capture safeguards as live telemetry.

#### Where

- Target: `src/commands/obs-backfill.ts` and backfill tests.
- Source docs: `ObservMe-Production-Docs/07-extension-implementation-blueprint.md` §12.
- Dependencies: tasks 8–10 and 19.

#### Acceptance criteria

- Backfill is a no-op unless explicitly invoked; it never runs automatically.
- Backfilled content still passes through the full redaction pipeline (task 9) unless capture settings explicitly allow it.
- A rate limit bounds backfill export volume; a test asserts the limit is enforced.

### 40. Replace template example command/tool and remove `_template` metadata

- [ ] Remove `src/commands/example-command.ts` and `src/tools/example-tool.ts` (or repurpose them if a genuinely useful agent-facing tool is identified), update `src/extension.ts` to register all real ObservMe modules, rename the exported factory to `observme`, and remove the `_template` block from `package.json`.

#### Why

Template artifacts must be removed before the package can be considered a real ObservMe extension rather than a renamed scaffold.

#### How

Delete or repurpose example modules, make `src/extension.ts` registration-only, wire real commands/handlers/tools, remove `_template`, and run validation.

#### Where

- Target: `src/commands/example-command.ts`, `src/tools/example-tool.ts`, `src/extension.ts`, `package.json`, and related tests/docs.

#### Acceptance criteria

- `src/extension.ts` only imports and calls `register*` functions; it contains no inline business logic.
- `package.json` no longer contains `_template`, and `pi.extensions` still points at `./src/extension.ts`.
- `npm run validate` passes after the removal.

### 41. Build overview, cost, and latency dashboards

- [ ] Create `dashboards/observme-overview.json`, `dashboards/observme-cost.json`, and `dashboards/observme-latency.json` per `ObservMe-Production-Docs/09-dashboards-alerts-slos.md` §2–3.

#### Why

These dashboards provide the primary MVP views for operational health, LLM cost, and latency.

#### How

Create valid Grafana dashboard JSON using only documented metric names and PromQL, then validate the JSON files.

#### Where

- Target: `dashboards/observme-overview.json`, `dashboards/observme-cost.json`, and `dashboards/observme-latency.json`.
- Source docs: `ObservMe-Production-Docs/09-dashboards-alerts-slos.md` §2–3.

#### Acceptance criteria

- Every PromQL query embedded in these three dashboards matches the metric names defined in `04-telemetry-semantic-conventions.md`.
- All three dashboard JSON files validate as well-formed Grafana dashboard JSON.

### 42. Build tools, agents, and models dashboards

- [ ] Create `dashboards/observme-tools.json`, `dashboards/observme-agents.json`, and `dashboards/observme-models.json` per `09-dashboards-alerts-slos.md` §4–6.

#### Why

These dashboards expose tool reliability, agent-tree behavior, and model usage patterns with safe aggregate labels.

#### How

Create valid Grafana dashboard JSON, copy only documented query patterns, and explicitly avoid workflow/agent IDs in agent-dashboard metric labels.

#### Where

- Target: `dashboards/observme-tools.json`, `dashboards/observme-agents.json`, and `dashboards/observme-models.json`.
- Source docs: `ObservMe-Production-Docs/09-dashboards-alerts-slos.md` §4–6.

#### Acceptance criteria

- Agent-dashboard aggregates avoid high-cardinality workflow/agent IDs per §5, using only low-cardinality labels such as `agent_role`/`agent_capability`/`subagent_depth`/`spawn_type`/`spawn_reason`.
- All three dashboard JSON files validate as well-formed Grafana dashboard JSON.

### 43. Build errors, branches/compactions, and export-health dashboards

- [ ] Create `dashboards/observme-errors.json`, `dashboards/observme-branches-compactions.json`, and `dashboards/observme-export-health.json` per `09-dashboards-alerts-slos.md` §7–9.

#### Why

These dashboards cover error diagnosis, branch/compaction behavior, and exporter health/drops.

#### How

Create valid Grafana dashboard JSON, use documented PromQL/LogQL, and normalize Loki attribute names as required.

#### Where

- Target: `dashboards/observme-errors.json`, `dashboards/observme-branches-compactions.json`, and `dashboards/observme-export-health.json`.
- Source docs: `ObservMe-Production-Docs/09-dashboards-alerts-slos.md` §7–9 and `ObservMe-Production-Docs/13-source-notes.md`.

#### Acceptance criteria

- Loki query examples use normalized attribute names (`event_name`, not `event.name`) per §9.
- All three dashboard JSON files validate as well-formed Grafana dashboard JSON.

### 44. Define alert rules

- [ ] Create an alert-rules artifact (e.g. `dashboards/observme-alerts.yaml` or an equivalent Prometheus/Grafana alerting-rule file) implementing every alert from `09-dashboards-alerts-slos.md` §11, including high LLM error rate, high tool failure rate, subagent spawn failures, export drops detected, cost spike, redaction failures, runaway fan-out, excessive tree depth, orphan agents, trace-context propagation failures, and active agents stuck high.

#### Why

Alert rules turn the emitted metrics into actionable production operations coverage for the documented failure modes.

#### How

Create the alert artifact with every documented expression and severity, reference only known metric names, and keep labels low-cardinality.

#### Where

- Target: `dashboards/observme-alerts.yaml` or equivalent alerting artifact.
- Source docs: `ObservMe-Production-Docs/09-dashboards-alerts-slos.md` §11 and `ObservMe-Production-Docs/04-telemetry-semantic-conventions.md`.

#### Acceptance criteria

- Every alert rule in §11 exists with the documented PromQL expression and severity guidance.
- Each alert rule references only metric names defined in `04-telemetry-semantic-conventions.md`.

### 45. Define SLO indicators

- [ ] Create an SLO-definitions artifact implementing every SLO from `09-dashboards-alerts-slos.md` §12: observability export SLO, workflow/agent lineage SLO, workflow completion SLO, instrumentation overhead SLO, redaction SLO.

#### Why

SLO definitions make production readiness measurable and keep runtime SLOs separate from CI/test-time privacy guarantees.

#### How

Document each SLO indicator with PromQL where applicable, identify measurement source, and explicitly mark redaction as CI/test-time per the production docs.

#### Where

- Target: an SLO artifact under `dashboards/` or docs, and any supporting validation tests.
- Source docs: `ObservMe-Production-Docs/09-dashboards-alerts-slos.md` §12.

#### Acceptance criteria

- Every SLO indicator expression from §12 exists as a reviewable artifact with correct PromQL where applicable.
- The redaction SLO is explicitly documented as a CI/test-time SLO, not a runtime-only indicator, per §12.

### 46. Add example config files

- [ ] Create `examples/observme.yaml` and `examples/collector.yaml` per `05-otel-pipeline-and-collector.md` §5–6, including the production Collector config with high-cardinality attribute drop processors.

#### Why

Example configs give users a safe starting point and document required Collector processors for privacy/cardinality control.

#### How

Copy the production reference settings into example YAML, include high-cardinality/content-drop processors, validate YAML syntax, and keep ObservMe config minimal but realistic.

#### Where

- Target: `examples/observme.yaml` and `examples/collector.yaml`.
- Source docs: `ObservMe-Production-Docs/05-otel-pipeline-and-collector.md` §5–6.

#### Acceptance criteria

- `examples/collector.yaml` matches the production reference in `05-otel-pipeline-and-collector.md` §6, including `resource/drop_high_cardinality_metric_attrs` and `attributes/drop_content_attributes` processors.
- `examples/observme.yaml` is a valid, minimal-but-realistic ObservMe config matching the schema from task 2.

### 47. Add compatibility matrix document

- [ ] Create a compatibility-matrix document tracking tested versions of Pi, Node.js, the OpenTelemetry JS package set, Collector distribution, Tempo, Loki, Prometheus/Mimir, and Grafana per `10-testing-release-operations.md` §11.

#### Why

The compatibility matrix records what combinations have actually been exercised, reducing ambiguity for users and future release work.

#### How

Create the document, populate it with versions tested in CI/local validation, and update it when integration tests exercise additional components.

#### Where

- Target: a compatibility matrix document under `docs/`, `specs/`, or another agreed documentation location.
- Source docs: `ObservMe-Production-Docs/10-testing-release-operations.md` §11.

#### Acceptance criteria

- The document lists at least the versions actually exercised in CI/local testing at the time it is written.

### 48. Add Collector integration tests

- [ ] Add integration tests that run a local debug-exporter Collector (per `10-testing-release-operations.md` §5) and assert traces/metrics/logs arrive with expected attributes and that content-capture defaults are respected.

#### Why

Collector integration tests prove ObservMe exports real OTLP signals and preserves privacy defaults outside isolated unit tests.

#### How

Start a local debug-exporter Collector, run representative telemetry through ObservMe, inspect received traces/metrics/logs, and assert optional content stays absent by default.

#### Where

- Target: integration test files and Collector test fixtures/config.
- Source docs: `ObservMe-Production-Docs/10-testing-release-operations.md` §5.

#### Acceptance criteria

- Tests pass against a locally run debug-exporter Collector container.
- Tests assert default content-capture settings are respected (no optional content present unless explicitly enabled).

### 49. Add Grafana-stack integration tests

- [ ] Add integration tests using the existing `observability-stack/` Docker Compose setup per `10-testing-release-operations.md` §6: Tempo trace query by trace id, Tempo/Loki query by `pi.agent.id`/`pi.agent.parent_id` for lineage, Loki log query by session id, Prometheus metric query for token totals, Grafana dashboard import validation.

#### Why

Full-stack integration tests verify that emitted telemetry can be queried and visualized by the actual reference stack shipped with the project.

#### How

Run the `observability-stack/` Compose services, emit representative telemetry, query each backend, and validate dashboard imports.

#### Where

- Target: integration tests and any fixtures under `observability-stack/` or test directories.
- Source docs: `ObservMe-Production-Docs/10-testing-release-operations.md` §6.
- Existing stack: `observability-stack/`.

#### Acceptance criteria

- Tests pass against `observability-stack/`'s Docker Compose services (Tempo/Loki/Prometheus-or-Mimir/Grafana).
- Dashboard import validation succeeds for the dashboards built in tasks 41–43.

### 50. Add chaos/failure tests

- [ ] Add tests for the failure scenarios in `10-testing-release-operations.md` §7: Collector down, Collector slow, subagent without propagated context, orphan agent, runaway fan-out/depth, queue full, redaction exception.

#### Why

Chaos/failure tests prove ObservMe fails safely and reports the right operational counters when dependencies or inputs misbehave.

#### How

Implement each documented scenario, assert Pi continues running, and assert the appropriate drop/error/fan-out/orphan/propagation metric increments.

#### Where

- Target: chaos/failure integration tests.
- Source docs: `ObservMe-Production-Docs/10-testing-release-operations.md` §7.

#### Acceptance criteria

- Each scenario asserts Pi continues running and increments the correct drop/error/fan-out/orphan/propagation counter, never an unhandled exception.

### 51. Add performance test

- [ ] Add a performance test using the synthetic workload from `10-testing-release-operations.md` §8 (100 sessions, 1,000 turns/session, 5 tool calls/turn, 2 LLM calls/turn, 1 subagent spawn every 20 turns).

#### Why

Performance tests verify that instrumentation overhead stays within documented targets under realistic synthetic load.

#### How

Generate the documented workload, measure handler latency percentiles, memory growth, drops, and batch sizes, then compare against p95/p99 targets.

#### Where

- Target: performance test files and result-reporting output.
- Source docs: `ObservMe-Production-Docs/10-testing-release-operations.md` §8.

#### Acceptance criteria

- The test reports handler p50/p95/p99 durations, memory growth, dropped-telemetry count, and export batch sizes.
- Results confirm `handler p95 < 10ms` and `handler p99 < 25ms` targets from §8.

### 52. Add redaction unit tests

- [ ] Create `test/redaction.test.ts` covering the redaction pipeline (tasks 8–10) per `10-testing-release-operations.md` §4.

#### Why

A dedicated redaction test suite ensures the most privacy-sensitive behavior remains covered even as handlers and commands evolve.

#### How

Build test cases for every documented secret/PII/path/content category, exercise the pipeline from tasks 8–10, and assert no raw sensitive value is exported.

#### Where

- Target: `test/redaction.test.ts` and any redaction fixtures.
- Source docs: `ObservMe-Production-Docs/10-testing-release-operations.md` §4.
- Dependencies: tasks 8–10.

#### Acceptance criteria

- Test cases cover every category in `10-testing-release-operations.md` §4 (AWS keys, GitHub tokens, bearer tokens, OpenAI/Anthropic-like keys, Slack tokens, password assignments, private key blocks, environment variable dumps, filesystem paths, URL credentials).

### 53. Add event-mapping contract tests

- [ ] Create `test/event-mapping.test.ts` with JSON fixtures under `test/fixtures/` (session entries) and `test/fixtures/events/` (extension event payloads) per `10-testing-release-operations.md` §3, asserting correct span names/attributes/parenting for every handler from tasks 17–26, including subagent spawn, wait/join, and orphan-agent fixtures.

#### Why

Contract tests lock the Pi event-to-telemetry mapping to documented fixtures and prevent regressions in span shape, attributes, and privacy defaults.

#### How

Add the documented fixture files, run every handler path from tasks 17–26, and assert span names, parent/child relationships, attributes, metric-label safety, and default content absence.

#### Where

- Target: `test/event-mapping.test.ts`, `test/fixtures/`, and `test/fixtures/events/`.
- Source docs: `ObservMe-Production-Docs/10-testing-release-operations.md` §3.
- Dependencies: tasks 17–26.

#### Acceptance criteria

- Fixtures exist for every file listed in `10-testing-release-operations.md` §3.
- Assertions cover correct span name, correct `pi.*`/`observme.*`/`gen_ai.*` attributes, no forbidden metric labels, correct parent/child span nesting, and absence of optional content by default.

### 54. Add metrics unit tests

- [ ] Create `test/metrics.test.ts` asserting every counter/histogram/gauge from `04-telemetry-semantic-conventions.md` §12 updates correctly for its corresponding handler.

#### Why

Metric tests ensure each documented instrument is emitted by the right handler and remains aligned with alerts, SLOs, dashboards, and query commands.

#### How

Enumerate the constants from task 7, exercise the corresponding handler or metric helper, and assert each counter/histogram/gauge records the expected value.

#### Where

- Target: `test/metrics.test.ts`.
- Source docs: `ObservMe-Production-Docs/04-telemetry-semantic-conventions.md` §12.
- Dependency: task 7 and the relevant handler tasks.

#### Acceptance criteria

- Every metric name from task 7's constants has at least one test exercising an increment/observation.

### 55. Add exporter-failure unit tests

- [ ] Create `test/exporter-failure.test.ts` covering the "Collector Down"/"Collector Slow"/"Queue Full" scenarios from `10-testing-release-operations.md` §7 at the unit level (mocked exporter), independent of the chaos integration tests in task 50.

#### Why

Exporter-failure unit tests provide fast feedback for the most common backend failure modes without requiring the integration stack.

#### How

Mock exporters for down/slow/full-queue behavior, run telemetry emission paths, and assert safe continuation plus the documented error/drop counters.

#### Where

- Target: `test/exporter-failure.test.ts`.
- Source docs: `ObservMe-Production-Docs/10-testing-release-operations.md` §7.
- Related task: task 50 covers broader chaos/integration scenarios.

#### Acceptance criteria

- Tests assert Pi continues without exception and drop/export-error counters increment as expected.

### 56. Add workflow and agent-lineage unit tests

- [ ] Create `test/agent-lineage.test.ts` covering workflow ID generation, agent ID generation, propagation, fan-out/depth tracking, wait/join tracking, orphan classification, and the "Subagent Without Propagated Context" scenario from `10-testing-release-operations.md` §7, exercising task 12 and task 23 directly (unit level, not integration).

#### Why

Lineage tests prove multi-agent correlation remains private, generated, bounded, and resilient to missing or malformed propagation context.

#### How

Exercise lineage and tree-tracker modules directly, simulate propagated/missing/malformed child context, and assert fan-out/depth/wait/join/orphan/propagation signals without high-cardinality labels.

#### Where

- Target: `test/agent-lineage.test.ts`.
- Source docs: `ObservMe-Production-Docs/10-testing-release-operations.md` §7 and `ObservMe-Production-Docs/06-security-privacy-redaction.md` §8.
- Dependencies: tasks 12 and 23.

#### Acceptance criteria

- Tests assert workflow/lineage IDs are generated, not derived from cwd/username/prompt/command line, per `06-security-privacy-redaction.md` §8.
- Tests assert a child without propagated context still records workflow/parent/root lineage attributes when available, and is marked root/orphan otherwise.
- Tests assert fan-out, depth, active-child, wait/join, child-status, orphan, and propagation-failure signals are updated without high-cardinality metric labels.

### 57. Add cardinality unit tests

- [ ] Create `test/cardinality.test.ts` asserting no forbidden high-cardinality field (workflow id, session id, agent id, parent/child agent id, agent run id, spawn id, spawn tool-call id, trace id, span id, entry id, raw path/command/prompt/error) ever appears in a metric label, per `10-testing-release-operations.md` §9.

#### Why

Cardinality tests protect Prometheus/Mimir health and enforce the semantic-convention rule that IDs and raw content belong in traces/log attributes, not metric labels.

#### How

Enumerate every emitted metric and label set, compare labels against the allowed list, and fail if any forbidden ID or raw-content field appears.

#### Where

- Target: `test/cardinality.test.ts`.
- Source docs: `ObservMe-Production-Docs/10-testing-release-operations.md` §9 and `ObservMe-Production-Docs/04-telemetry-semantic-conventions.md` §13.

#### Acceptance criteria

- The test enumerates every metric emitted by the extension and asserts its label set only contains allowed labels from `04-telemetry-semantic-conventions.md` §13.

### 58. Finalize README/CHANGELOG/SECURITY documentation

- [ ] Update `README.md`, `CHANGELOG.md`, and `SECURITY.md` to describe the now-implemented behavior (replacing any remaining "planned" labels and template placeholders) once tasks 1–57 are complete.

#### Why

Final documentation must reflect implemented behavior, privacy posture, and release scope after all code, tests, dashboards, and configs are complete.

#### How

Review user-facing docs against the implemented MVP, replace template/planned language, add a dated changelog entry, and perform final validation plus isolated Pi smoke testing.

#### Where

- Target: `README.md`, `CHANGELOG.md`, `SECURITY.md`, and final smoke-test notes.
- Source docs: `ObservMe-Production-Docs/00-README.md` MVP checklist and implemented behavior from tasks 1–57.

#### Acceptance criteria

- `npm run validate` passes (lint, typecheck, tests, pack check, all smoke scripts).
- `README.md` documents every implemented `/obs` command and the safety/privacy model accurately; no `{{PLACEHOLDER}}` tokens or "Planned" labels remain for shipped behavior.
- `CHANGELOG.md` has a real, dated entry describing the implemented MVP scope against `ObservMe-Production-Docs/00-README.md`'s "Minimum Viable Production Release" checklist.
- An isolated smoke test (`pi --no-extensions -e .`) loads ObservMe without error and `/obs status` returns a sane result against a local debug Collector.

## Testing Strategy

Follow `ObservMe-Production-Docs/10-testing-release-operations.md`: unit tests first (tasks 2–12, then 52–57 once their subject modules exist), then fixture-driven contract tests (task 53) against Pi event payloads produced by tasks 17–26, then Collector integration tests (task 48), then Grafana-stack integration tests (task 49, using the existing `observability-stack/` Docker Compose setup), then chaos/failure and performance tests (tasks 50–51). Keep `npm run validate` green after every task.

## Acceptance Criteria

- All 58 tasks above are implemented in order, each with its own passing acceptance criteria, before ObservMe is considered MVP-complete per `ObservMe-Production-Docs/00-README.md`.
- No task's acceptance criteria is satisfied by documentation alone when it specifies code/test behavior.
- The final implementation satisfies every bullet in `ObservMe-Production-Docs/00-README.md`'s "Minimum Viable Production Release" list, plus the alerts, SLOs, compatibility matrix, and integration/chaos/performance tests identified in the production docs but not originally called out in the MVP bullet list.

## Validation Commands

- `npm run validate` — full lint, typecheck, test, pack-check, and smoke-script pipeline; must pass after every task in this spec.
- `pi --no-extensions -e .` — isolated manual smoke test; run after task 17 onward to confirm real session behavior as handlers accumulate.

## Notes

This task spec is prepared but **not started**. All checkboxes are `- [ ]` and must remain unchecked until a separate implementation session works through them one at a time, per this skill's hard boundary against implementing features during preparation. If any task's acceptance criteria conflicts with `ObservMe-Production-Docs/`, update the task, not the production docs.

Tasks are intentionally small (one file or one tightly coupled pair per task) so each is completable within a single focused implementation session. Dependencies still flow top-to-bottom: later tasks assume earlier prerequisite tasks are complete (for example, task 18 assumes task 17 exists; task 38 assumes tasks 12, 31, and 33 exist).

### Open question carried into the implementation session

`ObservMe-Production-Docs/07-extension-implementation-blueprint.md` §14 ("Build Artifact") lists `dist/observme.js` and `dist/observme.d.ts` as expected build output, implying a bundled/compiled distribution. The current template convention (confirmed working via `npm run check:pack`) ships raw TypeScript source directly — `package.json`'s `files[]` includes `src/**/*.ts` with no bundler in `devDependencies`, and `pi.extensions` points at `./src/extension.ts` directly. These two conventions conflict. The implementation session must ask the user to resolve this explicitly (add a build/bundle step to match the doc, or update the doc/spec to match the source-shipping convention) before task 41's dashboard/artifact packaging expectations are finalized.
