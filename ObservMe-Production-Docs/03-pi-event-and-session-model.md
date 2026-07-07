# Pi Event and Session Model for ObservMe

## 1. Purpose

This document defines how ObservMe interprets Pi events and session files. The Pi session file is not ObservMe storage. It is a canonical Pi execution record that ObservMe may use as an event source, correlation source, and recovery source.

## 2. Pi Session Entries Relevant to ObservMe

ObservMe must understand these entry types:

- `session`
- `message`
- `model_change`
- `thinking_level_change`
- `compaction`
- `branch_summary`
- `custom`
- `custom_message`
- `label`
- `session_info`

## 3. Message Roles and Entry Types Relevant to ObservMe

For real-time capture, ObservMe should prefer Pi extension events (`session_start`, `agent_start`, `agent_end`, `turn_start`, `before_provider_request`, `after_provider_response`, `message_*`, `tool_execution_*`, `tool_call`, `tool_result`, `user_bash`, `model_select`, `thinking_level_select`, `session_compact`, `session_tree`, and `session_shutdown`). Session entries are still authoritative for startup recovery, explicit backfill, `/obs session`, and cross-checking event payloads.

### `user`

Used to detect user turns and optionally capture redacted prompt content.

Default telemetry:

- role
- timestamp
- content length
- content hash
- image count if multimodal

Optional telemetry:

- prompt text
- image metadata

### `assistant`

Used to capture provider/model/usage/cost and tool calls.

Default telemetry:

- provider
- model
- api
- stopReason
- usage.input
- usage.output
- usage.cacheRead
- usage.cacheWrite
- usage.cacheWrite1h if reported by the provider
- usage.reasoning if reported by the provider
- usage.cost.total
- responseModel and responseId when available
- diagnostics count when present
- tool call count
- error class if present

Optional telemetry:

- response text
- thinking content
- tool call arguments

### `toolResult`

Used to close tool spans and emit tool metrics.

Default telemetry:

- toolCallId
- toolName
- isError
- content length
- content hash

Optional telemetry:

- tool result body

### `bashExecution`

Used for command execution observability.

Default telemetry:

- command fingerprint
- exitCode
- cancelled
- truncated
- duration if derivable from event timestamps
- output length
- fullOutputPath presence

Optional telemetry:

- command string
- output body

### `custom` entry

Extension state entry created through `pi.appendEntry()`. It does not participate in LLM context. ObservMe should append a custom entry only for explicitly enabled minimal correlation state; by default it should not append custom entries.

### `custom_message` entry

Extension-injected context entry created through `pi.sendMessage()`/`appendCustomMessageEntry()`. It participates in LLM context and can alter agent behavior. ObservMe must not use `custom_message` for telemetry bookkeeping.

## 4. Session Tree Implications

Pi sessions are tree-shaped via `id` and `parentId`. ObservMe telemetry must preserve this structure.

Required attributes:

```text
pi.entry.id
pi.entry.parent_id
pi.entry.type
pi.branch.path_hash
pi.leaf.id
```

Branch events must include:

```text
pi.branch.from_id
pi.branch.to_id
pi.branch.common_ancestor_id        # if available
pi.branch.summary.hash
```

## 5. Context and Compaction

Compaction changes what the LLM sees, but it does not delete the historical session file. ObservMe should emit compaction telemetry from the `session_compact` event, which carries the saved `compactionEntry`, `reason`, `willRetry`, and whether the summary came from an extension.

Required fields:

```text
pi.compaction.first_kept_entry_id
pi.compaction.tokens_before
pi.compaction.summary.hash
pi.compaction.from_hook
pi.compaction.reason
pi.compaction.will_retry
```

Optional fields:

```text
pi.compaction.read_files_count
pi.compaction.modified_files_count
```

## 6. Event-to-Span Mapping

| Pi Source | ObservMe Operation |
|---|---|
| `session_start` | start `pi.session` span and initialize resource/session attributes |
| `agent_start` / `agent_end` | start/end a `pi.agent.run` span for one user-prompt lifecycle; turns are children of this span |
| `turn_start` / `turn_end` | start/end `pi.turn` span using `turnIndex` and finalized turn data |
| `before_provider_request` | start GenAI client span and record provider request metadata available from payload/`ctx.model` |
| `after_provider_response` | record provider HTTP status/headers that are safe to capture |
| `message_update` | optionally record streaming progress such as first-token/chunk timing |
| assistant `message_end` | record final model result, stop reason, usage, cost, and end GenAI span |
| assistant toolCall block from finalized message | prepare correlation for tool spans when needed |
| `tool_execution_start` | start `pi.tool.call` span before execution |
| `tool_call` | validate/record mutable tool input metadata and blocking outcome |
| `tool_result` / `tool_execution_end` | record result metadata and end `pi.tool.call` span |
| parent tool/extension launches another Pi agent | emit `pi.agent.spawn` span and propagate trace/workflow/agent lineage to the child |
| parent tool/extension waits for or receives child agent result | emit `pi.agent.wait` / `pi.agent.join` spans or events with child status and critical-path timing |
| `toolResult` message | cross-check persisted tool result order and content hashes |
| `user_bash` plus `bashExecution` session message | create or complete `pi.bash.execution` telemetry for `!`/`!!` commands |
| `model_select` plus `model_change` entry | emit model-change log event and metric |
| `thinking_level_select` plus `thinking_level_change` entry | emit thinking-level-change log event and metric |
| `session_compact` | emit compaction span/log/metric from `compactionEntry` |
| `session_tree` | emit branch/tree-navigation span/log/metric and include `summaryEntry` when present |
| `session_shutdown` | end open spans and flush exporters within timeout |

