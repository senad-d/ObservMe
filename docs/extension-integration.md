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

### Package helper

Packages that declare a real ObservMe dependency should import the explicit v2 helper and types from the package subpath:

```typescript
import {
  requestObservMeIntegrationV2,
  type ObservMeChildDescriptor,
  type ObservMeIntegrationApiV2,
} from "@senad-d/observme/integration";

const observme: ObservMeIntegrationApiV2 | undefined = requestObservMeIntegrationV2(pi);
```

The unsuffixed exports remain the source-compatible v1 surface. `OBSERVME_INTEGRATION_VERSION`, `ObservMeIntegrationApi`, `ObservMeStartSubagentOptions`, and `requestObservMeIntegration()` still mean v1 and do not require child identity. V2 is opt-in through `OBSERVME_INTEGRATION_VERSION_V2`, suffixed v2 types, and `requestObservMeIntegrationV2()`.

| Helper | Versions advertised | Return behavior |
| --- | --- | --- |
| `requestObservMeIntegration()` | `[1]` | First structurally valid synchronous v1 response, or `undefined`. |
| `requestObservMeIntegrationV2()` | `[2, 1]` | Highest structurally valid synchronous response, but returns it only when it is v2; a v1-only result is exposed as `undefined`. |

ObservMe registers no global object and does not expose its private telemetry session. The event bus is the runtime boundary; the package subpath is a convenience for constants, types, structural guards, and request helpers.

The API can be absent when ObservMe is not installed or loaded, is incompatible, or cannot register/respond through the shared event bus. When ObservMe is loaded, the provider can still be discovered before session startup or while `enabled: false`; methods then return `{ ok: false, reason: "session_unavailable" }` because no telemetry session is active. Once session shutdown begins, discovery is unsubscribed and every method on a previously cached API returns `{ ok: false, reason: "session_closing" }` until cleanup finishes, without changing spans, agent trees, metrics, or runtime hints. Orchestration must remain functional in all cases and may run the child without ObservMe correlation after reporting a bounded local warning.

### Package-decoupled wire contract

Separately installed Pi packages can have different Node module roots. An intentionally decoupled package may mirror the following wire shape locally and must not rely on `instanceof`, constructor identity, symbol identity, or shared module state:

```typescript
const channel = "observme:integration:request";

pi.events.emit(channel, {
  supportedVersions: [2, 1],
  respond(candidate: unknown) {
    // Collect structurally valid synchronous candidates here.
  },
});
```

The request is an object with a `supportedVersions` array of positive safe integers and a `respond(api)` callback. A provider responds once with its highest mutually supported version. A v2 response is an object with:

- `version: 2`;
- frozen `childRoles` exactly equal to `lead`, `helper`, `worker`, `validator` in that order;
- `childIdentityEnvelopeVersion: 1`;
- callable `getContext`, `startSubagent`, `completeSubagent`, `failSubagent`, `startWait`, `endWait`, `startJoin`, and `endJoin` methods.

A v1 response has `version: 1` and the same lifecycle methods, but no `childRoles` or `childIdentityEnvelopeVersion` field and no required `child` option. Package-decoupled consumers should validate fields structurally and treat accessor errors or malformed candidates as absent providers.

Discovery and selection are synchronous. Collect valid responses only until `pi.events.emit()` returns, select the highest version, use the first response in Pi load order only to break a same-version tie, and ignore every late callback. V2-aware clients advertise `[2, 1]`; array order does not force a provider to return a lower version. Request the API when the user or tool starts orchestration, not from the extension factory. If a `session_start` handler must launch work automatically, account for extension handler ordering and retry only after ObservMe has an active session.

### Identity concepts

V2 keeps presentation, telemetry classification, and lifecycle correlation separate:

| Concept | Contract |
| --- | --- |
| `displayName` | Launcher-owned human-readable label, 1–128 Unicode scalar values, no control characters, no invalid Unicode. It is not an ID, authorization input, or metric label. Duplicate names are valid. |
| `role` | Exactly `lead`, `helper`, `worker`, or `validator`. In the approved role order, a lead coordinates, a helper provides scoped assistance, a worker executes assigned work, and a validator independently checks it. ObservMe records the value; it grants no authority and infers nothing from role or depth. |
| `capability` | Stable launcher-defined machine value, 1–64 ASCII characters matching `[A-Za-z0-9][A-Za-z0-9._:-]*`. It is a resource/span/log/UI attribute, not a metric label unless a later bounded allowlist contract says otherwise. |
| Technical IDs | `spawnId`, `childAgentId`, workflow, task, attempt, instance, session, trace, and span IDs remain correlation keys. Display name, role, and capability never replace them. |

