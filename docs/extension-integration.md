# Integrating other Pi extensions with ObservMe

Use this guide when another Pi extension launches or manages work that ObservMe cannot infer from Pi's standard lifecycle events. Orchestrators, subagent runners, process managers, remote executors, and workflow engines should use the versioned integration API instead of constructing ObservMe lineage variables themselves.

## What ObservMe captures automatically

Every Pi process that loads ObservMe emits its own supported session, workflow, agent-run, turn, LLM, tool, Bash, branch, compaction, model, thinking, trace, metric, and log telemetry. No integration API is needed for those standard Pi events.

Cross-process orchestration adds information that Pi does not emit automatically:

- a parent decided to spawn a child;
- the child belongs to a specific workflow and parent/root lineage;
- W3C trace context should cross the process boundary;
- the parent waited for and joined the child;
- the launcher, child, or join failed, timed out, or recovered.

An orchestration extension must report those transitions and launch the child with the propagation environment returned by ObservMe.

## Public integration surface

Import the API types and discovery helper from the package subpath:

```typescript
import {
  requestObservMeIntegration,
  type ObservMeIntegrationApi,
} from "@senad-d/observme/integration";
```

The helper uses Pi's shared `pi.events` bus and negotiates integration API version 1 synchronously:

```typescript
const observme: ObservMeIntegrationApi | undefined = requestObservMeIntegration(pi);
```

ObservMe registers no global object and does not require another extension to import its internal telemetry session. The event bus is the runtime boundary; the package subpath provides the stable constants, types, and request helper.

The API can be absent when ObservMe is not installed, disabled by package configuration, not loaded yet, incompatible, or connected through a failing/malformed event-bus provider. A method returns `{ ok: false, reason: "session_unavailable" }` when ObservMe is loaded but no telemetry session is active. Orchestration must remain functional in both cases and may run the child without ObservMe correlation after reporting a bounded local warning.

A package that cannot take a runtime dependency can implement the same synchronous request directly. Keep this channel and version stable:

```typescript
let observme: ObservMeIntegrationApi | undefined;
pi.events.emit("observme:integration:request", {
  supportedVersions: [1],
  respond(api: ObservMeIntegrationApi) {
    observme ??= api;
  },
});
```

Request the API when the user/tool starts orchestration, not from the extension factory. If a `session_start` handler must launch work automatically, account for extension handler ordering and retry only after ObservMe has an active session.

## Required parent lifecycle

Use this order for each child process:

1. Request the ObservMe integration API.
2. Call `startSubagent()` immediately before launching the child.
3. Pass the returned `env` as the child process environment without logging it.
4. Call `failSubagent()` only when the launcher fails before the child is running.
5. Call `startWait()`/`endWait()` around time spent waiting for child completion.
6. Call `completeSubagent()` once with the matching terminal `childStatus` and `outcome` (`completed`, `failed`, or `cancelled`).
7. Call `startJoin()`/`endJoin()` when collecting the terminal child status or result.

```typescript
const observme = requestObservMeIntegration(pi);
const started = observme?.startSubagent({
  command: "pi",
  args: ["--mode", "rpc"],
  spawnType: "extension",
  spawnReason: "delegated_task",
  env: process.env,
});

if (!started?.ok) {
  // Continue fail-open without correlation, or notify the operator locally.
  return;
}

let child;
try {
  child = await launchChildPi({ env: started.env });
} catch (error) {
  observme.failSubagent(started.spawnId, {
    childAgentId: started.childAgentId,
    errorClass: error instanceof Error ? error.name : "launcher_error",
  });
  throw error;
}

const result = await waitForChildPi(child);
observme.completeSubagent(started.spawnId, {
  childAgentId: started.childAgentId,
  childStatus: result.status,
  outcome: result.status,
});
```

Do not put raw tasks, prompts, command lines, environment values, child output, or private paths in `errorClass`, `spawnReason`, or other bounded fields.

## API methods

| Method | Use |
| --- | --- |
| `getContext()` | Read the current workflow, root/parent/current agent, role, depth, session, and trace identifiers for local orchestration correlation. These are high-cardinality values and must not become metric labels. |
| `startSubagent(options)` | Starts `pi.agent.spawn`, records spawn metrics/logs, creates bounded parent tree state, and returns a sanitized propagation environment. |
| `completeSubagent(spawnId, options)` | Ends the active child lifecycle with one coherent `completed`, `failed`, or `cancelled` status/outcome pair. |
| `failSubagent(spawnId, options)` | Ends a launcher failure and records bounded failure telemetry. |
| `startWait(options)` / `endWait(id, options)` | Measures time the parent is blocked on a child or dependency. |
| `startJoin(options)` / `endJoin(id, options)` | Measures result collection and records child failure propagation or confirmed parent recovery. |

