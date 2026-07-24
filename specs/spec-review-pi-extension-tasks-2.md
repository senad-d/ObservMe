# Pi extension review tasks

## Review identity

- **Target:** `@senad-d/observme@0.1.6`
- **Review mode:** Comprehensive baseline
- **Current target:** `main` at `23e89cd7d3101dd4712ba687376ac011f4a84e97`, with 37 unstaged working-tree changes; the reviewed snapshot includes the dirty `src/config/bootstrap-project-config.ts` and related changed tests/docs.
- **Previous baseline:** N/A. An older review artifact exists, but this run was requested and executed as a new comprehensive baseline rather than a follow-up reconciliation.
- **Primary entry points:** `src/extension.ts`, `src/integration.ts`, `src/pi/handlers.ts`, and `src/commands/obs.ts`

## Vertical-slice coverage

| Slice or shared area | Entry point and execution path | Important scenarios/tests | Status | Notes |
| --- | --- | --- | --- | --- |
| Extension initialization and compatibility | `src/extension.ts` → capability preflight → handler registration → `/obs` registration | Missing Pi methods, partial registration, reload/rebind, packaged/runtime smoke | Reviewed | Includes the installed Pi 0.81.1 extension contract and closest examples. |
| Trusted configuration and project bootstrap | `session_start` → `bootstrap-project-config.ts` / `load-config.ts` → schema and semantic validation | Trust denied, precedence, malformed sources, symlink/ancestor races, repeated creation, environment overrides | Reviewed | Includes the dirty bootstrap implementation in the working-tree snapshot. |
| Session and OTEL lifecycle | `session_start` / `session_shutdown` → lifecycle queue → signal SDKs → bounded flush/shutdown | Disabled/startup failure, duplicate start, timeout, late settlement, retry, reload/new/resume/fork, cleanup | Reviewed | Real unresolved-exporter rebind and process-death races were not executed; exact paths were inspected. |
| Agent, turn, and LLM telemetry | Pi agent/turn/provider/message events → state registries → spans/metrics/logs | Zero/boundary indices, nested Pi result shapes, out-of-order completion, capture, active-state cleanup | Reviewed | Current installed Pi runtime event construction was inspected. |
| Tool and interactive Bash telemetry | Tool lifecycle and `user_bash` registrations → correlation/capture → final telemetry | Parallel tools, missing IDs, middleware mutation, cancellation, interactive `!`/`!!`, shutdown cleanup | Reviewed | The interactive completion path was traced through installed Pi runtime source. |
| Session metadata, branch, and compaction | model/thinking/session/tree/compaction events → attribute builders → telemetry | Missing fields, preparation state, branch navigation, compaction variants, sanitization | Reviewed | Focused fixtures and handler tests inspected. |
| Local `/obs` commands | `/obs` router → status/session/trace/link/agents runtime state → bounded notification | Missing UI, invalid/repeated arguments, disabled telemetry, reload state, output bounds | Reviewed | Root dispatch, usage, completions, and local-only contracts were compared. |
| Query-backed `/obs` commands | cost/tools/agents/errors/logs/trace → config readiness → Grafana transport → Prometheus/Loki/Tempo parsing → UI | Auth, timeout, malformed/oversized responses, disabled queries, empty data, partial enrichment | Reviewed | Collector/Grafana Docker-stack execution was deferred; transport and command tests passed. |
| Historical backfill | `/obs backfill` → parse/confirm/idle → session conversion → log exporter → flush/shutdown → summary | Invalid scope/window, no UI, cancellation, partial failure, redaction, rate limit, timestamp preservation | Reviewed | Production exporter and injected-exporter tests were compared end to end. |
| Public integration and subagent orchestration | `requestObservMeIntegration()` → event-bus API → spawn/wait/join state → propagation → runner example | Missing provider, invalid/duplicate IDs, environment validation, mismatch, timeout/cancel/failure, shutdown | Reviewed | Includes the packaged transport-neutral runner example and public integration documentation. |
| Privacy, safety, semantic conventions, and bounded state | Capture policy → redaction/hash/truncation; registries → eviction; semconv constants → exporters/dashboards | Missing salt, custom patterns, large input/output, secret/path handling, cardinality, eviction | Reviewed | Shared infrastructure was also included in the cross-slice pass. |

## Production-source classification

