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

- Config loading, precedence, and active-agent lease/export-interval bounds
- Active-agent lease renewal, deactivation, disposal, clock movement, and clean/abrupt lifecycle behavior
- Canonical lease-aware PromQL, replica deduplication, and missing/expired/future lease cases
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

- Correct canonical span name (the current provider request span is `pi.llm.request`)
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
  otel/opentelemetry-collector-contrib:0.104.0
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

### 6.1 Active-agent lease integration

Run the focused cached-exporter test separately from the broad Grafana stack:

```bash
npm run test:integration:active-agent-lease
```

The test starts pinned Collector and Prometheus containers, then runs real Node telemetry producers with a test-safe 2-second export interval, 10-second lease, and 1-second Prometheus scrape interval. It validates clean shutdown and `SIGTERM` first, then kills a producer with `SIGKILL` and requires all of the following:

- the raw `observme_active_agents` claim remains positive across fresh Prometheus scrapes;
- the canonical lease-aware count reaches zero without a shutdown event;
- convergence stays within the documented 10-second lease, 5-second clock-skew allowance, and one 1-second scrape interval;
- the Collector container identity and zero restart count remain unchanged.

The test uses no credentials or content capture. Its parent process owns bounded waits and unconditional cleanup for child processes, containers, anonymous storage, and the dedicated Docker network after success, assertion failure, startup failure, or timeout. A one-minute test-only `metric_expiration` deliberately remains much longer than the lease so exporter caching reproduces the old raw-query failure; production cleanup guidance remains five minutes for the default one-minute lease.

### 6.2 GitHub Actions cancellation validation

The `lease-cancellation` job in `.github/workflows/ci.yml` runs lease unit/contract tests and the focused integration on `ubuntu-latest` with a bounded timeout. It simulates cancellation by sending `SIGKILL` to a producer so the workflow can assert convergence; cancelling the validation job itself could not produce evidence about its own result. An `if: always()` step removes labeled Docker resources when GitHub still schedules cleanup, but the test must reach zero through lease expiry before that step runs.

Production workflows should likewise prefer graceful Pi and sidecar shutdown and use `if: always()` cleanup where available. Force cancellation, runner loss, or power loss can bypass both, so neither cleanup nor a shutdown callback may be the active-count correctness mechanism. GitHub-hosted runners meet the synchronized-clock expectation; self-hosted CI must keep the producer and Prometheus clocks within the supported 5-second skew.

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
- With no envelope, the child is a normal root; a partial, malformed, oversized, or stale envelope fails open as a root-like orphan.
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

1. Update the version and `CHANGELOG.md`.
2. Run `npm run validate` for source/test typechecks, ESLint, formatting, script checks, unit/contract/dashboard/alert tests, package-content checks, packaged-install smoke, handler smoke, Pi lifecycle smoke, and Pi runtime smoke.
3. Run `npm run test:integration:collector` against the pinned Collector distribution.
4. Run `npm run test:integration:active-agent-lease` and require clean shutdown, `SIGTERM`, and `SIGKILL` convergence without Collector restart while the raw claim remains cached.
5. Run `npm run test:integration:grafana-stack` for live backends and dashboard provisioning. Record any unrelated pre-existing blocker precisely; it must not replace focused lease evidence.
6. Validate Compose interpolation and the Collector config with the pinned distribution when Collector/example configuration changed.
7. Run `npm run pack:dry-run` and confirm the lease metric source, dashboards, alerts, examples, user/operator/reference docs, and packaged `observme-docs` skill are present. Do not publish during this check.
8. Record sanitized date, environment versions, pass/fail status, cleanup result, and any blocker in `docs/compatibility-matrix.md` and `docs/review-validation.md`; never record credentials, raw content, private paths, commands from interactive Pi, or full high-cardinality identifiers.
9. Publish the package/artifact only after lease-related failures are resolved.
10. Tag the release.

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
observme_agent_lease_expires_unixtime_seconds
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

## 13. Export Health operational contract

The Export Health dashboard is considered operationally useful when it proves both healthy liveness and induced failure visibility without changing a user's working local setup.

Healthy local validation:

- Keep the existing trusted-project setup and configured local OTLP endpoint; do not change `/obs status`, `/obs health`, Grafana auth/profile, or local debug capture settings to satisfy this contract.
- Generate representative Pi handler activity and verify `observme_events_observed_total` increases.
- Verify failure-only stat panels display `0` when no matching series exists for telemetry drops, redaction failures, export failures, or handler failures.
- Treat empty Loki tables for `telemetry.dropped`, `redaction.failed`, `export.failed`, and `trace_context.propagation_failed` as healthy when no matching failure was induced.

Induced failure validation:

- Queue-full or bounded-registry eviction increments `observme_telemetry_dropped_total` with bounded `reason` labels and emits a `telemetry.dropped` log.
- Redaction exceptions increment `observme_redaction_failures_total` with bounded `operation`/`error_class` labels and emit a `redaction.failed` log without raw content.
- Export failures increment `observme_export_errors_total` with bounded `reason`/`error_class` labels and emit existing `export.failed` logs.
- Subagent trace-context propagation failures increment the documented counter and emit `trace_context.propagation_failed` logs.
- Active span pressure is visible through `observme_active_spans` by bounded `operation`; normal completion, eviction, and shutdown must not leave negative or leaked gauge values.

Label validation for Export Health metrics is limited to `operation`, `reason`, `error_class`, and `status` where needed. Session IDs, workflow IDs, agent IDs, trace/span IDs, entry IDs, raw prompts, raw paths, raw commands, and raw error messages remain span/log attributes or are omitted; they are never metric labels.

## 14. Support Procedure

When troubleshooting:

1. Run `/obs status`.
2. Run `/obs health`.
3. Run `/obs agents` when troubleshooting workflow, parent/subagent lineage, fan-out, depth, or orphan agents.
4. Check Collector health endpoint.
5. Check Collector logs.
6. For active-agent incidents, compare the canonical leased count, raw positive claims, expired claims, and direct presence of `observme_agent_lease_expires_unixtime_seconds`; then verify producer/Prometheus clock skew, `observme_instance_id` preservation, and the configured lease/export relationship.
7. Query `observme_export_errors_total` and inspect Export Health before deciding that a missing or expired lease means the producer stopped.
8. Query Loki for `event_name="export.failed"` (or equivalent normalized structured metadata).
9. Temporarily enable the debug exporter in the Collector.
10. Never enable raw content capture in production without approval.

See [`11-deployment-runbooks.md` §5](11-deployment-runbooks.md#5-common-incidents) for expired-claim and missing-lease decision trees.
