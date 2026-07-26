# Agent and Subagent Orchestration Observability Requirements

## Purpose

This document explains what ObservMe and a future Pi agent-orchestration extension need in order to run, manage, and observe root agents and subagents correctly.

The target runtime model is explicit: subagents are isolated Pi processes, often started inside dedicated `tmux` sessions, and every child/subagent Pi process is expected to load the ObservMe extension too. Tmux isolation is compatible with ObservMe, but tmux does not create lineage by itself. The orchestration extension must launch tmux with ObservMe lineage and trace-context environment variables, then record spawn, wait, join, status, and cleanup telemetry.

It is documentation-only. It does not change runtime behavior.

## Sources reviewed

Project sources:

- `README.md`
- `docs/extension-integration.md`
- `docs/reference/01-requirements-and-scope.md`
- `docs/reference/02-reference-architecture.md`
- `docs/reference/03-pi-event-and-session-model.md`
- `docs/reference/04-telemetry-semantic-conventions.md`
- `docs/reference/06-security-privacy-redaction.md`
- `docs/reference/07-extension-implementation-blueprint.md`
- `docs/reference/09-dashboards-alerts-slos.md`
- `docs/reference/10-testing-release-operations.md`
- `docs/reference/12-configuration-reference.md`
- `src/integration.ts`
- `src/pi/agent-lineage.ts`
- `src/pi/agent-tree-tracker.ts`
- `src/pi/integration-api.ts`
- `src/pi/subagent-spawn.ts`
- `src/pi/handlers.ts`
- `src/pi/handler-internals.ts`
- `src/commands/obs-agents.ts`
- `src/commands/obs-agents-runtime.ts`
- `src/config/defaults.ts`
- `src/config/schema.ts`
- `src/config/validate.ts`
- `src/semconv/attributes.ts`
- `src/semconv/metrics.ts`
- `dashboards/observme-agents.json`
- `dashboards/observme-overview.json`
- `dashboards/observme-trace-journey.json`
- `dashboards/observme-alerts.yaml`
- `dashboards/observme-slos.yaml`
- `examples/observme.yaml`
- `examples/collector.yaml`
- `examples/integrations/subagent-runner.ts`
- `test/agent-lineage.test.ts`
- `test/subagent-spawn.test.mjs`

Pi documentation and examples:

- Pi `README.md`
- Pi `docs/extensions.md`
- Pi `docs/session-format.md`
- Pi `docs/sessions.md`
- Pi `docs/packages.md`
- Pi `examples/extensions/subagent/README.md`
- Pi `examples/extensions/subagent/index.ts`
- Pi `examples/extensions/subagent/agents.ts`

## Target outcome for the orchestration extension

The future orchestration extension should provide the complete control plane for agent and subagent work:

- discover and validate agent definitions
- start root-like managed agents and child subagents
- launch isolated subagent Pi processes inside tmux sessions
- ensure every child Pi process loads ObservMe
- propagate ObservMe workflow, parent/root agent lineage, spawn id, session id, and W3C trace context into the child process
- distinguish root agents, subagents, and orphan agents deterministically
- list, inspect, attach to, detach from, stop, and clean up tmux-backed agents
- send tasks or follow-up messages to running child agents when the selected execution mode supports it
- record spawn, wait, join, cancellation, timeout, child failure, and recovery telemetry
- keep high-cardinality identifiers out of Prometheus metric labels
- expose enough local state for `/obs agents` and enough exported telemetry for Grafana dashboards

Current state: ObservMe already has lineage, agent-tree, spawn, wait/join, dashboard, and `/obs agents` building blocks, but subagent dashboards are not fully automatic for arbitrary child Pi processes or tmux sessions. Full dashboard behavior requires an ObservMe-aware orchestration launcher.

### Published v2 boundary and OrcMe adoption status

ObservMe 0.1.8 defines integration API v2 and child-identity envelope version 1. A v2 launcher supplies one complete descriptor: a 1–128-code-point control-free Unicode display name, one exact role (`lead`, `helper`, `worker`, or `validator`), and a 1–64-character capability matching `[A-Za-z0-9][A-Za-z0-9._:-]*`. Display name is presentation, role is descriptive telemetry, capability is a stable machine value, and technical lifecycle IDs remain correlation keys. Display name and capability are forbidden metric labels.

The stable runtime boundary is the synchronous `observme:integration:request` channel. A package with an ObservMe dependency should use `requestObservMeIntegrationV2()`; a package intentionally decoupled from ObservMe may mirror the structural wire contract locally. Separately installed Pi packages must not assume shared Node module roots, constructors, or `instanceof` identity. Root API v2 compatibility also does not prove that an explicitly loaded child extension can read envelope version 1; a child launched with `--no-extensions` must explicitly load and pin ObservMe 0.1.8 or later.

The reviewed OrcMe implementation remains API v1 today: it mirrors the v1 shape locally, advertises `[1]`, and does not send the v2 child descriptor. Its approved downstream role chain is `lead` (coordinates), `helper` (scoped assistance), `worker` (executes assigned work), then `validator` (independently checks). Future adoption maps durable display identity, manifest role, and pinned definition name to ObservMe display name, role, and capability exactly. ObservMe telemetry remains supplementary, grants no OrcMe authority, and never replaces OrcMe's authoritative durable task state. See [`extension-integration.md`](extension-integration.md#orcme-interoperability-profile-shipped-v1-versus-planned-v2) for the direct-RPC environment bridge, policy, pinning, and lifecycle contract.

## 1. Terminology

### Pi agent runtime

A Pi agent runtime is one running Pi process/session that emits Pi lifecycle events such as:

- `session_start`
- `agent_start`
- `turn_start`
- `before_provider_request`
- `tool_execution_start`
- `tool_call`
- `tool_result`
- `turn_end`
- `agent_end`
- `session_shutdown`

In ObservMe, this runtime gets a logical identity:

- `pi.agent.id`
- `pi.agent.root_id`
- `pi.agent.parent_id` when it is a child
- `pi.agent.depth`
- `pi.agent.role`