| Paths or bounded glob | Classification | Covered by | Notes |
| --- | --- | --- | --- |
| `src/extension.ts`, `src/constants.ts`, `src/diagnostics/sanitize.ts` | Shared infrastructure | Initialization, lifecycle, commands | Default export, status constants, and diagnostic boundary reviewed. |
| `src/integration.ts` | Reviewed | Public integration | Version negotiation and runtime API validation reviewed. |
| `src/commands/*.ts` | Reviewed | Local/query commands and backfill | Every command module and shared parser/render helper assigned to a command slice. |
| `src/config/*.ts` | Shared infrastructure | Bootstrap, configuration, privacy, queries, OTEL | Defaults, schema, validation, transport policy, paths, and query limits reviewed. |
| `src/otel/*.ts` | Shared infrastructure | Session lifecycle and backfill | Trace/metric/log construction, endpoint mapping, flush, shutdown, and retry reviewed. |
| `src/pi/event-handlers/*.ts` | Reviewed | Agent/turn/LLM/tool/Bash/session events | Every registered event family traced to state, telemetry, cleanup, and tests. |
| `src/pi/handlers.ts`, `src/pi/handler-runtime.ts`, `src/pi/handler-types.ts`, `src/pi/handler-internals.ts` | Shared infrastructure | All Pi event slices | Registration, shared types/state, observation, registries, and attribute extraction reviewed. |
| `src/pi/compatibility.ts`, `src/pi/active-agent-lease.ts`, `src/pi/session-correlation.ts` | Shared infrastructure | Initialization and lifecycle | Capability policy, lease ownership, and persisted correlation reviewed. |
| `src/pi/agent-lineage.ts`, `src/pi/agent-tree-tracker.ts`, `src/pi/integration-api.ts`, `src/pi/subagent-spawn.ts`, `src/pi/subagent-types.ts` | Reviewed | Public integration and subagents | Propagation, tree, state transitions, event-bus adapter, and bounds reviewed. |
| `src/privacy/*.ts` | Shared infrastructure | Capture and privacy | Hashing, redaction, pattern detection, and truncation reviewed. |
| `src/query/*.ts` | Reviewed | Query-backed commands | Grafana readiness/transport/URLs, all datasource clients, and trace links reviewed. |
| `src/safety/*.ts` | Shared infrastructure | Commands and queries | Sensitive-input and display-bound policies reviewed. |
| `src/semconv/*.ts` | Shared infrastructure | All telemetry slices | Attribute, span, metric, log-event, and bounded-enum contracts reviewed. |
| `src/util/*.ts` | Shared infrastructure | Lifecycle and subagent state | Bounded-map insertion, replacement, eviction, and consumers reviewed. |
| Generated/vendored production paths | N/A | Project map | No generated or vendored authored production paths exist under `src/`. Installed package source was used only to verify external contracts. |

## Cross-slice checks

| Concern | Status | Evidence or blocker |
| --- | --- | --- |
| Schema, type, parser, and runtime consistency | Reviewed | Found project-environment lineage drift, zero-index handling, integration environment gaps, and persisted-correlation inconsistency. |
| Error, empty, disabled, and partial-result semantics | Reviewed | Compared Prometheus/Loki/Tempo and every query command; findings cover malformed, disabled, and partial-enrichment drift. |
| Cancellation, timeout, retry, cleanup, and reload | Reviewed | Compared lifecycle, backfill, health, query transport, and runner behavior; findings cover ownership, retry, response disposal, and outcome collapse. |
| Shared mutable state and ownership | Reviewed | Traced handler-local session state, module runtime snapshots, bounded registries, listener ownership, and shutdown mutation windows. |
| Privacy and trust boundaries | Reviewed | Traced project files/environment, redaction errors, query inputs, credentials, transport, and rendered diagnostics to their sinks. |
| Duplicated rules and sibling variants | Reviewed | Grouped datasource JSON parsing, disabled-query behavior, independent query fan-out, and wait/join variants by correction path. |
| Dependency direction and architecture | Reviewed | Registration facades remain mostly thin; only concrete ownership/contract problems are promoted below. |
| Material performance and resource bounds | Reviewed | Found unbounded config reads, custom-redaction amplification, serial query latency, and unconsumed health bodies. |
| Test protection and published-package behavior | Reviewed | Unit/contract tests, package dry run, packaged install, offline lifecycle, and real Pi RPC smoke all passed; defect-specific gaps are named in tasks. |

## Commands and results

| Command | Result | Relevant evidence or blocker |
| --- | --- | --- |
| `npm run typecheck` | Passed | Production/example TypeScript compiled with `--noEmit`. |
| `npm run typecheck:test` | Passed | Test TypeScript compiled with `--noEmit`. |
| `npm run lint:eslint` | Passed | ESLint completed with zero warnings. |
| `npm run format:check` | Passed | 247 files passed the non-mutating format check. |
| `npm run check` | Passed | All declared Node script syntax checks passed. |
| `npm test` | Passed | 619 tests passed, including the synthetic performance workload. |
| `npm run check:pack` | Passed | Dry-run package contained 132 files with no forbidden/missing contents. |
| `npm run smoke:packaged` | Passed | Temporary tarball install exposed the declared extension, skill, integration export, and example. |
| `npm run smoke:handlers` | Passed | Registered `/obs` executed and produced visible output. |
| `npm run smoke:pi-lifecycle` | Passed | Offline `session_start`/`session_shutdown` completed and cleared status. |
| `npm run smoke:pi-runtime` | Passed | Real Pi RPC discovery, reload/new-session lifecycle, event shapes, health, and query timeout passed. |
| `npm audit --omit=dev --json` | Passed | 0 production vulnerabilities across 18 production dependencies. |
| Targeted query probe | Failed contract | A 200 Tempo `{status:"error"}` envelope returned zero traces; malformed Prometheus JSON propagated a harmless body marker into the error message. |
| Build | Not available | No build script exists; the package publishes TypeScript source and is covered by type checks plus packaged/runtime smoke. |

## Findings summary

| Severity | Count | Categories |
| --- | ---: | --- |
| Critical | 0 | — |
| High | 3 | Pi Integration (1), Correctness (2) |
| Medium | 15 | Correctness (6), Lifecycle (2), Validation (2), Async/State (2), Security (1), Performance (2) |
| Low | 8 | Correctness (1), Validation (2), Pi Integration (1), Security (2), Performance (1), Lifecycle (1) |

## Tasks

