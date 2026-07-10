# Plan: Resolve Full Source Review Findings

## Task Description

Resolve every actionable Standards and Spec finding from the full review of the current `src/` tree. This is a **fix** plan with **complex** scope because it crosses privacy, Pi file-mutation behavior, bounded runtime state, semantic conventions, configuration validation, cross-process OpenTelemetry context, metric accounting, event timing, structured logs, and module boundaries.

The work must be completed one task at a time. Keep a task unchecked until its implementation, focused tests, documentation, and changelog entry satisfy that task's acceptance criteria.

## Objective

Bring the ObservMe source into conformance with repository standards and the canonical `ObservMe-Production-Docs/` contract by:

- preventing path and configuration data leaks;
- bounding every reviewed session/agent collection and metric dimension;
- continuing trusted child traces across process boundaries;
- emitting all declared lifecycle and agent-tree metrics with meaningful timing;
- producing correctly correlated structured logs; and
- reducing handler and OTLP endpoint maintenance duplication without changing public behavior.

## Problem Statement

The existing automated suite is green, but static review found behavior that the tests do not currently protect. The most serious gaps are incomplete path scrubbing, child sessions that cannot join a propagated W3C trace, arbitrary subagent reason labels, and required metrics that are constructed but never recorded. Additional standards violations include direct unqueued project-file mutation, unbounded runtime collections, hardcoded Pi configuration paths, inline telemetry keys, hand-built TypeBox enums, silent configuration rejection, and concentrated/duplicated module responsibilities.

Passing tests therefore do not currently prove the privacy, cardinality, distributed-tracing, or telemetry-completeness guarantees claimed by the production documentation.

## Solution Approach

Remediate safety boundaries before telemetry behavior, then repair missing telemetry and finally perform structure-only refactors:

1. Harden privacy, Pi path/mutation behavior, collection bounds, semantic constants, and enum contracts.
2. Normalize all metric dimensions to documented bounded enums.
3. validate and accept only a complete trusted child propagation envelope, then build the root `pi.session` span with explicit OpenTelemetry parent context or a documented fallback link.
4. Add sanitized rejection diagnostics and record each currently dormant metric at its authoritative lifecycle transition.
5. Measure bash execution from the pre-execution event instead of measuring the completion handler itself, and enrich tool completion logs with safe correlation.
6. Split event domains and extract shared OTLP endpoint helpers only after behavior is covered by focused regression tests.

`ObservMe-Production-Docs/` remains the semantic source of truth. Pi integration must follow the installed Pi extension documentation, particularly `docs/extensions.md` guidance for `CONFIG_DIR_NAME`, `StringEnum`, session-scoped lifecycle, and `withFileMutationQueue()`.

## Relevant Files

- `src/privacy/redact.ts` — embedded path detection and path-mode transformations.
- `src/config/bootstrap-project-config.ts` — trusted project starter creation and direct filesystem mutation.
- `src/config/load-config.ts`, `src/config/schema.ts`, `src/config/validate.ts` — config directory defaults, TypeBox enums, diagnostics, and fallback behavior.
- `src/extension.ts` — production registration options and propagated child-context trust wiring.
- `src/pi/agent-lineage.ts` — trusted propagation envelope validation and lineage construction.
- `src/pi/agent-tree-tracker.ts` — bounded agent nodes and parent child-ID retention.
- `src/pi/handlers.ts`, `src/pi/handler-internals.ts` — session state, lifecycle handlers, spans, logs, metrics, bash timing, and inline attributes.
- `src/pi/subagent-spawn.ts` — propagation, reason dimensions, spawn timing, and child failure/recovery accounting.
- `src/commands/obs-backfill.ts` — replay telemetry attributes that must use semantic constants.
- `src/semconv/attributes.ts`, `src/semconv/metrics.ts`, `src/semconv/spans.ts` — canonical telemetry names and bounded value contracts.
- `src/otel/logs.ts`, `src/otel/metrics.ts`, `src/otel/traces.ts` — duplicated OTLP endpoint handling and trace provider/context behavior.
- `test/redact.test.mjs`, `test/redaction.test.ts`, `test/content-capture-policy.test.mjs` — privacy regression coverage.
- `test/project-config-bootstrap.test.mjs`, `test/config-loader.test.mjs`, `test/config-validation.test.mjs` — Pi path, mutation, and rejection diagnostics.
- `test/agent-lineage.test.mjs`, `test/agent-lineage.test.ts`, `test/subagent-spawn.test.mjs` — trusted propagation, bounded dimensions, and child metrics.
- `test/pi-handlers.test.mjs`, `test/handler-internals.test.ts`, `test/event-mapping.test.ts`, `test/metrics.test.ts`, `test/cardinality.test.ts` — lifecycle, log, timing, metric, and semantic contracts.
- `test/otel-traces.test.mjs`, `test/otel-logs.test.mjs`, `test/otel-metrics.test.mjs` — trace parenting and shared OTLP endpoint behavior.
- `ObservMe-Production-Docs/03-pi-event-and-session-model.md` — child trace continuation and bash event mapping.
- `ObservMe-Production-Docs/04-telemetry-semantic-conventions.md` — attributes, logs, metrics, and bounded labels.
- `ObservMe-Production-Docs/06-security-privacy-redaction.md` — path sensitivity and redaction pipeline.
- `ObservMe-Production-Docs/10-testing-release-operations.md` — bounded state/cardinality and failure tests.
- `ObservMe-Production-Docs/12-configuration-reference.md` — config and propagated lineage rules.
- `docs/agent-subagent-observability-requirements.md` — currently documented production-wiring and metric-accounting gaps.
- `CHANGELOG.md` — required task-by-task change record.

