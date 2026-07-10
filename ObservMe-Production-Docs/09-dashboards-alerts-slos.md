# ObservMe Dashboards, Alerts, and SLOs

## 1. Dashboard Pack

ObservMe ships Grafana dashboards as JSON files:

```text
dashboards/
├── observme-overview.json
├── observme-slo-health.json
├── observme-export-health.json
├── observme-trace-journey.json
├── observme-agents.json
├── observme-agent-node-graphs.json
├── observme-cost.json
├── observme-models.json
├── observme-latency.json
├── observme-tools.json
├── observme-errors.json
├── observme-logs-llm.json
├── observme-llm-conversations.json
└── observme-branches-compactions.json
```

## 1.1 Dashboard Map

| Dashboard | Primary question answered | Typical next drill-down |
|---|---|---|
| `ObservMe Overview` | Is ObservMe healthy, is workload normal, are agents/subagents healthy, and are cost or latency elevated? | Open the linked SLO Health, Export Health, Trace Journey, Cost, Models, Latency, Tools, Agents, Errors, or LLM Conversations dashboard with the same time range. |
| `ObservMe SLO Health` | Which SLO is burning budget or near an alert threshold? | Export Health for telemetry-path inputs, Agents/Trace Journey for lineage, Errors for failed workflows, or Latency for handler overhead. |
| `ObservMe Export Health` | Is the telemetry/export path trustworthy, idle, dropped, redacting, or failing? | Failure-only Loki tables, SLO Health, and `/obs health` for backend reachability. |
| `ObservMe Trace Journey` | How did one session/agent/workflow move through turns, LLM calls, tools, bash, subagent spawns, waits, joins, logs, and Tempo traces? | Filtered LLM Conversations, Agents, Errors, Tools, or Tempo trace waterfall. |
| `ObservMe Agents and Subagents` | Are subagents spawning, failing, waiting, joining, becoming orphaned, or losing trace context? | Agent Node Graphs for aggregate topology, Trace Journey for per-run logs/traces, and SLO Health for lineage budget. |
| `ObservMe Agent Node Graphs` | What aggregate root/role/depth/spawn topology and health shape exists in the selected range? | Agents for ratios/top offenders and Trace Journey for per-execution investigation. |
| `ObservMe Cost` | Which providers/models/environments and token/cache patterns are driving spend and burn rate? | Models, Logs and LLM I/O, LLM Conversations, and Trace Journey. |
| `ObservMe Models` | How do provider/model traffic, errors, latency, stop reasons, and cost efficiency compare? | Cost, Latency, Logs and LLM I/O, and trace/log rows for representative requests. |
| `ObservMe Latency` | Which stage, provider/model, tool, or agent role is slow after accounting for volume? | Trace Journey, Models, Tools, Agents, and Errors. |
| `ObservMe Tools` | Which tools are busy, slow, failing, or producing large results? | Errors, Trace Journey, and filtered `tool.call.failed` logs. |
| `ObservMe Errors` | Which error family is pressuring reliability and what logs/traces explain it? | Export Health, Tools, Models, Agents, Trace Journey, and Tempo trace rows. |
| `ObservMe Logs and LLM I/O` | What LLM lifecycle logs, token trends, and prompt/response size trends exist without duplicating the content timeline? | LLM Conversations for redacted content and Trace Journey/Tempo for execution context. |
| `ObservMe LLM Conversations` | What redacted opt-in prompts, responses, thinking, and trace links belong to one session/workflow/agent/run? | Trace Journey and Tempo traces. |
| `ObservMe Branches and Compactions` | Did branch, compaction, model, or thinking-level changes explain cost/latency shifts? | Cost, Models, Latency, and Logs and LLM I/O. |

## 1.2 Shared Dashboard UX Conventions

New or changed dashboards must use the same variable names, row names, link patterns, and status colors so users can move from overview panels to domain drill-downs without relearning each dashboard.

### Standard variables