- [x] **REV-001 · High · Pi Integration — Add a real completion boundary for interactive user Bash**

  **Slice:** Tool and interactive Bash telemetry.

  **Evidence:** `src/pi/event-handlers/tool-bash.ts:210-250` starts a pending Bash span from `user_bash`, while `src/pi/event-handlers/llm.ts:88-101` can complete it only from a Bash-shaped `message_end`. Installed Pi 0.81.1 instead records `!`/`!!` results directly at `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:4972-4997` and `dist/core/agent-session.js:2222-2273` without emitting `message_end`.

  **Violated contract or scenario:** A normal interactive Bash command must end its span and emit completion metrics/logs from the actual result. Today every real `!`/`!!` command remains pending until shutdown, is marked incomplete, and loses its result, duration, output metadata, and normal completion signal.

  #### Why

  Interactive Bash is an advertised telemetry capability, but the production Pi event sequence cannot reach ObservMe's completion code. Synthetic tests invoke an event Pi does not emit and therefore conceal a complete feature failure.

  #### How to resolve

  - Establish a supported post-execution result boundary with Pi, or another integration that observes the actual recorded `BashExecutionMessage` without intercepting and blocking later `user_bash` handlers.
  - Keep pre-execution capture and final result correlation in one owned state transition.
  - Update compatibility checks/docs if completion requires a newer Pi capability; do not synthesize success when no result event exists.
  - Replace synthetic-only coverage with a real interactive or faithful runtime-harness path for normal, failed, cancelled, truncated, deferred-streaming, and extension-provided results.

  #### Acceptance criteria

  - A real `!` and `!!` command produces exactly one ended `pi.bash.execution` span and one matching completion metric/log with the actual outcome.
  - No pending Bash state or `bash_session_shutdown` drop remains after ordinary completion.
  - Multiple extensions can still participate according to Pi's first-result `user_bash` contract.
  - Focused handler/runtime tests and `npm run typecheck:test` pass.

- [x] **REV-002 · High · Correctness — Complete Pi's zero-based first turn**

  **Slice:** Agent and turn telemetry.

  **Evidence:** Installed Pi resets `_turnIndex` to `0` and emits it in `turn_start`/`turn_end` at `dist/core/agent-session.js:429-451`. `src/pi/event-handlers/agent-turn.ts:113-135` uses `if (!turnIndex)`, so index `0` is treated as missing even though `turn_start` created `agent-run-…-turn-000000`.

  **Violated contract or scenario:** Valid integer index `0` must identify the first turn. The current guard drops every first `turn_end`, leaving the span active and omitting completion count/log/duration until later cleanup.

  #### Why

  This affects every normal agent run, not a rare malformed input. The stale first-turn span can also remain the current parent for later telemetry.

  #### How to resolve

  - Distinguish `undefined` from numeric zero when resolving the turn index.
  - Keep generated turn IDs and sequence fallback consistent for both zero-based Pi events and legacy missing-index events.
  - Add current Pi fixtures beginning at zero and test first, later, missing, and out-of-order turn completion.

  #### Acceptance criteria

  - `turnIndex: 0` ends the corresponding span, clears current state, and records one completion with duration.
  - Missing indices still take the intended fallback/drop path without cross-correlating turns.
  - Regression tests use Pi's actual zero-based sequence and pass under `npm test`.

- [x] **REV-003 · High · Correctness — Preserve source timestamps in historical backfill export**

  **Slice:** Historical backfill.

  **Evidence:** `src/commands/obs-backfill.ts:1118-1128` stores each parsed entry timestamp, but `ObsBackfillLogExporter.emit()` at `:372-391` omits `record.timestamp`. OpenTelemetry's installed `LogRecord` contract supports `timestamp` at `node_modules/@opentelemetry/api-logs/build/esm/types/LogRecord.d.ts:28-43`.

  **Violated contract or scenario:** Replayed historical records must retain occurrence time. The production exporter currently assigns replay time, corrupting Loki chronology and the meaning of `--since` investigations.

  #### Why

  Timestamp preservation is fundamental to historical replay. Replay markers cannot recover original ordering after every record is stamped at export time.

  #### How to resolve

  - Pass each validated source timestamp to `logger.emit` and define the fallback for malformed/missing timestamps explicitly.
  - Test the production exporter, not only injected exporters.
  - Verify ordering through a focused in-memory log provider or collector contract.

  #### Acceptance criteria

  - Valid session-entry timestamps become OTEL log timestamps exactly once and remain ordered after replay.
  - Malformed timestamps follow a documented safe fallback without throwing or fabricating historical time.
  - Production-exporter regression tests and backfill command tests pass.

- [x] **REV-004 · Medium · Correctness — Derive terminal outcomes from actual Pi event payloads**

  **Slice:** Agent, turn, and session lifecycle telemetry.

  **Evidence:** `workflowFailed()` at `src/pi/handler-runtime.ts:390-392` reads only top-level `status`, `outcome`, `failed`, and `error`. Real `AgentEndEvent` supplies `messages`, `TurnEndEvent` supplies nested `message`/`toolResults`, and `SessionShutdownEvent` supplies only a reason, yet `agent-turn.ts:62-81,113-155` and `lifecycle.ts:564,834` use that helper for outcomes. Existing failure tests inject non-Pi top-level fields.

  **Violated contract or scenario:** A terminal span/log/metric must reflect the assistant/tool result Pi actually emitted. Provider errors in nested messages are currently reported as completed agent runs/turns, and shutdown cannot report a failed root workflow from its real payload.

  #### Why

  Error dashboards and workflow/agent failure counters under-report real failures while tests pass against shapes production Pi does not emit.

  #### How to resolve

  - Define outcome derivation separately for turn, agent, and workflow scopes using typed Pi payloads plus explicit session-owned failure state.
  - Mark successful terminal spans `OK`, failed ones `ERROR`, and preserve cancellation/unknown where Pi cannot prove success.
  - Replace synthetic status fields in tests with actual assistant/tool result messages and shutdown reasons.

  #### Acceptance criteria

  - Real assistant `stopReason: "error"` and failed tool results produce the intended turn, agent-run, and root-workflow failure signals without double counting.
  - Successful and cancelled/unknown paths remain distinguishable and set intentional span statuses.
  - Current Pi typed fixtures protect all three terminal scopes.

