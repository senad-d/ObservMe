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
└── observme-export-health.json
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
sum(rate(observme_sessions_started_total[5m]))
```

```promql
sum(rate(observme_turns_completed_total[5m]))
```

```promql
histogram_quantile(0.95, sum(rate(observme_turn_duration_ms_bucket[5m])) by (le))
```

Active sessions estimate:

```promql
clamp_min(sum(observme_sessions_started_total) - sum(observme_sessions_shutdown_total), 0)
```

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

Panels:

- Telemetry drops
- Redaction failures
- Export failures
- SDK queue saturation if exposed
- Collector health

PromQL:

```promql
sum(rate(observme_telemetry_dropped_total[5m])) by (reason)
```

```promql
sum(rate(observme_redaction_failures_total[5m]))
```

## 9. Loki Queries

Errors:

```logql
{service_name="observme-pi-extension"} | event_category="error"
```

Tool failures:

```logql
{service_name="observme-pi-extension"} | event_name="tool.call.failed"
```

LLM failures:

```logql
{service_name="observme-pi-extension"} | event_name="llm.request.failed"
```

Compactions:

```logql
{service_name="observme-pi-extension"} | event_name="compaction.created"
```

Subagent spawns:

```logql
{service_name="observme-pi-extension"} | event_name="agent.spawn.completed"
```

Orphan agents:

```logql
{service_name="observme-pi-extension"} | event_name="agent.orphaned"
```

Trace-context propagation failures:

```logql
{service_name="observme-pi-extension"} | event_name="trace_context.propagation_failed"
```

These examples assume Loki OTLP ingestion stores ObservMe OTEL attributes as labels or structured metadata. Dotted OTEL attribute names are queried in Loki with underscores, for example `event.name` as `event_name` and `pi.session.id` as `pi_session_id`.

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
