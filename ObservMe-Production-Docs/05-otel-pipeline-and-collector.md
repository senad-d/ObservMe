# ObservMe OTEL Pipeline and Collector Design

## 1. Export Strategy

ObservMe emits telemetry through OpenTelemetry SDKs using OTLP.

Recommended protocol:

```text
OTLP/HTTP protobuf to Collector base endpoint http://collector:4318
```

Also supported:

```text
OTLP/gRPC to Collector endpoint collector:4317
```

## 2. Why Collector First

A Collector decouples ObservMe from backend-specific topology. It allows batching, retrying, filtering, redaction, sampling, routing, authentication, and backend replacement without changing the Pi extension.

## 3. SDK Exporter Defaults

```yaml
otlp:
  protocol: http/protobuf
  endpoint: http://localhost:4318     # base endpoint; append /v1/{signal} for explicit JS exporter URLs
  signalEndpoints:
    traces: http://localhost:4318/v1/traces
    metrics: http://localhost:4318/v1/metrics
    logs: http://localhost:4318/v1/logs
  timeoutMs: 3000
  headers: {}

traces:
  enabled: true
  sampler: parentbased_traceidratio
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

logs:
  enabled: true
  batch:
    maxQueueSize: 2048
    maxExportBatchSize: 512
    scheduledDelayMillis: 1000
```

The OpenTelemetry JS OTLP HTTP exporters default to signal-specific paths such as `http://localhost:4318/v1/traces`, `http://localhost:4318/v1/metrics`, and `/v1/logs`. Treat `otlp.endpoint` as a base endpoint in ObservMe config, but pass signal-specific URLs to SDK exporters that require an explicit `url`.

## 4. Trace Context and Workflow/Agent-Lineage Propagation

When ObservMe launches or wraps a subagent process, the parent runtime should propagate both standard trace context and ObservMe-specific lineage:

```text
traceparent
tracestate
OBSERVME_WORKFLOW_ID
OBSERVME_AGENT_ID              # optional explicit child id, normally omitted so child generates one
OBSERVME_PARENT_AGENT_ID
OBSERVME_ROOT_AGENT_ID
OBSERVME_PARENT_SESSION_ID
OBSERVME_PARENT_TRACE_ID
OBSERVME_PARENT_SPAN_ID
OBSERVME_AGENT_DEPTH
OBSERVME_SPAWN_ID
```

Preferred behavior is W3C trace-context continuation: the child `pi.session` span becomes part of the same trace as the parent `pi.agent.spawn` span. If the child cannot continue the parent trace, ObservMe should start a new trace and record a span link or structured log with the parent trace/span IDs, `pi.workflow.id`, and `pi.agent.parent_id`.

These identifiers are high cardinality. Keep them on resource/span/log attributes only; do not promote them to Collector-generated metric labels or Loki index labels unless an operator explicitly accepts the cardinality cost.

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

This configuration routes traces to Tempo, logs to Loki, and metrics to a Prometheus-compatible remote write endpoint such as Mimir. Use a Collector distribution that contains every configured component. The minimal debug example works with the core Collector, while `prometheusremotewrite`, `probabilistic_sampler`, and `tail_sampling` are commonly deployed from the Collector Contrib distribution or a vendor distribution such as Grafana Alloy.

```yaml
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

  prometheusremotewrite/mimir:
    endpoint: http://mimir:9009/api/v1/push
    sending_queue:
      enabled: true
    retry_on_failure:
      enabled: true

  debug:
    verbosity: basic

service:
  extensions: [health_check]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, resource/observme, attributes/drop_content_attributes, batch]
      exporters: [otlp/tempo]

    metrics:
      receivers: [otlp]
      processors: [memory_limiter, resource/observme, resource/drop_high_cardinality_metric_attrs, batch]
      exporters: [prometheusremotewrite/mimir]

    logs:
      receivers: [otlp]
      processors: [memory_limiter, resource/observme, attributes/drop_content_attributes, batch]
      exporters: [otlphttp/loki]
```

The Collector attribute processor is defense in depth for attributes only. It must not be the only redaction layer, and it does not sanitize arbitrary log bodies; ObservMe must redact or drop sensitive content before export.

Keep high-cardinality lineage attributes on traces/logs, but remove them from the metrics pipeline unless the organization explicitly accepts the cardinality. Do not enable Prometheus resource-to-telemetry conversion for `pi.workflow.id`, `pi.agent.id`, `pi.session.id`, trace IDs, or spawn IDs.

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