### New Files

Expected structural files; exact names may be adjusted if an equally focused existing pattern is preferable:

- `src/otel/otlp-endpoint.ts` — shared signal endpoint normalization.
- `src/pi/event-handlers/lifecycle.ts` — session startup/shutdown and config diagnostic integration.
- `src/pi/event-handlers/agent-turn.ts` — agent-run and turn lifecycle.
- `src/pi/event-handlers/llm.ts` — provider/message lifecycle.
- `src/pi/event-handlers/tool-bash.ts` — tool and user-bash lifecycle.
- `src/pi/event-handlers/session-events.ts` — model, thinking, branch, and compaction events.

## Implementation Phases

### Phase 1: Safety and Contract Foundation

Complete tasks 1–6. Close privacy leaks, use Pi's supported mutation/config APIs, bound state, centralize telemetry names, use compatible schemas, and constrain all metric dimensions before changing distributed telemetry behavior.

### Phase 2: Telemetry Correctness

Complete tasks 7–11. Wire child trace continuation, surface sanitized config rejection, activate dormant metrics, measure real bash duration, and emit fully correlated tool logs.

### Phase 3: Integration and Polish

Complete tasks 12–14. Split oversized handler responsibilities, remove OTLP helper duplication, update documentation, run all validation, and record any environment-dependent validation blockers.

## Review Finding Coverage

| Review finding | Remediation task |
| --- | --- |
| Incomplete path redaction | Task 1 |
| Project-file creation bypasses Pi mutation queue | Task 2 |
| Hardcoded `.pi` fallback | Task 2 |
| Unbounded turn and child-ID collections | Task 3 |
| Inline telemetry keys outside `src/semconv/` | Task 4 |
| Hand-rolled TypeBox string enums | Task 5 |
| Arbitrary/unbounded subagent reason labels | Task 6 |
| Shipped entrypoint ignores propagated lineage | Task 7 |
| Child root span does not continue/link parent trace | Task 7 |
| Rejected unsafe configuration can be silent | Task 8 |
| Required metrics are declared but not recorded | Task 9 |
| Bash duration measures instrumentation time | Task 10 |
| Tool completion logs lack required correlation | Task 11 |
| Divergent event-handler module | Task 12 |
| Duplicated OTLP endpoint helpers | Task 13 |

## Step by Step Tasks

IMPORTANT: Execute every task in order, top to bottom. Work on only one unchecked task at a time. Mark its checkbox with `x` only after every acceptance criterion passes, and update `CHANGELOG.md` as part of that task.

### 1. Complete cross-platform path redaction

- [x] Make the redaction pipeline scrub all supported absolute filesystem path forms instead of only Unix home-directory paths.

#### Why

Full paths are sensitive according to `ObservMe-Production-Docs/06-security-privacy-redaction.md`. The current embedded-path matcher misses non-home Unix paths, Windows drive paths, and UNC paths, allowing optional captured content to leak local filesystem structure even when redaction is enabled.

#### How

- Define path recognition that handles POSIX absolute paths, Windows drive paths, and UNC paths without treating ordinary URLs or harmless slash-separated text as filesystem paths.
- Apply `hash`, `basename`, `drop`, and explicitly opted-in `full` behavior consistently to standalone and embedded paths.
- Use the correct POSIX or Windows basename/dirname semantics for the detected path form.
- Keep the existing stage order and fail closed when path transformation or tenant-salted hashing fails.
- Add positive and negative corpora, including `/workspace/project/file.ts`, `/etc/hosts`, `C:\\Users\\alice\\secret.txt`, `\\\\server\\share\\secret.txt`, home paths, URLs, and ordinary prose.