- [x] **REV-005 · Medium · Correctness — Reconcile telemetry with the final executed tool input**

  **Slice:** Tool telemetry.

  **Evidence:** Pi permits later `tool_call` handlers to mutate `event.input`, and the final input is available on `tool_result`. `src/pi/event-handlers/tool-bash.ts:144-158` records only result fields and never refreshes argument hash, size, labels, or captured arguments from final input.

  **Violated contract or scenario:** Telemetry must describe the arguments actually executed. If a later-loaded extension mutates input after ObservMe's `tool_call` handler, ObservMe exports stale pre-mutation data.

  #### Why

  Stale hashes and optional captured arguments make audit and debugging records disagree with the operation Pi ran.

  #### How to resolve

  - Recompute final argument-derived telemetry from `ToolResultEvent.input` before result finalization.
  - Preserve one capture/redaction policy and avoid duplicate counters/logs when start and final inputs are identical.
  - Add a chained-handler test where a later extension mutates input.

  #### Acceptance criteria

  - Final tool spans/log correlation reflect the exact post-middleware input that Pi executes.
  - Raw input remains absent unless its specific capture flag is enabled and redaction succeeds.
  - Parallel tool IDs remain isolated in regression tests.

- [x] **REV-006 · Medium · Lifecycle — Preserve unresolved OTEL operation ownership across runtime replacement**

  **Slice:** Session and OTEL lifecycle.

  **Evidence:** `registerHandlers()` creates fresh local state at `src/pi/handlers.ts:70-73`; unresolved shutdown is retained only in `state.pendingCleanup` at `lifecycle.ts:447-482`. Pi reload/new/resume/fork tears down and rebinds a new extension instance. In addition, timed-out flush settlements from `lifecycle.ts:547,576` are recorded but not retained as a startup gate, unlike shutdown settlement.

  **Violated contract or scenario:** No new provider set may start while a prior session's flush/shutdown still owns live exporter work. After a timeout and Pi rebind, the new instance cannot see the old pending state and can overlap new providers with unresolved timers, sockets, or promises.

  #### Why

  Existing tests reuse one handler closure and therefore validate only duplicate starts inside one extension instance, not Pi's documented replacement lifecycle.

  #### How to resolve

  - Introduce explicit process-scoped cleanup ownership that survives extension factory re-execution without exposing telemetry state as an uncontrolled global service locator.
  - Track late settlement for both flush and shutdown and define when replacement startup may proceed or require restart.
  - Test two independently registered extension instances around a timed-out and never-settling exporter.

  #### Acceptance criteria

  - A new extension instance cannot start OTEL providers while old flush/shutdown work remains unresolved.
  - Late success releases the gate; late rejection remains visible and retryable; never-settling work stays bounded and produces one diagnostic.
  - Reload/new/resume/fork tests model actual re-registration rather than repeated events on one closure.

- [x] **REV-007 · Medium · Lifecycle — Keep failed signal shutdowns genuinely retryable**

  **Slice:** OTEL shared infrastructure.

  **Evidence:** Each signal SDK clears provider/processor/exporter references and sets `shutdown` in `finally` (`src/otel/logs.ts:115-128`, `metrics.ts:117-130`, `traces.ts:124-137`). The composite consumes its SDK list and also sets `shutdown` in `finally` at `src/pi/handler-runtime.ts:698-733`, even when one shutdown rejects. The controller intentionally leaves `shutdown_failed` retryable.

  **Violated contract or scenario:** A retry after cleanup failure must retry the resource that failed. Current retry calls a terminal no-op composite and can report success while leaked resources remain.

  #### Why

  Controller state promises retryable cleanup, but production signal/composite ownership silently invalidates that promise.

  #### How to resolve

  - Retain ownership and non-terminal state for signal SDKs whose shutdown did not complete.
  - Make composite shutdown remember per-signal settlements and retry only unresolved signals while preserving all-settled behavior.
  - Add production-composite tests where one provider rejects once, then succeeds.

  #### Acceptance criteria

  - A failed signal remains owned and is invoked again on retry.
  - Successfully closed siblings are not duplicated, and final controller success is possible only after every signal is closed.
  - Failure, timeout, late settlement, and repeated shutdown tests pass.

- [x] **REV-008 · Medium · Correctness — Report backfill delivery only after flush establishes the outcome**

  **Slice:** Historical backfill.

  **Evidence:** `src/commands/obs-backfill.ts:627-633` increments `recordsExported` after `logger.emit`, although the production emitter only queues records and flush happens afterward. UI at `:244-259,1254-1261` labels those counts as exported even when flush fails.

  **Violated contract or scenario:** Queued/attempted records must not be represented as confirmed exports after a failed flush. Users need safe retry guidance without false certainty about loss or duplication.

  #### Why

  Current summaries can claim all records exported and none skipped after the only delivery boundary fails.

  #### How to resolve

  - Model attempted/queued, confirmed, unknown, and not-attempted outcomes explicitly.
  - Translate flush and shutdown failures into a partial/unknown summary rather than definitive success counts.
  - Update rendering and injected/production exporter tests.

  #### Acceptance criteria

  - Flush success reports confirmed exports; flush failure never labels queued records as definitely exported.
  - Cancellation and per-record emit failure preserve exact attempted/not-attempted counts and actionable retry semantics.
  - Existing rate-limit and redaction counts remain correct.