### Agent run

A Pi `agent_start` / `agent_end` pair is one user-prompt lifecycle inside a Pi runtime. ObservMe represents this as a `pi.agent.run` span.

Important distinction:

- `pi.agent.id` identifies the logical runtime.
- `pi.agent.run.id` identifies one prompt lifecycle inside that runtime.

Dashboard panels such as `observme_agent_runs_total` count `agent_start` / `agent_end` lifecycles, not process spawns.

### Pi subagent

Pi core does not have built-in subagents. The Pi docs state that subagents are created by extensions or packages. The official example subagent extension launches separate `pi` subprocesses in JSON/print mode so each delegated agent has an isolated context window.

In ObservMe, a subagent is a separate Pi runtime that has trusted parent lineage:

- `pi.agent.parent_id` is set.
- `pi.agent.root_id` is inherited from the original root agent.
- `pi.workflow.id` is inherited from the original workflow.
- `pi.agent.depth` is parent depth plus one.
- An envelope-free v1 child uses the legacy `subagent` role. A complete supported child-identity envelope uses the launcher's exact v2 role: `lead`, `helper`, `worker`, or `validator`. Role never determines ObservMe lineage depth.

### Pi subagent agent definitions

The Pi subagent example uses markdown agent definitions such as:

- `~/.pi/agent/agents/*.md`
- `.pi/agents/*.md`

Each definition has frontmatter like `name`, `description`, `tools`, and `model`, plus a system prompt body.

These markdown agent names are not automatically the same thing as ObservMe `pi.agent.id`, display name, role, or capability. A v2-aware launcher must supply all three child-identity fields explicitly; ObservMe does not infer any field from a markdown definition, command, prompt, or depth. The internal role model keeps the ObservMe topology role `root`, exact v2 child roles (`lead`, `helper`, `worker`, `validator`), and retained legacy/historical roles (`subagent`, `orchestrator`, `reviewer`, `unknown`) distinct.

Do not use markdown agent names as high-cardinality identifiers or metric labels.

### Tmux-managed subagent

A tmux-managed subagent is a child Pi process started in its own tmux session or pane. It is still just a Pi subagent from ObservMe's perspective. Tmux provides process isolation, attach/detach behavior, and operator control, but it does not provide ObservMe lineage.

Required tmux-managed subagent properties:

- It runs a normal Pi command inside tmux.
- It loads ObservMe through an installed package, project/user extension discovery, or an explicit `-e` extension source.
- It receives ObservMe lineage and trace env from the parent launcher.
- It exports telemetry to the same or compatible OTLP backend as the parent.
- It has a predictable tmux session/window/pane name so the orchestration extension can list, attach, stop, and clean it up.

Recommended naming pattern:

```text
observme-<workflow-short>-<agent-name>-<spawn-short>
```

The full workflow id, agent id, spawn id, and session id remain trace/log attributes only. Do not use them as Prometheus labels.

## 2. How to know root agent vs subagent

ObservMe decides agent lineage from trusted propagated context.

### Root-like agent

A runtime is root-like when no trusted parent context is accepted.

Expected fields:

```text
pi.agent.role = root
pi.agent.depth = 0
pi.agent.parent_id is absent
pi.agent.root_id = pi.agent.id
pi.workflow.root_agent_id = pi.agent.id
```

### Subagent

A runtime is a subagent when it accepts trusted parent lineage.

Expected fields:

```text
pi.agent.role = subagent
pi.agent.parent_id = <parent pi.agent.id>
pi.agent.root_id = <root pi.agent.id>
pi.workflow.id = <parent workflow id>
pi.workflow.root_agent_id = <root pi.agent.id>
pi.agent.depth = <parent depth> + 1
```

### Orphan subagent

A runtime is orphaned when some parent lineage is present but the root/parent linkage is incomplete or cannot be connected to a known parent.

Expected behavior:

- Emit `agent.orphaned` log/event.
- Increment `observme_orphan_agents_total`.
- Keep Pi running fail-open.
- Do not place raw environment values or raw command lines into telemetry.

### Current production rule

The shipped extension registers session handlers with `trustedParentContext: true`, making the Pi process environment eligible for launcher-provided lineage. Trusted project `.env` values are loaded into ObservMe configuration but are not copied into this lineage input, so a project file cannot establish parent provenance.

Eligibility is not blind acceptance. When any propagation value is present, `src/pi/agent-lineage.ts` requires a complete validated workflow, parent agent, root agent, parent depth, and spawn envelope. Child identity is read only after its version marker: marker version `1` must be accompanied by a complete descriptor whose display name, role, and capability pass the shared API validator. Identity fields without a marker, incomplete or malformed descriptors, stale contradictions, and unknown versions discard the whole propagated envelope and fail open to root/orphan lineage. Unknown versions are not partially interpreted. A `traceparent` that is present must be valid W3C; a missing `traceparent` does not invalidate the envelope — lineage connects and trace continuity degrades to the bounded `trace_context.propagation_failed` fallback. Optional `tracestate` and duplicate parent trace/span metadata must validate and agree. A stale inherited child agent id is rejected. Diagnostics are bounded and never include raw inherited values.

ObservMe validates the process envelope but does not cryptographically authenticate the launcher. An ObservMe-aware launcher remains responsible for constructing the envelope immediately before child startup and clearing stale propagation variables. Explicit trusted runtime lineage options remain available to tests and embedders and take precedence over validated propagated display name, role, and capability. Validated active-branch recovery metadata likewise takes precedence over process capability.

For tmux orchestration this is the critical distinction:

- **Child Pi with ObservMe but no propagation envelope:** telemetry exists and the child starts as a root-like runtime.
- **Child Pi with a complete validated v1 lineage envelope and no identity marker:** telemetry joins the parent workflow with legacy `subagent` behavior and no child capability.
- **Child Pi with a complete validated lineage envelope plus supported identity envelope:** telemetry joins the parent workflow with the exact display name, v2 role, and capability supplied by the launcher.
- **Child Pi with a partial, malformed, contradictory, stale, or unknown-version envelope:** Pi keeps running with root/orphan fallback and one bounded value-free propagation-failure signal.