Use these exact variable names and display labels when a dashboard supports the dimension. Prometheus variables must stay low-cardinality; high-cardinality identifiers are allowed only in Loki/Tempo drill-downs.

| Variable | Display label | Datasource scope | Backing label/attribute | Use |
|---|---|---|---|---|
| `environment` | Environment | Prometheus; mixed only if the log/trace backend exposes the same bounded value | `environment` metric label; `deployment.environment.name`/`observme.environment` attribute | Fleet, stage, or local/CI/prod filtering. |
| `provider` | Provider | Prometheus; Loki for LLM lifecycle/content dashboards when promoted | `provider` metric label; `gen_ai_provider_name` Loki label | LLM traffic, latency, error, token, cost, and content-log filtering. |
| `model` | Model | Prometheus; Loki for LLM lifecycle/content dashboards when promoted | `model` metric label; `gen_ai_request_model` Loki label | Provider/model comparison; keep values provider-reported and bounded by active use. |
| `tool_name` | Tool | Prometheus | `tool_name` metric label | Tool workload, latency, and failure panels. |
| `agent_role` | Agent role | Prometheus; Tempo where attributes are searchable | `agent_role` metric label; `pi.agent.role` attribute if emitted | Root/subagent/orchestrator/worker/reviewer comparison. |
| `agent_capability` | Agent capability | Prometheus only after verifying the value set is bounded; Tempo otherwise | `agent_capability` metric label; `pi.agent.capability` attribute if emitted | Capability-level aggregate panels without agent IDs. |
| `subagent_depth` | Subagent depth | Prometheus; Tempo where attributes are searchable | `subagent_depth` metric label; `pi.agent.depth` attribute if emitted | Depth/fan-out/orphan/propagation diagnostics. |
| `spawn_reason` | Spawn reason | Prometheus | `spawn_reason` metric label | Delegation and fan-out cause analysis. |
| `session_id` | Session ID | Loki/Tempo only | `pi_session_id` Loki label; `pi.session.id` Tempo/span attribute | Follow one session across logs and traces. Never use in PromQL. |
| `agent_id` | Agent ID | Loki/Tempo only | `pi_agent_id` Loki label; `pi.agent.id` Tempo/span attribute | Follow one root agent or subagent. Never use in PromQL. |
| `agent_run_id` | Agent run ID | Loki/Tempo only | `pi_agent_run_id` Loki label; `pi.agent.run.id` Tempo/span attribute | Follow one execution attempt. Never use in PromQL. |
| `workflow_id` | Workflow ID | Optional Loki/Tempo only where the backend exposes it | `pi_workflow_id` Loki label; `pi.workflow.id` Tempo/span attribute | Follow a multi-agent workflow. Never use in PromQL. |
| `content_kind` | Content kind | Loki only | `pi_llm_content_kind` Loki label | Filter redacted opt-in prompt, response, thinking, or lifecycle content views. Never use raw content values. |

Variable scope rules:

- Prometheus-primary: `provider`, `model`, `tool_name`, `spawn_reason`, and any low-cardinality `agent_capability` use; `provider` and `model` may also be Loki variables on LLM lifecycle/content dashboards when the Collector promotes bounded GenAI labels.
- Loki-only: `content_kind` and any other log-only variable whose backing label is promoted by the local Collector and used only by log panels.
- Tempo-only: none by default; use trace attributes and row-level links instead of global trace identifiers unless a dashboard is specifically trace-search-only.
- Mixed: `environment`, `agent_role`, and `subagent_depth` only when every datasource exposes bounded equivalent values.
- Loki/Tempo-only high-cardinality drill-downs: `session_id`, `agent_id`, `agent_run_id`, and `workflow_id`; these identify individual executions and must never be used in PromQL.

### Standard row names

Use these row names consistently and only add domain-specific rows when the dashboard needs additional detail:

- `Health`: top-level status, no-data/idle hints, alert state, and failure chips.
- `Workload`: sessions, turns, requests, tool calls, spawns, and throughput.
- `Cost`: spend, burn rate, tokens, cache/reasoning usage, and efficiency.
- `Latency`: p50/p95/p99, stage attribution, and slow-offender tables.
- `Agent lineage`: root/subagent health, fan-out, depth, orphan, propagation, wait, and join behavior.
- `Logs`: Loki drill-down tables or log panels with parsed labels and empty-state descriptions.
- `Traces`: Tempo trace search, trace waterfall entry points, and trace-navigation help.
- `SLOs`: SLO attainment, burn rates, error budget, and alert-threshold context.

### Drill-down and data-link patterns

Preserve the dashboard time range on all drill-down links using Grafana time macros such as `${__url_time_range}` or explicit `from=${__from}&to=${__to}` parameters. Prometheus panels should link to domain dashboards with low-cardinality variables first, then to Loki/Tempo views for per-execution context.

Required link patterns for new or changed panels:

- Overview health/SLO panels link to Export Health, Errors, SLO Health when present, and Trace Journey.
- LLM, model, token, and cost panels link to Models, Cost, Logs and LLM I/O, LLM Conversations, and Tempo traces when a trace ID or session/run filter is available.
- Tool latency/error panels link to Tools, Errors, filtered `tool.call.failed` Loki rows, and Tempo traces.
- Agent lineage panels link to Agents, Agent Node Graphs, Trace Journey, filtered `event_category="agent-tree"` Loki rows, and Tempo traces.
- Export/redaction/drop panels link to Export Health, failure logs, and the relevant SLO/alert context.
- Loki rows should expose a Tempo link from `trace_id`/`span_id` when available; otherwise they should link back to Trace Journey using `session_id`, `agent_id`, and `agent_run_id` filters.

Do not place raw prompt, response, command, path, or raw error-message values into dashboard URLs. Prometheus links may pass only low-cardinality labels; high-cardinality values must originate from Loki/Tempo labels or trace/log fields.

### Threshold colors and empty states

Use consistent threshold colors:

| State | Color | Meaning |
|---|---|---|
| Healthy | Green | Within objective or zero failures for the selected range. |
| Warning | Yellow/Orange | Degraded trend, non-zero recoverable failures, elevated burn, or approaching an alert threshold. |
| Critical | Red | Active alert condition, redaction failure, export drop/error, lineage break, or SLO violation. |
| Idle/no data | Gray/Blue | No workload or optional capture disabled; panel description must explain why this can be healthy. |

Every failure-only log panel must state that an empty table means no matching failures were observed in the selected range. Every zero-safe Prometheus stat that uses `or vector(0)` must explain whether zero means healthy idle, no events yet, or an actual zero failure rate. Content-capture dashboards must state that prompts, responses, and thinking logs are redacted and opt-in.

### Operator drill-down workflows

Use the dashboards as a guided investigation path instead of opening raw metric families randomly:

1. **General health:** start in Overview, inspect the `Health` row, then follow the panel link to SLO Health, Export Health, Errors, or Trace Journey. Keep `${__url_time_range}` on all links.
2. **Multi-agent lineage:** start in Overview or Trace Journey, copy/filter by `session_id`, `workflow_id`, `agent_id`, or `agent_run_id` only in Loki/Tempo dashboards, then use Agents and Agent Node Graphs for aggregate ratios and topology.
3. **Cost/model changes:** start in Cost or Models, compare burn rate, token mix, cache/reasoning usage, stop reasons, and model/thinking annotations, then use Logs and LLM I/O or LLM Conversations for per-run context.
4. **Latency/tool/error:** start in Latency, Tools, or Errors, use top-offender tables that pair percentile/rate with volume, and open linked Loki rows or Tempo traces for representative executions.
5. **Export trust:** if panels are blank or suspicious, inspect Export Health before interpreting product dashboards; an idle range can be healthy, but drops, export errors, redaction failures, handler errors, or propagation failures should be visible as non-green chips or failure logs.

Zero-state interpretation checklist:

- Empty failure-only Loki tables mean no matching failures in the selected range, not that the log pipeline is broken.
- `or vector(0)` stats must say whether zero means healthy idle/no activity or a true zero failure ratio.
- Optional redacted content panels can be empty when capture is disabled or when the Collector dropped content attributes by policy.
- Active-session estimates are approximate across process restarts/counter resets; `observme_active_agents` is the authoritative active agent gauge.
- High-cardinality execution identifiers are allowed as Loki/Tempo filter variables only and must never be introduced into Prometheus queries or panel links from aggregate panels.

## 2. Overview Dashboard

Purpose: act as the operator landing page. Users should be able to answer whether ObservMe is healthy, workload is normal, agents/subagents are healthy, spend or latency is high, and which focused dashboard to open next without scanning every raw metric series.

Rows and panels:

- `Health`: SLO/health chips for `Export health`, `Agent lineage health`, `Workflow completion health`, `Error pressure`, `Cost burn / hour`, and `Latency health`.
- `Workload`: compact KPI stats with sparklines for `Active sessions estimate`, `Turns/min`, `LLM requests/min`, `Tool calls/min`, `Subagent spawns/min`, and `Active agents`.
- `Cost`: selected-range `Total cost`, `Token mix`, and aggregate `Cost trend` without provider/model detail.
- `Latency`: compact p95 sparkline stats for turn, LLM, and tool latency.
- `Agent lineage`: selected-range `Lineage failures`, p95 tree depth, p95 fan-out, and current active agents by bounded role/depth labels.
- `Links`: navigation to Cost, Models, Latency, Tools, Agents, Trace Journey, Errors, Export Health, and LLM Conversations with the current time range preserved.

The overview intentionally keeps only landing-page signals. Provider/model, tool, error-family, export, and full trace/log details belong on the domain dashboards linked from the row or panel links.

PromQL examples:

Export health chip:

```promql
1 - ((sum(rate(observme_telemetry_dropped_total[$__range])) or vector(0)) / clamp_min((sum(rate(observme_events_observed_total[$__range])) or vector(0)), 1e-9))
```

Agent lineage health chip:

```promql
clamp_min(1 - (((sum(rate(observme_subagent_spawn_failures_total[$__range])) or vector(0)) + (sum(rate(observme_orphan_agents_total[$__range])) or vector(0)) + (sum(rate(observme_trace_context_propagation_failures_total[$__range])) or vector(0))) / clamp_min((sum(rate(observme_subagents_spawned_total[$__range])) or vector(0)), 1e-9)), 0)
```

Active sessions estimate:

```promql
clamp_min((sum(observme_sessions_started_total) or vector(0)) - (sum(observme_sessions_shutdown_total) or vector(0)), 0)
```

Use the `or vector(0)` fallbacks for session lifecycle panels because fresh active sessions can exist before any shutdown counter series has been exported. The overview describes this panel as an estimate because process restarts and counter resets can affect the value.

Compact workload stats:

```promql
60 * (sum(rate(observme_turns_completed_total[$__rate_interval])) or vector(0))
```

```promql
60 * (sum(rate(observme_subagents_spawned_total[$__rate_interval])) or vector(0))
```

Agent fan-out p95:

```promql
histogram_quantile(0.95, sum(rate(observme_agent_fanout_count_bucket[$__rate_interval])) by (le)) or vector(0)
```

Dashboard links must preserve the current time range with `${__url_time_range}` and must not include high-cardinality IDs or raw content values. Use Loki/Tempo drill-down dashboards for session, workflow, agent, run, trace, and span identifiers.

## 3. Cost Dashboard

Purpose: show selected-range spend, hourly burn, budget pressure, token/cache behavior, and provider/model attribution without misleading denominators.

Panels:

- Total selected-range cost, cost burn rate per hour, selected-range budget usage, and projected 24h cost.
- Cost by provider, model, and environment with percent-of-total context.
- Cost over time as a trend panel suitable for model/thinking/compaction annotations.
- Token totals by type: input, output, total, reasoning, cache read, cache write, and cache write 1h.
- Cache read/write token usage, cache read ratio, and estimated cache savings where supported by metrics.

