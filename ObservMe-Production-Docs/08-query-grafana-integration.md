# ObservMe Query and Grafana Integration

## 1. Purpose

ObservMe is primarily an emitter, but it should also help users query the observability stack from inside Pi. Query commands must be lightweight and optional.

## 2. Query Architecture

```text
Pi /obs command
  -> ObservMe query client
      -> Grafana API
      -> Tempo API
      -> Loki API
      -> Prometheus/Mimir API
      -> Agent lineage queries (Tempo/Loki)
  -> Render concise result in Pi TUI
```

Preferred integration is Grafana API because Grafana already knows all datasources and provides stable links.

## 3. Configuration

```yaml
query:
  enabled: true
  grafana:
    url: https://grafana.example.com
    token: ${OBSERVME_GRAFANA_TOKEN}
    username: ""
    password: ""
    datasourceUids:
      tempo: tempo
      loki: loki
      prometheus: mimir
    tls:
      insecureSkipVerify: false
    transport:
      preferIPv4: false
  links:
    traceUrlTemplate: "https://grafana.example.com/explore?left=..."
```

Authentication and local transport behavior:

- Prefer `query.grafana.token` for Grafana service-account or bearer tokens.
- If the token is blank or an unresolved environment placeholder, ObservMe may use `query.grafana.username` plus `query.grafana.password` as a local-development Basic auth fallback.
- Query-backed commands fail fast before backend calls when `query.grafana.token` is unresolved, auth is missing/incomplete, `query.grafana.url` is invalid, or a required datasource UID is blank.
- `401` and `403` responses are surfaced as Grafana authentication failures without printing token or password values.
- For the bundled `observability-stack/` behind `https://observability.local`, set `query.grafana.tls.insecureSkipVerify=true` only for the local self-signed certificate and `query.grafana.transport.preferIPv4=true` when DNS resolution stalls on IPv6.

## 4. Commands

### `/obs status`

Shows local ObservMe state.

Output:

```text
ObservMe: enabled
OTLP endpoint: https://otel.example.com:4318
Traces: enabled
Metrics: enabled
Logs: enabled
Prompt capture: disabled
Queue drops: 0
Last export error: none
```

### `/obs health`

Checks Collector and Grafana reachability, and reports Grafana query auth/config readiness before datasource calls.

```text
Collector: reachable
Grafana: reachable
Tempo datasource: ok
Loki datasource: ok
Metrics datasource: ok
```

### `/obs session`

Shows current session telemetry summary.

```text
Session: 8ddf...
Trace: 4bf92f...
Turns: 12
LLM calls: 18
Tool calls: 35
Cost: $1.42
Open trace: https://grafana.example.com/...
```

### `/obs trace`

Returns a Grafana Tempo trace link.

Options:

```text
/obs trace
/obs trace --last-turn
/obs trace --session <session-id>
```

### `/obs cost`

Queries Prometheus/Mimir.

PromQL example for aggregate cost:

```promql
sum(increase(observme_llm_cost_usd_total[24h])) by (model, provider)
```

Session-scoped metric query, only for deployments that explicitly promote session IDs to metric labels:

```promql
sum(increase(observme_llm_cost_usd_total{pi_session_id="$session"}[24h])) by (model, provider)
```

Because `session_id` is high cardinality, session-scoped metric queries should be disabled by default. The safer default is querying trace/log attributes for the current session.

### `/obs agents`

Shows the current workflow/agent identity and, when query integration is enabled, recent parent/child relationships, depth, fan-out, orphan, and critical-path hints.

Output:

```text
Workflow: 91ce... root=2f4c...
Agent: 2f4c... (orchestrator depth=0)
Session: 8ddf...
Subagents spawned in current trace: 3
Current tree: depth=2 width=4 active=1 orphaned=0
Latest child: 7a91... status=ok cost=$0.18 join=1.2s
Open lineage trace: https://grafana.example.com/...
```

PromQL aggregate examples must use only low-cardinality labels:

```promql
sum(rate(observme_subagents_spawned_total[1h])) by (agent_role, subagent_depth, spawn_type, spawn_reason)
```

```promql
histogram_quantile(0.95, sum(rate(observme_agent_fanout_count_bucket[1h])) by (subagent_depth, le))
```

```promql
sum(rate(observme_orphan_agents_total[1h])) by (agent_role, subagent_depth)
```

Per-agent and per-workflow drill-down should use Tempo/Loki attributes such as `pi_workflow_id`, `pi_agent_id`, `pi_agent_parent_id`, and trace/span IDs, not Prometheus labels.

### `/obs tools`

PromQL:

```promql
topk(10, sum(rate(observme_tool_calls_total[1h])) by (tool_name))
```

Failures:

```promql
sum(rate(observme_tool_failures_total[1h])) by (tool_name, error_class)
```

### `/obs errors`

Loki LogQL:

```logql
{service_name="observme-pi-extension", event_name=~".*[.]failed|.*[.]dropped|agent[.]orphaned"}
```

With Loki OTLP ingestion, OTel attribute dots are normalized to underscores (`event.name` -> `event_name`, `pi.session.id` -> `pi_session_id`). `event.category` remains a semantic category such as `lifecycle`, `agent-tree`, or `compaction`; use `event_name` for failure/error selectors. Use `| json` only when the log body itself is JSON; default ObservMe event fields should be OTEL log attributes/structured metadata.

### `/obs logs`

Loki LogQL for current session:

```logql
{service_name="observme-pi-extension", pi_session_id="$session"}
```

Only available if Loki receives `pi.session.id` as structured metadata or label.

## 5. Trace Links

If trace id is available:

```text
https://grafana.example.com/explore?schemaVersion=1&panes=...
```

ObservMe should support configurable URL templates because Grafana URL encoding changes across versions and organizations.

## 6. Grafana Query Abstraction

Interface:

```typescript
interface ObservabilityQueryClient {
  health(): Promise<HealthResult>;
  getTraceLink(traceId: string): string;
  queryPrometheus(query: string, time?: Date): Promise<QueryResult>;
  queryLoki(query: string, range: TimeRange): Promise<LogResult[]>;
  searchTempo(attrs: Record<string, string>, range: TimeRange): Promise<TraceSummary[]>;
}
```

## 7. Safe Query Rules

- Never send raw prompts as query strings.
- Prefer session id, trace id, generated workflow id, generated agent id, and hashed fields.
- Do not query raw prompts, raw commands, raw paths, or inherited subagent environment values.
- Apply max result limits.
- Apply query timeouts.
- Render summaries, not huge raw logs.

Defaults:

```yaml
query:
  timeoutMs: 5000
  maxLogs: 50
  maxTraces: 20
  maxMetricSeries: 20
  maxAgents: 20
```

## 8. Dependency Direction

ObservMe telemetry emission must not depend on Grafana query availability.

Bad:

```text
Pi event -> Grafana query -> emit telemetry
```

Good:

```text
Pi event -> emit telemetry
/obs command -> optional query
```