- [x] **REV-009 · Medium · Validation — Normalize malformed datasource responses without leaking body fragments**

  **Slice:** Query-backed commands and Grafana adapters.

  **Evidence:** `src/query/tempo.ts:267-285` converts every non-array/non-`{traces:[]}` JSON shape and every invalid item into an empty result, unlike strict Prometheus/Loki parsers. All three adapters call raw `Response.json()` (`tempo.ts:267`, `prometheus.ts:202`, `loki.ts:214`); the targeted probe showed a harmless malformed-body marker is included in the thrown parser message and survives command sanitization.

  **Violated contract or scenario:** Backend/schema/parser failure must remain distinct from legitimate empty data, and untrusted response bodies must not reach user-facing diagnostics.

  #### Why

  A proxy error such as `{status:"error"}` can become “no trace found,” while malformed text can disclose arbitrary backend fragments in TUI/RPC output.

  #### How to resolve

  - Add one bounded safe JSON-reading boundary that maps syntax failures to fixed body-free diagnostics.
  - Make Tempo require a supported envelope and valid trace items, matching Prometheus/Loki schema-failure semantics.
  - Preserve legitimate empty arrays/streams as empty success.

  #### Acceptance criteria

  - Malformed JSON, error envelopes, unsupported shapes, and invalid items fail with fixed subsystem/schema errors containing no response fragment.
  - Legitimate empty Tempo, Loki, and Prometheus responses remain successful empty results.
  - Command tests distinguish backend failure from no-data guidance for every datasource.

- [x] **REV-010 · Medium · Correctness — Preserve `/obs agents` local state when enrichment fails**

  **Slice:** `/obs agents`.

  **Evidence:** `src/commands/obs-agents.ts:177-187` obtains the local runtime snapshot first, then requires all Prometheus/Tempo enrichment to succeed. `handleObsAgentsCommand()` at `:152-173` renders only an error on any enrichment failure, despite the documented command contract being local state plus optional drill-downs.

  **Violated contract or scenario:** Local workflow, child, fan-out, orphan, and wait/join state must remain available when Grafana is unconfigured, unauthorized, malformed, or temporarily down.

  #### Why

  The most immediately useful in-process diagnostics disappear precisely during backend outages.

  #### How to resolve

  - Return/render the local snapshot independently from enrichment outcomes.
  - Represent Prometheus and Tempo enrichment as bounded partial sections with sanitized warnings.
  - Test disabled, not-ready, timeout, one-backend failure, and total-backend failure paths.

  #### Acceptance criteria

  - `/obs agents` always renders available local state even when every backend request fails.
  - Partial enrichment identifies the unavailable subsystem without converting the entire command to an error.
  - Successful enrichment output and display bounds remain unchanged.

- [x] **REV-011 · Medium · Correctness — Distinguish disabled query integration from empty backend data**

  **Slice:** Query-backed `/obs` commands.

  **Evidence:** Prometheus, Loki, and Tempo return empty success when `query.enabled=false` at `src/query/prometheus.ts:125`, `loki.ts:72`, and `tempo.ts:139`. Cost/tools/errors/logs/trace render those empties as “no metrics/logs/trace” with generation or datasource repair guidance (`obs-cost.ts:127`, `obs-tools.ts:140-148`, `obs-errors.ts:117`, `obs-logs.ts:126`, `obs-trace.ts:266`). `grafana-readiness.ts:27-49` already models `disabled` explicitly.

  **Violated contract or scenario:** An intentionally disabled adapter state must not be collapsed into a successful request with no data.

  #### Why

  Current guidance sends users toward generating telemetry or repairing datasources when the actual cause is a local configuration switch.

  #### How to resolve

  - Propagate a discriminated disabled result or preflight readiness at the command boundary.
  - Apply one consistent disabled message and next action across all query-backed commands.
  - Keep local trace/link and `/obs agents` state available where no backend is required.

  #### Acceptance criteria

  - Every affected command explicitly reports `query.enabled=false` and performs no network call.
  - Legitimate backend empty results retain their existing no-data guidance.
  - Status, health, command, and adapter tests agree on the same disabled semantics.

- [x] **REV-012 · Medium · Async/State — Fence integration mutations before session cleanup begins**

  **Slice:** Public integration and session shutdown.

  **Evidence:** `src/pi/event-handlers/lifecycle.ts:564-582` ends active spans, then awaits UI clearing, flush, and shutdown while `state.session` remains present until `:618`. The integration listener is removed only by a later `session_shutdown` handler registered at `src/pi/handlers.ts:86-93`. A cached API can therefore start new spawn/wait/join work after `endAllActiveSpans()` and before shutdown finishes.

  **Violated contract or scenario:** Once session shutdown starts, no new session-backed mutation may succeed, and active orchestration must receive an explicit interrupted/cancelled outcome rather than silent span truncation.

  #### Why

  The race can return success for telemetry created after cleanup already ran, leaving new state unclosed while the SDK is shutting down.

  #### How to resolve

  - Add a closing phase visible to all integration methods before active state is drained.
  - Reject new calls deterministically during closing and terminalize existing spawn/wait/join operations with explicit incomplete/cancelled semantics plus runtime-hint cleanup.
  - Unsubscribe early enough to close the event-bus entry path while allowing owned completions to finish intentionally.

  #### Acceptance criteria

  - Calls racing after shutdown begins return a documented failure and create no span/tree/hint mutation.
  - Active operations are closed exactly once with explicit terminal/incomplete telemetry.
  - A deterministic overlap test pauses flush and exercises a cached API throughout the shutdown window.