PromQL examples:

```promql
sum(increase(observme_llm_cost_usd_total[$__range])) by (provider, model)
```

```promql
sum(increase(observme_llm_cost_usd_total[$__range])) / clamp_min(sum(increase(observme_llm_requests_total[$__range])), 1e-9) * 1000
```

```promql
sum(increase(observme_llm_input_tokens_total[$__range])) by (provider, model)
```

```promql
sum(increase(observme_llm_cache_read_tokens_total[$__range])) / clamp_min(sum(increase(observme_llm_cache_read_tokens_total[$__range])) + sum(increase(observme_llm_input_tokens_total[$__range])), 1e-9)
```

## 4. Tool Dashboard

Purpose: identify busy, slow, failing, or oversized tools and connect aggregate symptoms to filtered failure logs/traces.

Panels:

- Tool calls by name, tool failure rate, and tool p95 latency trend panels.
- Interactive user-bash (`!`/`!!`) exit codes over the selected range; assistant Bash tool calls remain in the tool-call panels.
- Tool result size distribution with character/count semantics when the source metric uses `*_chars`.
- Tool failures by severity with failure count and failure-rate sorting.
- Tool latency percentiles with volume so sparse p95/p99 series are not overinterpreted.
- Captured failed-tool output from `tool.error.captured` logs only when `capture.toolResults` is explicitly enabled; the panel must identify content as opt-in and policy-processed, preserve multiline output, and remain empty when capture is disabled or redaction fails closed.

PromQL examples:

```promql
sum(rate(observme_tool_calls_total[$__rate_interval])) by (tool_name)
```

```promql
sum(rate(observme_tool_failures_total[$__rate_interval])) by (tool_name) / clamp_min(sum(rate(observme_tool_calls_total[$__rate_interval])) by (tool_name), 1e-9)
```

```promql
histogram_quantile(0.95, sum(rate(observme_tool_duration_ms_bucket[$__rate_interval])) by (tool_name, le))
```

Operational Loki failure rows use `event_name="tool.call.failed"` and should expose `tool_name`, bounded error/status fields, and a Tempo link when trace metadata is present. Captured output uses the separate `event_name="tool.error.captured", event_category="tool_content"` stream so aggregate failure logs remain content-free and broad session-log views can exclude captured bodies.

## 5. Agent and Subagent Dashboard

Purpose: make root/subagent reliability and orchestration behavior obvious, especially spawn failures, fan-out, depth, orphan lineage, trace-context propagation, wait/join latency, and recovered child failures.

Panels:

- Agent runs by role, subagent spawns by depth/spawn type/reason, and spawn failures.
- p95 agent-run and subagent-spawn duration trends.
- Active agents by depth, agent-tree depth/width, fan-out per parent operation, and alert-aligned threshold references.
- Orphan agents and trace-context propagation failures.
- Parent wait/join latency, child-agent failures, and recovered child failures.
- Ratio panels for spawn failure rate, orphan pressure vs spawns/runs, propagation failure rate, and child recovery ratio.
- Top tables for slow agent roles, failing spawn reasons, orphan-prone depths, and high fan-out roles.
- Parent/child handoff table with parsed fields and Trace Journey/Tempo links.

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

## 5.1 Agent Node Graphs Dashboard

Purpose: visualize aggregate topology and health for root agents, roles, spawn reasons, and subagent depths without implying a single trace tree.

Panels:

- `Pi root → agents → subagents`: aggregate root-to-role-to-depth node graph with selected-range counts and red health nodes/edges for failed spawns, orphan lineage, and propagation failures.
- `Agent role → spawn reason → subagent depth`: aggregate delegation-path node graph using spawn counts as edge weights.

Node graphs use only bounded aggregate labels. Per-workflow/session/agent identifiers belong in Trace Journey, Loki handoff rows, or Tempo spans.

## 5.2 Trace Journey Dashboard

Panels:

- Trace journey map explaining the `session → agent run → turn → LLM → tool/bash → subagent spawn → wait/join → branch/compaction` flow.
- Summary stats for active agents, completed workflows, failed workflows, workflow completion ratio, subagent spawns, LLM requests, tool calls, and trace-context propagation failures.
- Journey flow rate over time for turns, LLM requests, tool calls, bash executions, subagent spawns, and compactions.
- p95 stage-latency bar gauge for agent-run, turn, LLM, tool, bash, wait, and join spans.
- Agent-tree shape over time using active agents, p95 depth, p95 width, and p95 fan-out.
- Subagent handoffs by depth and spawn reason.
- Loki-backed execution journey events and ordered journey log, filterable by `pi_session_id`, `pi_agent_id`, and `pi_agent_run_id`; these use logs panels because Loki log streams do not provide state-timeline frames without extra transforms.
- Parent/child handoff table from `event_category="agent-tree"` logs.
- Tempo TraceQL table for recent `observme-pi-extension` traces so users can open the full waterfall and keep the current session/agent filters beside matching logs.

The dashboard uses high-cardinality IDs only for Loki/Tempo drill-down filters. Prometheus panels continue to use low-cardinality aggregate labels only.

## 6. Model Dashboard

Purpose: compare provider/model traffic, reliability, latency, stop reasons, and cost efficiency using semantically valid denominators.

Panels:

- Requests by provider/model with traffic share context.
- Error rate by provider/model paired with error counts and request volume.
- p95 latency by provider/model, with adjacent volume context in Latency.
- Stop reason distribution as selected-range totals or a true time series.
- Cost per 1k LLM requests by provider/model.
- Overall cost per completed turn when turn attribution is aggregate-only.

PromQL examples:

```promql
sum(rate(observme_llm_requests_total[$__rate_interval])) by (provider, model)
```

```promql
sum(rate(observme_llm_errors_total[$__rate_interval])) by (provider, model) / clamp_min(sum(rate(observme_llm_requests_total[$__rate_interval])) by (provider, model), 1e-9)
```

```promql
sum(increase(observme_llm_cost_usd_total[$__range])) by (provider, model) / clamp_min(sum(increase(observme_llm_requests_total[$__range])) by (provider, model), 1e-9) * 1000
```

Do not divide model-level cost by global turn counts and label the result as model cost per turn. Use provider/model LLM-request denominators, or explicitly label aggregate cost per completed turn when the denominator is global turns.

## 7. Branch and Compaction Dashboard

Purpose: explain context-branching and compaction pressure, and provide model/thinking change context for cost, latency, and model dashboards.

Panels:

- Branches per session estimate, using selected-range counts when possible and explaining sparse-session noise.
- Compactions over time, with per-session/turn context where available.
- Tokens before compaction histogram with p95 and optional p50/p99 companion views.
- Branch summaries created and compaction logs as parsed Loki rows.
- Model changes and thinking level changes, also suitable as dashboard annotations for Cost, Models, and Latency.

PromQL examples:

```promql
sum(rate(observme_compactions_total[$__rate_interval])) by (environment)
```

```promql
histogram_quantile(0.95, sum(rate(observme_compaction_tokens_before_bucket[$__rate_interval])) by (le))
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

The dedicated `observme-llm-conversations.json` dashboard is the canonical opt-in content view. It shows a redacted conversation timeline, prompt/response/thinking panels, and trace links. Its Loki template filters cover `pi_session_id`, `pi_workflow_id` where promoted, `pi_agent_id`, `pi_agent_run_id`, `provider`, `model`, and content kind; the local Collector promotes the required normalized labels for this dashboard when capture and label policy allow them.

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

The `ObservMe SLO Health` dashboard (`dashboards/observme-slo-health.json`) surfaces runtime SLO scorecards, 1h/30d burn-rate panels, and alert-threshold references. Export Health also links to the SLO dashboard and shows the liveness, drop, export-error, redaction-failure, and handler-overhead inputs separately so healthy idle ranges are distinguishable from unhealthy export behavior.

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