#### Where

- Target: `src/privacy/redact.ts` and, if useful, a focused path helper under `src/privacy/`.
- Tests: `test/redact.test.mjs`, `test/redaction.test.ts`, `test/content-capture-policy.test.mjs`.
- Source: `ObservMe-Production-Docs/06-security-privacy-redaction.md` §§3–7.

#### Acceptance criteria

- Redaction-enabled capture does not export any tested raw POSIX, Windows-drive, or UNC absolute path under `hash`, `basename`, or `drop` mode.
- `full` mode remains available only as the existing explicit configuration choice.
- Path hashing remains tenant-salted and deterministic.
- URL credentials and normal URLs continue through the intended secret/path stages without malformed replacement.
- Focused privacy tests and the existing redaction corpus pass.

### 2. Make project config bootstrap queue-safe and distribution-safe

- [x] Use Pi's exported config-directory constant and file-mutation queue for trusted project starter creation.

#### Why

Hardcoding `.pi` breaks rebranded Pi distributions, and direct `mkdir`/`writeFile` can race built-in or extension file mutations targeting the same project file.

#### How

- Import `CONFIG_DIR_NAME` instead of defining `".pi"` fallbacks in config modules.
- Resolve the final absolute `observme.yaml` target within the trusted project root before mutation.
- Wrap the complete existence-check/create/write window in `withFileMutationQueue(targetPath, ...)`, as documented by Pi; do not queue only the final write.
- Preserve idempotency: concurrent calls create at most one starter and never overwrite an existing file.
- Keep trust and path-containment checks outside or before any mutation.

#### Where

- Target: `src/config/bootstrap-project-config.ts`, `src/config/load-config.ts`, and `src/extension.ts` if registration arguments simplify.
- Tests: `test/project-config-bootstrap.test.mjs`, `test/config-loader.test.mjs`.
- Pi reference: installed `docs/extensions.md`, sections `ctx.cwd` and `withFileMutationQueue()`.

#### Acceptance criteria

- No source config module contains a hardcoded default `.pi` directory.
- Starter creation uses the resolved absolute target with `withFileMutationQueue()`.
- A concurrent `Promise.all` regression test proves one creation and no overwrite/lost update.
- Untrusted, traversal, absolute-override, and missing-`cwd` cases remain non-mutating.
- Existing bootstrap behavior across startup/reload/new/resume/fork remains green.

### 3. Bound all reviewed runtime collections

- [x] Bound per-run turn sequences and parent child-ID retention with deterministic eviction cleanup.

#### Why

`turnSequences` and retained `childIds` can grow for the life of a session despite bounded span/node registries, violating the no-unbounded-session-state requirement.

#### How

- Replace `turnSequences` with a configured `BoundedMap` or an equivalent bounded structure tied to `limits.maxActiveAgentRuns`; remove entries on normal agent completion as well as eviction.
- When an agent-tree node is evicted, detach its ID from its retained parent and remove stale references without decrementing historical fan-out counters incorrectly.
- Ensure parent snapshots expose only currently retained child IDs while historical aggregate counters stay meaningful.
- Emit the existing bounded telemetry-drop signal when state is evicted due to capacity.
- Add stress tests with far more runs/children than configured limits and with missing/out-of-order completion events.

#### Where

- Target: `src/pi/handlers.ts`, `src/pi/handler-internals.ts`, `src/pi/agent-tree-tracker.ts`, `src/util/bounded-map.ts` only if its callback contract needs a safe extension.
- Tests: `test/pi-handlers.test.mjs`, `test/agent-lineage.test.mjs`, `test/bounded-map.test.mjs`, `test/chaos-failure.test.mjs`.
- Source: `specs/spec-guidelines.md` and `ObservMe-Production-Docs/10-testing-release-operations.md` §8.

#### Acceptance criteria

- Runtime collection sizes remain at or below configured limits after stress workloads.
- Evicted child IDs are not returned by parent snapshots or `/obs agents` runtime state.
- Normal completion removes obsolete turn sequence entries.
- Eviction records one bounded drop signal per evicted state entry without high-cardinality labels.
- Existing fan-out, depth, width, orphan, and active-child tests remain correct.

### 4. Centralize every telemetry name in semantic-convention modules

- [x] Replace inline `pi.*`, `observme.*`, and `gen_ai.*` telemetry keys in reviewed source with typed constants from `src/semconv/`.

#### Why

