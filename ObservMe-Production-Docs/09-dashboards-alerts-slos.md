# ObservMe Dashboards, Alerts, and SLOs

## 1. Dashboard Pack

ObservMe should ship Grafana dashboards as JSON files:

```text
dashboards/
├── observme-overview.json
├── observme-cost.json
├── observme-latency.json
├── observme-tools.json
├── observme-agents.json
├── observme-models.json
├── observme-errors.json
├── observme-branches-compactions.json
├── observme-export-health.json
├── observme-logs-llm.json
├── observme-llm-conversations.json
└── observme-trace-journey.json
```

## 2. Overview Dashboard

Panels:

- Sessions started
- Active sessions estimate
- Turns per minute
- LLM requests per minute
- Tool calls per minute
- Subagent spawns per minute
- Active agents
- Agent-tree depth and fan-out
- Orphan agents and trace-context propagation failures
- Error rate
- Total cost
- Token usage
- p95 turn latency
- p95 LLM latency
- p95 tool latency

PromQL examples:

```promql
(sum(rate(observme_sessions_started_total[5m])) or vector(0))
```

```promql
sum(rate(observme_turns_completed_total[5m]))
```

```promql
histogram_quantile(0.95, sum(rate(observme_turn_duration_ms_bucket[5m])) by (le))
```

Active sessions estimate:

```promql
clamp_min((sum(observme_sessions_started_total) or vector(0)) - (sum(observme_sessions_shutdown_total) or vector(0)), 0)
```

Use the `or vector(0)` fallbacks for session lifecycle panels because fresh active sessions can exist before any shutdown counter series has been exported.

Subagent spawn rate:

```promql
sum(rate(observme_subagents_spawned_total[5m])) by (agent_role, subagent_depth)
```

Active agents:

```promql
sum(observme_active_agents) by (agent_role, subagent_depth)
```

Agent fan-out p95:

```promql
histogram_quantile(0.95, sum(rate(observme_agent_fanout_count_bucket[5m])) by (subagent_depth, le))
```

## 3. Cost Dashboard

Panels:

- Cost by provider
- Cost by model
- Cost by environment
- Cost over time
- Input vs output token distribution
- Cache read/write token usage

PromQL:

```promql
sum(increase(observme_llm_cost_usd_total[$__range])) by (provider, model)
```

```promql
sum(increase(observme_llm_input_tokens_total[$__range])) by (provider, model)
```

```promql
sum(increase(observme_llm_output_tokens_total[$__range])) by (provider, model)
```

## 4. Tool Dashboard

Panels:

- Tool calls by name
- Tool failure rate
- Tool p95 latency
- Bash exit codes
- Tool result size distribution

PromQL:

```promql
sum(rate(observme_tool_calls_total[5m])) by (tool_name)
```

```promql
sum(rate(observme_tool_failures_total[5m])) by (tool_name) / clamp_min(sum(rate(observme_tool_calls_total[5m])) by (tool_name), 1e-9)
```

```promql
histogram_quantile(0.95, sum(rate(observme_tool_duration_ms_bucket[5m])) by (tool_name, le))
```

## 5. Agent and Subagent Dashboard

Panels:

- Agent runs by role
- Subagent spawns by depth and spawn type
- Subagent spawn failures
- p95 agent-run duration
- p95 subagent-spawn duration
- Parent/child trace links table from Tempo/Loki
- Active agents by depth
- Agent-tree depth and width
- Fan-out per parent operation
- Orphan agents
- Trace-context propagation failures
- Parent wait/join latency
- Child-agent failures and recovered child failures

PromQL aggregates must avoid high-cardinality workflow IDs and agent IDs:

```promql
sum(rate(observme_agent_runs_total[5m])) by (agent_role)
```

```promql
sum(rate(observme_subagents_spawned_total[5m])) by (subagent_depth, spawn_type, spawn_reason)
```

```promql
histogram_quantile(0.95, sum(rate(observme_agent_fanout_count_bucket[5m])) by (subagent_depth, le))
```

```promql
sum(rate(observme_orphan_agents_total[5m])) by (agent_role, subagent_depth)
```

```promql
sum(rate(observme_trace_context_propagation_failures_total[5m])) by (agent_role, subagent_depth)
```

```promql
histogram_quantile(0.95, sum(rate(observme_agent_join_duration_ms_bucket[5m])) by (agent_role, le))
```

```promql
histogram_quantile(0.95, sum(rate(observme_agent_run_duration_ms_bucket[5m])) by (agent_role, le))
```

Use Tempo or Loki for per-agent/per-workflow drill-down with attributes normalized by the backend, for example `pi_workflow_id`, `pi_agent_id`, `pi_agent_parent_id`, `pi_agent_root_id`, and `pi_agent_spawn_id`.

## 5.1 Trace Journey Dashboard

Panels:

- Trace journey map explaining the `session → agent run → turn → LLM → tool/bash → subagent spawn → wait/join → branch/compaction` flow.
- Summary stats for active sessions, completed workflows, subagent spawns, LLM requests, tool calls, and trace-context propagation failures.
- Journey flow rate over time for turns, LLM requests, tool calls, bash executions, subagent spawns, and compactions.
- p95 stage-latency bar gauge for agent-run, turn, LLM, tool, bash, wait, and join spans.
- Agent-tree shape over time using active agents, p95 depth, p95 width, and p95 fan-out.
- Subagent handoffs by depth and spawn reason.
- Loki-backed execution journey timeline and ordered journey log, filterable by `pi_session_id`, `pi_agent_id`, and `pi_agent_run_id`.
- Parent/child handoff table from `event_category="agent-tree"` logs.
- Tempo TraceQL table for recent `observme-pi-extension` traces so users can open the full waterfall.

The dashboard uses high-cardinality IDs only for Loki/Tempo drill-down filters. Prometheus panels continue to use low-cardinality aggregate labels only.

## 6. Model Dashboard

Panels:

- Requests by provider/model
- Error rate by provider/model
- p95 latency by provider/model
- Stop reason distribution
- Cost per 1k turns

PromQL:

```promql
sum(rate(observme_llm_requests_total[5m])) by (provider, model)
```

```promql
sum(rate(observme_llm_errors_total[5m])) by (provider, model)
```

## 7. Branch and Compaction Dashboard

Panels:

- Branches per session estimate
- Compactions over time
- Tokens before compaction histogram
- Branch summaries created
- Model changes and thinking level changes

PromQL:

```promql
sum(rate(observme_compactions_total[1h])) by (environment)
```

```promql
histogram_quantile(0.95, sum(rate(observme_compaction_tokens_before_bucket[1h])) by (le))
```

## 8. Export Health Dashboard

Purpose: show whether ObservMe is observing Pi handler activity and whether the local telemetry/export path is dropping, redacting, or failing. This dashboard intentionally combines liveness panels with failure-only panels; failure-only panels can be quiet in a healthy range and should not make the whole dashboard appear blank.

Healthy local-session behavior:

- A trusted local project where `/obs status` and `/obs health` succeed should show recent ObservMe activity from `observme_events_observed_total` after representative Pi events occur.
- Failure counters render as `0` when no failure series exists in the selected time range.
- Collector/export health renders healthy when events are observed and local drops/export errors remain zero.
- Loki failure tables remain empty unless matching failure logs occur; empty `redaction.failed`, `telemetry.dropped`, `export.failed`, and `trace_context.propagation_failed` tables mean no matching failures were observed in the selected range.
- The dashboard contract does not require changing project trust, `/obs status`, `/obs health`, local OTLP endpoint selection, Grafana auth/profile, or local debug capture policy.

Panels and signals:

- Recent observed event rate: `observme_events_observed_total`.
- Handler latency and pressure: `observme_handler_duration_ms` and `observme_handler_errors_total`.
- Active SDK spans: `observme_active_spans` by bounded `operation`.
- Telemetry drops: `observme_telemetry_dropped_total` by bounded `reason`.
- Redaction failures: `observme_redaction_failures_total` by bounded `operation`/`error_class` where available.
- Export failures: `observme_export_errors_total` by bounded `reason`/`error_class` where available.
- Failure logs: Loki `event_name` values `redaction.failed`, `telemetry.dropped`, `export.failed`, and `trace_context.propagation_failed`.

Allowed metric labels for Export Health panels are the low-cardinality labels `operation`, `reason`, `error_class`, and `status`. Dashboard PromQL must not group or filter by session IDs, workflow IDs, agent IDs, trace/span IDs, entry IDs, raw prompts, raw commands, raw paths, or raw error messages.

Zero-safe PromQL examples for stat panels:

```promql
sum(rate(observme_events_observed_total[$__rate_interval])) or vector(0)
```

```promql
sum(rate(observme_telemetry_dropped_total[$__rate_interval])) or vector(0)
```

```promql
sum(rate(observme_redaction_failures_total[$__rate_interval])) or vector(0)
```

```promql
sum(rate(observme_export_errors_total[$__rate_interval])) or vector(0)
```

```promql
sum(rate(observme_handler_errors_total[$__rate_interval])) or vector(0)
```

Breakdowns can keep low-cardinality grouping while still documenting that an unlabeled zero means no series exists yet:

```promql
sum(rate(observme_telemetry_dropped_total[$__rate_interval])) by (reason) or vector(0)
```

Observability Export SLO alignment:

```promql
1 - (sum(rate(observme_telemetry_dropped_total[$__range])) / clamp_min(sum(rate(observme_events_observed_total[$__range])), 1e-9))
```

## 9. Loki Queries

Errors:

```logql
{service_name="observme-pi-extension", event_name=~".*[.]failed|.*[.]dropped|agent[.]orphaned"}
```

Tool failures:

```logql
{service_name="observme-pi-extension", event_name="tool.call.failed"}
```

LLM failures:

```logql
{service_name="observme-pi-extension", event_name="llm.request.failed"}
```

The dedicated `observme-llm-conversations.json` dashboard shows a full redacted conversation timeline plus separate prompt, response, and thinking panels. It includes Loki template filters for `pi_agent_id` and `pi_agent_run_id`; the local Collector promotes `pi.agent.id` and `pi.agent.run.id` as Loki labels for this dashboard.