The root `pi.session` span is intentionally long-lived and remains open until `session_shutdown`. During an active session, Tempo searches may show ended child spans before the root span is exported; post-shutdown traces must include the canonical `pi.session` root with the session and workflow attributes.

## 7. Correlation IDs

ObservMe must maintain the following IDs:

```text
observme.instance.id       # unique per extension process startup
observme.export.session_id # same as pi.session.id if available
pi.session.id
pi.workflow.id             # generated workflow/root execution id, high-cardinality trace/log attribute
pi.workflow.root_agent_id
pi.agent.id                # logical Pi agent runtime
pi.agent.parent_id         # parent agent when this is a subagent
pi.agent.root_id           # root agent in the lineage tree
pi.agent.run.id            # one user-prompt lifecycle from agent_start to agent_end
pi.agent.spawn.id          # individual subagent spawn operation if known
pi.entry.id
pi.turn.id
pi.tool_call.id
trace_id
span_id
```

## 8. Multi-Agent and Subagent Lineage

Pi's documented extension events identify sessions, agent prompt lifecycles, turns, tools, and session-tree changes. They do not provide a built-in cross-process subagent lineage event. Therefore ObservMe must create and propagate lineage when an extension/tool starts another Pi agent.

Required lineage behavior:

1. Generate `pi.agent.id` when the ObservMe runtime starts unless a trusted parent supplied one for a resumed child context.
2. Set `pi.agent.root_id = pi.agent.id` for root agents.
3. Generate `pi.workflow.id` in the root agent unless a trusted parent supplied one, and preserve it across every descendant.
4. For subagents, set `pi.agent.parent_id` to the parent `pi.agent.id`, preserve `pi.agent.root_id`, and increment `pi.agent.depth`.
5. Create a `pi.agent.spawn` span around the parent operation that launches the child process.
6. When the parent waits for or receives the child result, emit `pi.agent.wait` and/or `pi.agent.join` spans/events so critical-path latency is visible.
7. Propagate W3C `traceparent`/`tracestate` plus ObservMe lineage environment variables such as `OBSERVME_WORKFLOW_ID`, `OBSERVME_PARENT_AGENT_ID`, `OBSERVME_ROOT_AGENT_ID`, and `OBSERVME_PARENT_SESSION_ID`.
8. In the child, continue the trace when trace context is available; otherwise start a new trace and attach a span link or log event with parent trace/span metadata.
9. If a child starts with malformed or missing parent lineage, classify it as root or orphan according to config and emit an orphan log/metric.

Workflow IDs and agent IDs must be generated identifiers or salted hashes. Never derive them directly from raw cwd, username, prompt text, or command line. They are high-cardinality and must not be metric labels.

## 9. Turn Identification

Pi extension events provide `turnIndex`, not a durable session-file turn id. ObservMe should derive a stable-in-process turn id from `pi.session.id`, `pi.agent.run.id`, active branch/leaf context, and `turnIndex`. If a future Pi API provides a durable turn id, ObservMe must prefer it.

Derived format:

```text
agent-run-000001-turn-000001
agent-run-000001-turn-000002
```

The derived id must be scoped by session id and agent run id and must not be used as a metric label.

## 10. Recovery Behavior

On extension startup in an existing session:

1. Read current session header if available.
2. Set `pi.session.id`, `pi.workflow.id`, `pi.agent.id`, and resource attributes.
3. Reconstruct optional workflow/agent lineage only from trusted environment variables or an explicitly enabled minimal custom correlation entry.
4. Do not replay old telemetry by default.
5. Optionally support `replayOnStart: true` for backfill, but it must be off by default.
6. If replay is enabled, mark spans/logs with `observme.replayed=true`.

## 11. Local Session Reading Rules

Allowed:

- Read header on startup.
- Read current branch on `/obs session`.
- Read entries for explicit `/obs backfill` command.

Not allowed by default:

- Continuous tailing of session file when lifecycle events are sufficient.
- Storing parsed session data locally.
- Appending telemetry summaries into Pi context.