Inline telemetry names can drift from the canonical semantic convention and are difficult to audit across handlers, lineage, subagent, and replay paths.

#### How

- Add any missing resource/span/log attribute constants to `src/semconv/attributes.ts` and missing event/metric names to their existing semantic modules.
- Replace duplicate local `sessionAttributeKeys` maps and cited inline keys in handlers, lineage, subagent, and backfill code.
- Do not turn ordinary bounded values such as `status="ok"` into attribute-name constants; centralize names, not every string value.
- Add a source contract test that rejects telemetry-key literals outside `src/semconv/`, with narrow documented exceptions only where technically unavoidable.

#### Where

- Target: `src/semconv/attributes.ts`, `src/semconv/metrics.ts`, `src/pi/handler-internals.ts`, `src/pi/handlers.ts`, `src/pi/agent-lineage.ts`, `src/pi/subagent-spawn.ts`, `src/commands/obs-backfill.ts`.
- Tests: `test/semconv-attributes.test.mjs`, `test/semconv-metrics.test.mjs`, `test/event-mapping.test.ts`.
- Source: `specs/spec-guidelines.md` Coding Conventions and `ObservMe-Production-Docs/04-telemetry-semantic-conventions.md`.

#### Acceptance criteria

- Reviewed source emits telemetry names only through `src/semconv/` constants.
- No duplicate session-attribute key map remains in handler modules.
- The semantic-convention inventory tests still cover every documented key and event.
- A regression test prevents new inline telemetry-name literals outside the semantic modules.

### 5. Replace hand-built config enums with `StringEnum`

- [x] Use `@earendil-works/pi-ai` `StringEnum` for TypeBox string-enum config fields.

#### Why

Pi documents `StringEnum` as the Google-compatible schema representation; hand-built `Type.Union(Type.Literal(...))` fields violate the repository convention.

#### How

- Replace environment and privacy path-mode literal unions with `StringEnum([... ] as const)`.
- Keep single-value protocol constraints as a literal unless they become a real multi-value enum.
- Confirm compiled TypeBox validation and inferred/exported TypeScript types remain equivalent.
- Add schema tests for each accepted enum value and representative rejected values.

#### Where

- Target: `src/config/schema.ts`.
- Tests: `test/config-defaults.test.mjs`, `test/config-validation.test.mjs`.
- Pi reference: installed `docs/extensions.md`, Available Imports and Tool Definition sections.

#### Acceptance criteria

- No multi-value config string enum uses a hand-built literal union.
- Every documented environment and path-mode value validates successfully.
- Unknown enum values fail structural validation and fall back safely.
- Typecheck and config contract tests pass without widening the runtime types.

### 6. Enforce bounded subagent reason enums

- [x] Normalize spawn and wait/join reasons to the exact documented low-cardinality enums before attributes or metric labels are built.

#### Why

Sanitizing arbitrary strings to 64 characters does not bound cardinality. Existing defaults such as `subagent` and `child_completion` are also outside the documented metric contract.

#### How

- Define typed constants/unions for spawn reasons (`delegated_task`, `parallel_search`, `review`, `tool_wrapper`, `unknown`) and wait reasons (`dependency`, `rate_limit`, `child_running`, `unknown`).
- Map any unknown runtime value to `unknown`; use `child_running` as the default only when the operation is actually waiting for an active child.
- Use the same normalized value for span attributes, logs, runtime hints, and metric labels.
- Keep public boundaries resilient to untyped JavaScript callers by validating at runtime even if TypeScript options become narrower.
- Add cardinality tests with hundreds of unique arbitrary inputs and assert the emitted set remains bounded.

#### Where

- Target: `src/pi/subagent-spawn.ts` and semantic value exports if added under `src/semconv/`.
- Tests: `test/subagent-spawn.test.mjs`, `test/cardinality.test.ts`, `test/metrics.test.ts`.
- Source: `ObservMe-Production-Docs/04-telemetry-semantic-conventions.md` §§5.1, 7.1, and 13.

#### Acceptance criteria

- Metric labels emit only documented spawn/wait reason values.
- Arbitrary public API input maps to `unknown` and cannot create a new series value.
- Existing spawn type, status, role, and depth labels remain bounded.
- Span/log reason attributes and metric labels do not disagree for the same operation.

### 7. Wire trusted child lineage and W3C parent context

- [x] Make a child ObservMe runtime consume a complete validated parent propagation envelope and continue the parent trace, with a documented fallback link when continuation is unavailable.

#### Why

The parent helper writes W3C and ObservMe environment values, but the production entrypoint does not trust/read them and the child `pi.session` span is always started as a new root without a parent or link.

