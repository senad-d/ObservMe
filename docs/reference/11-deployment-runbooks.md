# ObservMe Deployment Runbooks

## 1. Local Debug Runbook

### Start Collector

```bash
cat > collector-debug.yaml <<'YAML'
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318
exporters:
  debug:
    verbosity: detailed
processors:
  batch: {}
service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [debug]
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [debug]
    logs:
      receivers: [otlp]
      processors: [batch]
      exporters: [debug]
YAML

docker run --rm -p 4317:4317 -p 4318:4318 \
  -v "$PWD/collector-debug.yaml:/etc/otelcol/config.yaml" \
  otel/opentelemetry-collector:latest
```

This debug config uses only core Collector components. Production configs that use `prometheusremotewrite`, `tail_sampling`, or other contrib components must run a distribution that includes those components.

### Configure ObservMe

```yaml
otlp:
  endpoint: http://localhost:4318   # ObservMe base endpoint; SDK exporters use /v1/traces, /v1/metrics, /v1/logs
  protocol: http/protobuf
traces:
  enabled: true
metrics:
  enabled: true
logs:
  enabled: true
capture:
  prompts: false
  responses: false
```

### Validate

Run Pi with ObservMe loaded and execute:

```text
/obs status
/obs health
```

## 2. Docker Compose LGTM Runbook

Services:

- otel-collector
- tempo
- loki
- prometheus
- grafana

Recommended ports:

```text
4317 collector OTLP gRPC
4318 collector OTLP HTTP
3000 grafana
3100 loki
3200 tempo
9090 prometheus
```

### Prometheus exporter cleanup policy

The bundled Collector exposes all metrics through one Prometheus exporter with `metric_expiration: 5m`. Treat that value only as stale-series/cardinality cleanup, not as active-agent liveness. It applies to every exported gauge, counter, and histogram. The leased active-agent queries determine liveness and converge after the 60-second default lease even while a raw positive claim remains cached.

When changing `metrics.activeAgentLeaseDurationMillis`, `metrics.exportIntervalMillis`, scrape timing, or expected outage tolerance:

1. Keep `metric_expiration` longer than the active-agent lease; five minutes is the recommendation for the default 60-second lease and 15-second export interval.
2. Leave enough margin for ordinary export delays and scrape gaps. Shorter cleanup lowers Collector memory/cardinality but can remove every metric type during a temporary producer outage; longer cleanup retains abandoned series longer.
3. Preserve generated `observme.instance.id`/`service.instance.id` resource identity for lease joins, while continuing to drop workflow, session, logical-agent, trace, span, spawn, and job-run identifiers from metric labels.
4. Validate the configuration with the deployed Collector distribution, then use its supported reload mechanism or restart it. The bundled Compose stack requires a Collector restart.
5. Expect a restart to clear the exporter's in-memory cache only. Prometheus history remains stored until its normal retention or deletion policy removes it. Traces and logs are unaffected.

For the pinned local distribution, validate before restart:

```bash
docker compose -f observability-stack/docker-compose.yml config
docker compose -f observability-stack/docker-compose.yml exec -T otel-collector \
  /otelcol-contrib validate --config=/etc/otel/otel-collector.yaml
```

## 3. CI Agent Runbook

CI agents are short lived. Use one of:

### Option A: Direct to central Collector

```text
Pi CI job -> central collector
```

Simplest. Requires network availability and credentials.

### Option B: Sidecar Collector

```text
Pi CI job -> sidecar collector -> central collector
```

Best for high-volume jobs because Pi hands off telemetry locally.

Preferred shutdown steps:

1. Parent Pi passes trace context, `OBSERVME_WORKFLOW_ID`, and `OBSERVME_PARENT_AGENT_ID`/`OBSERVME_ROOT_AGENT_ID` to any child Pi processes it launches.
2. Stop Pi and child producers gracefully so ObservMe can deactivate the lease, export the zero lifecycle claim, and flush within its timeout.
3. Drain the sidecar Collector with a timeout.
4. Put best-effort process, container, and network cleanup in an `if: always()` GitHub Actions step.
5. End the CI job.

Graceful shutdown and unconditional cleanup reduce latency and resource leakage, but forced cancellation, `SIGKILL`, runner loss, or power loss can skip both. The active count still converges from the last lease; never make a post-job step, Pi shutdown callback, or Collector restart the correctness mechanism. Test cancellation by killing a child producer from a still-running validation job, because a cancelled workflow cannot assert its own convergence.

GitHub-hosted runners satisfy the supported clock expectation. A self-hosted runner must keep its wall clock and the Prometheus clock synchronized within 5 seconds using reliable NTP or an equivalent managed time service. Monitor synchronization health and clock steps; a producer clock behind can fail closed early, while one ahead can delay expiry until the bounded future-horizon rule rejects it.

## 4. Production Configuration Checklist

