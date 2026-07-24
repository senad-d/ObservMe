# ObservMe OTEL Pipeline and Collector Design

## 1. Export Strategy

ObservMe emits telemetry through OpenTelemetry SDKs using OTLP.

Supported protocol:

```text
OTLP/HTTP protobuf to an absolute HTTP(S) Collector base endpoint
```

The current schema accepts only `otlp.protocol: http/protobuf`, and the extension ships OTLP/HTTP protobuf exporters. OTLP/gRPC is not a supported ObservMe exporter mode.

## 2. Why Collector First

A Collector decouples ObservMe from backend-specific topology. It allows batching, retrying, filtering, redaction, sampling, routing, authentication, and backend replacement without changing the Pi extension.

## 3. SDK Exporter Defaults

```yaml
otlp:
  protocol: http/protobuf
  endpoint: https://otel-collector.example.com:4318
  timeoutMs: 3000
  headers:
    Authorization: "Bearer ${OBSERVME_OTLP_TOKEN}"
  tls:
    insecureSkipVerify: false
  # signalEndpoints is absent by default. When omitted, ObservMe derives
  # /v1/traces, /v1/metrics, and /v1/logs from the base endpoint.

traces:
  enabled: true
  sampleRatio: 1.0
  batch:
    maxQueueSize: 2048
    maxExportBatchSize: 512
    scheduledDelayMillis: 1000
    exportTimeoutMillis: 3000

metrics:
  enabled: true
  exportIntervalMillis: 15000
  exportTimeoutMillis: 3000
  activeAgentLeaseDurationMillis: 60000

logs:
  enabled: true
  batch:
    maxQueueSize: 2048
    maxExportBatchSize: 512
    scheduledDelayMillis: 1000
```

The OpenTelemetry JS OTLP HTTP exporters default to signal-specific paths such as `http://localhost:4318/v1/traces`, `http://localhost:4318/v1/metrics`, and `/v1/logs`. Treat `otlp.endpoint` as a base endpoint in ObservMe config, but pass signal-specific URLs to SDK exporters that require an explicit `url`.

