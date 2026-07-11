# ObservMe Requirements and Scope

## 1. Product Definition

ObservMe is a Pi extension that instruments Pi agents and sends observability data to an external telemetry platform using OpenTelemetry.

ObservMe must answer questions such as:

- Which Pi sessions are running now?
- Which sessions are expensive?
- Which models are used most often?
- Which tools fail or run slowly?
- Which prompts or tool calls caused high latency?
- How often do agents branch or compact context?
- Which projects, users, or environments generate the most cost?
- What happened in an ephemeral agent after it disappeared?
- Which parent agent spawned a subagent, and what did the child agent do?
- How deep and wide did an orchestrated multi-agent workflow become?
- Which child or grandchild agent was on the critical path?
- Did any child agent become orphaned, fail to report lineage, or continue after the parent finished?
- Did one orchestrator prompt amplify cost, latency, or tool usage through excessive fan-out?

## 2. Personas

### Platform Engineering

Needs centralized observability, retention, SLOs, alerts, and tenant isolation.

### AI Platform Owner

Needs cost, model usage, prompt efficiency, failure analysis, and quality signals.

### Developer Using Pi

Needs quick session diagnostics from inside Pi via `/obs` commands.

### Security / Compliance

Needs prompt capture off by default, redaction controls, audit trails, and safe handling of code and secrets.

## 3. Hard Requirements

### 3.1 External Durability

ObservMe must not depend on local Pi storage for telemetry durability. Pi sessions may be ephemeral or deleted. Telemetry must be exported to a central durable backend as close to real time as possible.

### 3.2 No Durable Local Telemetry Database

ObservMe must not create SQLite, local JSONL telemetry archives, parquet files, or long-lived caches. Allowed local state:

- In-memory span registry
- In-memory metric instruments
- Bounded retry queue inside OTEL SDK/exporter
- Optional one-line session/agent correlation custom entry if explicitly enabled

### 3.3 OTEL Native

ObservMe must use OpenTelemetry APIs and OTLP exporters for traces, metrics, and logs. Where OpenTelemetry GenAI semantic conventions apply, ObservMe should emit the official `gen_ai.*` attributes in addition to Pi-specific `pi.*` attributes.

### 3.4 Collector First

The default topology is:

```text
ObservMe -> OTEL Collector -> Backends
```

Direct export to Tempo, Loki, Prometheus, or Grafana Cloud is allowed but not the default production recommendation.

### 3.5 Fail Open

ObservMe must never block Pi agent execution because the collector or backend is down.

Required behavior:

- Export failures are logged locally only as minimal warnings through Pi UI when debug is enabled.
- Telemetry is dropped when queues are full.
- Tool calls, model calls, and sessions must continue.

### 3.6 Privacy by Default

Default settings:

```yaml
capture:
  prompts: false
  responses: false
  thinking: false
  toolArguments: false
  toolResults: false
  bashCommands: false
  bashOutput: false
  filePaths: false
```

Metadata such as token counts, duration, status, model, provider, tool name, agent role, subagent depth, and error class is captured by default. High-cardinality identifiers such as `pi.workflow.id`, `pi.workflow.root_agent_id`, `pi.agent.id`, `pi.agent.parent_id`, `pi.agent.run.id`, `pi.session.id`, trace IDs, and tool-call IDs are allowed on spans/logs but must not be promoted to metric labels by default.

### 3.7 Multi-Agent Workflow and Subagent Lineage

Adding a single `agent_id` is necessary but not sufficient for multi-agent observability. ObservMe must model the workflow and lineage explicitly:

```text
pi.workflow.id          # generated workflow/root execution id; high cardinality, traces/logs only
pi.workflow.root_agent_id
pi.agent.id             # current logical Pi agent runtime
pi.agent.parent_id      # parent agent when this is a subagent
pi.agent.root_id        # root agent in the tree
pi.agent.depth          # 0 for root, 1+ for subagents
pi.agent.spawn.id       # individual spawn operation id when known
pi.agent.spawn.tool_call_id
```

Preferred behavior:

1. Generate `pi.agent.id` at session runtime startup unless supplied by trusted parent context.
2. When a tool/extension spawns a subagent, pass W3C `traceparent`/`tracestate` plus ObservMe lineage environment variables to the child process.
3. If trace context is propagated, make the subagent session span a descendant of the parent spawn/tool span.
4. If trace context cannot be propagated, emit the child as a separate trace with span links and the `pi.agent.parent_id`/`pi.agent.root_id` attributes.
5. Track agent-tree depth, fan-out, active children, orphaned children, trace-context propagation failures, child failures, and parent wait/join latency.
6. Keep workflow IDs and agent IDs out of metric labels; use traces and logs for per-workflow/per-agent drill-down, and low-cardinality labels such as `agent_role`, `agent_capability`, `subagent_depth`, `spawn_type`, or `spawn_reason` for aggregate metrics.

## 4. Non-Goals

ObservMe is not:

- A local trace database
- A replacement for Grafana
- A replacement for OTEL Collector
- An OpenInference implementation
- A replacement for official OpenTelemetry GenAI semantic conventions
- A vendor-specific AI observability SDK
- A prompt evaluation framework
- A policy enforcement extension
- A session replay system by default

Session replay can be enabled only with explicit content capture settings.

## 5. Production Capabilities

### Traces

- Session root span
- Agent-run spans
- Turn spans
- LLM request spans
- Tool call spans
- Subagent-spawn spans
- Agent wait/join spans for multi-agent critical-path analysis
- Bash execution spans
- Compaction spans
- Branch spans
- Extension error spans

### Metrics

- Token counters
- Cost counters
- Turn counters
- Tool call counters
- Error counters
- Latency histograms
- Queue/drop counters
- Export health metrics
- Agent-run and subagent-spawn counters
- Workflow counters and duration histograms
- Active-agent gauges
- Agent-tree depth, width, and fan-out histograms
- Orphan-agent and trace-context propagation failure counters
- Parent wait/join duration histograms
- Child-agent failure and recovery counters

### Logs

- Structured session events
- Structured tool events
- Structured model events
- Structured workflow, agent-run, subagent-spawn, wait/join, orphan-agent, and trace-context propagation events
- Redacted error logs
- Optional prompt and response logs

### Query Commands

- `/obs status`
- `/obs health`
- `/obs session`
- `/obs cost`
- `/obs trace`
- `/obs tools`
- `/obs errors`
- `/obs logs`
- `/obs link`
- `/obs agents`

## 6. Success Criteria

ObservMe is production ready when:

1. Telemetry from an ephemeral Pi agent survives after the agent is deleted.
2. Grafana shows session traces in Tempo.
3. Loki contains structured event logs for sessions and tools.
4. Prometheus/Mimir contains token, cost, latency, and failure metrics.
5. The extension survives backend outages without breaking Pi.
6. Redaction tests prevent secrets from leaving the agent.
7. Cardinality limits prevent observability stack overload.
8. Users can open a Grafana trace link from Pi.
9. Parent agents and spawned subagents can be correlated without adding high-cardinality workflow IDs or agent IDs to metrics.
10. Orchestrator workflows expose depth, fan-out, active-agent, orphan, cost-amplification, and critical-path signals without adding workflow IDs or agent IDs to metric labels.
