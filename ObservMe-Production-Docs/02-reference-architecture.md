# ObservMe Reference Architecture

## 1. High-Level Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│                          Pi Agent                            │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                ObservMe Extension                      │  │
│  │                                                        │  │
│  │  Event Capture  -> Semantic Mapper -> OTEL Emitters    │  │
│  │       │                 │               │              │  │
│  │       │                 │               ├─ Traces      │  │
│  │       │                 │               ├─ Metrics     │  │
│  │       │                 │               └─ Logs        │  │
│  │       │                 │                              │  │
│  │       └──── Query Commands /obs ───────────────────────┘  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬───────────────────────────────┘
                               │ OTLP HTTP/protobuf (4318) or gRPC (4317)
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                    OpenTelemetry Collector                   │
│                                                              │
│  Receivers -> Processors -> Exporters                        │
│                                                              │
│  processors: memory_limiter, batch, attributes/filter, sampling │
└──────────────┬────────────────┬────────────────┬─────────────┘
               │                │                │
               ▼                ▼                ▼
            Tempo             Loki          Prometheus/Mimir
            Traces            Logs             Metrics
               └────────────────┬────────────────┘
                                ▼
                             Grafana
```

## 2. Component Responsibilities

### 2.1 ObservMe Pi Extension

Responsibilities:

- Subscribe to Pi lifecycle events.
- Read Pi event/session metadata from event payloads and session APIs.
- Maintain in-memory span context and workflow/agent lineage context.
- Create OTEL traces, metrics, and logs.
- Redact sensitive values before export.
- Provide `/obs` commands for health, links, and downstream queries.

Not responsible for:

- Long-term telemetry storage
- Heavy aggregation
- Dashboard rendering engine
- Backend-specific data retention
- Collector-side sampling
- Durable agent registry storage

### 2.2 Agent and Subagent Correlation

Each ObservMe runtime has an extension instance identity, a workflow identity, and a logical agent identity:

```text
observme.instance.id    # unique ObservMe extension process startup
pi.workflow.id          # generated root workflow/execution id, high-cardinality trace/log attribute
pi.workflow.root_agent_id
pi.agent.id             # logical Pi agent runtime
pi.agent.parent_id      # parent agent when spawned as a subagent
pi.agent.root_id        # root of the agent tree
pi.agent.depth          # bounded integer depth
```

When a Pi tool or extension starts another Pi agent, ObservMe should create a `pi.agent.spawn` span under the current turn/tool span and pass correlation to the child through environment variables and W3C trace context. If the child receives `traceparent`, its `pi.session` span can continue the parent trace. If it cannot continue the trace, it must still record `pi.agent.parent_id`, `pi.agent.root_id`, and a span link or log event so Grafana can reconstruct lineage.

`pi.workflow.id`, `pi.workflow.root_agent_id`, `pi.agent.id`, `pi.agent.parent_id`, and `pi.agent.spawn.id` are high-cardinality identifiers. They belong in resource/span/log attributes and trace links, not Prometheus labels.

For orchestrator workloads, ObservMe treats the root agent and every descendant as one logical workflow tree. The root agent creates `pi.workflow.id`; descendants inherit it through environment propagation. Aggregate metrics describe the tree using low-cardinality dimensions such as `agent_role`, `agent_capability`, `subagent_depth`, `spawn_type`, `spawn_reason`, and `status`, while per-workflow drill-down uses Tempo/Loki attributes.

### 2.3 OpenTelemetry Collector

Responsibilities:

- Receive OTLP from ObservMe.
- Batch telemetry and retry when exporter `sending_queue`/`retry_on_failure` settings are enabled.
- Apply memory limits.
- Apply central redaction/filtering when needed.
- Route traces to Tempo.
- Route logs to Loki.
- Route metrics to Prometheus/Mimir.

Recommended processors:

```yaml
processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 512
    spike_limit_mib: 128
  batch:
    timeout: 2s
    send_batch_size: 1024
    send_batch_max_size: 2048
