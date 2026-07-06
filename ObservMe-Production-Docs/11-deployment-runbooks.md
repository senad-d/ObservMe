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

Shutdown steps:

1. Parent Pi passes trace context, `OBSERVME_WORKFLOW_ID`, and `OBSERVME_PARENT_AGENT_ID`/`OBSERVME_ROOT_AGENT_ID` to any child Pi processes it launches.
2. Pi exits.
3. ObservMe flushes with timeout.
4. Sidecar collector drains with timeout.
5. CI job ends.

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
