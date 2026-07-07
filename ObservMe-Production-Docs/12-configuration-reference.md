# ObservMe Configuration Reference

## 1. Full Example

```yaml
observme:
  enabled: true
  environment: production
  tenant: platform

  otlp:
    endpoint: https://otel-collector.example.com:4318   # base OTLP HTTP endpoint
    protocol: http/protobuf
    timeoutMs: 3000
    headers:
      Authorization: "Bearer ${OBSERVME_OTLP_TOKEN}"
    tls:
      enabled: true
      insecureSkipVerify: false
    # Derived SDK URLs for OTLP/HTTP exporters:
    # traces:  https://otel-collector.example.com:4318/v1/traces
    # metrics: https://otel-collector.example.com:4318/v1/metrics
    # logs:    https://otel-collector.example.com:4318/v1/logs

  resource:
    attributes:
      service.name: observme-pi-extension
      observme.tenant.id: platform
      pi.project.name: my-project
      deployment.environment.name: production

  workflow:
    idEnv: OBSERVME_WORKFLOW_ID
    enabled: true
    maxDepthWarning: 5
    maxFanoutWarning: 20

  agent:
    # Generated when absent. Parent/root values are accepted only from trusted
    # process environment or explicit runtime options.
    idEnv: OBSERVME_AGENT_ID
    parentIdEnv: OBSERVME_PARENT_AGENT_ID
    rootIdEnv: OBSERVME_ROOT_AGENT_ID
    parentSessionIdEnv: OBSERVME_PARENT_SESSION_ID
    parentTraceIdEnv: OBSERVME_PARENT_TRACE_ID
    parentSpanIdEnv: OBSERVME_PARENT_SPAN_ID
    depthEnv: OBSERVME_AGENT_DEPTH
    spawnIdEnv: OBSERVME_SPAWN_ID
    propagateTraceContext: true
    propagateToSubagents: true
    capabilityEnv: OBSERVME_AGENT_CAPABILITY
    writeCorrelationEntry: false

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

  logs:
    enabled: true
    batch:
      maxQueueSize: 2048
      maxExportBatchSize: 512
      scheduledDelayMillis: 1000

  capture:
    prompts: false
    responses: false
    thinking: false
    toolArguments: false
    toolResults: false
    bashCommands: false
    bashOutput: false
    filePaths: false

  privacy:
    redactionEnabled: true
    allowUnsafeCapture: false
    allowInsecureTransport: false
    tenantSaltEnv: OBSERVME_HASH_SALT
    pathMode: hash
    customRedactionPatterns:
      - name: internal-token
        pattern: "(?i)internal_token=[a-z0-9-]+"

  limits:
    maxPromptChars: 12000
    maxResponseChars: 12000
    maxToolArgumentChars: 8000
    maxToolResultChars: 16000
    maxBashOutputChars: 16000
    maxLogBodyChars: 32000
    maxActiveAgentRuns: 16
    maxActiveTurns: 128
    maxActiveToolCalls: 1024
    maxActiveLlmRequests: 128
    maxActiveSubagentSpawns: 128
    maxActiveAgentWaits: 128
    maxActiveAgentJoins: 128

  query:
    enabled: true
    timeoutMs: 5000
    maxLogs: 50
    maxTraces: 20
    maxMetricSeries: 20
    maxAgents: 20
    links:
      traceUrlTemplate: "https://grafana.example.com/explore?left=..."
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

  shutdown:
    flushTimeoutMs: 3000
```

## 2. Environment Variables

```text
OBSERVME_ENABLED
OBSERVME_ENVIRONMENT
OBSERVME_TENANT
OBSERVME_OTLP_ENDPOINT
OBSERVME_OTLP_PROTOCOL
OBSERVME_OTLP_TRACES_ENDPOINT
OBSERVME_OTLP_METRICS_ENDPOINT
OBSERVME_OTLP_LOGS_ENDPOINT
OBSERVME_OTLP_TOKEN
OBSERVME_WORKFLOW_ID
OBSERVME_WORKFLOW_MAX_DEPTH_WARNING
OBSERVME_WORKFLOW_MAX_FANOUT_WARNING
OBSERVME_AGENT_ID
OBSERVME_PARENT_AGENT_ID
OBSERVME_ROOT_AGENT_ID
OBSERVME_PARENT_SESSION_ID
OBSERVME_PARENT_TRACE_ID
OBSERVME_PARENT_SPAN_ID
OBSERVME_AGENT_DEPTH
OBSERVME_SPAWN_ID
OBSERVME_AGENT_CAPABILITY
OBSERVME_PROPAGATE_TRACE_CONTEXT
OBSERVME_PROPAGATE_TO_SUBAGENTS
OBSERVME_WRITE_CORRELATION_ENTRY
OBSERVME_GRAFANA_URL
OBSERVME_GRAFANA_TOKEN
OBSERVME_GRAFANA_USERNAME
OBSERVME_GRAFANA_PASSWORD
OBSERVME_GRAFANA_TLS_INSECURE_SKIP_VERIFY
OBSERVME_GRAFANA_PREFER_IPV4
OBSERVME_HASH_SALT
OBSERVME_CAPTURE_PROMPTS
OBSERVME_CAPTURE_RESPONSES
OBSERVME_CAPTURE_TOOL_ARGUMENTS
OBSERVME_CAPTURE_TOOL_RESULTS
OBSERVME_CAPTURE_THINKING
OBSERVME_CAPTURE_BASH_COMMANDS
OBSERVME_CAPTURE_BASH_OUTPUT
OBSERVME_CAPTURE_FILE_PATHS
OBSERVME_REDACTION_ENABLED
OBSERVME_ALLOW_UNSAFE_CAPTURE
OBSERVME_ALLOW_INSECURE_TRANSPORT
```