#### How

- Define the trust boundary explicitly: only system/process environment supplied by an ObservMe-aware launcher is eligible; project `.env` values must not become lineage provenance.
- Treat a complete envelope (workflow, parent/root agent, depth, spawn, and valid `traceparent`; optional `tracestate`) as a propagated child candidate, validate all configured names/lengths/formats, and preserve explicit runtime overrides for tests/embedders.
- Keep malformed or partial envelopes fail-open: create root/orphan lineage as documented, emit sanitized orphan/propagation-failure telemetry, and never expose raw inherited env values.
- Extract or construct an OpenTelemetry parent `Context` through public OTEL APIs after the session trace provider starts.
- Start `pi.session` with the explicit parent context when valid. When lineage is trusted but W3C continuation is unavailable, start a new trace with a span link containing only validated parent trace/span metadata and emit the existing propagation-failure signal.
- Verify the parent process propagates a span context for the `pi.agent.spawn` span, not an unrelated ambient span.

#### Where

- Target: `src/extension.ts`, `src/pi/agent-lineage.ts`, `src/pi/handlers.ts`, `src/pi/handler-internals.ts`, `src/pi/subagent-spawn.ts`, and trace SDK helpers if needed.
- Tests: `test/agent-lineage.test.mjs`, `test/agent-lineage.test.ts`, `test/subagent-spawn.test.mjs`, `test/pi-handlers.test.mjs`, `test/otel-traces.test.mjs`, `test/chaos-failure.test.mjs`.
- Source: `ObservMe-Production-Docs/03-pi-event-and-session-model.md` §8 and `ObservMe-Production-Docs/07-extension-implementation-blueprint.md` Subagent Spawn.

#### Acceptance criteria

- An integration-style in-memory exporter test proves child `pi.session` shares the propagated trace ID and has the parent spawn span ID.
- A missing/invalid W3C context produces a new trace with a validated span link or fallback log and increments the propagation-failure counter once.
- A complete valid lineage envelope preserves workflow/root/parent/depth/spawn values in the child.
- Partial, malformed, oversized, project-local, or stale envelopes are rejected without raw env values in diagnostics.
- Root sessions without propagated context behave exactly as before.

### 8. Emit sanitized configuration rejection diagnostics

- [x] Surface every invalid/unsafe configuration fallback as a bounded, secret-safe runtime diagnostic.

#### Why

Falling back to defaults without a logger sink hides security-relevant state changes and makes `/obs status` the only place a user might discover rejection.

#### How

- Preserve validation issue codes through `loadSessionConfigWithDiagnostics` without retaining raw rejected values.
- After telemetry startup, emit one structured config-rejection event per load attempt (or one bounded summary event) with issue codes/count and config source, never secret-bearing messages or values.
- Add a semantic event-name constant if needed and document it in the canonical log event inventory.
- Notify through available Pi UI/status diagnostics when telemetry logs are disabled, while keeping headless modes non-throwing.
- Ensure the diagnostic path itself is safe-wrapped and cannot prevent session startup.

#### Where

- Target: `src/config/validate.ts`, `src/config/load-config.ts`, `src/pi/handlers.ts`, `src/semconv/metrics.ts`, and status diagnostics as needed.
- Tests: `test/config-validation.test.mjs`, `test/config-loader.test.mjs`, `test/pi-handlers.test.mjs`, `test/obs-status-command.test.mjs`.
- Docs: `ObservMe-Production-Docs/04-telemetry-semantic-conventions.md` log events if a new event is introduced.
- Source: `ObservMe-Production-Docs/06-security-privacy-redaction.md` §14.

#### Acceptance criteria

- Invalid structure, unsafe capture, insecure transport, forbidden labels, malformed lineage, and oversized queue rejection each produce a sanitized diagnostic.
- Diagnostics include bounded issue codes/source but no tokens, passwords, headers, paths, raw regexes, or rejected values.
- Missing UI or disabled log export never throws or blocks session startup.
- Safe valid configuration emits no rejection diagnostic.

### 9. Record all declared lifecycle and agent-tree metrics

- [x] Record the currently dormant error/duration/recovery instruments at their authoritative lifecycle transitions.

#### Why

Constructed but unused instruments make dashboards and SLOs look healthy or empty despite real failures and durations.

#### How