- [x] **REV-013 · Medium · Async/State — Bind wait/join handles to their original targets and clean evicted hints**

  **Slice:** Parent/subagent wait and join lifecycle.

  **Evidence:** `AgentWaitJoinState` stores only span/time/labels/reason at `src/pi/subagent-types.ts:19-24`. Start records caller target fields only in telemetry (`subagent-spawn.ts:480-500`), while end rebuilds completion from new caller options (`:503-552`) and wait skips target validation. Bounded eviction ends the span but `evictWaitJoinState()` at `handler-internals.ts:975-977` does not deactivate the module-level `/obs agents` hint.

  **Violated contract or scenario:** A handle must remain bound to the spawn/child it started for, and registry/hint/tree state must agree after completion or eviction.

  #### Why

  A wait can start for child A and complete successfully as child B; low registry limits can also leave evicted operations displayed as active.

  #### How to resolve

  - Persist handle ID, kind, spawn ID, child ID, and relevant starting state in `AgentWaitJoinState`.
  - Validate end options against stored identity for both waits and joins, and use stored fields when options are omitted.
  - Synchronize child `starting`→`active` state and deactivate/update hints on completion, failure, eviction, and shutdown.

  #### Acceptance criteria

  - Mismatched end targets fail without mutating spans, tree state, metrics, or hints.
  - Eviction and shutdown leave no impossible active hints.
  - Matching wait/join flows preserve one coherent identity across spans, logs, tree state, and `/obs agents`.

- [x] **REV-014 · Medium · Correctness — Preserve timeout, cancellation, child failure, and transport failure distinctions in runners**

  **Slice:** Subagent runner adapters.

  **Evidence:** `runSubagentWithObservability()` at `src/pi/subagent-spawn.ts:214-241` maps every runner rejection to launcher/child failure. The packaged example's `waitForResult()` at `examples/integrations/subagent-runner.ts:81-101` maps every thrown wait error to failed wait/child/join, and `childStatus()` at `:251-255` maps a returned timeout to failed child status.

  **Violated contract or scenario:** A wait timeout does not prove a still-running child failed; abort and transport-read failure are also distinct from child execution failure.

  #### Why

  False terminal failure inflates metrics and prevents a later truthful completion of a child that remains active.

  #### How to resolve

  - Define a shared outcome classifier for launcher failure, wait timeout, caller cancellation, transport failure, and terminal child results.
  - Do not call `completeSubagent(...failed)` on timeout unless the transport confirms termination; keep or explicitly cancel the active handle according to transport ownership.
  - Add success, returned timeout/cancel, thrown abort, thrown transport error, and later-completion tests to both core and example adapters.

  #### Acceptance criteria

  - Each outcome produces the documented child and join state without irreversible false failure.
  - A timed-out but running child can later complete exactly once.
  - Example and core helper tests agree on the same classification rules.

- [x] **REV-015 · Medium · Validation — Exclude trusted project `.env` lineage values from config validation**

  **Slice:** Trusted configuration and parent-lineage boundary.

  **Evidence:** `src/config/load-config.ts:137-171` passes the merged project `.env` plus process environment as `env` to validation. `src/config/validate.ts:408-444` validates lineage values in that merged object, while lifecycle lineage construction intentionally uses only the Pi process environment. Documentation states project `.env` is configuration-only and cannot establish parent lineage.

  **Violated contract or scenario:** Data that is forbidden from reaching lineage must not reject an otherwise valid config as malformed lineage. A malformed lineage-looking key in trusted project `.env` currently triggers fallback defaults even though startup will not consume it as provenance.

  #### Why

  This creates surprising configuration loss and contradicts the documented trust boundary.

  #### How to resolve

  - Separate the environment used for ObservMe overrides/hash salt from the process-provenance environment used for lineage validation.
  - Keep configured lineage variable-name validation independent of runtime values.
  - Add malformed project-only lineage values alongside valid/malformed process propagation tests.

  #### Acceptance criteria

  - Project `.env` lineage-looking values neither establish lineage nor cause `malformed_lineage_value` fallback.
  - The same malformed values in the trusted Pi process propagation envelope still fail open and emit bounded diagnostics.
  - Precedence and tenant-salt behavior remain intact.

- [x] **REV-016 · Medium · Security — Sanitize config-derived redaction failure reasons before export**

  **Slice:** Privacy and self-observability.

  **Evidence:** `privacy.tenantSaltEnv` accepts any non-empty string at `src/config/schema.ts:337`. `src/privacy/hash.ts:84-88` interpolates that value into missing-salt errors, and `src/pi/handler-internals.ts:729-738` places the raw first error into `redaction.failed` reason attributes without diagnostic sanitization.

  **Violated contract or scenario:** Config-derived text must not be exported as an operational error reason unless it is constrained and sanitized. A sensitive value mistakenly placed in `tenantSaltEnv` can be emitted verbatim when capture fails.

  #### Why

  A fail-closed content path can still leak the configuration value through its health telemetry.

  #### How to resolve

  - Constrain `tenantSaltEnv` to a bounded environment-variable name grammar.
  - Replace dynamic missing-salt messages with a fixed error class/reason, or sanitize before self-observability export.
  - Search all redaction-error variants for dynamic values and apply the same fixed contract.

  #### Acceptance criteria

  - Invalid environment names are rejected without echoing their values.
  - Missing-salt telemetry contains only bounded fixed codes/classes and no configured name or captured content.
  - Focused live capture and backfill redaction-failure tests prove the sink is secret-free.

