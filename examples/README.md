# ObservMe examples

The npm package ships configuration examples and an extension-integration example. They are starting points, not credential stores or a complete orchestration product. Copy only what you need, review every endpoint and lifecycle transition, and keep tokens, passwords, and hash salts in environment variables or a trusted project `.env` file.

## `observme.yaml`

[`observme.yaml`](observme.yaml) is a privacy-preserving local-development profile for the repository's supported Grafana stack:

- OTLP/HTTP exports to `http://localhost:4318`.
- Grafana queries use `https://observability.local`.
- Local self-signed TLS and IPv4 preference are enabled for that profile.
- Prompt, response, thinking, tool, Bash, and path capture remain disabled.
- Redaction remains enabled and unsafe capture remains disabled.
- Metrics export every 15 seconds and renew a 60-second active-agent lease; keep producer and Prometheus clocks synchronized within 5 seconds.

To use it in a trusted project:

1. Copy it to `<project>/<CONFIG_DIR_NAME>/observme.yaml` (normally `.pi/observme.yaml`).
2. Set Grafana and OTLP credentials through environment variables or a trusted project `.env`.
3. Restart Pi so the session-scoped configuration is reloaded.
4. Run `/obs status` and `/obs health`.

Read [`../docs/configuration.md`](../docs/configuration.md) for the quick guide and [`../docs/reference/12-configuration-reference.md`](../docs/reference/12-configuration-reference.md) for every setting.

## `collector.yaml`

[`collector.yaml`](collector.yaml) is a production-oriented Collector reference for a Grafana stack:

- traces are exported to Tempo;
- logs are exported to Loki;
- metrics are exposed on a Prometheus scrape endpoint;
- the five-minute `metric_expiration` applies to all exported metric types only as stale-series/cardinality cleanup, not active-agent liveness;
- lease-aware PromQL joins the positive lifecycle claim and lease on generated `observme_instance_id`; raw `observme_active_agents` sums are diagnostics, not production live totals;
- high-cardinality workflow, agent, session, and spawn attributes are removed from metrics;
- accidental content attributes are removed from logs as defense in depth.

The example uses Collector components commonly provided by the Collector Contrib distribution. Verify that your deployed distribution includes every receiver, processor, and exporter, then replace backend endpoints and security settings for your environment.

Read [`../docs/reference/05-otel-pipeline-and-collector.md`](../docs/reference/05-otel-pipeline-and-collector.md) for pipeline design, [`../docs/reference/09-dashboards-alerts-slos.md`](../docs/reference/09-dashboards-alerts-slos.md#131-canonical-active-agent-promql) for canonical queries and raw-query migration, and [`../docs/reference/11-deployment-runbooks.md`](../docs/reference/11-deployment-runbooks.md) for deployment and incident checks.

For GitHub Actions, prefer graceful Pi/sidecar shutdown and an `if: always()` cleanup step, but do not depend on either after force cancellation. Lease expiry provides correctness without a Collector restart. GitHub-hosted runner clocks meet the supported expectation; self-hosted runners must use reliable time synchronization.

## `integrations/subagent-runner.ts`

[`integrations/subagent-runner.ts`](integrations/subagent-runner.ts) demonstrates how another Pi extension can wrap any child transport with ObservMe's versioned integration API. The transport interface can represent a local subprocess, Pi RPC, tmux, SSH, a container, a queue, or another process manager.

The generic adapter records spawn, launcher success/failure, wait, join, cancellation, timeout, and failure propagation while passing the returned environment to the transport unchanged. It does not prescribe task delivery, process management, result encoding, concurrency, retries, durable state, or child-ID handshake.

Read [`../docs/extension-integration.md`](../docs/extension-integration.md) before adapting it and [`../docs/agent-subagent-observability-requirements.md`](../docs/agent-subagent-observability-requirements.md) for the complete orchestration contract.

## Safety notes

- Do not place real secrets directly in either YAML file.
- Keep content capture disabled unless there is an explicit, reviewed need.
- Keep redaction enabled for captured content and configure `OBSERVME_HASH_SALT`.
- Do not promote session, workflow, agent, trace, span, entry, or tool-call IDs to Prometheus labels.
- Use insecure transport or certificate verification bypass only for controlled local development.
