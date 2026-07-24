<p align="center">
  <img alt="ObservMe icon" src="img/icon.svg" width="128">
</p>

<p align="center">
  <a href="https://pi.dev"><img alt="pi package" src="https://img.shields.io/badge/pi-package-6f42c1?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/@senad-d/observme"><img alt="npm" src="https://img.shields.io/npm/v/%40senad-d%2Fobservme?style=flat-square" /></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
  <a href="https://sonarcloud.io/summary/new_code?id=senad-d_ObservMe"><img alt="Quality Gate Status" src="https://sonarcloud.io/api/project_badges/measure?project=senad-d_ObservMe&metric=alert_status" /></a>
</p>

<p align="center">
  OpenTelemetry observability for <a href="https://pi.dev">pi</a> agent sessions.
  <br />Turns Pi session, turn, tool, LLM, bash, branch, compaction, model, thinking, and agent-lineage events into OTLP traces, metrics, and logs.
</p>

---

ObservMe maps Pi lifecycle and session events to OpenTelemetry traces, metrics, and logs, then exports them via OTLP to an OpenTelemetry Collector. It uses `pi.*`, `observme.*`, and applicable official `gen_ai.*` attributes. ObservMe is **privacy-preserving by default**: prompts, responses, thinking content, tool arguments/results, and bash commands/output are not captured unless explicitly enabled. Absolute paths embedded in enabled content are scrubbed by default; `capture.filePaths` is currently a reserved setting with no direct live recording point.

<table align="center">
  <tr>
    <th>ObservMe</th>
  </tr>
  <tr>
    <td align="center">
      <img src="img/demo.gif" alt="ObservMe banner" title="ObservMe" width="760">
    </td>
  </tr>
</table>

- **OTLP-first:** emits OpenTelemetry traces, metrics, and logs; no durable local telemetry database.
- **Fail open:** if the Collector or backend is unreachable, Pi keeps running — telemetry is dropped, never blocking.
- **Privacy by default:** optional content capture starts disabled and passes through the redaction pipeline when enabled.
- **Agent lineage aware:** propagates parent/child/root agent identity and W3C trace context across subagent process boundaries without adding high-cardinality identifiers to metric labels.
- **Pi-native:** usable as a Pi package, project-local install, git install, or local source checkout.

> **Security:** Pi packages run with your full system permissions. ObservMe reads Pi session/event data through Pi's extension API, does not execute shell commands itself, and sends telemetry only to configured OTLP endpoints. Read [`SECURITY.md`](SECURITY.md).

## Table of Contents