- [ ] OTLP endpoint uses TLS or private network.
- [ ] Authentication configured.
- [ ] Prompts disabled by default.
- [ ] Responses disabled by default.
- [ ] Tool arguments disabled by default.
- [ ] Redaction enabled.
- [ ] Metric labels audited for cardinality.
- [ ] Agent IDs, session IDs, trace IDs, and spawn IDs are not metric labels.
- [ ] Workflow/subagent lineage propagation is enabled where subagents are used.
- [ ] Workflow/agent-tree alerts are tuned for expected max depth, fan-out, active-agent count, and cost budget.
- [ ] Collector distribution contains every configured component.
- [ ] Collector memory limiter enabled.
- [ ] Collector batch processor enabled.
- [ ] Loki structured metadata enabled when required by the deployed Loki version.
- [ ] Prometheus OTLP receiver enabled with `--web.enable-otlp-receiver` if sending directly to Prometheus.
- [ ] Prometheus scrape-exporter `metric_expiration` is longer than the active-agent lease and is treated only as exporter-wide cleanup.
- [ ] Lease-aware queries, rather than raw active claims or Collector expiration, determine active-agent liveness.
- [ ] Producer and Prometheus clocks are synchronized within 5 seconds; self-hosted runner time synchronization is monitored.
- [ ] GitHub Actions uses graceful shutdown and `if: always()` cleanup where possible without depending on either for active-count correctness.
- [ ] Backend retention configured.
- [ ] Dashboards imported.
- [ ] Alerts enabled.
- [ ] `/obs health` succeeds.
- [ ] `/obs agents` shows expected workflow/root/subagent lineage, depth, fan-out, active-child count, and orphan count when subagents are enabled.

## 5. Common Incidents

### No Traces in Tempo

Check:

1. `/obs status` traces enabled
2. Collector receives traces
3. Collector trace pipeline exports to Tempo
4. Tempo OTLP endpoint reachable
5. Grafana Tempo datasource configured

### No Logs in Loki

Check:

1. Logs enabled in ObservMe
2. Collector logs pipeline configured
3. Loki accepts the OTLP endpoint (`/otlp` for Collector `otlphttp` exporter)
4. Structured metadata enabled if required
5. Queries use normalized attribute names such as `event_name` and `pi_session_id`
6. Label cardinality within limits

### No Metrics in Prometheus

Check:

1. Metrics enabled in ObservMe
2. Collector metrics pipeline configured
3. Prometheus OTLP receiver enabled (`--web.enable-otlp-receiver`) and exporter endpoint set to base `/api/v1/otlp` or explicit signal URL `/api/v1/otlp/v1/metrics`, or scrape endpoint configured
4. Metric names visible
5. Resource attributes not unexpectedly dropped

### Active Count Is Correct but Raw Claims Remain

This is expected after an ungraceful producer exit. Check:

1. The dashboard uses the leased active-agent query, not `sum(observme_active_agents)`.
2. The expired-claims diagnostic shows the abandoned stream.
3. The configured lease has elapsed and producer/Prometheus clocks are synchronized within 5 seconds.
4. `metric_expiration` remains longer than the lease. Do not shorten it to force correctness; the exporter will remove the raw gauge, counter, and histogram series together after the cleanup window.
5. Collector memory/cardinality is within budget. If cleanup timing changes, validate and reload/restart the Collector; stored Prometheus history will remain.

No Collector restart is required. Restarting clears the exporter's in-memory cache and can hide the diagnostic raw claim, but it does not improve lease convergence or delete Prometheus history.

### Live Producer Is Missing from the Leased Count

A missing, expired, malformed, or pathologically future lease fails closed. Diagnose in this order:

1. Confirm Prometheus and the Export Health dashboard are reachable. If the backend is unavailable, zero is not a reliable health result.
2. Compare the canonical leased total, raw positive claims, and expired claims. Query `observme_agent_lease_expires_unixtime_seconds` directly only for diagnosis; do not expose `observme_instance_id` in a public legend or variable.
3. If the raw claim and lease are both missing, check `metrics.enabled`, `/obs status`, `/obs health`, OTLP reachability, `observme_export_errors_total`, Collector logs, and the metrics pipeline.
4. If the raw claim exists but the lease is missing, confirm every expected producer runs a lease-capable ObservMe version and that the Collector preserves the same generated `observme_instance_id` label on both metrics. During a mixed-version rollout, missing leases intentionally do not count.
5. If the lease is expired while the producer runs, verify metric collection/export is still occurring, then inspect Export Health for drops or exporter failures. Confirm `metrics.activeAgentLeaseDurationMillis >= (2 * metrics.exportIntervalMillis) + 5000`.
6. If the lease is rejected as future, compare producer and Prometheus clocks. Restore reliable synchronization within 5 seconds; do not widen panel-local PromQL or remove the `time() + 305` safety bound.
7. After export recovers, wait for the next metric collection and Prometheus scrape. The lease renews automatically while the session remains active; neither workload activity nor Collector restart is required.

### Expired Claims Are Missing from Diagnostics

The live total can still be correct. Check whether `metric_expiration` elapsed, the Collector restarted, or the deployment uses remote write rather than the scrape exporter. Any of those can remove the current raw series while historical Prometheus samples remain. Use backend history and Export Health for incident timing; do not infer that graceful shutdown occurred merely because the expired-claim panel is empty.

### Subagents Not Linked to Parent

Check:

1. Parent runtime creates `pi.agent.spawn` spans.
2. Child process receives `traceparent`/`tracestate` or parent trace/span fallback attributes.
3. Child process receives `OBSERVME_WORKFLOW_ID`, `OBSERVME_PARENT_AGENT_ID`, `OBSERVME_ROOT_AGENT_ID`, and `OBSERVME_AGENT_DEPTH`.
4. Queries use normalized attribute names such as `pi_workflow_id`, `pi_agent_id`, `pi_agent_parent_id`, and `pi_agent_root_id`.
5. Collector/Loki configuration has not promoted high-cardinality workflow IDs or agent IDs to index labels unless explicitly accepted.

### High Telemetry Drops

Actions:

1. Increase collector capacity.
2. Increase SDK queue within memory budget.
3. Reduce content capture.
4. Add sampling.
5. Increase batch size.

### Sensitive Data Found

Actions:

1. Disable capture immediately.
2. Rotate exposed secrets.
3. Reduce backend retention or delete data according to backend process.
4. Add redaction test case.
5. Release hotfix.