V2 supplies no descriptor or field defaults: all three fields are required for every launch. Validation is exact; ObservMe does not trim, normalize, rewrite, or partially accept a descriptor. A malformed descriptor returns `invalid_request` before observability or propagation state is created.

## Required parent lifecycle

Use this order for each child process:

1. Request the v2 ObservMe integration API when child identity is required.
2. Call `startSubagent()` with one complete child descriptor immediately before launching the child.
3. Pass the returned `env` as the child process environment without logging it.
4. Call `failSubagent()` only when the launcher fails before the child is running.
5. Call `startWait()`/`endWait()` around time spent waiting for child completion.
6. Call `completeSubagent()` once with the matching terminal `childStatus` and `outcome` (`completed`, `failed`, or `cancelled`).
7. Call `startJoin()`/`endJoin()` when collecting a child status or result.

Classify launcher and wait outcomes before changing child state:

| Transport outcome | Child state | Join state | Required ownership |
| --- | --- | --- | --- |
| Launcher rejects before returning a handle | `failed` | No join | Call `failSubagent()`; no child is running. |
| Launcher is cancelled before returning a handle | `cancelled` | No join | End the cancelled launch attempt without recording child failure. |
| Wait returns `completed`, `failed`, or `cancelled` | Matching terminal state | Matching terminal state | Call `completeSubagent()` exactly once. |
| Wait returns `timeout` | Keep `active` | `timeout` | Retain the handle and wait again, or explicitly cancel through the owning transport. |
| Wait throws an abort/cancellation error | Keep `active` | `cancelled` | The caller stopped waiting; do not infer that the child stopped. |
| Wait throws a transport/read error | Keep `active` | `unknown` | Repair/retry result delivery; do not infer child failure. |

The shared `classifyObservMeRunnerOutcome()` helper implements these rules. A returned `cancelled` status is a confirmed terminal child result; a thrown `AbortError` from a wait describes the caller's wait operation and is non-terminal for the child. The packaged runner's `start()` method returns an `ObservableSubagentExecution` whose `wait()` method can be retried after timeout, abort, or transport failure. The `run()` method is a one-wait convenience; use `start()` whenever later completion must remain reachable through the adapter.

```typescript
const observme = requestObservMeIntegrationV2(pi);
const childDescriptor: ObservMeChildDescriptor = {
  displayName: "Scout",
  role: "worker",
  capability: "code-search",
};
const started = observme?.startSubagent({
  child: childDescriptor,
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
if (result.status !== "timeout") {
  observme.completeSubagent(started.spawnId, {
    childAgentId: started.childAgentId,
    childStatus: result.status,
    outcome: result.status,
  });
}
```

If the wait times out, retain `child` and the ObservMe spawn identifiers for a later wait/completion or explicitly cancel the child through the transport. Do not convert timeout, wait abort, or result-channel failure into `failed` child completion.

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
| `childAgentId` | Optional bounded parent-side placeholder; this is not propagated as the child's real agent ID and must remain unique while its active or terminal node is retained. |
| `command` / `args` | Used only to create a salted command fingerprint when configured; raw values are not exported. Omit them if the launcher cannot safely provide them. |
| `spawnType` | `command`, `tool`, `extension`, or `unknown`. |
| `spawnReason` | `delegated_task`, `parallel_search`, `review`, `tool_wrapper`, or `unknown`. |
| `toolCallId` | Optional high-cardinality trace/log correlation when a tool initiated the spawn. |
| `env` | Base child environment. ObservMe removes stale lineage/W3C/identity keys and returns the replacement environment. |
| `child` | Required in v2 and absent from v1: exact `displayName`, `role`, and `capability` descriptor defined above. |