```

Optional processors such as `probabilistic_sampler` and `tail_sampling` are useful at scale. Verify they are included in the Collector distribution you deploy; several advanced processors/exporters are in the Collector Contrib distribution rather than the minimal core distribution.

### 2.4 Tempo

Stores traces. Trace granularity is session -> agent run -> turn -> operation.

Tempo is best used for:

- Session timeline
- Root cause analysis
- Latency breakdown
- Tool/LLM correlation
- Trace-to-log and trace-to-metric linking

### 2.5 Loki

Stores structured logs. Loki is best used for:

- Redacted prompt/response capture if enabled
- Tool arguments/results if enabled
- Error bodies
- Session audit event stream
- Searching historical sessions without local Pi logs

### 2.6 Prometheus / Mimir

Stores metrics. Used for:

- Cost dashboards
- Token dashboards
- Latency dashboards
- Alerting
- SLO monitoring
- Aggregation across agent roles/depths, projects, users, models, providers

## 3. Data Flow

### 3.1 Session Start

```text
Pi emits session_start
ObservMe creates root span pi.session
ObservMe emits log event session.started
ObservMe increments session counter
```

### 3.2 Agent Run and Turn Start

```text
Pi emits agent_start
ObservMe creates child span pi.agent.run for the user prompt lifecycle
Pi emits turn_start for each LLM/tool iteration
ObservMe creates child span pi.turn under the active pi.agent.run
ObservMe records current model, cwd hash, session id, agent id, agent run id, turn id
```

### 3.3 LLM Request

```text
Pi emits before_provider_request before the provider payload is sent
ObservMe creates a GenAI client span (`pi.llm.request` or official `chat <model>` naming)
Attributes: provider, model, api, estimated input, settings
Pi emits message_update/message_end for the assistant response
ObservMe ends the span and updates usage/cost metrics from the finalized assistant message
```

### 3.4 Tool Call

```text
Pi emits tool_execution_start and tool_call before execution
ObservMe creates pi.tool.call span
Pi emits tool_result/tool_execution_end and later a toolResult message
ObservMe closes the span from tool result/execution-end data
Metrics update success/failure and latency
```

### 3.5 Subagent Spawn and Agent-Tree Flow

```text
A parent tool/extension decides to start another Pi agent
ObservMe creates pi.agent.spawn span with spawn id, workflow id, parent agent id, parent session id, tool call id
ObservMe propagates traceparent/tracestate, OBSERVME_WORKFLOW_ID, and OBSERVME_AGENT_* environment variables to the child
Child ObservMe runtime starts pi.session with pi.workflow.id, pi.agent.parent_id, and pi.agent.root_id
If the parent waits for the child, ObservMe records pi.agent.wait and/or pi.agent.join spans/events
Metrics increment subagent spawn, fan-out, depth, active-agent, wait/join, orphan, and propagation-failure counters/histograms; per-agent drill-down uses traces/logs, not metric labels
```

### 3.6 Compaction

```text
Pi emits session_compact with compactionEntry
ObservMe emits pi.compaction span/event/log
Metrics increment compaction counters and tokens_before histogram
```

### 3.7 Branching

```text
Pi emits session_tree after tree navigation; summaryEntry is present when a branch summary was written
ObservMe emits pi.branch span/event/log
Metrics increment branch counters
```

### 3.8 Shutdown

```text
Pi emits session_shutdown
ObservMe closes root span
Flushes OTEL SDK with timeout
No infinite blocking allowed
```

## 4. Trace Shape

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

## 5. Multi-Agent Operational Signals

For orchestrator workloads, operators should watch these signals closely:

| Signal | Why it matters | Primary telemetry |
|---|---|---|
| Fan-out per parent operation | Detects runaway delegation and cost amplification | `observme_agent_fanout_count`, `pi.agent.child.count` |
| Tree depth and width | Detects unexpectedly deep/large agent trees | `observme_agent_tree_depth`, `observme_agent_tree_width`, `subagent_depth` |
| Active agents | Detects stuck or leaked child agents | `observme_active_agents`, `pi.agent.children.active` |
| Orphan agents | Detects broken lineage propagation | `observme_orphan_agents_total`, `agent.orphaned` logs |
| Trace-context propagation failures | Detects fragmented traces | `observme_trace_context_propagation_failures_total`, span links/log fallback |
| Wait/join latency | Shows critical path and slow child results | `pi.agent.wait`, `pi.agent.join`, `observme_agent_wait_duration_ms`, `observme_agent_join_duration_ms` |
| Child-agent failures and recovery | Separates child failure from parent workflow failure | `observme_child_agent_failures_total`, `observme_parent_recovered_from_child_failure_total` |
| Cost by role/depth | Shows cost amplification without workflow IDs as labels | existing token/cost metrics labeled by `agent_role`, `agent_capability`, `subagent_depth`, provider, and model |

Per-workflow and per-agent drill-down should use Tempo/Loki attributes such as `pi.workflow.id`, `pi.agent.id`, `pi.agent.parent_id`, and trace/span IDs. These identifiers must not become Prometheus labels by default.

## 6. Deployment Topologies

### 5.1 Local Development

```text
Pi -> localhost:4318 -> Collector -> debug exporter
```

Used for extension testing.

### 5.2 Developer Workstation with Shared Collector

```text
Pi -> regional collector DNS -> Grafana stack
```

Recommended when developers run Pi locally but telemetry must be centralized.

### 5.3 Ephemeral CI Agent

```text
CI Pi container -> sidecar collector -> central collector gateway -> Grafana stack
```

Sidecar collector provides fast local handoff and retries while the job is alive.

### 5.4 Kubernetes

```text
Pi pod -> daemonset collector -> gateway collector -> Tempo/Loki/Mimir
```

Recommended for scale and centralized policy.

## 7. Failure Modes

| Failure | Expected Behavior |
|---|---|
| Collector unavailable | Drop after bounded retry; Pi continues |
| Backend unavailable | Collector buffers/retries if configured; Pi unaffected |
| Redaction failure | Drop sensitive field and emit redaction error metric |
| Span context lost | Emit orphan span with session id and agent id attributes |
| Subagent trace context not propagated | Emit child trace with `pi.agent.parent_id`, `pi.agent.root_id`, `pi.workflow.id`, and span/log link metadata; increment propagation failure counter |
| Orphan child agent | Mark as root or orphan according to config, emit `agent.orphaned` log, increment orphan counter |
| Runaway agent fan-out/depth | Continue exporting fail-open but emit high fan-out/depth metrics and alerts; never block Pi by default |
| Queue full | Drop telemetry and increment drop counter |
| Shutdown timeout | Abort flush after configured timeout |

## 8. Extension Boundary

ObservMe should not parse the full session file continuously during normal operation if Pi events provide the data. It may read session state on startup or command execution to reconstruct current session context, but runtime observability should be event-driven.