## 3. Workflow and Agent Lineage Configuration

The `workflow:` and `agent:` config blocks control generated workflow identity, generated agent identity, and parent/child propagation. `pi.workflow.id`, `pi.agent.id`, `pi.agent.parent_id`, and related values are high-cardinality identifiers for traces/logs only; they must not be metric labels by default.

Rules:

- Generate a random `pi.agent.id` and `pi.workflow.id` when no trusted value is supplied.
- For root agents, set `pi.agent.root_id = pi.agent.id`, `pi.workflow.root_agent_id = pi.agent.id`, and `pi.agent.depth = 0`.
- For subagents, accept parent/root/depth values from the configured environment variables when the parent process is trusted.
- When `propagateTraceContext` is true, propagate W3C `traceparent`/`tracestate` to child processes launched by ObservMe-aware subagent wrappers.
- When `workflow.enabled` is true, propagate `OBSERVME_WORKFLOW_ID` to child processes and report depth/fan-out/orphan metrics.
- `writeCorrelationEntry` may append a minimal `custom` session entry for recovery, but it must remain disabled by default and must never use `custom_message`.

## 4. Config Precedence

1. Defaults
2. Global config (`~/.pi/agent/observme.yaml`)
3. Project config (`<cwd>/<CONFIG_DIR_NAME>/observme.yaml`, normally `.pi/observme.yaml`) only when `ctx.isProjectTrusted()` is true
4. Environment variables
5. Explicit runtime options

## 5. Safe Production Defaults

```yaml
capture:
  prompts: false
  responses: false
  thinking: false
  toolArguments: false
  toolResults: false
  bashCommands: false
  bashOutput: false
  filePaths: false
privacy:
  redactionEnabled: true
  allowUnsafeCapture: false
  allowInsecureTransport: false
agent:
  propagateTraceContext: true
  propagateToSubagents: true
  writeCorrelationEntry: false
workflow:
  enabled: true
```

## 6. Development Defaults

```yaml
otlp:
  endpoint: http://localhost:4318
  protocol: http/protobuf
privacy:
  redactionEnabled: true
  allowInsecureTransport: true  # development localhost only
capture:
  prompts: false
  responses: false
```

## 7. Local Grafana Query Development

For the bundled `observability-stack/` behind `https://observability.local`, use a supported local-only query configuration such as:

```yaml
query:
  enabled: true
  grafana:
    url: https://observability.local
    token: ${OBSERVME_GRAFANA_TOKEN}      # preferred for service-account/bearer auth when set
    username: admin                       # optional local Basic auth fallback
    password: ${OBSERVME_GRAFANA_PASSWORD}
    datasourceUids:
      tempo: tempo
      loki: loki
      prometheus: prometheus
    tls:
      insecureSkipVerify: true            # local self-signed cert only
    transport:
      preferIPv4: true                    # avoids localhost/observability.local IPv6 stalls
```

Rules:

- A resolved `query.grafana.token` is sent as `Authorization: Bearer ...` and takes precedence.
- When the token is blank or an unresolved placeholder, a resolved `query.grafana.username` and `query.grafana.password` are sent as Basic auth for local development.
- `/obs health` must report Grafana `401`/`403` responses as authentication failures and must not print token or password values.
- `tls.insecureSkipVerify=true` is only for local self-signed certificates; production should trust the CA instead.
- `transport.preferIPv4=true` uses Node's local HTTP(S) transport with IPv4 DNS lookup for Grafana calls.

## 8. Unsafe Debug Mode

Unsafe mode must require explicit opt-in:

```yaml
privacy:
  allowUnsafeCapture: true
capture:
  prompts: true
  responses: true
  toolArguments: true
  toolResults: true
```

ObservMe must display a warning when unsafe capture is active. Unsafe mode must still pass all configured redactors unless redaction is explicitly disabled with a separately validated exception.

## 9. Validation Rules

Reject config when:

- `allowUnsafeCapture=false` and `redactionEnabled=false` while any content capture is true.
- Production endpoint uses `http://` and `allowInsecureTransport` is not true.
- `otlp.protocol=http/protobuf` but a signal-specific exporter URL omits the required `/v1/traces`, `/v1/metrics`, or `/v1/logs` path.
- Metric labels include high-cardinality fields such as workflow IDs, session IDs, agent IDs, parent/child agent IDs, trace IDs, span IDs, entry IDs, spawn IDs, or spawn tool-call IDs.
- Project-local config is read while `ctx.isProjectTrusted()` is false.
- Propagated workflow or agent lineage values are malformed, too long, or contain unsafe characters.
- Queue sizes exceed configured memory guardrails.

## 10. Minimal Config

```yaml
observme:
  otlp:
    endpoint: http://localhost:4318
```

Everything else uses safe defaults.