`startSubagent()` accepts:

| Option | Values and meaning |
| --- | --- |
| `spawnId` | Optional caller-generated safe ID; omit to let ObservMe generate it. |
| `childAgentId` | Optional bounded parent-side placeholder; this is not propagated as the child's real agent ID. |
| `command` / `args` | Used only to create a salted command fingerprint when configured; raw values are not exported. Omit them if the launcher cannot safely provide them. |
| `spawnType` | `command`, `tool`, `extension`, or `unknown`. |
| `spawnReason` | `delegated_task`, `parallel_search`, `review`, `tool_wrapper`, or `unknown`. |
| `toolCallId` | Optional high-cardinality trace/log correlation when a tool initiated the spawn. |
| `env` | Base child environment. ObservMe removes stale lineage/W3C keys and returns the replacement environment. |

Runtime callers are validated even when JavaScript bypasses the TypeScript types. Caller-provided lifecycle identifiers must match `[A-Za-z0-9._:-]{1,128}`. Commands and individual arguments are capped at 4096 characters, argument lists at 256 items, and environment objects at 4096 entries. Durations must be finite, non-negative milliseconds. Invalid or duplicate active operations return a failure without replacing an existing span.

Completion accepts only terminal child states (`completed`, `failed`, `cancelled`), and any supplied outcome must match. Wait/join methods use bounded child states (`starting`, `active`, `completed`, `failed`, `cancelled`, `orphaned`), join states (`waiting`, `completed`, `failed`, `cancelled`, `timeout`, `unknown`), and wait reasons (`dependency`, `rate_limit`, `child_running`, `unknown`). `failurePropagated=false` on a completed join confirms that the parent recovered from a failed child.

All mutation methods return a discriminated result. Handle these reasons without crashing Pi:

| Reason | Meaning |
| --- | --- |
| `session_unavailable` | ObservMe is loaded but no telemetry session is active. |
| `invalid_request` | An identifier, enum, duration, command/argument field, or environment shape is invalid or oversized. |
| `spawn_already_exists` / `wait_already_exists` / `join_already_exists` | The requested lifecycle identifier is already active. Generate a unique identifier or finish the active operation; do not overwrite it. |
| `spawn_not_found` / `wait_not_found` / `join_not_found` | The lifecycle handle is absent or has already ended. |
| `child_agent_mismatch` | The supplied child ID does not match the child stored for the active spawn. |
| `invalid_terminal_transition` | Terminal status/outcome fields contradict each other or would rewrite an existing terminal tree state. |
| `operation_failed` | ObservMe could not safely complete the operation. |

Do not retry a completed lifecycle handle blindly; repeated completion can otherwise hide an orchestration-state bug.

## Propagation environment

`startSubagent()` clears stale ObservMe and W3C values from the supplied base environment and, when enabled, returns a complete current envelope. Default names are:

```text
OBSERVME_WORKFLOW_ID
OBSERVME_PARENT_AGENT_ID
OBSERVME_ROOT_AGENT_ID
OBSERVME_PARENT_SESSION_ID
OBSERVME_PARENT_TRACE_ID
OBSERVME_PARENT_SPAN_ID
OBSERVME_AGENT_DEPTH
OBSERVME_SPAWN_ID
OBSERVME_AGENT_CAPABILITY
traceparent
tracestate
```

Important rules:

- Pass the complete returned `env`; do not merge stale lineage values back afterward.
- Do not set `OBSERVME_AGENT_ID` for a child. The child creates its own logical agent ID.
- `OBSERVME_AGENT_DEPTH` carries the parent depth; the child increments it.
- The child accepts lineage only from its Pi process environment, not project `.env`.
- When trace propagation is enabled, `traceparent` is required and duplicate parent trace/span metadata must agree with it.
- Never log or persist the full environment.

Names can be changed in ObservMe configuration. This is another reason to use the returned environment rather than hardcoding defaults.

## Child requirements

The child Pi process must:

1. load a compatible ObservMe package;
2. receive the returned environment unchanged;
3. use the same or a compatible OTLP destination;
4. run in a trusted project when project-local ObservMe configuration is required;
5. avoid `--no-extensions` unless ObservMe is explicitly loaded again with `-e`.

A child that loads ObservMe without the envelope is still observable, but it appears as a separate root-like runtime. A malformed or partial envelope fails open and emits bounded orphan/propagation diagnostics.