## 3. What ObservMe must do at a subagent spawn point

Pi does not emit a dedicated `subagent_spawned` event. ObservMe must instrument the exact code path that launches or waits for another Pi process.

The required parent-side flow is:

1. Parent is already inside an ObservMe session.
2. Parent extension/tool decides to launch a child Pi process.
3. ObservMe starts a `pi.agent.spawn` span.
4. ObservMe creates a spawn id: `pi.agent.spawn.id`.
5. ObservMe builds child environment variables containing workflow, parent/root agent, depth, spawn, session, and trace context.
6. The subagent launcher must pass that environment to `child_process.spawn` or an equivalent process runner.
7. Parent records spawn completion or failure.
8. Parent records `pi.agent.wait` when it waits for the child.
9. Parent records `pi.agent.join` when it receives the child result/status.
10. Parent updates the in-memory agent tree and `/obs agents` runtime state.

External extensions use the versioned API documented in [`extension-integration.md`](extension-integration.md):

- `requestObservMeIntegration(pi)` for legacy metadata-free v1;
- `requestObservMeIntegrationV2(pi)` for required v2 child identity;
- `startSubagent(...)`
- `completeSubagent(...)`
- `failSubagent(...)`
- `startWait(...)` / `endWait(...)`
- `startJoin(...)` / `endJoin(...)`

The API delegates to ObservMe's internal `src/pi/subagent-spawn.ts` helpers without exposing the private telemetry session. If a subagent extension launches `pi` without this integration, ObservMe can still observe the launcher as a normal tool call, but the agent/subagent dashboards will not get the full spawn/depth/fan-out/wait/join contract.

### Tmux-specific spawn requirements

When the child is launched through tmux, the orchestration extension must still treat tmux as the process runner around a child Pi process.

Required flow:

1. Start `pi.agent.spawn` before creating the tmux session.
2. Build the child environment from the started spawn state.
3. Start tmux with an explicit command that injects that environment into the child Pi process.
4. Do not rely on the tmux server's cached global environment; it may be stale if the tmux server was started earlier.
5. Store the tmux session/window/pane identifiers in local orchestration state and in safe span/log attributes when low-cardinality or hashed.
6. Mark spawn `completed` only when the tmux session/pane and child command were created successfully.
7. Mark spawn `failed` if tmux cannot be started, the pane exits before Pi starts, or the command cannot be delivered.
8. Record `wait` while the orchestrator is waiting for child completion or a child status signal.
9. Record `join` when the orchestrator collects a child result, sees a terminal child status, or times out.

Prefer a dedicated tmux server/socket that is started with the returned process environment, or explicit tmux per-session environment facilities. Do not serialize the envelope into a shell command. The generic [`../examples/integrations/subagent-runner.ts`](../examples/integrations/subagent-runner.ts) adapter leaves this transport-specific environment handling to its `ChildTransport` implementation.

## 4. Environment propagation contract

When propagation is enabled, parent-to-child environment must include safe generated lineage values.

Configured default env names:

```text
OBSERVME_WORKFLOW_ID
OBSERVME_PARENT_AGENT_ID
OBSERVME_ROOT_AGENT_ID
OBSERVME_PARENT_SESSION_ID
OBSERVME_PARENT_TRACE_ID
OBSERVME_PARENT_SPAN_ID
OBSERVME_AGENT_DEPTH
OBSERVME_SPAWN_ID
OBSERVME_CHILD_IDENTITY_ENVELOPE_VERSION
OBSERVME_AGENT_DISPLAY_NAME
OBSERVME_AGENT_ROLE
OBSERVME_AGENT_CAPABILITY
traceparent
tracestate
```

Important details:

- `OBSERVME_AGENT_ID` is not normally propagated from parent to child; the child should generate its own `pi.agent.id`.
- V2 identity uses marker `OBSERVME_CHILD_IDENTITY_ENVELOPE_VERSION=1` plus all three display-name, role, and capability values. V1 propagation omits all four identity values and does not inherit parent capability.
- The child parses the marker before any identity field. Unknown versions, marker-free identity fields, and partial or invalid descriptors invalidate propagation atomically; no partial identity reaches lineage.
- Inherited ObservMe and W3C propagation variables are cleared before current child lineage is written, so stale identity, agent IDs, spawn IDs, parent trace/span IDs, `traceparent`, or `tracestate` never leak into a new child environment.
- This sanitization only happens on the ObservMe spawn path. A subagent process that launches a further child by passing its own `process.env` directly hands down the envelope *it received*: the grandchild then validates successfully but attaches as a **sibling** of its parent (same parent agent id, same spawn id, same depth) with no orphan signal. Every spawn must go through `startSubagent()` (or otherwise rebuild the envelope) — never reuse an inherited envelope.
- `OBSERVME_AGENT_DEPTH` carries the parent depth. The child increments it when creating its own lineage.
- `traceparent` and `tracestate` let the child continue the same distributed trace when possible.
- If W3C trace context cannot be propagated, the parent still propagates workflow/parent/root ids and emits `trace_context.propagation_failed` fallback telemetry. The child accepts the complete lineage envelope even without `traceparent`: it joins the workflow at the correct depth, starts a new trace (with a validated span link when duplicate parent trace/span metadata is available), and emits its own bounded `trace_context.propagation_failed` signal. Only a present-but-malformed `traceparent` invalidates the envelope.
- Note that with `traces.enabled: false` the extension still generates valid (unsampled) span contexts, so `traceparent` continues to propagate; disabling traces does not break lineage or trace continuity variables.
- Raw commands, prompts, cwd, usernames, hostnames, PIDs, and inherited environment values must not be used to derive lineage ids.
- In tmux mode, env propagation must be explicit per child command or per tmux session. Do not assume the parent process environment reaches a pane through an already-running tmux server.
- If the orchestrator stores tmux metadata, store only safe names, hashed values, or bounded status enums in telemetry.

Config gates:

```yaml
workflow:
  enabled: true
agent:
  propagateTraceContext: true
  propagateToSubagents: true
```

Validation gates:

- Workflow, parent-agent, root-agent, depth, and spawn values must be present together when any propagated value is supplied.
- A child-identity marker must be exactly version `1`; all three descriptor fields must be present and pass the shared child-descriptor validator. Identity fields without the marker are a partial envelope.
- Display name is 1–128 Unicode scalar values with no control characters; role is exactly `lead`, `helper`, `worker`, or `validator`; capability is 1–64 ASCII characters matching `[A-Za-z0-9][A-Za-z0-9._:-]*`.
- Lineage env values must be short and match the safe character pattern.
- A supplied `traceparent` must be valid W3C; a missing `traceparent` degrades trace continuity without invalidating the lineage envelope. Optional `tracestate` is bounded, structurally validated, and requires `traceparent`.
- Parent trace id must be 32 hex characters and parent span id must be 16 hex characters when duplicate metadata is supplied; both must match `traceparent`.
- Depth must be an integer between 0 and 64.
- A stale inherited child agent id or uppercase W3C propagation variable invalidates the envelope.

## 5. Child runtime contract

For child subagent telemetry to appear correctly:

1. The child process must load the ObservMe extension.
2. The child process must inherit the ObservMe propagation env from the parent wrapper.
3. The child ObservMe runtime must treat that env as trusted parent context.
4. The child must export traces, metrics, and logs to the same or compatible OTLP backend.
5. The Collector must preserve lineage attributes on traces/logs and drop high-cardinality lineage attributes from metric labels.

If the child process runs `pi --no-session`, it can still emit runtime telemetry, but durable Pi session-file recovery is not available. ObservMe should rely on live events and propagated lineage in that case.

## 5.1 Tmux-based orchestration extension requirements

This section is the implementation brief for the future Pi extension that manages agent orchestration.

### Responsibilities

The orchestration extension is responsible for:

- agent discovery and validation
- tmux session creation and naming
- ObservMe lineage and trace propagation
- child Pi command construction
- child ObservMe loading guarantees
- child task delivery
- child lifecycle/status tracking
- parent wait/join accounting
- cancellation/timeout handling
- attach/detach user workflows
- safe cleanup of completed or failed tmux sessions
- local `/obs agents` state updates and exported telemetry

The ObservMe telemetry layer is responsible for:

- spans, metrics, logs, and dashboards
- redaction and high-cardinality protection
- fail-open export behavior
- agent-tree and lineage semantics

Do not mix these responsibilities by putting orchestration secrets or raw commands into telemetry.

### Required execution modes

The extension should support at least these modes:

| Mode | Description | Best for | Join source |
|---|---|---|---|
| `tmux-interactive` | Start a normal interactive Pi TUI in tmux. Operators can attach and watch or steer. | Long-running isolated work. | tmux pane status, explicit completion marker, or operator action. |
| `tmux-print-json` | Start `pi --mode json -p` in tmux and capture stdout/stderr to files or pipes. | Automated delegated tasks with structured output. | process exit plus parsed JSON events. |
| `tmux-rpc` | Start Pi RPC mode in tmux or a supervised process and communicate through explicit pipes. | Long-lived managed agents. | RPC response/status protocol. |

For all modes, ObservMe lineage propagation is mandatory.

### Agent definition contract

Each manageable agent should have a bounded definition:

```yaml
name: scout                 # launcher definition name; not inferred by ObservMe
displayName: Scout          # durable presentation identity
role: worker                # lead|helper|worker|validator
capability: code-search     # stable machine value
description: Fast codebase recon
model: claude-haiku-4-5
tools: read, grep, find, ls, bash
mode: tmux-print-json       # tmux-interactive|tmux-print-json|tmux-rpc
cwdPolicy: parent           # parent|explicit|project-root
maxRuntimeMs: 1800000
maxConcurrent: 4
```

Rules:

- The launcher validates and supplies a complete descriptor; ObservMe does not trim, normalize, infer, or rewrite it.
- `displayName` may be shown in UI and tmux names, but it must not replace `pi.agent.id` or any task/spawn/attempt/instance ID.
- `role` is one of the four frozen v2 values and may be used only where a metric already has documented bounded role semantics.
- `displayName` and `capability` remain UI/resource/span/log attributes and must not become metric labels without a later explicit bounded allowlist contract.
- Project-local agent definitions require project trust and, in interactive mode, confirmation before execution.

### Child Pi command requirements

The child command must guarantee ObservMe loads in the child runtime.

Acceptable approaches:

- ObservMe is installed globally as a Pi package and extension discovery is enabled.
- ObservMe is installed project-locally and the project is trusted.
- The orchestrator explicitly passes `-e <observme-extension-source>` to the child Pi command.

The child command must not use `--no-extensions` unless it also explicitly loads ObservMe. If a mode requires `--no-extensions` for isolation, the command must add ObservMe back explicitly.

Recommended child command inputs:

```text
pi [observme-load-options] [mode-options] [model/tools options] [task]
```

Examples of mode options:

```text
--mode json -p --no-session
--mode rpc
# or normal interactive mode inside tmux
```

Do not include raw prompt/task text in exported telemetry. Use hashes, lengths, bounded status, or redacted content only when capture is explicitly enabled.

### Tmux session lifecycle

The orchestration extension should maintain a bounded in-memory registry for active tmux agents:

```text
spawn_id
workflow_id
parent_agent_id
child_agent_id when known
agent_display_name
agent_role
agent_capability
tmux_session_name
tmux_window_id / pane_id when available
status: starting|active|completed|failed|cancelled|timeout|orphaned
started_at
last_status_at
```

Telemetry rules:

- `spawn_id`, `workflow_id`, `parent_agent_id`, `child_agent_id`, and session ids are span/log attributes only.
- `agent_role`, `subagent_depth`, `spawn_type`, `spawn_reason`, `status`, and `reason` may be metric labels only where their bounded semantics are documented. `agent_display_name` and `agent_capability` remain local/trace/log metadata.
- Tmux pane ids and raw session names should be treated as operational metadata; prefer span/log attributes or hashed values, not metric labels.