- [Implementation Status](#implementation-status)
- [Quick Start](#quick-start)
- [Installation](#installation)
- [Extension Integration](#extension-integration)
- [Commands](#commands)
- [Architecture](#architecture)
- [Available Telemetry](#available-telemetry)
- [Configuration and Privacy](#configuration-and-privacy)
- [Safety Model](#safety-model)
- [Dashboards and Examples](#dashboards-and-examples)
- [Documentation Set](#documentation-set)
- [Development](#development)
- [Publishing](#publishing)
- [License](#license)

---

## Implementation Status

This checkout implements the ObservMe MVP scope described by the packaged [`docs/reference/00-README.md`](docs/reference/00-README.md) technical reference:

- Extension load checks and `/obs health` backend checks.
- Session, workflow, agent-run, turn, LLM, tool, bash, subagent-spawn, wait/join, compaction, branch, model-change, and thinking-level telemetry.
- Lease-qualified multi-agent activity plus tree metrics for depth, fan-out, orphan agents, trace-context propagation failures, child failures, and workflow duration; abrupt exits converge without a Collector restart.
- Session-scoped OTLP trace, metric, and log exporters with bounded queues, timeouts, and shutdown flushing.
- Configurable capture controls, redaction, path scrubbing, hashing, truncation, and high-cardinality metric-label guards.
- Grafana dashboard JSON, alert rules, SLO definitions, Collector examples, and compatibility matrix artifacts.
- Unit, contract, integration, chaos/failure, performance, package, and smoke-test coverage in the validation pipeline.

## Quick Start

Use this checklist to confirm telemetry end to end. You need a supported Pi installation; see the [compatibility matrix](docs/compatibility-matrix.md). If you already have an OTLP Collector and Grafana stack, skip the first step.

### 1) Start the included local stack

The local stack is available in a repository checkout, not in the npm package:

```bash
git clone https://github.com/senad-d/ObservMe.git
cd ObservMe/observability-stack
cp .env.example .env
mkdir -p secrets
if [ ! -s secrets/grafana_admin_password ]; then
  openssl rand -hex 24 > secrets/grafana_admin_password
fi
chmod 600 secrets/grafana_admin_password
docker compose up -d
```

### 2) Install the extension

```bash
cd /path/to/your/project
pi install npm:@senad-d/observme
```

For local-stack credentials or other environment variables, copy `.env.example` from an ObservMe checkout to the project as `.env`. Keep secrets out of `.pi/observme.yaml`.

### 3) Start Pi and check connectivity

```bash
pi
```

Inside Pi, run:

```text
/obs status
/obs health
/obs session
/obs trace
```

### 4) Generate and inspect telemetry

In the running Pi session, start a normal task, such as:

```text
Summarize this repository in one sentence
```

Open your configured Grafana URL, then open **ObservMe Overview** and confirm that the task produced traces, logs, and metrics. ObservMe never blocks Pi execution when the backend is unavailable.

On the first trusted `session_start` for a project, ObservMe creates `observme.yaml` under Pi's exported project config directory (`.pi/observme.yaml` in the standard distribution) when the file is missing. The starter keeps raw prompt, response, thinking, tool, bash, and path capture disabled by default; opt in only to the specific redacted capture fields you need.

### Run from a source checkout

```bash
git clone https://github.com/senad-d/ObservMe.git
cd ObservMe
npm ci
npm run validate
pi --no-extensions -e .
```

## Installation

| Scope | Command | Notes |
| --- | --- | --- |
| Global | `pi install npm:@senad-d/observme` | Loads in every trusted Pi project. |
| Project-local | `pi install npm:@senad-d/observme -l` | Writes to `.pi/settings.json` in the current project. |
| One run | `pi -e npm:@senad-d/observme` | Try without changing settings. |
| Git | `pi install git:senad-d/ObservMe` | Install from Git; use a tag or commit when you need a fixed version. |
| Local checkout | `pi --no-extensions -e .` | Develop or test this repository. |

The package also includes the `observme-docs` skill. Pi can load it automatically for natural-language ObservMe questions, or you can invoke it explicitly with `/skill:observme-docs`. The skill reads only the relevant packaged documentation and cites the matching file and section. ObservMe registers no system-prompt hook; Pi exposes the skill through its normal skill-discovery metadata.

## Extension Integration

Orchestrators, subagent runners, process managers, remote executors, and other Pi extensions can request ObservMe's versioned integration API through `pi.events`. The API records parent-side spawn/wait/join telemetry and returns the sanitized environment that must be passed to each child Pi process for workflow, agent-lineage, and W3C trace propagation.

```typescript
import { requestObservMeIntegration } from "@senad-d/observme/integration";

const observme = requestObservMeIntegration(pi);
const started = observme?.startSubagent({
  command: "pi",
  spawnType: "extension",
  spawnReason: "delegated_task",
  env: process.env,
});

if (started?.ok) {
  let child;
  try {
    child = await launchChildPi({ env: started.env });
  } catch (error) {
    observme.failSubagent(started.spawnId, {
      childAgentId: started.childAgentId,
      errorClass: error instanceof Error ? error.name : "launcher_error",
    });
  }

  if (child) {
    const result = await waitForChildPi(child);
    observme.completeSubagent(started.spawnId, {
      childAgentId: started.childAgentId,
      childStatus: result.status,
      outcome: result.status,
    });
  }
}
```

The discovery helper fails open when the event bus or a provider is malformed. API methods also reject unsafe/oversized requests, duplicate active lifecycle IDs, and active or retained child-placeholder collisions without replacing existing telemetry state. Handle every discriminated failure result locally and keep orchestration functional.

Use [`docs/extension-integration.md`](docs/extension-integration.md) for the complete lifecycle, validation limits, and failure contract. The shipped [`examples/integrations/subagent-runner.ts`](examples/integrations/subagent-runner.ts) wraps a generic child transport, while [`docs/agent-subagent-observability-requirements.md`](docs/agent-subagent-observability-requirements.md) covers the larger orchestration design.

## Commands

All commands are registered under `/obs`.

| Command | Description | Backend access |
| --- | --- | --- |
| `/obs status` | Shows local ObservMe enablement, OTLP endpoint, config source/trust status, Grafana query URL/readiness, signal enablement, capture flags, queue drops, and last export error. | Local state only |
| `/obs health` | Checks Collector, Grafana, and configured datasource reachability with bounded timeouts. | Collector/Grafana |
| `/obs session` | Shows current-session turn, LLM-call, tool-call, cost, and trace-link state from runtime counters. | Local state only |
| `/obs cost` | Queries Prometheus/Mimir for 24-hour model/provider cost aggregates. Session-scoped metric cost queries are rejected. | Prometheus/Mimir via Grafana |
| `/obs trace` | Returns a Grafana Tempo trace link for current, last-turn, or safe session-id scopes. | Local link construction; Tempo via Grafana for a non-current session ID |
| `/obs link` | Uses the same scopes and canonical trace-link builder as `/obs trace`. | Local link construction; Tempo via Grafana for a non-current session ID |
| `/obs tools` | Queries tool-call and tool-failure aggregates using only safe tool/error labels. | Prometheus/Mimir via Grafana |
| `/obs errors` | Queries Loki for recent failed/dropped/orphan event names and renders a capped summary. | Loki via Grafana |
| `/obs logs` | Queries Loki for the current session's normalized `pi_session_id` label, excludes `llm_content`/`tool_content` bodies, and renders a capped operational summary. | Loki via Grafana |
| `/obs agents` | Shows current workflow/agent identity, lineage, fan-out/depth, active children, orphan status, and wait/join hints. | Local state plus safe Tempo/Prometheus drill-downs |
| `/obs backfill` | Explicit current-session OTEL log-record replay with confirmation, replay markers, the live capture/redaction policy, a 100-record default cap, and an optional `--since` window up to 30d. | OTLP log export when confirmed |

Query-backed commands enforce configured timeouts and result limits and reject raw prompt, command, path, or other sensitive query inputs.

Trace visibility note: `/obs trace` and `/obs session` can link to the current trace as soon as `session_start` creates it. During an active Pi session, Tempo may show ended child spans before the long-lived root `pi.session` span appears; the canonical root span is ended, flushed, and visible after `session_shutdown`.

## Architecture

```text
Pi Agent
  └── ObservMe Pi Extension
        ├── OTEL Traces  ──► OTEL Collector ──► Tempo
        ├── OTEL Metrics ──► OTEL Collector ──► Prometheus / Mimir
        └── OTEL Logs    ──► OTEL Collector ──► Loki

Grafana
  ├── Tempo datasource
  ├── Loki datasource
  └── Prometheus/Mimir datasource
```

The extension factory in `src/extension.ts` only registers handlers and commands. OTEL SDK startup happens from `session_start`, and bounded flush/shutdown happens from `session_shutdown`, so importing or registering the extension does not open exporters, timers, or sockets.

## Available Telemetry

Traces, metrics, and logs are enabled by default and can be disabled independently in configuration. The names below are the OpenTelemetry instrument, span, and `event.name` values defined by ObservMe; backend ingestion may normalize dotted names. The tables identify reserved or registered names that do not yet have a live recording point. Other signals appear only after their corresponding Pi lifecycle event occurs.

Metric labels are intentionally low-cardinality. Session, workflow, agent, trace, span, and entry IDs are available on correlated spans and logs, but are not added to Prometheus labels. Prometheus-compatible backends expose histograms as the usual `_bucket`, `_sum`, and `_count` series.

### Metrics

| Type | Area | Available metrics | What they show |
| --- | --- | --- | --- |
| Counter | Sessions and workflows | `observme_sessions_started_total`<br>`observme_sessions_shutdown_total`<br>`observme_workflows_started_total`<br>`observme_workflows_completed_total`<br>`observme_workflow_errors_total` | Session lifecycle and root-workflow outcomes. |
| Counter | Agents and subagents | `observme_agent_runs_total`<br>`observme_agent_run_errors_total`<br>`observme_subagents_spawned_total`<br>`observme_subagent_spawn_failures_total`<br>`observme_orphan_agents_total`<br>`observme_trace_context_propagation_failures_total`<br>`observme_child_agent_failures_total`<br>`observme_parent_recovered_from_child_failure_total` | Agent activity, lineage health, child failures, and parent recovery. |
| Counter | Turns and LLM requests | `observme_turns_started_total`<br>`observme_turns_completed_total`<br>`observme_llm_requests_total`<br>`observme_llm_errors_total` | Turn throughput and provider request outcomes. |
| Counter | LLM tokens and cost | `observme_llm_input_tokens_total`<br>`observme_llm_output_tokens_total`<br>`observme_llm_cache_read_tokens_total`<br>`observme_llm_cache_write_tokens_total`<br>`observme_llm_cache_write_1h_tokens_total`<br>`observme_llm_reasoning_tokens_total`<br>`observme_llm_total_tokens_total`<br>`observme_llm_cost_usd_total` | Provider-reported token usage, cache usage, reasoning usage, and USD cost. Values are recorded when the provider supplies them. |
| Counter | Tools and Bash | `observme_tool_calls_total`<br>`observme_tool_failures_total`<br>`observme_bash_executions_total`<br>`observme_bash_failures_total` | Tool and interactive Bash volume and failures. |
| Counter | Session changes | `observme_model_changes_total`<br>`observme_thinking_level_changes_total`<br>`observme_compactions_total`<br>`observme_branches_total` | Model/thinking changes, compactions, and branch creation. |
| Counter | ObservMe health | `observme_telemetry_dropped_total`<br>`observme_export_errors_total`<br>`observme_redaction_failures_total`<br>`observme_events_observed_total`<br>`observme_handler_errors_total` | Local drops, export/redaction failures, handler activity, and handler failures. |
| Histogram | Workflow and agent tree | `observme_workflow_duration_ms`<br>`observme_agent_run_duration_ms`<br>`observme_subagent_spawn_duration_ms`<br>`observme_agent_wait_duration_ms`<br>`observme_agent_join_duration_ms`<br>`observme_agent_tree_depth`<br>`observme_agent_tree_width`<br>`observme_agent_fanout_count` | Workflow/agent latency and multi-agent tree shape. |
| Histogram | Operation latency | `observme_turn_duration_ms`<br>`observme_llm_request_duration_ms`<br>`observme_tool_duration_ms`<br>`observme_bash_duration_ms`<br>`observme_handler_duration_ms` | End-to-end operation and extension-handler duration in milliseconds. |
| Histogram | Context and payload size | `observme_compaction_tokens_before`<br>`observme_prompt_size_chars`<br>`observme_response_size_chars`<br>`observme_tool_result_size_chars` | Context size before compaction and payload sizes in characters. Size metrics do not contain payload content. |
| Up-down counter | Current activity | `observme_active_spans`<br>`observme_active_agents` | Active operations and the compatibility lifecycle claim for agents in the current exported stream. |
| Asynchronous gauge | Agent liveness lease | `observme_agent_lease_expires_unixtime_seconds` | Absolute Unix expiry renewed on each metric collection while the session is active; operational active-agent queries join it to the positive lifecycle claim. |
| Registered, not yet recorded | Agent lifetime | `observme_agent_lifetime_duration_ms` | Reserved instrument; the current live handlers do not record measurements yet. |
| Registered, not yet recorded | Official GenAI compatibility | `gen_ai.client.token.usage`<br>`gen_ai.client.operation.duration` | Reserved OpenTelemetry GenAI instruments; use the `observme_llm_*` metrics above for current data. |

### Active-agent liveness

`observme_active_agents` remains a clean-start/clean-shutdown lifecycle claim, but raw sums are not authoritative after a crash, `SIGKILL`, cancelled GitHub Actions job, or lost runner. The shipped dashboards and alerts count an instance only when that claim is positive and its `observme_agent_lease_expires_unixtime_seconds` value is current and within the supported future horizon. Clean shutdown reaches zero after export/scrape propagation; an ungraceful exit converges within the configured lease plus up to 5 seconds of supported clock skew and one Prometheus scrape/evaluation interval (80 seconds with the default 60-second lease and a 15-second scrape).

Missing, expired, malformed, or pathologically future leases fail closed. GitHub-hosted runners satisfy the clock requirement; self-hosted runners must keep the producer and Prometheus clocks synchronized within 5 seconds. Collector restart is not required for convergence, even when its Prometheus exporter continues to expose a cached raw claim. Migrate custom panels, alerts, and recording rules from raw `sum(observme_active_agents)` queries to the [canonical lease-aware PromQL](docs/reference/09-dashboards-alerts-slos.md#131-canonical-active-agent-promql), and use raw/expired claims only for diagnostics.

### Traces

| Span name | Created for | Notes |
| --- | --- | --- |
| `pi.session` | A trusted Pi session | Root session span. It remains open during the session and is ended, flushed, and exported on `session_shutdown`. |
| `pi.agent.run` | An agent run | Child of the session span; records run identity, lineage, source, duration, and status. |
| `pi.agent.spawn` | A subagent launch | Records spawn type/reason, child identity, propagation outcome, duration, and failure status. |
| `pi.agent.wait` | Waiting for a child agent | Correlates the parent, child, spawn, wait reason, and duration. |
| `pi.agent.join` | Joining a child agent | Records child/join status, failure propagation or recovery, and duration. |
| `pi.turn` | An agent turn | Child of the active agent run when available; contains turn, model, and lineage metadata. |
| `pi.llm.request` | An LLM provider request | Records provider/model, API, usage, cost, stop reason, duration, and status. Redacted content attributes are opt-in. |
| `pi.tool.call` | A Pi tool call | Records safe tool metadata, result size, duration, success, and bounded error class. Arguments/results are opt-in. |
| `pi.bash.execution` | Interactive Bash execution | Records exit/cancel/truncation metadata, output size, duration, and status. Commands/output are opt-in. Tool-driven Bash remains a `pi.tool.call` span. |
| `pi.compaction` | Session compaction | Records compaction reason, token count, summary metadata, and file-count metadata. |
| `pi.branch` | Session-tree branch creation | Records source/destination entry metadata, branch summary metadata, and file counts. |
| `pi.model.change` | Model change | Reserved span name. Current live telemetry adds a `model.changed` event to `pi.session` and emits a structured log instead of a standalone span. |
| `pi.thinking.change` | Thinking-level change | Reserved span name. Current live telemetry adds a `thinking.changed` event to `pi.session` and emits a structured log instead of a standalone span. |

### Logs

All operational logs use short event bodies plus structured attributes. Correlation fields include available session, workflow, agent, agent-run, turn, trace, and span IDs. Raw prompts, responses, thinking, tool data, Bash data, paths, and error messages are excluded unless their specific capture setting is enabled and the value passes the redaction policy.

| Area | Available `event.name` values | Availability and purpose |
| --- | --- | --- |
| Configuration, session, and workflow | `config.rejected`<br>`session.started`<br>`session.named`<br>`session.shutdown`<br>`session.duplicate_start`<br>`workflow.started`<br>`workflow.completed`<br>`workflow.failed`<br>`workflow.cancelled`<br>`workflow.unknown` | Configuration diagnostics, session rename metadata, and top-level lifecycle/outcome events. |
| Reserved session event | `session.error` | Public event name reserved for compatibility; current live handlers do not emit it. |
| Agent run | `agent.run.started`<br>`agent.run.completed`<br>`agent.run.failed`<br>`agent.run.cancelled`<br>`agent.run.unknown` | Agent-run lifecycle and outcome. |
| Subagent lineage | `agent.spawn.started`<br>`agent.spawn.completed`<br>`agent.spawn.failed`<br>`agent.spawn.cancelled`<br>`agent.wait.started`<br>`agent.wait.completed`<br>`agent.join.started`<br>`agent.join.completed`<br>`agent.orphaned`<br>`trace_context.propagation_failed` | Parent/child lifecycle, lineage gaps, propagation failures, and join outcomes. |
| Turn | `turn.started`<br>`turn.completed`<br>`turn.failed`<br>`turn.cancelled`<br>`turn.unknown` | Turn lifecycle with run/turn correlation and payload-derived outcomes. |
| LLM lifecycle | `llm.request.started`<br>`llm.request.completed`<br>`llm.request.failed` | Content-free provider request lifecycle, usage, cost, stop reason, and bounded errors. |
| LLM content | `llm.prompt.captured`<br>`llm.response.captured`<br>`llm.thinking.captured` | Emitted only when the corresponding prompt, response, or thinking capture flag is enabled and redaction succeeds. |
| Replay | `message.replayed` | Emitted by explicit `/obs backfill` replay; historical replay is disabled by default. |
| Tools | `tool.call.started`<br>`tool.call.completed`<br>`tool.call.failed` | Content-free tool lifecycle, safe tool metadata, status, and correlation. |
| Tool content | `tool.error.captured` | Separate failed-tool result log emitted only when `capture.toolResults` is enabled and redaction succeeds. |
| Bash | `bash.completed` | Interactive Bash completion, status, exit/cancel/truncation metadata, and safe size/hash metadata. |
| Session changes | `model.changed`<br>`thinking.changed`<br>`branch.created`<br>`compaction.created` | Model/thinking annotations and branch/compaction lifecycle. |
| ObservMe health | `telemetry.dropped`<br>`redaction.failed`<br>`export.failed`<br>`handler.failed` | Bounded, content-safe diagnostics for the extension's own telemetry pipeline. |

## Configuration and Privacy

ObservMe supports layered configuration with this precedence:

```text
defaults → global ~/.pi/agent/observme.yaml → trusted project config → trusted project .env → system environment variables → runtime options
```

Factory-safe loading uses defaults/global/system-environment/runtime options only. Session-scoped loading can add trusted project config and a project-local `.env` when Pi marks the project trusted. Global and project `observme.yaml` files are limited to 256 KiB; the project `.env` is limited to 128 KiB. Exact-limit files load, while larger files are rejected from opened-file metadata before content allocation. Project files must remain inside the stable canonical project root: in-root symlinks are supported, while out-of-root, dangling, replaced, or unverifiable paths fail closed through identity-verified file I/O. `/obs status` reports the effective config source, whether project-local config was loaded, skipped because the project is untrusted, missing, or rejected, plus bounded rejection issue codes, effective OTLP/Grafana transport security, the configured Grafana URL, and query-readiness status without rendering tokens, passwords, canonical targets, or external paths. In untrusted projects, ObservMe does not read project-local config or `.env` files and uses safe defaults/global/system-environment layers instead. Invalid or unsafe configuration emits a bounded `config.rejected` diagnostic and falls back safely without exposing rejected values.

Cross-process agent lineage has a separate boundary: only the Pi process environment available to the shipped extension, or explicit runtime options for controlled embedders, is eligible for parent provenance. Project-local `.env` values configure ObservMe but cannot establish lineage. A child accepts only a complete validated workflow/parent/root/depth/spawn envelope and valid W3C context; malformed or stale envelopes fail open to a root/orphan fallback with sanitized telemetry.

Default capture policy:

```yaml
capture:
  prompts: false
  responses: false
  thinking: false
  toolArguments: false
  toolResults: false
  bashCommands: false
  bashOutput: false
  filePaths: false  # reserved; no direct live file-path recording point
privacy:
  redactionEnabled: true
  allowUnsafeCapture: false
  allowInsecureTransport: false
workflow:
  enabled: true
```

When optional content capture is enabled, live telemetry and `/obs backfill` use the same policy. With `privacy.redactionEnabled: true`, the live pipeline applies size guards, secret detection, cross-platform absolute-path scrubbing (`hash`, `basename`, `full`, or `drop`), custom regex redactors, truncation metadata, and tenant-salted hashing before export. A PII stage exists in the redaction helper, but the current live configuration does not provide or enable a PII detector; do not rely on it for PII removal. POSIX, Windows-drive, and UNC paths are scrubbed without treating normal URLs or harmless slash-separated prose as paths. `privacy.pathMode: full` preserves recognized paths embedded in other enabled content regardless of `capture.filePaths`, so use it only when that exposure is intentional. Redaction failures drop content and emit `redaction.failed` diagnostics. With `privacy.redactionEnabled: false` and `privacy.allowUnsafeCapture: true`, captured content is exported raw but still truncated to the configured limit. Hash salts are read from secure environment/runtime config, not hardcoded.

To show failed-tool output such as GuardMe denial messages in the Tools dashboard, explicitly set `capture.toolResults: true` (or `OBSERVME_CAPTURE_TOOL_RESULTS=true`) while keeping redaction enabled and providing `OBSERVME_HASH_SALT`. New failed calls then emit a separate `tool.error.captured` content log; normal `tool.call.failed` operational logs remain content-free.

Metadata such as token counts, duration, status, model/provider, tool name, and agent role/depth is captured by default. High-cardinality identifiers (session IDs, workflow IDs, agent IDs, trace/span IDs, entry IDs) are allowed on spans/logs for drill-down but are blocked from Prometheus metric labels.

Grafana-backed query commands use the Grafana HTTP API, so browser login cookies are irrelevant. Keep `query.grafana.url` credential-free; a base URL containing a username or password is rejected before network I/O with a bounded diagnostic that does not render the URL or credentials. Configure either a Grafana service-account token (`OBSERVME_GRAFANA_TOKEN`) or local Basic auth (`OBSERVME_GRAFANA_USERNAME`/`OBSERVME_GRAFANA_PASSWORD`); token auth takes precedence and secrets are never rendered in command errors. You can supply these values as system environment variables before starting Pi, or copy the `.env.example` shipped with ObservMe to `.env` in a trusted project; system environment variables override `.env` values.

### Supported local-stack query profile

The repository-only local stack at <https://github.com/senad-d/ObservMe/tree/main/observability-stack> supports `/obs` query commands through authenticated Grafana behind Nginx at `http://localhost`. The default Compose stack does not publish Grafana directly on `localhost:3000`; Nginx on host port 80 is the supported entrypoint.

```yaml
query:
  enabled: true
  links:
    traceUrlTemplate: http://localhost/explore?left=...
  grafana:
    url: http://localhost
    token: ${OBSERVME_GRAFANA_TOKEN}
    username: admin
    password: ${OBSERVME_GRAFANA_PASSWORD}
    datasourceUids:
      tempo: tempo
      loki: loki
      prometheus: prometheus
    tls:
      insecureSkipVerify: false
    transport:
      preferIPv4: false
```

Create a Grafana service-account token in Grafana (Administration → Users and access → Service accounts → Add service account/token; Viewer is enough for read-only datasource queries) and export it as `OBSERVME_GRAFANA_TOKEN`, or for local-only Basic auth read the generated admin password from the repository-only local stack's secrets directory. The bundled endpoint is plain local HTTP, so its profile keeps `query.grafana.tls.insecureSkipVerify` and `query.grafana.transport.preferIPv4` false while `privacy.allowInsecureTransport: true` acknowledges the development transport. Production should use HTTPS with certificate verification; `otlp.tls.enabled` is not supported because endpoint URL schemes select HTTP or HTTPS. If you prefer a project-local env file, run `cp .env.example .env`, fill either `OBSERVME_GRAFANA_TOKEN` or `OBSERVME_GRAFANA_PASSWORD`, then restart Pi from that project. The local Collector and Loki profile uses `service.name=observme-pi-extension`; Loki queries use normalized labels such as `service_name`, `pi_session_id`, `pi_agent_id`, `pi_agent_run_id`, `event_name`, and `event_category`. If data is visible in Grafana but `/obs` commands fail, run `/obs health` and check extension env loading, Grafana auth, datasource UIDs, and the configured URL.

### Show LLM chat content in Grafana

LLM prompt, response, and thinking bodies are hidden by default. To display redacted chat content in Tempo span attributes and Loki log panels, restart Pi with explicit capture and a tenant hash salt:

```bash
export OBSERVME_CAPTURE_PROMPTS=true
export OBSERVME_CAPTURE_RESPONSES=true
export OBSERVME_CAPTURE_THINKING=true
export OBSERVME_REDACTION_ENABLED=true
export OBSERVME_HASH_SALT="$(openssl rand -hex 32)"
```

For intentionally raw local debugging only, set `OBSERVME_REDACTION_ENABLED=false` together with `OBSERVME_ALLOW_UNSAFE_CAPTURE=true`. Environment variables and trusted project `.env` values override `.pi/observme.yaml`, so remove stale overrides before relying on YAML privacy settings.

Only new LLM events emitted after these settings and the updated Collector are active can show content; older telemetry dropped by the Collector cannot be recovered. Open the **ObservMe LLM Conversations** dashboard for a dedicated opt-in chat timeline. Do not query Grafana with raw prompt or response text.

Full configuration schema: `docs/reference/12-configuration-reference.md`. Full redaction/privacy design: `docs/reference/06-security-privacy-redaction.md`.

## Safety Model

- ObservMe does not execute shell commands itself; it observes Pi's tool/Bash events and the read-only session record Pi appends after interactive `!`/`!!` execution.
- ObservMe never blocks Pi agent execution when the observability backend is degraded or unreachable.
- ObservMe starts exporters only for a trusted session and shuts them down with bounded timeouts.
- ObservMe does not continuously tail the full Pi session file. Optional correlation persistence uses one bounded `observme.correlation` custom entry on the active Pi branch, never LLM context; historical replay is never automatic and requires an explicit, confirmed `/obs backfill` command.
- Optional content capture is disabled by default and must pass through the redaction pipeline before export when enabled.
- `/obs` query commands are read-only and are not imported by telemetry-emission code paths.
- Invalid or unsafe configuration falls back to safe defaults with bounded `config.rejected`, `/obs status`, and available Pi UI diagnostics; rejected values are never rendered. Intentionally unsafe capture emits a visible warning.

See [`SECURITY.md`](SECURITY.md) and `docs/reference/06-security-privacy-redaction.md` for details.

## Dashboards and Examples

These assets are included in the npm package:

- Grafana dashboards: `dashboards/observme-*.json`, including Overview, SLO Health, Export Health, Trace Journey, Agents, Agent Node Graphs, Cost, Models, Latency, Tools, Errors, Logs and LLM I/O, LLM Conversations, and Branches/Compactions.
- Alert rules: `dashboards/observme-alerts.yaml`.
- SLO definitions: `dashboards/observme-slos.yaml`.
- Example guide and safety notes: [`examples/README.md`](examples/README.md).
- Transport-agnostic subagent integration example: [`examples/integrations/subagent-runner.ts`](examples/integrations/subagent-runner.ts).
- Supported local-stack ObservMe config: [`examples/observme.yaml`](examples/observme.yaml).
- Production Collector config with high-cardinality and content-drop processors: [`examples/collector.yaml`](examples/collector.yaml).
- Compatibility matrix: [`docs/compatibility-matrix.md`](docs/compatibility-matrix.md).

Open **ObservMe Overview** first for health/SLO chips, workload, cost, latency, agent-lineage status, and time-preserving links to focused dashboards. Use **Trace Journey** to follow a session/workflow/agent/run across Prometheus aggregates, Loki logs, and Tempo traces. Use **LLM Conversations** only for redacted opt-in content; raw prompt, response, command, path, and error-message values should never be placed in dashboard URLs or Prometheus labels. Empty failure tables normally mean no matching failures in the selected range, while optional content panels can be empty because capture is disabled by default.

The full dashboard map, canonical lease-aware active-agent queries, raw-query migration, standard variables, drill-down workflow, threshold colors, and zero-state semantics are documented in `docs/reference/09-dashboards-alerts-slos.md`. For an unexpected zero or stale raw claim, follow the active-lease troubleshooting flow in `docs/reference/11-deployment-runbooks.md` and check Export Health before concluding that the producer stopped.

## Documentation Set

Start with [`docs/README.md`](docs/README.md), which routes installation, configuration, privacy, telemetry, troubleshooting, operations, architecture, and contributor questions to the smallest relevant document set.

- [`docs/configuration.md`](docs/configuration.md): quick configuration guide.
- [`docs/compatibility-matrix.md`](docs/compatibility-matrix.md): supported Pi, Node.js, OpenTelemetry, and local-stack versions.
- [`docs/validation-flow.md`](docs/validation-flow.md): secret-safe Grafana and `/obs` troubleshooting flow.
- [`docs/extension-integration.md`](docs/extension-integration.md): public API and process-propagation contract for other Pi extensions.
- [`examples/README.md`](examples/README.md): example selection, usage, and safety guidance.
- [`docs/reference/00-README.md`](docs/reference/00-README.md): categorized technical reference index.
- [`SECURITY.md`](SECURITY.md): security reporting and package safety guidance.
- [`skills/observme-docs/SKILL.md`](skills/observme-docs/SKILL.md): Pi's progressive-disclosure router for natural-language ObservMe questions.

## Development

```bash
npm ci
npm run validate
```

Useful checks:

```bash
npm run typecheck
npm run typecheck:test
npm run lint        # TypeScript, test TypeScript, ESLint, formatting, and script syntax checks
npm run lint:fix    # ESLint auto-fix pass
npm run format:check
npm run test
npm run test:integration:collector
npm run test:integration:active-agent-lease
npm run test:integration:grafana-stack
npm run check:pack
npm run pack:dry-run
npm run smoke:pi-runtime
npm run validate:grafana-obs
pi --no-extensions -e .
```

`npm run smoke:pi-lifecycle` runs lifecycle handlers with traces, metrics, logs, and query integration disabled through an explicit offline test config. `npm run smoke:pi-runtime` launches a real Pi RPC process against a temporary trusted project, verifies `/obs` discovery plus `/obs status` and `/obs session` routing after `session_start`, and exercises a bounded `/obs cost` timeout against a local deterministic Grafana backend.

`npm run test:coverage` writes `coverage/node-test-coverage.txt` and SonarQube-readable `coverage/lcov.info` for the default non-Docker test suite; `coverage/` is git-ignored, and `rm -rf coverage` removes generated coverage artifacts after review. Docker integration coverage is opt-in with `OBSERVME_INCLUDE_INTEGRATION_COVERAGE=1 npm run test:coverage`.

End-to-end troubleshooting flow: [`docs/validation-flow.md`](docs/validation-flow.md) provides a deterministic, secret-safe checklist and script for the common user-facing case where Grafana has data but `/obs` commands are failing.

## Publishing

ObservMe publishes to npm as `@senad-d/observme`. Run from a clean working tree after validation and a `CHANGELOG.md` update.

```bash
npm login
npm whoami
npm run validate
npm run validate:grafana-obs  # with the release-candidate stack and Grafana query env configured
npm version <version>
npm publish --access public
```

Push the release commit and tag after the package is published.

## License

MIT