- [x] **REV-017 · Medium · Performance — Bound custom-redaction replacement work and amplification**

  **Slice:** Privacy/redaction shared infrastructure.

  **Evidence:** Patterns/counts are bounded, but names are not (`src/config/schema.ts:206-210,339`). `src/privacy/redact.ts:232-239,426-432` applies every global match and hashes each replacement before output truncation. A safe broad pattern such as `.` can create up to one million replacements; a long name amplifies each replacement further.

  **Violated contract or scenario:** Trusted customization must have bounded match count, CPU work, replacement size, and intermediate allocation before truncation.

  #### Why

  A syntactically safe configuration can still stall or exhaust the Pi process when opt-in capture handles a large value.

  #### How to resolve

  - Bound normalized pattern-name length and total replacement/match work.
  - Stop or fail closed before constructing output beyond the configured budget.
  - Preserve deterministic truncation metadata without hashing unbounded matches.

  #### Acceptance criteria

  - Worst-case broad-pattern input stays within an explicit time/memory/match budget.
  - Exceeding the budget drops content with one bounded redaction failure and no partial raw export.
  - Boundary tests cover maximum input, names, pattern count, match count, and replacement output.

- [x] **REV-018 · Medium · Performance — Bound configuration and environment-file reads before allocation**

  **Slice:** Configuration filesystem boundary.

  **Evidence:** Canonical project files are fully loaded by `FileHandle.readFile()` at `src/config/project-paths.ts:55-73`; global config uses unbounded `readFile()` at `src/config/load-config.ts:478-480`. No byte-size guard precedes parsing project/global YAML or trusted `.env`.

  **Violated contract or scenario:** Startup input files must have a finite supported size and be rejected before allocating their complete contents.

  #### Why

  An accidental or sparse oversized file can block repeated `session_start` or exhaust memory before validation has a chance to fail safely.

  #### How to resolve

  - Define documented byte limits for global/project config and project `.env`.
  - Check the opened file's stable `fstat` size before reading; keep existing symlink/identity protections.
  - Map oversize files to bounded source diagnostics without file paths or content.

  #### Acceptance criteria

  - Exact-limit files load; over-limit and sparse files are rejected before full read/allocation.
  - Project trust, path containment, precedence, and missing/unreadable classifications remain correct.
  - Focused filesystem tests cover global, project config, and `.env` limits.

- [x] **REV-019 · Low · Correctness — Stop emitting a fabricated zero image count for turns**

  **Slice:** Turn telemetry.

  **Evidence:** `src/pi/handler-internals.ts:305-324` sets `pi.turn.user_message.image_count` to `0` when `turn_start` lacks `imageCount`. Real Pi exposes images on `before_agent_start`, while `TurnStartEvent` includes only index and timestamp.

  **Violated contract or scenario:** Unknown image count must not be represented as known zero.

  #### Why

  Image-bearing prompts are silently misclassified, producing false analytics.

  #### How to resolve

  - Capture image count from the appropriate preceding event in session-owned state, or omit the attribute when unavailable.
  - Clear/correlate the value across repeated/queued agent runs.

  #### Acceptance criteria

  - Text-only and image-bearing prompts report accurate counts when known.
  - Missing source data omits the attribute instead of writing zero.
  - Tests cover repeated turns and no stale carry-over.

- [x] **REV-020 · Low · Validation — Reject recovered child lineage that identifies itself as root**

  **Slice:** Persisted session correlation.

  **Evidence:** `src/pi/session-correlation.ts:135-142` requires a distinct parent at depth greater than zero but does not require `rootAgentId !== agentId`. `{agentId:"child", parentAgentId:"parent", rootAgentId:"child", depth:1}` is accepted.

  **Violated contract or scenario:** A non-root child cannot also be the workflow root when it has a different parent.

  #### Why

  Corrupt branch-local state can be restored as valid topology and propagate inconsistent root attributes.

  #### How to resolve

  - Add relational invariants for root, parent, agent, and depth combinations to correlation normalization.
  - Keep malformed persisted data ignored/fail-open without echoing values.

  #### Acceptance criteria

  - Root and valid child tuples are accepted; self-rooted children and other contradictory tuples are rejected.
  - Reload/resume/fork correlation tests cover every invariant.

- [x] **REV-021 · Low · Validation — Reject child environments that Node cannot spawn**

  **Slice:** Public integration environment boundary.

  **Evidence:** `src/pi/integration-api.ts:322-330` validates only entry count, non-empty keys, and string/undefined values. Node child-process environments reject embedded NUL characters, so `startSubagent()` can return success and mutate telemetry with an environment guaranteed to fail at the documented launch sink.

  **Violated contract or scenario:** A successful integration response must provide an environment usable unchanged by Node-compatible child launchers.

  #### Why

  Validation currently occurs after the API promises runtime-safe propagation but before the actual spawn boundary, turning invalid input into misleading success telemetry.

  #### How to resolve

  - Reject NUL-containing keys/values and enforce platform-safe bounded key rules where required.
  - Validate before creating any span/tree/metric state.

  #### Acceptance criteria

  - Invalid environment entries return `invalid_request` with zero mutation.
  - The accepted boundary round-trips through a representative `child_process` launch on supported platforms.
  - Existing stale-lineage sanitization remains intact.

