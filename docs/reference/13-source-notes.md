# ObservMe Source Notes

This document captures external technical assumptions referenced by the design and the official documentation sources used for cross-checking.

## Pi

- Pi extension lifecycle, event names, command registration, `ExtensionContext`, `ExtensionCommandContext`, and tool hooks are based on the official Pi `docs/extensions.md` documentation.
- Pi extension factories may run before any session starts and may run in invocations that never start a session; background resources such as exporter timers must therefore be started from `session_start` and cleaned up from `session_shutdown`.
- Pi session JSONL format, entry types, tree behavior, and `SessionManager` APIs are based on the official Pi `docs/session-format.md`, `docs/sessions.md`, and `docs/compaction.md` documentation plus installed TypeScript declarations under `@earendil-works/pi-coding-agent/dist/`.
- ObservMe currently registers `session_start`, `session_shutdown`, `agent_start`, `agent_end`, `turn_start`, `turn_end`, `before_provider_request`, `after_provider_response`, `message_end`, `tool_execution_start`, `tool_call`, `tool_result`, `tool_execution_end`, `user_bash`, `session_info_changed`, `model_select`, `thinking_level_select`, `session_before_tree`, `session_tree`, and `session_compact`. Pi exposes additional streaming/update events, but ObservMe does not currently register them.
- Pi exposes `ctx.isProjectTrusted()` and `CONFIG_DIR_NAME`; ObservMe project-local config must use these instead of hardcoding `.pi` or reading untrusted project config.
- Pi does not expose a dedicated built-in "subagent spawned" lifecycle event. Workflow/agent/subagent lineage in ObservMe is an extension-level concern implemented by wrapping subagent launch/wait/join points and propagating W3C trace context plus ObservMe workflow/lineage environment variables.

## OpenTelemetry

- OpenTelemetry Collector receives, processes, and exports traces, metrics, and logs through configurable pipelines of receivers, processors, exporters, and service pipelines.
- OTLP is the preferred protocol between ObservMe and the Collector.
- OTLP/HTTP uses signal paths such as `/v1/traces`, `/v1/metrics`, and `/v1/logs`; OpenTelemetry JS exporters may require signal-specific `url` values even when ObservMe config stores a base endpoint.
- Collector use is recommended for production because it centralizes batching, retries, filtering, routing, sampling, authentication, and backend decoupling.
- Advanced Collector components such as `prometheusremotewrite`, `probabilistic_sampler`, and `tail_sampling` may require the Collector Contrib distribution or a vendor distribution.
- OpenTelemetry GenAI semantic conventions define `gen_ai.*` attributes and metrics for model/client/agent telemetry. In the OpenTelemetry JS semantic-conventions package these GenAI constants are experimental/evolving, so ObservMe also keeps stable `observme_*` product metrics and `pi.*` domain attributes.
- Current GenAI conventions include `gen_ai.agent.id`, `gen_ai.agent.name`, `gen_ai.agent.version`, `gen_ai.tool.*`, `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.*`, and metrics such as `gen_ai.client.operation.duration` and `gen_ai.client.token.usage`. ObservMe records applicable attributes, but its two official GenAI metric instruments are currently registered without measurements.
- W3C trace context (`traceparent`/`tracestate`) is the standard way to propagate parent trace identity across subagent process boundaries; if propagation is unavailable, ObservMe should record span links or equivalent log attributes. ObservMe's `pi.workflow.*` attributes are extension-defined correlation fields for orchestrator/agent-tree drill-down and are not official OTEL semantic conventions.
- `deployment.environment.name` is the official OpenTelemetry deployment-environment resource attribute; `observme.environment` is only a compatibility alias.
- `service.instance.id` and `observme.instance.id` identify an ObservMe telemetry session/process startup; they do not replace `pi.workflow.id` or `pi.agent.id` for logical workflow and parent/child agent lineage.

## Grafana Stack

- Tempo is the reference trace backend and accepts OTLP spans through gRPC or HTTP endpoints such as `/v1/traces` for OTLP/HTTP.
- Loki is the reference log backend and can ingest OpenTelemetry logs through the OTLP HTTP endpoint using the Collector `otlphttp` exporter with an endpoint such as `http://loki:3100/otlp`.
- Loki stores many OTLP attributes as structured metadata and normalizes dots to underscores for queries, for example `event.name` -> `event_name`, `pi.session.id` -> `pi_session_id`, `pi.workflow.id` -> `pi_workflow_id`, and `pi.agent.id` -> `pi_agent_id`.
- Prometheus can receive OTLP metrics over HTTP only when started with `--web.enable-otlp-receiver`; the base endpoint is `/api/v1/otlp`, while explicit signal URLs use `/api/v1/otlp/v1/metrics`.
- Mimir is the reference production-scale Prometheus-compatible metrics backend; Collector remote write to Mimir uses endpoints such as `/api/v1/push`.
