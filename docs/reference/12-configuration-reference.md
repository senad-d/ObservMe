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
    activeAgentLeaseDurationMillis: 60000

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
OBSERVME_ACTIVE_AGENT_LEASE_DURATION_MS
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
OBSERVME_GRAFANA_TEMPO_DATASOURCE_UID
OBSERVME_GRAFANA_LOKI_DATASOURCE_UID
OBSERVME_GRAFANA_PROMETHEUS_DATASOURCE_UID
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

### 2.1 Active-agent lease configuration

| Setting | Default | Supported values | Purpose |
| --- | --- | --- | --- |
| `metrics.activeAgentLeaseDurationMillis` | `60000` | Integer `10000`–`300000`, and at least `(2 * metrics.exportIntervalMillis) + 5000` | Validity window renewed on each metric collection while the session is active. |
| `OBSERVME_ACTIVE_AGENT_LEASE_DURATION_MS` | unset | Same as the YAML field | Environment override through the normal trusted `.env` / system environment precedence. |

The value controls failure-convergence latency, not a background timer. A clean shutdown deactivates the lease before final flush and reaches zero after normal export/scrape propagation. An ungraceful exit reaches zero within the configured lease plus up to 5 seconds of supported clock skew and one Prometheus scrape/evaluation interval. Missing or invalid leases fail closed. Keep producer and Prometheus clocks synchronized within 5 seconds; GitHub-hosted runners meet this requirement, while self-hosted runners need reliable time synchronization.

Do not tune this field by shortening Collector `metric_expiration`. The recommended five-minute exporter cleanup remains longer than the default lease and applies to all gauges, counters, and histograms. Changing Collector configuration may require reload or restart, but restart is not required for active-agent correctness.

## 3. Workflow and Agent Lineage Configuration

The `workflow:` and `agent:` config blocks control generated workflow identity, generated agent identity, and parent/child propagation. `pi.workflow.id`, `pi.agent.id`, `pi.agent.parent_id`, and related values are high-cardinality identifiers for traces/logs only; they must not be metric labels by default.

Rules:

- Generate a random `pi.agent.id` and `pi.workflow.id` when no trusted value is supplied.
- For root agents, set `pi.agent.root_id = pi.agent.id`, `pi.workflow.root_agent_id = pi.agent.id`, and `pi.agent.depth = 0`.
- For subagents, accept parent/root/depth values only from the Pi process environment supplied by a trusted ObservMe-aware launcher or from explicit runtime overrides. Project-local `.env` values may configure ObservMe but must not establish lineage provenance.
- Require a complete validated workflow, parent agent, root agent, depth, and spawn envelope. When `propagateTraceContext` is true, also require a valid W3C `traceparent`; validate optional `tracestate` and require duplicate parent trace/span metadata to match it.
- Reject partial, malformed, oversized, or stale propagation fail-open: generate root/orphan identity, emit only bounded sanitized failure telemetry, and never include rejected raw environment values.
- Continue a valid W3C parent context explicitly on the child `pi.session` span. If trusted lineage has no usable continuation, start a new trace and add a validated parent span link when metadata exists, otherwise emit the documented propagation-failure log/counter fallback.
- When `propagateTraceContext` is true, propagate W3C `traceparent`/`tracestate` to child processes launched by ObservMe-aware subagent wrappers.
- When `workflow.enabled` is true, propagate `OBSERVME_WORKFLOW_ID` to child processes and report depth/fan-out/orphan metrics.
- `writeCorrelationEntry` may append a minimal `custom` session entry for recovery, but it must remain disabled by default and must never use `custom_message`.

## 4. Config Precedence

1. Defaults
2. Global config (`~/.pi/agent/observme.yaml`)
3. Project config (`<cwd>/<CONFIG_DIR_NAME>/observme.yaml`, normally `.pi/observme.yaml`) only when `ctx.isProjectTrusted()` is true
4. Project env file (`<cwd>/.env`) only when `ctx.isProjectTrusted()` is true
5. System environment variables
6. Explicit runtime options

Copy `.env.example` to `.env` for project-local extension variables, or export the same `OBSERVME_*` names in the shell before starting Pi. System environment variables override `.env` values, and `.env` must never be committed. If redacted content capture is enabled, set `OBSERVME_HASH_SALT` in the shell or trusted project `.env`; missing salts make capture fail closed.

Automatic project starter file:

- On `session_start`, the extension creates `<cwd>/<CONFIG_DIR_NAME>/observme.yaml` (`<cwd>/.pi/observme.yaml` in the standard distribution) when the project is trusted and the file is missing.
- The target is resolved as an absolute contained project path before mutation. The complete existence-check/create/write window uses Pi's per-file mutation queue, so concurrent starts create at most one starter.
- Existing project config is never overwritten.
- Edit the resolved project `observme.yaml` for custom setup: `otlp.endpoint` / signal-specific endpoints for the Collector, `resource.attributes` for service/project/tenant/environment labels, `capture` and `privacy` for content capture and redaction, and `query.grafana` / `query.links.traceUrlTemplate` for `/obs` query commands.
- The generated starter mirrors the privacy-preserving local profile; raw content capture is disabled, redaction is enabled, and unsafe capture is disabled.
- Keep credentials out of YAML. Reference environment variables in YAML and set secrets through the shell or a trusted project `.env`.
- Use `~/.pi/agent/observme.yaml` only for standard-distribution global defaults that should apply across projects; project `<CONFIG_DIR_NAME>/observme.yaml` overrides it after trust.

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
metrics:
  exportIntervalMillis: 15000
  activeAgentLeaseDurationMillis: 60000
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