- [x] **REV-022 · Low · Pi Integration — Roll back the integration listener when handler registration fails**

  **Slice:** Extension initialization and integration registration.

  **Evidence:** `src/pi/handlers.ts:86-87` installs the shared event-bus listener before `registrar.commit()`. If a later `pi.on` registration throws, no catch unsubscribes it. `src/integration.ts:149-159` accepts the first valid response, so a stale listener can win future discovery.

  **Violated contract or scenario:** Partial initialization must not leave a callable integration provider after handler registration failed.

  #### Why

  Pi can continue after extension load errors; a stale provider can answer `session_unavailable` ahead of a later valid instance until process restart.

  #### How to resolve

  - Treat listener installation and handler commit as one rollback-aware registration transaction.
  - Unsubscribe on every commit failure and preserve the original initialization error.

  #### Acceptance criteria

  - Injected failure at each handler registration point leaves no integration listener.
  - Successful initialization leaves exactly one listener and shutdown removes it once.

- [x] **REV-023 · Low · Security — Retain only the project environment values ObservMe needs**

  **Slice:** Configuration and tenant-salt ownership.

  **Evidence:** `src/config/load-config.ts:137-171` builds an effective environment containing the entire trusted project `.env`, and `src/privacy/hash.ts:22-33` retains that object in a WeakMap for the config lifetime even though only ObservMe overrides and the selected salt are needed.

  **Violated contract or scenario:** Unrelated project credentials should not gain extension-long retention merely because they share a `.env` file.

  #### Why

  This unnecessarily broadens plaintext lifetime and heap-dump exposure for application secrets unrelated to telemetry.

  #### How to resolve

  - Filter project `.env` to supported ObservMe keys plus the configured salt key before long-lived registration.
  - Avoid retaining unrelated process/project environment entries in config-associated state.

  #### Acceptance criteria

  - Supported overrides and custom salt names still work.
  - The retained representation contains no unrelated project keys or values.
  - Precedence and hashing tests cover the filtered environment.

- [x] **REV-024 · Low · Security — Prevent out-of-root creation before containment is proven**

  **Slice:** Project config bootstrap filesystem boundary.

  **Evidence:** `src/config/project-paths.ts:80-107,194-203` opens the final path after canonical checks, but an ancestor can be swapped to an outside symlink before open. Post-open containment catches the race only after an empty outside file may exist; cleanup at `:276-286` is best-effort and swallows unlink failure.

  **Violated contract or scenario:** Bootstrap must never create an artifact outside the trusted project root, including on process interruption or cleanup failure.

  #### Why

  Existing race tests prove successful cleanup, not that creation itself stays contained.

  #### How to resolve

  - Use an operation anchored to verified directory handles/no-follow semantics, or another design that cannot traverse a swapped ancestor before creation.
  - Surface cleanup failure safely if a platform fallback cannot provide the invariant.

  #### Acceptance criteria

  - Ancestor-swap tests cannot observe any outside inode, including with injected cleanup failure/interruption.
  - In-root symlinks, exclusive no-overwrite behavior, and cross-platform supported paths continue to work.

- [x] **REV-025 · Low · Performance — Bound independent query fan-out by total command latency**

  **Slice:** `/obs tools` and `/obs agents` query enrichment.

  **Evidence:** `/obs tools` awaits two independent Prometheus calls serially at `src/commands/obs-tools.ts:183-188`; `/obs agents` awaits three at `src/commands/obs-agents.ts:246-255`. Each request can consume the full configured timeout, so one command can take roughly two or three timeout windows.

  **Violated contract or scenario:** Independent bounded queries should complete within an intentional total command budget rather than multiplying per-request latency silently.

  #### Why

  At the default five-second request timeout, successful slow responses can make commands take around 10–15 seconds.

  #### How to resolve

  - Run independent queries with bounded concurrency, or enforce/document a total deadline and explicit load policy.
  - Preserve cancellation and identify partial subsystem results where applicable.

  #### Acceptance criteria

  - Delayed-query tests prove total latency stays within the chosen command budget rather than the sum of request budgets.
  - Result ordering, limits, and partial-error semantics remain deterministic.

- [x] **REV-026 · Low · Lifecycle — Consume or cancel Collector health response bodies**

  **Slice:** `/obs health` network lifecycle.

  **Evidence:** `src/commands/obs-health.ts:161-200,220-232` clears the timeout after receiving headers and inspects only status; it neither consumes nor cancels the Collector response body.

  **Violated contract or scenario:** Every network response must release its stream/socket on success, failure, and timeout.

  #### Why

  A server that sends headers then stalls its body can be reported reachable while repeated health checks retain response resources.

  #### How to resolve

  - Cancel the body immediately when status-only reachability is sufficient, or consume it under the same bounded timeout/size policy.
  - Keep injected and native fetch behavior consistent.

  #### Acceptance criteria

  - Success, failure, stalled-body, and abort tests observe body cancellation/closure exactly once.
  - Repeated health checks do not retain open response resources and still render the same bounded status.

## Blocked or deferred coverage

- `npm run test:coverage` — not run because it intentionally writes generated `coverage/` artifacts and would repeat the already completed broad test suite. Coverage-related source/test mapping was inspected without creating reports.
- `npm run test:integration:collector`, `npm run test:integration:grafana-stack`, and `npm run validate:grafana-obs` — deferred because they require Docker/local observability services and environment-specific endpoints; unit/transport and credential-free runtime smoke were used instead.
- Manual TUI `!`/`!!` execution — not run in the non-interactive review harness. The installed Pi implementation and event types provided direct evidence for REV-001; correction still requires a real interactive regression.
- Never-settling real OTEL exporter across two Pi extension instances — not executed to avoid leaked background work. Source ownership and one-instance timeout tests support REV-006; the two-instance scenario is required by its acceptance criteria.
- Process-death filesystem race — not executed because deterministic interruption can leave external artifacts. Existing race hooks and exact open/check/cleanup order support REV-024; use an isolated test sandbox for remediation validation.