Runtime callers are validated even when JavaScript bypasses the TypeScript types. Caller-provided lifecycle identifiers must match `[A-Za-z0-9._:-]{1,128}`. Commands and individual arguments are capped at 4096 characters, argument lists at 256 items, environment objects at 4096 entries, environment keys at 256 characters, and `errorClass` at 256 characters. Environment keys must be non-empty and contain neither `=` nor NUL; values may be strings or explicit `undefined` tombstones and must not contain NUL. Durations must be finite, non-negative safe milliseconds. Invalid or duplicate active operations return a failure without replacing an existing span. Child placeholders, including generated placeholders, are collision-checked before span, tree, metric, or propagation state is created; do not reuse a terminal placeholder while its bounded tree node remains retained.

Completion accepts only terminal child states (`completed`, `failed`, `cancelled`), and any supplied outcome must match. Wait/join methods use bounded child states (`starting`, `active`, `completed`, `failed`, `cancelled`, `orphaned`), join states (`waiting`, `completed`, `failed`, `cancelled`, `timeout`, `unknown`), and wait reasons (`dependency`, `rate_limit`, `child_running`, `unknown`). Spawn type is `command`, `tool`, `extension`, or `unknown`; spawn reason is `delegated_task`, `parallel_search`, `review`, `tool_wrapper`, or `unknown`. `failurePropagated=false` on a completed join confirms that the parent recovered from a failed child.

Lifecycle results are structural discriminated unions:

| Operation | Success shape |
| --- | --- |
| `getContext()` | `{ ok: true, context }` |
| `startSubagent()` | `{ ok: true, spawnId, childAgentId, env, traceContextPropagated }` |
| `startWait()` / `startJoin()` | `{ ok: true, id }` |
| Completion/failure/end methods | `{ ok: true }` |

Every operation can instead return `{ ok: false, reason }`. Handle these reasons without crashing Pi:

| Reason | Meaning |
| --- | --- |
| `session_unavailable` | ObservMe is loaded but no telemetry session is active. |
| `session_closing` | Session shutdown has started. Do not retry the cached API; finish orchestration without new ObservMe mutations. |
| `invalid_request` | An identifier, enum, duration, command/argument field, or environment shape is invalid or oversized. |
| `spawn_already_exists` / `wait_already_exists` / `join_already_exists` | The requested lifecycle identifier is already active. Generate a unique identifier or finish the active operation; do not overwrite it. |
| `child_agent_already_exists` | The requested or generated child placeholder belongs to an active spawn or retained tree node. Generate a unique child identifier; do not reuse terminal placeholders. |
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
OBSERVME_CHILD_IDENTITY_ENVELOPE_VERSION
OBSERVME_AGENT_DISPLAY_NAME
OBSERVME_AGENT_ROLE
OBSERVME_AGENT_CAPABILITY
traceparent
tracestate
```

Important rules:

- Pass the complete returned `env`; do not merge stale lineage or child-identity values back afterward.
- In v2, ObservMe scrubs all configured identity keys and then writes marker `1` plus the complete requested descriptor. Child metadata replaces stale inherited parent or previous-child metadata.
- In v1, ObservMe scrubs identity keys, writes no identity marker or descriptor, retains legacy child role `subagent`, and does not inherit the parent's capability.
- A child reads identity only after a supported marker and accepts it atomically. Marker-free, partial, malformed, contradictory, or future-version identity fails open with one bounded value-free propagation diagnostic; no field is partially interpreted.
- Explicit trusted runtime identity options take precedence over propagated identity. Otherwise a complete supported envelope wins; without one, legacy/root defaults apply. Project `.env` configuration cannot establish lineage or child identity.
- Do not set `OBSERVME_AGENT_ID` for a child. The child creates its own logical agent ID.
- `OBSERVME_AGENT_DEPTH` carries the parent depth; the child increments it.
- The child accepts lineage only from its Pi process environment, not project `.env`.
- A missing `traceparent` does not invalidate the lineage envelope: the child joins the workflow, starts a new trace, and emits `trace_context.propagation_failed` fallback telemetry. A present-but-malformed `traceparent` invalidates the envelope, and duplicate parent trace/span metadata must agree with it.
- Never log or persist the full environment.

Names can be changed in ObservMe configuration. This is another reason to use the returned environment rather than hardcoding defaults.

## Child requirements

The child Pi process must:

1. load a compatible ObservMe package; child-identity envelope version 1 requires `@senad-d/observme` 0.1.8 or later;
2. receive the returned environment unchanged;
3. use the same or a compatible OTLP destination;
4. run in a trusted project when project-local ObservMe configuration is required;
5. avoid `--no-extensions` unless ObservMe is explicitly loaded again with `-e`.

A child that loads ObservMe without the lineage envelope is still observable, but it appears as a separate root-like runtime. A malformed or partial envelope fails open and emits bounded orphan/propagation diagnostics. Negotiating a v2 root provider proves only the in-process lifecycle API; it does not prove that an explicitly loaded child extension can read identity envelope version 1. Launchers using `--no-extensions` must add ObservMe back explicitly and pin a compatible child release rather than assuming the root provider's package is reused.

## Troubleshooting: every agent appears as its own root

Pi core emits no subagent event. ObservMe cannot detect a spawn by observation; the launcher must opt in. If every agent and subagent you run shows `pi.agent.role = root` and `pi.agent.depth = 0` in its own workflow, work through this list in order:

1. **The launcher never calls the integration API.** This is the most common cause. The stock Pi example subagent extension, plain `child_process.spawn`, and tmux launchers all start child Pi processes without the ObservMe envelope; each child then generates a fresh workflow and root identity. Fix: wrap the spawn with `startSubagent()` and pass the returned `env` to the child process, or use the adapter in [`../examples/integrations/subagent-runner.ts`](../examples/integrations/subagent-runner.ts).
2. **The launcher calls the API but discards the returned `env`.** Lineage crosses the process boundary only through the returned environment. Spawning with `process.env` or a hand-built environment produces a root child even though the parent recorded a `pi.agent.spawn` span.
3. **The envelope is incomplete, so the child rejects all of it.** When any propagation value is present, the child requires `OBSERVME_WORKFLOW_ID`, `OBSERVME_PARENT_AGENT_ID`, `OBSERVME_ROOT_AGENT_ID`, `OBSERVME_AGENT_DEPTH`, and `OBSERVME_SPAWN_ID` together. One missing variable rejects the whole envelope: the child fails open as an orphaned root and increments `observme_trace_context_propagation_failures_total`. Hand-building the envelope instead of using the returned `env` is the usual trigger. A missing `traceparent` is the exception — lineage still connects, only trace continuity degrades (the child starts a new trace and emits `trace_context.propagation_failed`); a present-but-malformed `traceparent` still rejects the envelope.
4. **Parent and child load different configurations.** A child launched with a different working directory loads that project's `observme.yaml`. If the parent has `workflow.enabled: false` or `agent.propagateToSubagents: false`, no envelope is sent and the child becomes a root. Renamed `*Env` variable names on one side only have the same effect, because the child then sees a partial envelope under its own names.
5. **The child does not load ObservMe at all.** A child started with `--no-extensions` (without re-adding ObservMe via `-e`) emits nothing; there is no root agent in the dashboards — the child is simply invisible.
6. **A subagent re-used its inherited environment for a further spawn.** The envelope a subagent received stays in its `process.env`. Passing that environment directly to a grandchild attaches the grandchild as a *sibling* (same parent, same spawn id) instead of a child, with no orphan warning. Always go through `startSubagent()` again for each spawn; it clears inherited lineage keys before writing current ones.

Quick verification:

- In the child process, check that the `OBSERVME_*` variables and `traceparent` are present (`printenv | grep -E 'OBSERVME|traceparent'` in a Bash tool call, without logging the values elsewhere).
- Run `/obs agents` in the parent: a wired launcher shows the child under recent children with fan-out ≥ 1.
- Query Prometheus for `observme_subagents_spawned_total` (parent side wired) and `observme_orphan_agents_total` / `observme_trace_context_propagation_failures_total` (child received but rejected an envelope).
- Query Loki for `event_name="agent.orphaned"` or `event_name="trace_context.propagation_failed"` with `event_category="agent-tree"`.

Symptom table:

| Observation | Meaning |
| --- | --- |
| No `pi.agent.spawn` span, child is a new root | Launcher never called `startSubagent()` (case 1). |
| `pi.agent.spawn` span exists, child is a new root, no orphan signals | Returned `env` was not passed to the child (case 2), or the child did not load ObservMe (case 5). |
| Child is a root **and** `pi.agent.orphaned = true` with `partial_envelope` | Child received an incomplete envelope (cases 3–4). |
| Grandchild appears as a sibling of its parent | Inherited envelope was reused for a new spawn (case 6). |

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

## OrcMe interoperability profile: shipped v1 versus planned v2

ObservMe publishes this profile as a neutral interoperability contract. It does not claim that OrcMe already ships v2 identity.

**Current reviewed OrcMe behavior:** OrcMe intentionally declares no ObservMe package dependency, mirrors API v1 locally in `src/process/observme.ts`, advertises `[1]`, and launches direct Pi RPC children with `--no-extensions`. Its implemented ObservMe integration is therefore metadata-free v1 behavior; no durable managed display name or v2 child descriptor should be inferred from it.

**Approved downstream plan, not shipped behavior:** once OrcMe adopts v2, it will advertise `[2, 1]` and require a structurally valid v2 result when identity is required. The mapping is exact and does not use aliases or inference:

- durable managed display identity → `displayName`;
- manifest role → `role`, in the order `lead` (coordinates), `helper` (scoped assistance), `worker` (executes assigned work), `validator` (independently checks);
- pinned definition name → `capability`.

Task, attempt, instance, spawn, and child-agent placeholders remain OrcMe lifecycle identifiers. OrcMe managed depth and ObservMe lineage depth remain separate: an OrcMe depth-0 lead can be an ObservMe depth-1 child of an interactive root. ObservMe role telemetry is supplementary evidence only; it grants, infers, or widens no OrcMe authority, and OrcMe's durable task state remains authoritative.

OrcMe's launch contract remains transport-owned: build and sanitize its managed base environment, pass that base to `startSubagent()`, preserve every returned ObservMe value, and carry explicit `undefined` tombstones so Pi RPC's `process.env` overlay cannot restore keys ObservMe removed. Never log, persist, hash, display, or snapshot complete environments or unrelated values. Keep `spawnType: "extension"` and `spawnReason: "delegated_task"`. A duplicate requested `spawnId` or `childAgentId` may be retried once without those technical identifiers, but with the byte-identical descriptor.

Lifecycle ordering remains start immediately before launch, `failSubagent()` once only for pre-handle launch failure, wait calls around actual blocking, `completeSubagent()` exactly once for confirmed terminal child state, and join calls around terminal evidence collection. Export or telemetry failure after a valid launch stays fail-open and never replaces OrcMe task state.

Policy stays explicit: `disabled` performs no ObservMe negotiation; `inherit` follows effective OrcMe configuration; after v2 adoption, `enabled` requires a v2 root provider and an explicitly pinned envelope-compatible child ObservMe release under `--no-extensions`. Each nested delegation must supply a fresh descriptor and use the immediate parent's newly returned environment.

## Dependency and versioning guidance

The example imports `@senad-d/observme/integration` because it ships inside the same ObservMe package. A separately distributed Pi package has two choices:

1. Add `@senad-d/observme` as a development/runtime dependency according to its packaging strategy so the helper and types resolve, while still requiring users to load ObservMe as a Pi extension.
2. Avoid a runtime dependency by mirroring the documented structural interfaces and emitting `observme:integration:request` locally. The runtime protocol is the shared Pi event channel, not shared module state.

Pi packages can have separate module roots. Do not assume that an independently installed ObservMe package is automatically resolvable as a Node module from another package, and do not load a bundled second ObservMe extension accidentally. Runtime negotiation determines whether one compatible ObservMe integration provider is actually loaded.

Integration API v1 remains stable and metadata-free. Integration API v2 and child-identity envelope version 1 first appear in `@senad-d/observme` 0.1.8. Adding, removing, renaming, or changing the meaning of a v2 role requires a later integration API version; the v2 role catalog is not runtime-configurable.

## Related documentation

- [Documentation index](README.md)
- [Agent and subagent orchestration requirements](agent-subagent-observability-requirements.md)
- [Pi event and session model](reference/03-pi-event-and-session-model.md)
- [Telemetry semantic conventions](reference/04-telemetry-semantic-conventions.md)
- [Configuration reference](reference/12-configuration-reference.md)