The default active-agent lease is 60 seconds and renews on each 15-second metric collection. Supported lease values are 10 seconds through 5 minutes and must be at least twice the export interval plus 5 seconds. Keep the producer and Prometheus clocks within 5 seconds; otherwise a lease may fail closed early or remain valid longer than intended. The exact contract is frozen in [`04-telemetry-semantic-conventions.md` §12.4.1](04-telemetry-semantic-conventions.md#1241-active-agent-lease-and-clock-contract).

## 4. Trace Context and Workflow/Agent-Lineage Propagation

When an ObservMe-aware orchestrator launches a subagent process, it should call `startSubagent()` and pass the returned environment unchanged. That environment can contain standard trace context and ObservMe-specific lineage:

```text
traceparent
tracestate
OBSERVME_WORKFLOW_ID
OBSERVME_PARENT_AGENT_ID
OBSERVME_ROOT_AGENT_ID
OBSERVME_PARENT_SESSION_ID
OBSERVME_PARENT_TRACE_ID
OBSERVME_PARENT_SPAN_ID
OBSERVME_AGENT_DEPTH
OBSERVME_SPAWN_ID
```

Preferred behavior is W3C trace-context continuation: the child `pi.session` span becomes part of the same trace as the parent `pi.agent.spawn` span. If the child cannot continue the parent trace, ObservMe should start a new trace and record a span link or structured log with the parent trace/span IDs, `pi.workflow.id`, and `pi.agent.parent_id`.

A child envelope must not contain `OBSERVME_AGENT_ID`; the child generates its own logical agent ID. These identifiers are high cardinality. Keep them on resource/span/log attributes only; never promote them to Collector-generated metric labels. Loki label promotion requires an explicit cardinality decision; structured metadata is preferred for broad deployments.

## 5. Minimal Debug Collector

Use this for local validation.

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch: {}

exporters:
  debug:
    verbosity: detailed

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
```

## 6. Production Collector for Grafana Stack

This configuration routes traces to Tempo, logs to Loki, and metrics to a Prometheus scrape endpoint. Use a Collector distribution that contains every configured component. The minimal debug example works with the core Collector, while `prometheus`, `prometheusremotewrite`, `probabilistic_sampler`, and `tail_sampling` are commonly deployed from the Collector Contrib distribution or a vendor distribution such as Grafana Alloy.

```yaml
# Production-oriented Collector reference for Tempo, Loki, and Prometheus.
# Verify that your Collector distribution contains every configured component,
# replace backend endpoints/security for your deployment, and never add raw
# content or high-cardinality execution identifiers to metric labels.
# Guide: examples/README.md; design: docs/reference/05-otel-pipeline-and-collector.md.
extensions:
  health_check:
    endpoint: 0.0.0.0:13133

receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 1024
    spike_limit_mib: 256

  batch:
    timeout: 2s
    send_batch_size: 1024
    send_batch_max_size: 2048

  resource/observme:
    attributes:
      - key: telemetry.source
        value: observme
        action: upsert
      - key: service.name
        value: observme-pi-extension
        action: insert
      - key: service.namespace
        value: pi
        action: upsert

  resource/drop_high_cardinality_metric_attrs:
    attributes:
      - key: pi.workflow.id
        action: delete
      - key: pi.workflow.root_agent_id
        action: delete
      - key: pi.agent.id
        action: delete
      - key: pi.agent.parent_id
        action: delete
      - key: pi.agent.root_id
        action: delete
      - key: pi.agent.run.id
        action: delete
      - key: pi.agent.spawn.id
        action: delete
      - key: pi.agent.spawn.tool_call_id
        action: delete
      - key: pi.agent.child.id
        action: delete
      - key: pi.session.id
        action: delete

  # Drops accidental content attributes from logs. Intentional LLM content capture
  # is emitted as already-redacted log bodies and opt-in span attributes.
  attributes/drop_content_attributes:
    actions:
      - key: gen_ai.input.messages
        action: delete
      - key: gen_ai.output.messages
        action: delete
      - key: pi.llm.prompt.redacted
        action: delete
      - key: pi.llm.response.redacted
        action: delete
      - key: pi.llm.thinking.redacted
        action: delete
      - key: pi.tool.arguments.redacted
        action: delete
      - key: pi.tool.result.redacted
        action: delete

exporters:
  otlp/tempo:
    endpoint: tempo:4317
    tls:
      insecure: true
    sending_queue:
      enabled: true
    retry_on_failure:
      enabled: true

  otlphttp/loki:
    endpoint: http://loki:3100/otlp
    sending_queue:
      enabled: true
    retry_on_failure:
      enabled: true

  prometheus:
    endpoint: 0.0.0.0:8889
    # Exporter-wide stale-series/cardinality cleanup for gauges, counters, and
    # histograms. Five minutes exceeds ObservMe's default one-minute active-agent
    # lease; lease-aware PromQL, not expiration, determines liveness.
    metric_expiration: 5m
    resource_to_telemetry_conversion:
      enabled: true

  debug:
    verbosity: basic

service:
  extensions: [health_check]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, resource/observme, batch]
      exporters: [otlp/tempo]

    metrics:
      receivers: [otlp]
      processors: [memory_limiter, resource/observme, resource/drop_high_cardinality_metric_attrs, batch]
      exporters: [prometheus]

    logs:
      receivers: [otlp]
      processors: [memory_limiter, resource/observme, attributes/drop_content_attributes, batch]
      exporters: [otlphttp/loki]