- Increment `agentRunErrors` when a completed agent run is classified failed.
- Record `workflowDurationMs` for root workflows at shutdown from the stored workflow start time, for both success and failure.
- Record `subagentSpawnDurationMs` from `SubagentSpawnState.startedAtMs` in both completion and failure paths.
- Increment `childAgentFailures` when an actual child reports failed status at join/completion; do not double-count a launcher failure that never created a child.
- Increment `parentRecoveredFromChildFailure` once when a child failed but `failurePropagated` is false and the parent continues/recoveries are confirmed by join completion.
- Define deduplication state so repeated completion/join calls cannot count the same child transition twice; keep it bounded.
- Use only the bounded labels documented for each metric and align them with dashboard queries.

#### Where

- Target: `src/pi/handlers.ts`, `src/pi/handler-internals.ts`, `src/pi/subagent-spawn.ts`.
- Tests: `test/pi-handlers.test.mjs`, `test/subagent-spawn.test.mjs`, `test/metrics.test.ts`, `test/cardinality.test.ts`, `test/dashboards.test.mjs`.
- Source: `ObservMe-Production-Docs/01-requirements-and-scope.md` §6.2, `ObservMe-Production-Docs/04-telemetry-semantic-conventions.md` §12, and `ObservMe-Production-Docs/02-reference-architecture.md` §5.

#### Acceptance criteria

- Every instrument named in this task has at least one production recording call and focused success/failure tests.
- Durations use injected/fake clocks in tests and reflect elapsed lifecycle time rather than handler execution time.
- Child failure and recovery counters are mutually understandable and not double-counted across spawn/join events.
- Metric labels pass the existing forbidden-cardinality inventory.
- Dashboard tests prove the repaired metrics match the queried names and grouping labels.

### 10. Measure real user-bash execution duration

- [x] Correlate `user_bash` pre-execution with its completed `bashExecution` record and omit duration when elapsed time cannot be derived safely.

#### Why

Starting and ending the bash span inside the completion handler records instrumentation latency near zero, not command execution latency.

#### How

- Start a bounded pending bash operation at `user_bash`, storing only safe metadata, start time, and span state; never retain/export the raw command unless existing capture policy explicitly allows redacted content.
- Complete the matching operation from `bashExecution`, using event timestamps when trustworthy or the stored monotonic/injected clock otherwise.
- Because Pi does not provide a durable user-bash call ID, define deterministic single-flight/queue behavior and emit a bounded drop/eviction signal for ambiguous overlap rather than attaching a result to the wrong command.
- For a completion without a pre-event, emit completion telemetry but record duration only if valid event timestamps provide it; do not synthesize near-zero duration.
- Close pending bash spans during session shutdown/eviction with the existing incomplete/evicted attributes.

#### Where

- Target: `src/pi/handlers.ts`, `src/pi/handler-internals.ts`, and span registry types.
- Tests: `test/pi-handlers.test.mjs`, `test/handler-internals.test.ts`, `test/event-mapping.test.ts`, `test/fixtures/bash-execution.json`.
- Pi reference: installed `docs/extensions.md` User Bash Events.
- Source: `ObservMe-Production-Docs/03-pi-event-and-session-model.md` bash mapping.

#### Acceptance criteria

- A fake-clock test with a 250 ms command records approximately 250 ms, not zero/handler time.
- Failed, cancelled, truncated, unmatched-completion, duplicate-pre-event, and shutdown-with-pending cases are covered.
- No raw command/output bypasses the shared content-capture policy.
- Pending bash state is explicitly bounded and cleaned up.
- Tool-driven bash telemetry remains distinct and is not double-counted as user bash.

### 11. Add required correlation to tool completion logs

- [x] Emit safe tool identity and common session/workflow/agent/turn/trace correlation on tool completion and failure logs.

#### Why

Current final logs contain only success/error fields, so Loki rows cannot identify the tool operation or connect it to its trace.

#### How

- Preserve safe tool identity/correlation in `ToolCallState` or rebuild it from existing state without reading raw arguments/results.
- Before ending the span, build completion log attributes containing event name/category plus session, workflow/root, agent/parent/root, agent run, turn, tool call/name/category, trace ID, span ID, success, and bounded error class where available.
- Reuse semantic constants and shared correlation builders; do not duplicate attribute literals.
- Keep high-cardinality IDs in logs/spans only, never metric labels.
- Ensure redacted optional content remains in its dedicated capture logs rather than being copied into operational completion logs.

#### Where

- Target: `src/pi/handlers.ts`, `src/pi/handler-internals.ts`, and tool state types.
- Tests: `test/pi-handlers.test.mjs`, `test/handler-internals.test.ts`, `test/event-mapping.test.ts`, `test/cardinality.test.ts`.
- Source: `ObservMe-Production-Docs/04-telemetry-semantic-conventions.md` §14.