The parent-side `childAgentId` is a bounded placeholder until the child's generated agent ID is reported through the orchestrator's own RPC, status-file, or result protocol. Use `spawnId`, workflow ID, and trace context as the initial cross-process correlation. Do not propagate the placeholder as `OBSERVME_AGENT_ID`.

## Transport requirements

The integration API is transport-agnostic. A launcher can use a local subprocess, Pi RPC, JSON/print mode, tmux, SSH, a container runtime, a queue, or another process manager as long as it:

- passes the returned environment unchanged to the child Pi process;
- does not serialize the envelope or raw task into telemetry or captured logs;
- reports launcher failure separately from child completion, failure, or cancellation;
- records wait and join around the transport's actual blocking and result-collection boundaries;
- guarantees the child loads a compatible ObservMe extension;
- cleans up temporary files, pipes, sessions, containers, or remote resources deterministically.

Transport-specific environment behavior remains the launcher's responsibility. For example, a long-running tmux server can cache an old environment, an SSH command can expose arguments in logs, and a container runtime can require an explicit environment allowlist. Use the transport's secure environment mechanism instead of embedding the envelope in a shell command.

See [`../examples/integrations/subagent-runner.ts`](../examples/integrations/subagent-runner.ts) for a generic transport adapter and [`agent-subagent-observability-requirements.md`](agent-subagent-observability-requirements.md) for detailed orchestration considerations.

## Telemetry produced by a complete integration

A complete parent/child flow can produce:

- spans: `pi.agent.spawn`, `pi.agent.wait`, `pi.agent.join`, and the child's normal `pi.session`/agent/turn/LLM/tool spans;
- metrics: spawn count/failure/duration, wait/join duration, active agents, depth, width, fan-out, orphan and propagation failures, child failures, and parent recovery;
- logs: `agent.spawn.*`, `agent.wait.*`, `agent.join.*`, `agent.orphaned`, and `trace_context.propagation_failed`.

Workflow, session, agent, spawn, trace, and span identifiers remain trace/log attributes only. Aggregate metric labels use bounded fields such as role, depth, spawn type/reason, status, reason, and error class.

## Supported boundaries and non-goals

| Integration | Supported behavior |
| --- | --- |
| Direct child `pi` process | Full parent spawn/wait/join telemetry and child trace continuation when the child loads ObservMe and receives the returned environment. |
| Process-manager child Pi | Supported with explicit environment handling appropriate to the selected transport. |
| RPC, JSON, or print-mode child Pi | Supported; the orchestration transport determines task/result handling while ObservMe handles telemetry correlation. |
| Remote child Pi | Supported when the launcher transmits the envelope securely, the child loads ObservMe, and both sides export to compatible backends. Do not print the envelope into remote shell logs. |
| Non-Pi subprocess | Parent launcher telemetry can be recorded, but the subprocess does not emit Pi session/turn/LLM/tool telemetry unless it is itself instrumented. |
| Arbitrary custom metrics/logs/spans | Not exposed by this API. The API intentionally limits labels and event names to the ObservMe orchestration contract. Propose a versioned semantic addition instead of accepting arbitrary telemetry names or labels. |
| Orchestration control | Not provided. Task queues, process/session management, RPC, retries, concurrency, status transport, result storage, and cleanup remain the orchestrator's responsibility. |

## Dependency and versioning guidance

The example imports `@senad-d/observme/integration` because it ships inside the same ObservMe package. A separately distributed Pi package has two choices:

1. Add `@senad-d/observme` as a development/runtime dependency according to its packaging strategy so the helper and types resolve, while still requiring users to load ObservMe as a Pi extension.
2. Avoid a runtime dependency by emitting the documented `observme:integration:request` event locally and using an `import type` during development. The runtime protocol is the shared Pi event channel, not shared module state.

Pi packages can have separate module roots. Do not assume that an independently installed ObservMe package is automatically resolvable as a Node module from another package, and do not load a bundled second ObservMe extension accidentally. Runtime negotiation determines whether one compatible ObservMe integration provider is actually loaded.

The current public integration version is `1`. Additive API changes can preserve version 1; incompatible behavior requires a new negotiated version.

## Related documentation

- [Documentation index](README.md)
- [Agent and subagent orchestration requirements](agent-subagent-observability-requirements.md)
- [Pi event and session model](reference/03-pi-event-and-session-model.md)
- [Telemetry semantic conventions](reference/04-telemetry-semantic-conventions.md)
- [Configuration reference](reference/12-configuration-reference.md)