Lifecycle operations:

1. **Create**: validate agent definition, build lineage env, create tmux session, start child Pi.
2. **Activate**: mark child status active after tmux and Pi startup are confirmed.
3. **Wait**: record `pi.agent.wait` while parent waits for child output, exit, or status marker.
4. **Join**: record `pi.agent.join` with terminal status and result summary.
5. **Attach**: open or report the tmux attach command without exposing secrets.
6. **Detach**: leave child running and keep status active.
7. **Stop**: request graceful Pi shutdown first, then terminate tmux session after timeout.
8. **Cleanup**: remove completed tmux sessions according to retention policy.

### Management command surface

The future extension should expose commands or tools equivalent to:

```text
/agents list
/agents start <agent> [task]
/agents status [agent|spawn]
/agents attach <agent|spawn>
/agents send <agent|spawn> <message>
/agents wait <agent|spawn>
/agents join <agent|spawn>
/agents stop <agent|spawn>
/agents cleanup
```

If this is folded under ObservMe commands, use `/obs agents` only for observability and add a separate orchestration namespace for mutations. `/obs` query commands should remain read-only.

LLM-facing tools should be separate from user commands and must have clear schemas, prompt snippets, and prompt guidelines. Tool names must explicitly identify the tool in every guideline.

### Result and status collection

The extension must define how a parent knows a tmux subagent has completed.

Allowed approaches:

- child process exits and the orchestrator captures exit status
- child writes a small status/result file with redacted/structured summary
- child emits JSON events that the orchestrator reads from a pipe/log
- child is controlled through RPC and returns an explicit response
- operator marks a tmux-interactive child as joined/cancelled
- backend query confirms terminal telemetry, with timeout fallback

The ObservMe API accepts separate bounded status fields:

```text
childStatus: starting|active|completed|failed|cancelled|orphaned
joinStatus: waiting|completed|failed|cancelled|timeout|unknown
failurePropagated: true|false
active children count
child count / fan-out count
```

Terminal `completeSubagent()` transitions accept only `completed`, `failed`, or `cancelled`; `partial`, `ok`, and `error` are not valid API values. Result summary transport remains the orchestrator's responsibility and is not a field in the current ObservMe integration API.

### Trust model for propagated lineage

The implemented trust boundary is the child Pi process environment plus a complete generated spawn envelope:

1. The parent creates a fresh `OBSERVME_SPAWN_ID` and validated workflow/parent/root/depth values around the `pi.agent.spawn` span.
2. The launcher passes those values and W3C context directly to the child process after clearing stale ObservMe and W3C variables.
3. The shipped child extension makes only the Pi process environment eligible for lineage; trusted project `.env` remains configuration-only.
4. The child accepts the envelope only when every required value validates and the W3C and duplicate trace metadata agree.
5. Invalid envelopes fail open without raw-value diagnostics. Explicit runtime overrides are reserved for controlled embedders and tests.

This is process-boundary validation, not a cryptographic launcher signature. A future orchestration extension may add signing if it needs stronger provenance against other code running as the same local user, but it must preserve the current bounded validation and fail-open behavior.

### Isolation and safety

Tmux isolation does not sandbox filesystem or network access. A tmux child Pi process has the permissions of the user account.

Requirements:

- confirm project-local agents before running them unless the project is already trusted and policy disables confirmation
- do not pass secrets through command strings when a safer env/pipe path is available
- do not log raw env, raw task prompts, raw command lines, or full paths by default
- support cancellation and timeout for spawned children
- avoid unbounded local registries, output buffers, and result files
- clean up temporary files containing prompts or status details
- fail open for ObservMe export failures, but fail safely for orchestration control errors

## 6. Spans and logs required for dashboards

### Spans

Required span names:

```text
pi.session
pi.agent.run
pi.turn
pi.llm.request
pi.tool.call
pi.agent.spawn
pi.agent.wait
pi.agent.join
pi.bash.execution
pi.compaction
pi.branch
```

Agent/subagent-specific spans:

- `pi.agent.run`: one prompt lifecycle in current agent runtime.
- `pi.agent.spawn`: parent operation that launches a child Pi process.
- `pi.agent.wait`: parent waiting for child progress/completion.
- `pi.agent.join`: parent collecting child result/status.

### Logs

Agent-tree log events expected by Loki dashboards:

```text
agent.run.started
agent.run.completed
agent.run.failed
agent.spawn.started
agent.spawn.completed
agent.spawn.failed
agent.spawn.cancelled
agent.wait.started
agent.wait.completed
agent.join.started
agent.join.completed
agent.orphaned
trace_context.propagation_failed
```

Agent-tree logs use:

```text
event.category = agent-tree
```

Loki normalizes dotted OTEL names, so Grafana queries use labels such as:

```text
event_name
pi_agent_id
pi_agent_parent_id
pi_agent_root_id
pi_workflow_id
pi_agent_spawn_id
```

## 7. Metrics required by the dashboards

Prometheus metrics must use only low-cardinality labels.

### Agent run metrics

```text
observme_agent_runs_total
observme_agent_run_errors_total
observme_agent_run_duration_ms
```

Expected labels:

```text
agent_role
environment
provider/model only for LLM metrics, not agent-run metrics
```

Dashboard examples:

```promql
sum(rate(observme_agent_runs_total[$__rate_interval])) by (agent_role)
histogram_quantile(0.95, sum(rate(observme_agent_run_duration_ms_bucket[$__rate_interval])) by (agent_role, le))
```

### Subagent spawn metrics

```text
observme_subagents_spawned_total
observme_subagent_spawn_failures_total
observme_subagent_spawn_duration_ms
```

Expected labels:

```text
agent_role, subagent_depth, spawn_type, spawn_reason   # spawned_total and spawn_duration_ms
spawn_type, error_class                                 # spawn_failures_total only
```

Dashboard examples:

```promql
sum(rate(observme_subagents_spawned_total[$__rate_interval])) by (subagent_depth, spawn_type, spawn_reason)
sum(rate(observme_subagent_spawn_failures_total[$__rate_interval])) by (spawn_type, error_class)
histogram_quantile(0.95, sum(rate(observme_subagent_spawn_duration_ms_bucket[$__rate_interval])) by (agent_role, spawn_type, spawn_reason, le))
```

### Agent tree metrics

```text
observme_active_agents
observme_agent_lease_expires_unixtime_seconds
observme_agent_tree_depth
observme_agent_tree_width
observme_agent_fanout_count
```

The active claim and lease carry the bounded `agent_role` and `environment` dimensions plus generated resource-instance identity normalized by the Collector to `observme_instance_id`. They do not currently carry `subagent_depth`; never derive a replacement depth label from workflow, session, logical-agent, trace, span, or job-run IDs. The tree histograms retain their documented bounded tree dimensions.

Dashboard examples:

```promql
sum by (agent_role) (
  max by (observme_instance_id, agent_role) (
    (observme_active_agents > 0)
    and on (observme_instance_id)
    (
      (observme_agent_lease_expires_unixtime_seconds > time())
      and
      (observme_agent_lease_expires_unixtime_seconds <= time() + 305)
    )
  )
) or on() vector(0)
histogram_quantile(0.95, sum(rate(observme_agent_tree_depth_bucket[$__rate_interval])) by (subagent_depth, le))
histogram_quantile(0.95, sum(rate(observme_agent_tree_width_bucket[$__rate_interval])) by (subagent_depth, le))
histogram_quantile(0.95, sum(rate(observme_agent_fanout_count_bucket[$__rate_interval])) by (subagent_depth, le))
```