```

### 6.1 Prometheus exporter expiration policy

The shipped local and production scrape-exporter examples set `metric_expiration: 5m`. This exporter-level setting applies uniformly to every Prometheus-exported gauge, counter, and histogram; it cannot be scoped only to active-agent metrics. Its only purpose is stale-series and cardinality cleanup: it bounds the Collector memory used by abandoned metric streams and eventually lets Prometheus mark an expired series stale after the exporter stops exposing it. Lease-aware PromQL remains the active-agent correctness mechanism, even while the Collector still exposes a cached positive `observme_active_agents` value.

Five minutes comfortably exceeds the default 60-second active-agent lease and 15-second SDK metric export interval. If either interval is customized, keep `metric_expiration` longer than the lease and allow enough additional time for expected export delays and scrape gaps. A shorter value cleans abandoned streams sooner but can evict gauges, counters, and histograms during a temporary producer outage; a longer value consumes Collector memory and preserves abandoned cardinality for longer. It must never be shortened merely to make active-agent totals converge.

Apply a Collector configuration change through the deployment's supported reload mechanism or restart the Collector. A restart clears the Prometheus exporter's in-memory series cache, but neither reload nor restart deletes samples already stored in Prometheus; historical samples remain subject to Prometheus retention and deletion policy. Restart is never required merely to make an expired active-agent lease stop counting. `metric_expiration` belongs only to the metrics scrape exporter, so traces and logs are unaffected. Remote-write deployments do not use this scrape-exporter cache setting and must apply their backend's series-retention policy, while continuing to use the same lease-aware active-agent queries.

When migrating, deploy a version that emits `observme_agent_lease_expires_unixtime_seconds`, verify the Collector preserves the generated `observme_instance_id`, then replace every current-activity raw sum in dashboards, recording rules, and alerts with the canonical queries in [`09-dashboards-alerts-slos.md` §1.3.1](09-dashboards-alerts-slos.md#131-canonical-active-agent-promql). Keep raw and expired claims only as clearly labeled diagnostics. Missing leases intentionally fail closed, so do not switch a mixed-version fleet until the lease metric is visible for the producers that should count.

The Collector attribute processor is defense in depth for log attributes only. It must not be the only redaction layer, and it does not sanitize arbitrary log bodies; ObservMe must redact or drop sensitive content before export. The traces pipeline intentionally keeps `pi.llm.prompt.redacted`, `pi.llm.response.redacted`, and `pi.llm.thinking.redacted` so Tempo can display redacted content after explicit capture is enabled. Old telemetry that an earlier Collector dropped cannot be recovered; generate new LLM events after updating the Collector.

Keep high-cardinality lineage attributes on traces/logs, but remove them from the metrics pipeline unless the organization explicitly accepts the cardinality. The bundled local Loki pipeline promotes `pi.agent.id` and `pi.agent.run.id` as log labels so the LLM Conversations dashboard can filter captured chat content by agent and run. Prometheus resource-to-telemetry conversion is safe only after the metrics pipeline drops `pi.workflow.id`, `pi.agent.id`, `pi.session.id`, trace IDs, and spawn IDs. Preserve the generated `service.instance.id`/`observme.instance.id` resource identity in the metrics pipeline so lease-aware queries can join and deduplicate concurrent ObservMe metric streams without exposing workflow, session, logical-agent, trace, span, or job-run identifiers as labels.

## 7. Direct-to-Backend Development Mode

Allowed only for development:

```text
ObservMe -> Tempo OTLP HTTP for traces
ObservMe -> Loki OTLP HTTP for logs
ObservMe -> Prometheus OTLP HTTP receiver for metrics only
```

Not recommended for production because every Pi agent would need backend credentials and backend-specific routing. If direct metric export is used, configure SDK views/exporter resource handling so `pi.workflow.*`, `pi.agent.*`, `pi.session.id`, trace IDs, and spawn IDs are not emitted as Prometheus labels.

## 8. Sampling Strategy

Default for developer and CI agents:

```yaml
traces:
  sampleRatio: 1.0
```

Production high-volume environments can sample traces in the Collector:

```yaml
processors:
  probabilistic_sampler:
    sampling_percentage: 25
```

For AI agent observability, tail sampling can be valuable:

- Always keep errors.
- Always keep expensive turns.
- Always keep tool failures.
- Sample successful low-cost turns.

Example policy concept:

```yaml
processors:
  tail_sampling:
    decision_wait: 10s
    policies:
      - name: keep-errors
        type: status_code
        status_code:
          status_codes: [ERROR]
      - name: keep-expensive
        type: numeric_attribute
        numeric_attribute:
          key: pi.llm.cost.total_usd
          min_value: 0.10
      - name: sample-rest
        type: probabilistic
        probabilistic:
          sampling_percentage: 20
```

## 9. Collector Security

Production collectors must:

- Require TLS or run inside trusted network boundaries.
- Authenticate external agents.
- Restrict OTLP ingestion ports.
- Apply rate limits at ingress.
- Avoid exposing collector debug endpoints publicly.
- Use separate tenants or headers for environments.

## 10. Multi-Tenant Routing

Use resource attributes or headers:

```text
observme.tenant.id
deployment.environment.name
observme.environment
pi.project.name
pi.agent.role
pi.agent.depth
```

Collector routing can send tenants to separate backends or tenants within Mimir/Loki/Tempo.

## 11. Backend Notes

### Tempo

Use Tempo for traces. Send via OTLP gRPC or HTTP. Prefer Collector -> Tempo.

### Loki

Use Loki OTLP ingestion for logs. Ensure structured metadata support is enabled for Loki versions/configurations that require it.

### Prometheus / Mimir

For Prometheus-only setups, choose one:

1. Collector exposes Prometheus scrape endpoint.
2. Prometheus enables the OTLP HTTP receiver with `--web.enable-otlp-receiver`; send SDK metrics to base endpoint `http://prometheus:9090/api/v1/otlp` when the exporter appends `/v1/metrics`, or to explicit URL `http://prometheus:9090/api/v1/otlp/v1/metrics` when configuring a signal-specific exporter URL.
3. Collector remote writes to Mimir, Thanos, Cortex, or compatible backend.

For production scale, Mimir or compatible remote write backend is preferred.
