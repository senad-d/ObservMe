# ObservMe Testing, Release, and Operations

## 1. Test Strategy

ObservMe must be tested at five levels:

1. Unit tests
2. Contract tests against Pi event payloads
3. Integration tests with OTEL Collector
4. Backend tests with Grafana stack
5. Chaos and failure tests

## 2. Unit Tests

Required areas:

- Config loading and precedence
- Redaction patterns
- Hashing stability
- Truncation behavior
- Attribute mapping
- Metric label cardinality checks
- Span registry eviction
- Agent lineage ID generation and propagation
- Safe handler error isolation

## 3. Event Mapping Tests

Use JSON fixtures for Pi session entries and extension event payloads:

```text
test/fixtures/session-user-message.json
test/fixtures/session-assistant-usage.json
test/fixtures/session-assistant-usage-reasoning-cache.json
test/fixtures/tool-result-error.json
test/fixtures/bash-execution.json
test/fixtures/compaction.json
test/fixtures/branch-summary.json
test/fixtures/events/session-start.json
test/fixtures/events/agent-start-end.json
test/fixtures/events/turn-start-end.json
test/fixtures/events/message-end-assistant.json
test/fixtures/events/tool-execution-start-end.json
test/fixtures/events/session-compact.json
test/fixtures/events/session-tree.json
test/fixtures/events/subagent-spawn.json
test/fixtures/events/agent-wait-join.json
test/fixtures/events/orphan-agent.json
```

Assertions:

- Correct span name or documented GenAI-compatible provider span name
- Correct `pi.*`, `observme.*`, and applicable `gen_ai.*` attributes
- No forbidden metric labels, including workflow IDs, session IDs, or agent IDs
- Agent-run spans are parented under session spans, and turn spans under agent-run spans when available
- Subagent spawn telemetry carries workflow/parent/root/depth attributes and trace context when configured
- Agent wait/join telemetry exposes child status and critical-path timing without high-cardinality metric labels
- Orphan-agent and trace-context propagation failure metrics/logs are emitted when lineage is missing or malformed
- Optional content absent by default
- Redacted content when capture enabled

## 4. Redaction Tests

Test cases must include:

- AWS keys
- GitHub tokens
- bearer tokens
- OpenAI-like keys
- Anthropic-like keys
- Slack tokens
- password assignments
- private key blocks
- environment variable dumps
- filesystem paths
- URL credentials

Example assertion:

```text
Input:  Authorization: <Bearer abcdefghijklmnopqrstuvwxyz123456>
Output: Authorization: [REDACTED:bearer:<hash>]
```

## 5. Collector Integration Tests

Run Collector with debug exporter:

```bash
docker run --rm \
  -p 4317:4317 \
  -p 4318:4318 \
  -v "$PWD/test/collector-debug.yaml:/etc/otelcol/config.yaml" \
  otel/opentelemetry-collector:latest
```

The core Collector image is sufficient for this debug config. Test production configs with the exact target distribution, for example Collector Contrib or Grafana Alloy when using `prometheusremotewrite`, `tail_sampling`, or other contrib-only components.

Test:

- Traces arrive
- Metrics arrive
- Logs arrive
- Attributes are present
- Content capture defaults are respected

## 6. Grafana Stack Integration Tests

Use Docker Compose with:

- Collector
- Tempo
- Loki
- Prometheus or Mimir
- Grafana

Tests:

- Tempo trace query by trace id
- Tempo or Loki query by `pi.agent.id` / `pi.agent.parent_id` for lineage
- Loki log query by session id
- Prometheus metric query for token totals
- Grafana dashboard import validates

## 7. Failure Tests

### Collector Down

Expected:

- Pi continues.
- ObservMe increments drop/export error metrics if possible.
- No unhandled exception.

### Collector Slow

Expected:

- Export timeout triggers.
- Handler latency remains below budget.

### Subagent Without Propagated Context

Expected:

- Child agent still starts and exports telemetry.
- Child telemetry includes `pi.workflow.id`, `pi.agent.parent_id`, and `pi.agent.root_id` if provided by environment.
- If no parent context is available, child is marked as root or orphan according to config.
- `observme_trace_context_propagation_failures_total` or `observme_orphan_agents_total` increments as appropriate.
- No high-cardinality workflow IDs or agent IDs are emitted as metric labels.

### Runaway Fan-Out or Depth

Expected:

- Pi continues unless a separate policy extension blocks execution.
- Fan-out/depth metrics update (`observme_agent_fanout_count`, `observme_agent_tree_depth`).
- Alerts can fire from dashboard/alert rules.
- No high-cardinality workflow/parent/child IDs are emitted as metric labels.

### Queue Full

Expected:

- Telemetry drops.
- Drop counter increments.
- Memory remains bounded.

### Redaction Exception

Expected:

- Field is dropped.
- Redaction failure metric increments.
- No raw value exported.

## 8. Performance Tests

Synthetic workload:

```text
100 sessions
1,000 turns/session
5 tool calls/turn
2 LLM calls/turn
1 subagent spawn every 20 turns
```

Required measurements:

- handler duration p50/p95/p99
- memory growth
- dropped telemetry count
- export batch sizes
- CPU overhead

Targets:

```text
handler p95 < 10ms
handler p99 < 25ms
steady memory < configured limit
no unbounded maps
```

## 9. Cardinality Tests

Ensure metrics do not include:

- workflow id
- session id
- agent id
- parent agent id
- child agent id
- agent run id
- spawn id
- spawn tool call id
- trace id
- span id
- entry id
- raw path
- raw command
- raw prompt
- raw error

Reject or sanitize dynamically generated labels.

## 10. Release Process

1. Update version.
2. Run unit tests.
3. Run integration tests.
4. Run redaction corpus tests.
5. Run dashboard JSON validation.
6. Run Collector config validation.
7. Generate changelog.
8. Publish package/artifact.
9. Tag release.

## 11. Compatibility Matrix

Maintain a tested matrix:

```text
Pi version
Node.js version
OpenTelemetry JS package set
Collector distribution and version
Tempo version
Loki version
Prometheus/Mimir version
Grafana version
```

## 12. Operational Metrics for ObservMe Itself

ObservMe must emit self-observability metrics:

```text
observme_events_observed_total
observme_handler_errors_total
observme_handler_duration_ms
observme_telemetry_dropped_total
observme_export_errors_total
observme_redaction_failures_total
observme_active_spans
observme_active_agents
observme_workflows_started_total
observme_workflows_completed_total
observme_workflow_errors_total
observme_workflow_duration_ms
observme_agent_runs_total
observme_subagents_spawned_total
observme_subagent_spawn_failures_total
observme_orphan_agents_total
observme_trace_context_propagation_failures_total
observme_child_agent_failures_total
observme_agent_fanout_count
observme_agent_tree_depth
observme_agent_tree_width
observme_agent_wait_duration_ms
observme_agent_join_duration_ms
```

## 13. Support Procedure

When troubleshooting:

1. Run `/obs status`.
2. Run `/obs health`.
3. Run `/obs agents` when troubleshooting workflow, parent/subagent lineage, fan-out, depth, or orphan agents.
4. Check Collector health endpoint.
5. Check Collector logs.
6. Query `observme_export_errors_total`.
7. Query Loki for `event_name="export.failed"` (or equivalent normalized structured metadata).
8. Temporarily enable debug exporter in Collector.
9. Never enable raw content capture in production without approval.