Use the canonical total, role, environment, diagnostics, and migration guidance in [`reference/09-dashboards-alerts-slos.md` §1.3](reference/09-dashboards-alerts-slos.md#13-active-agent-leased-state-contract); raw active-claim sums are not current-liveness queries after ungraceful termination.

### Lineage health metrics

```text
observme_orphan_agents_total
observme_trace_context_propagation_failures_total
```

Expected labels:

```text
status, reason                        # orphan_agents_total
agent_role, subagent_depth, reason    # trace_context_propagation_failures_total
```

Dashboard examples:

```promql
sum(rate(observme_orphan_agents_total[$__rate_interval])) by (status, reason)
sum(rate(observme_trace_context_propagation_failures_total[$__rate_interval])) by (agent_role, subagent_depth)
```

### Wait/join and child failure metrics

```text
observme_agent_wait_duration_ms
observme_agent_join_duration_ms
observme_child_agent_failures_total
observme_parent_recovered_from_child_failure_total
```

Expected labels:

```text
agent_role
subagent_depth
status/reason as bounded enums when needed
```

Dashboard examples:

```promql
histogram_quantile(0.95, sum(rate(observme_agent_wait_duration_ms_bucket[$__rate_interval])) by (agent_role, le))
histogram_quantile(0.95, sum(rate(observme_agent_join_duration_ms_bucket[$__rate_interval])) by (agent_role, le))
sum(rate(observme_child_agent_failures_total[$__rate_interval])) by (agent_role, subagent_depth)
sum(rate(observme_parent_recovered_from_child_failure_total[$__rate_interval])) by (agent_role, subagent_depth)
```

## 8. Labels that are allowed vs forbidden

### Allowed metric labels

Low-cardinality labels allowed for aggregates when the owning instrument documents them:

```text
agent_role
subagent_depth
spawn_type
spawn_reason
status
reason
error_class
environment
provider
model
tool_name
tool_category
operation
```

### Forbidden metric labels

These may appear on traces/logs, but must not be Prometheus labels:

```text
session_id
workflow_id
workflow_root_agent_id
agent_id
parent_agent_id
child_agent_id
agent_run_id
spawn_id
spawn_tool_call_id
trace_id
span_id
entry_id
tool_call_id
raw_command
raw_prompt
raw_path
raw_error_message
agent_display_name
agent_capability
```

Display name and capability are permitted as bounded resource/span/log/UI attributes, but not as Prometheus labels under the v2 contract. The production Collector config reinforces this by deleting `pi.agent.display_name`, `pi.agent.capability`, and high-cardinality metric resource attributes such as `pi.workflow.id`, `pi.agent.id`, `pi.agent.parent_id`, `pi.agent.root_id`, `pi.agent.spawn.id`, `pi.agent.child.id`, and `pi.session.id` from the metrics pipeline.

## 9. What `/obs agents` needs

`/obs agents` combines:

1. In-memory runtime state from the current Pi process.
2. Prometheus aggregate queries.
3. Tempo trace search by safe lineage attributes.

It renders:

- workflow id and root id
- current agent id, role, and depth
- current session id
- fan-out count in current trace
- tree depth/width/active/orphan counts
- recent children
- wait/join hints
- aggregate series counts
- Tempo drill-down attributes and latest trace id

Current PromQL used by `/obs agents`:

```promql
sum(rate(observme_subagents_spawned_total[1h])) by (agent_role, subagent_depth, spawn_type, spawn_reason)
histogram_quantile(0.95, sum(rate(observme_agent_fanout_count_bucket{subagent_depth!=""}[1h])) by (subagent_depth, le))
sum(rate(observme_orphan_agents_total[1h])) by (status, reason)
```

Tempo drill-down uses span attributes:

```text
pi.agent.id
pi.workflow.id
```

These are query attributes, not metric labels.

## 10. Pi subagent example and tmux compatibility

The Pi example subagent extension:

- registers a `subagent` tool
- supports single, parallel, and chain modes
- discovers user agents from `~/.pi/agent/agents/*.md`
- optionally discovers project agents from `.pi/agents/*.md`
- spawns child `pi` processes with `child_process.spawn(...)`
- runs children with `--mode json -p --no-session`
- reads child JSON events from stdout
- collects child assistant messages, tool results, token usage, cost, and final output
- supports Ctrl+C abort by killing child processes

By default, the example spawn call does not request ObservMe's integration API or pass its propagation environment.

Therefore, to use that style of subagent and still populate ObservMe dashboards, an ObservMe-aware adapter must wrap the child process spawn and pass the returned env to the child process.

Minimum identity-aware adapter behavior:

1. Request API v2 with `requestObservMeIntegrationV2(pi)`; do not fall back to v1 when child identity is required.
2. Before spawning child Pi, call `startSubagent` with a complete fresh descriptor, spawn type/reason, and safe command metadata.
3. Pass the returned `env` into `child_process.spawn`.
4. On launcher error before the child runs, call `failSubagent`.
5. Around blocking waits, call `startWait` and `endWait`.
6. When the child reaches a terminal state, call `completeSubagent` once with matching `completed`, `failed`, or `cancelled` status/outcome fields.
7. When child output is collected, call `startJoin` and `endJoin` with child status.
8. Ensure the child command loads ObservMe as an extension/package.
9. Ensure the child ObservMe runtime receives the complete propagated parent context.

Without that adapter, parent tool metrics may show a `subagent` tool call, but the agent-tree dashboard will not have reliable spawn/depth/fan-out/wait/join lineage.

### Tmux compatibility conclusion

Running subagents in tmux is supported by the requirements, but tmux must be integrated as an ObservMe-aware runner.

The correct mental model is:

```text
parent Pi + ObservMe
  -> orchestration extension starts pi.agent.spawn
  -> orchestration extension starts tmux with explicit ObservMe env
  -> child Pi starts inside tmux and loads ObservMe
  -> child ObservMe accepts trusted parent lineage
  -> parent records wait/join based on tmux/process/result status
  -> Grafana correlates parent and child by workflow/agent lineage
```

If the child loads ObservMe but does not receive or trust parent lineage, the child is observable but not connected as a subagent.

## 11. Dashboard readiness checklist

Use this checklist before expecting subagents to appear correctly in Grafana.

### Parent process

- [ ] ObservMe extension is loaded in the parent Pi process.
- [ ] Parent has emitted `session_start`.
- [ ] Parent has a current `pi.workflow.id` and `pi.agent.id`.
- [ ] `workflow.enabled=true`.
- [ ] `agent.propagateToSubagents=true`.
- [ ] Parent subagent launcher uses the explicit v2 helper when identity is required.
- [ ] Every v2 launch supplies one fresh complete child descriptor.
- [ ] Parent passes returned env into the child Pi process.
- [ ] In tmux mode, parent injects env explicitly into the tmux child command and does not rely on stale tmux server env.
- [ ] Parent records tmux session/pane status in a bounded local registry.
- [ ] Parent records spawn completion/failure.
- [ ] Parent records wait/join if it waits for child output, process exit, status marker, or operator action.

### Child process

- [ ] Child Pi process loads ObservMe 0.1.8 or later when identity envelope version 1 is used.
- [ ] Child command does not use `--no-extensions` unless the pinned compatible ObservMe extension is explicitly re-added.
- [ ] Child receives `OBSERVME_WORKFLOW_ID`, `OBSERVME_PARENT_AGENT_ID`, `OBSERVME_ROOT_AGENT_ID`, `OBSERVME_AGENT_DEPTH`, and `OBSERVME_SPAWN_ID`.
- [ ] A v2 child also receives marker version `1` and the complete display-name, role, and capability fields.
- [ ] Child receives `traceparent` when trace propagation is enabled and possible.
- [ ] Child accepts propagated ObservMe env as trusted parent context.
- [ ] Child exports OTLP to the configured Collector/backend.
- [ ] In tmux-interactive mode, operators can attach/detach without changing lineage or losing telemetry.

### Collector/backend

- [ ] Traces pipeline preserves `pi.workflow.*` and `pi.agent.*` attributes.
- [ ] Logs pipeline preserves normalized event labels/metadata needed by Loki dashboards.
- [ ] Metrics pipeline drops high-cardinality lineage attributes but preserves safe labels.
- [ ] Prometheus contains `observme_subagents_spawned_total` after a subagent run.
- [ ] Loki contains `event_category="agent-tree"` logs.
- [ ] Tempo can search by `pi.workflow.id` or `pi.agent.id`.

### Quick checks

Prometheus:

```promql
sum(rate(observme_subagents_spawned_total[5m])) by (agent_role, subagent_depth, spawn_type, spawn_reason)
sum(rate(observme_orphan_agents_total[5m])) by (status, reason)
sum(rate(observme_trace_context_propagation_failures_total[5m])) by (agent_role, subagent_depth)
```

Loki:

```logql
{service_name="observme-pi-extension", event_category="agent-tree"}
{service_name="observme-pi-extension", event_name="agent.spawn.completed"}
{service_name="observme-pi-extension", event_name="agent.orphaned"}
{service_name="observme-pi-extension", event_name="trace_context.propagation_failed"}
```

Pi command:

```text
/obs agents
```

### Dashboard navigation note

Use the improved dashboards in this order when validating a root-agent/subagent scenario:

1. Start in **ObservMe Overview** and confirm the `Agent lineage` and `Health` rows are green or intentionally idle.
2. Open **Trace Journey** with the same time range and apply Loki/Tempo-only `session_id`, `workflow_id`, `agent_id`, or `agent_run_id` filters to follow one execution.
3. Open **Agents and Subagents** for spawn failure, orphan, propagation, child recovery, wait/join, fan-out, and depth ratios, then use the handoff rows to jump back to Trace Journey or Tempo.
4. Open **Agent Node Graphs** only for aggregate topology; it shows selected-range counts and red health nodes/edges, not a single trace tree.
5. Open **SLO Health** or **Export Health** when lineage panels look empty or stale, because healthy idle ranges, missing optional child telemetry, and export failures have different meanings.

High-cardinality identifiers remain log/trace filters only. Prometheus panels should continue to use bounded labels such as `agent_role`, `subagent_depth`, `spawn_type`, `spawn_reason`, `status`, `reason`, and `error_class`.

### Dashboard implementation note

The Agents and Agent Node Graphs dashboards now surface the main operator questions directly: spawn failure ratio, orphan pressure, trace-context propagation failure ratio, child recovery ratio, depth/fan-out alert references, slow/failing/orphan/high-fan-out top tables, and Loki handoff rows with Trace Journey/Tempo drill-down links. The node graphs also include red health nodes/edges for failed spawns, orphan lineage, and propagation failures alongside selected-range counts.

`agent_capability` remains deliberately absent from dashboard filters. Keep capability detail in Loki/Tempo or orchestration-local state; v2 does not permit capability as a Prometheus label without a later explicit bounded allowlist contract.

## 12. Current implementation checkpoints and gaps

These checkpoints reflect the current code and dashboards after source-review remediation.

### Present pieces

- Agent lineage generation and complete propagated-envelope validation exist in `src/pi/agent-lineage.ts`.
- The production extension enables process-environment lineage eligibility while keeping trusted project `.env` outside the provenance boundary.
- Valid W3C context explicitly parents the child `pi.session`; unavailable continuation uses a validated span link or bounded propagation-failure fallback.
- Bounded agent-tree tracking exists in `src/pi/agent-tree-tracker.ts`.
- Spawn/wait/join helper functions exist in `src/pi/subagent-spawn.ts` and are exposed to other loaded extensions through the versioned `@senad-d/observme/integration` event-bus API.
- Spawn duration is recorded on completion and launcher failure. Child completion/join records child failure and confirmed parent recovery once through bounded deduplication state.
- Session, agent-run/turn, LLM, tool/bash, and session metadata/tree handlers are split under `src/pi/event-handlers/` behind the stable `src/pi/handlers.ts` facade.
- Root workflow duration is recorded at shutdown, and failed agent runs increment `observme_agent_run_errors_total`.
- `/obs agents` is implemented and uses local runtime state, Prometheus aggregates, and Tempo drill-down attributes.
- Grafana dashboards include agent/subagent panels and alert/SLO rules.
- Tests cover child trace parenting, sanitized propagation fallback, spawn duration, child failure/recovery deduplication, wait/join spans, and low-cardinality metric labels.

### Remaining integration gaps before relying on full subagent dashboards

1. **External and tmux subagent launchers are not automatically wrapped.**
   - The public integration API lets launchers record the lifecycle explicitly, but arbitrary extensions that call `child_process.spawn` or `tmux new-session` without it cannot be detected automatically.
   - The Pi example subagent extension currently spawns child Pi processes without ObservMe env propagation.
   - A future tmux orchestration extension must own this wrapping and lifecycle tracking.

2. **Some metric label sets remain narrower than a full dashboard contract might want.**
   - `observme_active_agents` currently carries `environment` and `agent_role`, not `subagent_depth`.
   - `observme_subagent_spawn_failures_total` carries only `spawn_type` and `error_class`; shipped dashboards, alerts, and SLOs no longer select or group on other labels for it (a dashboard test enforces this).
   - Orphan signals from the tracker and session-propagation paths share the `{status, reason}` label keys but use different bounded values per path.
   - The agent-tree depth/width/fan-out histograms are recorded from two paths with disjoint label sets (`agent_role`/`subagent_depth`/`spawn_type`/`spawn_reason` from spawns vs `status`/`reason` from lineage observations); dashboards grouping on spawn-path labels filter with `subagent_depth!=""` to exclude blank-label lineage samples.

3. **External launcher adoption remains explicit.**
   - V2 resolves descriptor ownership and validation: the launcher supplies display name, exact role, and capability without ObservMe inference. Individual launchers, including OrcMe, still need downstream adoption before their managed definitions emit that descriptor.
   - Capability remains trace/log/resource/UI metadata and is not a dashboard metric label under this contract.

4. **Tmux management state does not exist yet.**
   - ObservMe has bounded in-memory telemetry agent-tree state, but not a tmux orchestration registry for session names, panes, attach commands, stop/cleanup state, or result collection.
   - A future extension must add that management layer while keeping telemetry privacy and cardinality boundaries intact.

## 13. Decision summary

To use subagents and have them appear in ObservMe dashboards, the extension must treat subagent support as explicit instrumentation, not passive observation.

Required decisions:

1. **Subagent spawn point:** choose the exact launcher(s) to wrap, including tmux session creation and any direct `child_process.spawn` paths.
2. **Tmux control model:** decide supported modes (`tmux-interactive`, `tmux-print-json`, `tmux-rpc`), session naming, attach/detach behavior, status detection, and cleanup policy.
3. **Trust model:** use the implemented complete process-envelope boundary; decide whether a future orchestrator also needs cryptographic signing against same-user processes.
4. **Child ObservMe loading:** decide whether child Pi commands rely on installed ObservMe packages or receive explicit `-e` extension loading.
5. **Descriptor ownership:** require each v2 launcher to supply display name, exact role, and capability explicitly; do not infer them from Pi markdown definitions, commands, prompts, tools, or depth.
6. **Metric label contract:** align the remaining active-agent, spawn-failure, and orphan dashboard dimensions while keeping high-cardinality ids out of labels.
7. **Duration/failure accounting:** use the implemented elapsed spawn duration and deduplicated child failure/recovery counters at completion/join transitions.
8. **Packaging:** ensure both parent and child Pi processes load ObservMe and share compatible config/export endpoints.
9. **Management command surface:** define commands/tools for list, start, status, attach, send, wait, join, stop, and cleanup.

Once those decisions are implemented, root agents and subagents can be distinguished as follows:

- Root agent: no parent id, depth `0`, topology role `root` (with `orchestrator` retained only as a historical value).
- V1 subagent: has parent id, inherited workflow/root id, depth `1+`, legacy role `subagent`, and no child display name/capability.
- V2 subagent: has parent id, inherited workflow/root id, depth `1+`, and exactly the launcher-supplied `lead`, `helper`, `worker`, or `validator` role; role never determines depth or authority.
- Orphan: has incomplete/broken parent lineage or parent cannot be linked, with orphan logs/metrics emitted.