Captured prompts, responses, and thinking (redacted, opt-in log bodies):

```logql
{service_name="observme-pi-extension", event_name="llm.prompt.captured"}
{service_name="observme-pi-extension", event_name="llm.response.captured"}
{service_name="observme-pi-extension", event_name="llm.thinking.captured"}
```

Compactions:

```logql
{service_name="observme-pi-extension", event_name="compaction.created"}
```

Subagent spawns:

```logql
{service_name="observme-pi-extension", event_name="agent.spawn.completed"}
```

Orphan agents:

```logql
{service_name="observme-pi-extension", event_name="agent.orphaned"}
```

Trace-context propagation failures:

```logql
{service_name="observme-pi-extension", event_name="trace_context.propagation_failed"}
```

These examples assume Loki OTLP ingestion stores ObservMe OTEL attributes as labels or structured metadata. Dotted OTEL attribute names are queried in Loki with underscores, for example `event.name` as `event_name`, `event.category` as `event_category`, and `pi.session.id` as `pi_session_id`. `event.category` is the ObservMe semantic category, so failure dashboards select by `event_name` rather than `event_category="error"`.

## 10. Tempo / TraceQL Concepts

Trace search examples depend on Tempo version and configured attributes. Conceptual queries:

```text
Find traces where pi.tool.name = bash and status = error
Find traces where pi.llm.cost.total_usd > 0.10
Find traces where pi.compaction.tokens_before > 50000
Find traces by pi.session.id
Find child traces/spans by pi.agent.parent_id or pi.agent.root_id
Find all traces/spans in an orchestrated workflow by pi.workflow.id
Find joins where pi.agent.join.status = timeout or error
```

## 11. Suggested Alerts

### High LLM Error Rate

```promql
sum(rate(observme_llm_errors_total[10m])) / clamp_min(sum(rate(observme_llm_requests_total[10m])), 1e-9) > 0.05
```

Severity: warning

### High Tool Failure Rate

```promql
sum(rate(observme_tool_failures_total[10m])) by (tool_name) / clamp_min(sum(rate(observme_tool_calls_total[10m])) by (tool_name), 1e-9) > 0.10
```

Severity: warning

### Subagent Spawn Failures

```promql
sum(rate(observme_subagent_spawn_failures_total[10m])) > 0
```

Severity: warning

### Export Drops Detected

```promql
sum(rate(observme_telemetry_dropped_total[5m])) > 0
```

Severity: warning

### Cost Spike

```promql
sum(increase(observme_llm_cost_usd_total[1h])) > 50
```

Severity depends on organization budget.

### Redaction Failures

```promql
sum(rate(observme_redaction_failures_total[5m])) > 0
```

Severity: critical if content capture is enabled.

### Runaway Agent Fan-Out

```promql
histogram_quantile(0.95, sum(rate(observme_agent_fanout_count_bucket[10m])) by (le)) > 20
```

Severity: warning; tune the threshold to the organization's normal orchestrator workload.

### Excessive Agent Tree Depth

```promql
histogram_quantile(0.95, sum(rate(observme_agent_tree_depth_bucket[10m])) by (le)) > 5
```

Severity: warning; tune the threshold to expected maximum delegation depth.

### Orphan Agents Detected

```promql
sum(rate(observme_orphan_agents_total[10m])) > 0
```

Severity: warning.

### Trace Context Propagation Failures

```promql
sum(rate(observme_trace_context_propagation_failures_total[10m])) > 0
```

Severity: warning.

### Active Agents Stuck High

```promql
sum(observme_active_agents) > 100
```

Severity depends on normal fleet size; tune per deployment.

## 12. SLOs

### Observability Export SLO

99% of observed telemetry events are not locally dropped over 30 days.

Indicator:

```promql
1 - (sum(rate(observme_telemetry_dropped_total[30d])) / clamp_min(sum(rate(observme_events_observed_total[30d])), 1e-9))
```

### Agent Lineage SLO

99% of known subagent spawns produce either propagated trace context or parent/child lineage attributes.

Indicator:

```promql
1 - ((sum(rate(observme_subagent_spawn_failures_total{reason="lineage_missing"}[30d])) + sum(rate(observme_orphan_agents_total[30d])) + sum(rate(observme_trace_context_propagation_failures_total[30d]))) / clamp_min(sum(rate(observme_subagents_spawned_total[30d])), 1e-9))
```

### Workflow Completion SLO

99% of started workflows complete or explicitly fail with terminal telemetry over 30 days.

Indicator:

```promql
(sum(rate(observme_workflows_completed_total[30d])) + sum(rate(observme_workflow_errors_total[30d]))) / clamp_min(sum(rate(observme_workflows_started_total[30d])), 1e-9)
```

### Instrumentation Overhead SLO

99% of event handlers complete in under 10ms.

Metric:

```text
observme_handler_duration_ms
```

### Redaction SLO

100% of configured secret test patterns are redacted in CI.

This is a test SLO, not runtime-only.