#### Acceptance criteria

- Successful and failed tool completion logs contain every available common correlation attribute required by §14.
- Tool name/category and trace/span IDs are present and match the completed span.
- Operational logs contain no raw arguments, results, prompts, commands, paths, or raw error messages.
- Metric labels remain unchanged and low-cardinality.

### 12. Split event handlers by responsibility

- [x] Refactor the multi-domain handler module into focused event-family registration modules while preserving one public registration entrypoint.

#### Why

`src/pi/handlers.ts` changes for unrelated lifecycle, LLM, tool, bash, model, branch, and compaction behavior, increasing regression and merge-conflict risk.

#### How

- Keep `registerHandlers()` as the stable orchestration facade used by `src/extension.ts` and tests.
- Move registration and handler factories into focused, top-level modules for lifecycle, agent/turn, LLM, tool/bash, and session metadata/tree events.
- Keep shared session types/runtime constructors in a neutral module with one-way dependencies; do not create circular imports between handler families.
- Preserve the single serialized session lifecycle queue and shared safe-handler/observation wrapper.
- Avoid nested functions and avoid behavior changes during this task; rely on tests added in earlier tasks.

#### Where

- Target: `src/pi/handlers.ts`, `src/pi/handler-internals.ts`, and new `src/pi/event-handlers/*.ts` files.
- Tests: all handler, event-mapping, smoke-handler, lifecycle, and runtime tests.
- Source: `specs/spec-guidelines.md` Coding Conventions and `docs/STRUCTURE.md` module guidance.

#### Acceptance criteria

- `src/pi/handlers.ts` is a thin public facade/runtime composition module rather than the implementation home for every event family.
- Each event family has one focused registration function and no circular dependency.
- Existing public exports used by tests/consumers remain compatible or receive a documented migration.
- No telemetry snapshot, metric count, handler ordering, or fail-open behavior changes solely because of the move.
- No new nested functions are introduced.

### 13. Deduplicate OTLP signal endpoint handling

- [x] Extract one shared endpoint path helper used by trace, metric, and log exporters.

#### Why

`appendSignalPath` and trailing-slash removal are duplicated across three signal modules, making edge-case fixes prone to drift.

#### How

- Create a pure helper that resolves a base endpoint plus the signal path with the existing slash semantics.
- Keep signal-specific constants (`/v1/traces`, `/v1/metrics`, `/v1/logs`) in their owning modules or a clearly named shared contract.
- Preserve explicit signal endpoint precedence over the base endpoint.
- Test root URLs, nested base paths, repeated trailing slashes, explicit signal URLs, and invalid URLs according to current validation behavior.

#### Where

- New target: `src/otel/otlp-endpoint.ts`.
- Existing targets: `src/otel/traces.ts`, `src/otel/metrics.ts`, `src/otel/logs.ts`.
- Tests: `test/otel-traces.test.mjs`, `test/otel-metrics.test.mjs`, `test/otel-logs.test.mjs`.

#### Acceptance criteria

- Only one implementation performs signal-path joining/trailing-slash normalization.
- All three exporters retain their documented resolved URLs and explicit endpoint precedence.
- No exporter headers, timeout, batch, startup, or disabled-signal behavior changes.

### 14. Close documentation and validation

- [x] Reconcile documentation with the repaired behavior and run the complete validation matrix.

#### Why

The remediation is incomplete if documented gaps remain stale, new semantic events are undocumented, or only focused tests pass.

#### How

- Update `docs/agent-subagent-observability-requirements.md` production-wiring and metric-gap sections after tasks 7 and 9 are verified.
- Update canonical semantic/log documentation only for actual contract additions, such as a new config-rejection event.
- Update README/security/config docs only where user-visible behavior or trust boundaries changed; do not duplicate the production docs.
- Confirm every task has an `Unreleased` changelog entry and mark each completed checkbox only after its own criteria passed.
- Run static checks, complete tests, package checks, offline smoke tests, and coverage. Run Collector integration when Docker is available; record an explicit blocker instead of claiming success when unavailable.
- Review the final diff specifically for secrets, raw paths, raw environment values, high-cardinality metric labels, unbounded collections, and accidental source mentions prohibited by `AGENTS.md`.

#### Where

- Target: `CHANGELOG.md`, relevant docs listed above, and this spec's checkboxes.
- Validation: package scripts and focused source audits.

#### Acceptance criteria