For the bundled `observability-stack/`, the supported `/obs` command path is authenticated Grafana through nginx HTTPS at `https://observability.local`. The default stack does not publish Grafana on `localhost:3000`; use a direct `http://127.0.0.1:<port>` Grafana URL only for tests or a custom Compose override.

```yaml
query:
  enabled: true
  links:
    traceUrlTemplate: https://observability.local/explore?left=...
  grafana:
    url: https://observability.local
    token: ${OBSERVME_GRAFANA_TOKEN}      # preferred service-account/bearer token
    username: admin                       # local Basic auth fallback
    password: ${OBSERVME_GRAFANA_PASSWORD}
    datasourceUids:
      tempo: tempo
      loki: loki
      prometheus: prometheus
    tls:
      insecureSkipVerify: true            # local self-signed cert only
    transport:
      preferIPv4: true                    # avoids observability.local IPv6 stalls
```

Rules:

- Create a Grafana service-account token with Viewer access for read-only datasource queries and export it as `OBSERVME_GRAFANA_TOKEN`, or export/set `OBSERVME_GRAFANA_PASSWORD` from `observability-stack/secrets/grafana_admin_password` for local Basic auth. These values may come from system environment variables or a trusted project `.env` copied from `.env.example`.
- Browser login cookies are not used by the extension; `/obs` commands call the Grafana API directly from the Pi process.
- A resolved `query.grafana.token` is sent as `Authorization: Bearer ...` and takes precedence.
- When the token is blank or an unresolved placeholder, a resolved `query.grafana.username` and `query.grafana.password` are sent as Basic auth for local development.
- Query-backed commands and `/obs health` must fail fast before Grafana calls when Grafana auth is unresolved/missing/incomplete, `query.grafana.url` is invalid, or a required datasource UID is blank.
- `/obs health` must report Grafana `401`/`403` responses as authentication failures and must not print token or password values.
- `tls.insecureSkipVerify=true` is only for local self-signed certificates; production should trust the CA instead.
- `transport.preferIPv4=true` uses Node's local HTTP(S) transport with IPv4 DNS lookup for Grafana calls.
- Provisioned datasource UIDs are `tempo`, `loki`, and `prometheus`; Loki selectors use normalized labels such as `service_name`, `pi_session_id`, `event_name`, and `event_category` for ObservMe data.

## 8. Unsafe Debug Mode

Unsafe mode must require explicit opt-in:

```yaml
privacy:
  allowUnsafeCapture: true
capture:
  prompts: true
  responses: true
  thinking: true
  toolArguments: true
  toolResults: true
```

To show redacted LLM chat content in Grafana Tempo and Loki, set `OBSERVME_CAPTURE_PROMPTS=true`, `OBSERVME_CAPTURE_RESPONSES=true`, `OBSERVME_CAPTURE_THINKING=true`, keep `OBSERVME_REDACTION_ENABLED=true`, and set `OBSERVME_HASH_SALT` before the conversation occurs. To show failed-tool output in the Tools dashboard, set `OBSERVME_CAPTURE_TOOL_RESULTS=true` with the same redaction and hash-salt safeguards; successful tool results remain span-only while failed output is emitted to the dedicated `tool.error.captured` Loki stream. Set `OBSERVME_ALLOW_UNSAFE_CAPTURE=true` only when redaction is disabled for intentionally raw local debugging. Dashboards show only new events emitted after these settings and the updated Collector are active; older data dropped by the Collector cannot be recovered.

ObservMe must display a warning when unsafe capture is active. Redacted capture must pass all configured redactors, and raw unsafe capture is permitted only when redaction is explicitly disabled with a separately validated exception.

## 9. Validation Rules

Reject config when:

- `allowUnsafeCapture=false` and `redactionEnabled=false` while any content capture is true.
- Production endpoint uses `http://` and `allowInsecureTransport` is not true.
- `otlp.protocol=http/protobuf` but a signal-specific exporter URL omits the required `/v1/traces`, `/v1/metrics`, or `/v1/logs` path.
- `metrics.activeAgentLeaseDurationMillis` is fractional, non-numeric, below `10000`, above `300000`, or less than `(2 * metrics.exportIntervalMillis) + 5000`.
- Metric labels include high-cardinality fields such as workflow IDs, session IDs, agent IDs, parent/child agent IDs, trace IDs, span IDs, entry IDs, spawn IDs, or spawn tool-call IDs. The generated `observme.instance.id` / `service.instance.id` remains a resource identity used by the Collector for the `observme_instance_id` lease join; it must not be configured as an execution-derived label.
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