- Every review finding in the coverage table has a completed task with focused regression tests.
- `npm run lint` passes.
- `npm test` passes.
- `npm run test:coverage` passes and writes the expected ignored artifacts.
- `npm run check:pack` passes without secrets, local state, or planning specs entering the package.
- `npm run smoke:handlers`, `npm run smoke:pi-lifecycle`, and `npm run smoke:pi-runtime` pass.
- `npm run validate` passes end to end.
- `npm run test:integration:collector` passes when Docker is available, or the exact environment blocker is recorded.
- Documentation and `CHANGELOG.md` describe the final trust, privacy, timing, and telemetry behavior accurately.

## Testing Strategy

Use layered tests so each risk is verified at the cheapest reliable level:

- **Pure unit tests:** path parsing/modes, bounded reason normalization, OTLP endpoint joining, and enum schema validation.
- **State/contract tests:** bounded maps/sets, eviction cleanup, config rejection diagnostics, metric recording, tool log attributes, and bash lifecycle correlation with injected clocks.
- **OpenTelemetry integration-style tests:** in-memory exporters verifying parent trace ID, parent span ID, fallback links, log correlation, and exact metric instruments/labels.
- **Pi handler tests:** startup trust boundaries, headless fail-open behavior, event ordering, duplicate/out-of-order events, and session shutdown cleanup.
- **Cardinality/privacy tests:** large arbitrary reason sets, raw POSIX/Windows/UNC paths, inherited env values, and forbidden IDs/content in metric labels.
- **Smoke/package tests:** real extension registration and lifecycle without requiring a live backend.
- **Optional Docker integration:** Collector acceptance and exported parent/child trace shape when local Docker prerequisites are available.

Important edge cases include malformed or partial propagation envelopes, disabled traces/logs, untrusted projects, missing UI, duplicate session starts, evicted parent/child nodes, repeated child completion, a child failure recovered by the parent, unmatched bash completion, and concurrent project starter creation.

## Acceptance Criteria

- All 15 findings in the review coverage table are resolved by production code and regression tests.
- Redaction-enabled capture cannot leak tested absolute filesystem paths outside explicit `pathMode: full`.
- No reviewed session/agent state or metric reason dimension is unbounded.
- Child sessions continue a valid propagated parent trace or emit the documented safe fallback.
- Every declared metric identified by the review is recorded at the correct lifecycle transition.
- Bash duration represents command execution when derivable and is omitted rather than fabricated otherwise.
- Tool completion logs carry safe common correlation and no raw sensitive content.
- Pi integration uses `CONFIG_DIR_NAME`, `StringEnum`, and `withFileMutationQueue()` according to installed documentation.
- Handler and OTLP helper refactors preserve public behavior and pass the full validation pipeline.
- Documentation and changelog accurately reflect the completed remediation.

## Validation Commands

Execute these commands as tasks are completed, then run the full set in task 14:

- `npm run typecheck` — validate strict source TypeScript.
- `npm run typecheck:test` — validate strict test TypeScript.
- `npm run lint:eslint` — validate repository lint rules.
- `npm run format:check` — validate formatting.
- `npm test` — run all unit, contract, cardinality, privacy, lifecycle, and performance tests.
- `npm run test:coverage` — generate Node coverage and Sonar-readable LCOV.
- `npm run check:pack` — validate package contents and secret exclusions.
- `npm run smoke:handlers` — validate packaged handler execution.
- `npm run smoke:pi-lifecycle` — validate offline Pi lifecycle integration.
- `npm run smoke:pi-runtime` — validate real Pi RPC registration and lifecycle behavior.
- `npm run test:integration:collector` — validate OTLP output when Docker is available.
- `npm run validate` — run the complete release validation pipeline.
- `rg -n '"(?:pi|observme|gen_ai)\.[a-z0-9_.-]+"' src --glob '!src/semconv/**'` — manually audit remaining inline telemetry-name literals and document any narrow exception.
- `rg -n 'new (Map|Set)\(' src/pi` — manually audit all Pi runtime collections for explicit bounds or lifecycle-bounded justification.

## Notes

- Do not add a durable local telemetry store to solve bounded-state or correlation problems.
- Do not trust project-local `.env` as proof that lineage came from an ObservMe parent process.
- Do not solve cardinality by hashing arbitrary reason strings; map them to documented bounded enums.
- Do not fabricate bash duration or parent/child trace relationships when source correlation is unavailable.
- High-cardinality IDs remain permitted on spans/logs for drill-down but forbidden from Prometheus labels.
- If a remediation changes telemetry naming incompatibly, apply the independent `observme.semconv.version` policy from `specs/spec-guidelines.md`; do not bump it for implementation-only fixes that preserve names.
- No new runtime dependency is expected. Use existing Pi and OpenTelemetry public APIs.
