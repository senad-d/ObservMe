# ObservMe Telemetry Semantic Conventions

## 1. Naming Strategy

ObservMe does not depend on OpenInference. It uses official OpenTelemetry GenAI semantic-convention attributes where they apply and its own namespaces for Pi-specific concepts.

Namespaces:

```text
observme.*    Extension/runtime attributes
pi.*          Pi domain attributes, including `pi.workflow.*` and `pi.agent.*` for Pi workflow/agent/subagent lineage
gen_ai.*      Official OpenTelemetry GenAI client/agent attributes and metrics where applicable
llm.*         Legacy ObservMe aliases only; do not use as the sole representation for new telemetry
```

Do not introduce a bare `agent.*` namespace for new telemetry. Use `pi.agent.*` for Pi runtime lineage and `gen_ai.agent.*` only where OpenTelemetry's GenAI agent attributes fit.

ObservMe-owned metric names use snake_case and are prefixed with `observme_`. Official GenAI metrics such as `gen_ai.client.token.usage` may also be emitted when the selected OpenTelemetry SDK/backend supports them. Because OTEL GenAI conventions are still evolving, ObservMe's `observme_*` metrics remain the stable product contract.

Span names use dotted lowercase operation names:

```text
pi.session
pi.agent.run
pi.agent.spawn
pi.agent.wait
pi.agent.join
pi.turn
pi.llm.request
pi.tool.call
pi.bash.execution
pi.compaction
pi.branch
pi.model.change
pi.thinking.change
```

## 2. Resource Attributes

Set once at SDK initialization.

```text
service.name                       = observme-pi-extension
service.namespace                  = pi
service.version                    = <extension version>
service.instance.id                = <uuid per ObservMe telemetry session/process startup>
telemetry.sdk.name                 = opentelemetry          # normally set by SDK
observme.version                   = <extension version>
observme.instance.id               = <uuid per ObservMe telemetry session/process startup>
pi.agent.id                        = <uuid or trusted propagated id per logical agent runtime>
pi.agent.parent_id                 = <parent agent id>, optional high-cardinality resource attribute
pi.agent.root_id                   = <root agent id>, optional high-cardinality resource attribute
pi.agent.role                      = root|subagent
pi.agent.depth                     = 0 for root, 1+ for subagents
pi.cwd.hash                        = sha256(cwd)
pi.cwd.basename                    = basename(cwd), optional
deployment.environment.name        = development|test|staging|production|custom
observme.environment               = dev|ci|prod|unknown, optional compatibility alias
observme.tenant.id                 = optional tenant/routing id
pi.workflow.id                     = generated workflow/root execution id; high-cardinality resource/span/log attribute
pi.workflow.root_agent_id          = root agent id for the workflow tree
pi.user.hash                       = optional stable user hash
pi.project.name                    = optional safe project name
```

Never set raw `cwd` by default because paths often include usernames, project codenames, or customer names.

## 3. Common Span Attributes

Every ObservMe span should include:

```text
pi.session.id
pi.workflow.id
pi.workflow.root_agent_id
pi.agent.id
pi.agent.parent_id                  # if this runtime is a subagent
pi.agent.root_id
pi.agent.run.id                     # if inside an agent_start/agent_end lifecycle
pi.entry.id                         # if linked to an entry
pi.entry.parent_id                  # if linked to an entry
pi.entry.type                       # if linked to an entry
observme.capture.prompts            # boolean
observme.capture.responses          # boolean
observme.capture.tool_arguments     # boolean
observme.redaction.enabled          # boolean
observme.semconv.version            # ObservMe convention version
observme.replayed                   # true for explicit replay/backfill telemetry
observme.evicted                    # true when span was closed by bounded-registry eviction
observme.truncated                  # true when content was truncated before export
observme.original_length            # original character length when truncation occurred
```

## 4. Session Span

Span name:

```text
pi.session
```

Attributes:

```text
pi.session.id
pi.session.name
pi.session.cwd_hash
pi.session.parent_session_hash
pi.session.persisted
pi.session.file_hash
pi.session.version
pi.model.provider.current
pi.model.id.current
pi.thinking.level.current
```

Events:

```text
session.started
session.named
session.shutdown
session.error
```

## 5. Workflow, Agent, and Subagent Spans

### 5.1 Agent Run Span

Pi emits `agent_start` and `agent_end` once per user prompt lifecycle. Represent that lifecycle with a child span under `pi.session`.

Span name:

```text
pi.agent.run
```

Attributes:

```text
pi.agent.id
pi.agent.parent_id                  # optional
pi.agent.root_id
pi.agent.role                       # root|subagent
pi.agent.depth
pi.agent.run.id
pi.agent.run.index
pi.agent.run.source                 # user|rpc|extension|unknown when known
pi.agent.run.prompt.hash
pi.agent.run.prompt.length
```

Official GenAI attributes may be mirrored when they describe the Pi agent rather than a provider-side assistant:

```text
gen_ai.agent.id                     # same as pi.agent.id, span/log attribute only
gen_ai.agent.name                   # optional configured safe name
gen_ai.agent.version                # ObservMe/Pi agent version if meaningful
```

### 5.2 Subagent Spawn Span

When a tool or extension launches another Pi agent, emit a spawn span around the parent operation.

Span name:

```text
pi.agent.spawn
```

Attributes:

```text
pi.agent.spawn.id
pi.agent.spawn.type                 # tool|command|extension|unknown
pi.agent.spawn.reason               # delegated_task|parallel_search|review|tool_wrapper|unknown
pi.agent.spawn.outcome              # started|failed|cancelled|timeout
pi.agent.spawn.tool_call_id          # if spawned from a tool call
pi.agent.spawn.command.hash          # if spawned by a command; never raw by default
pi.agent.child.id                    # if known after spawn
pi.agent.child.count                 # current/observed child count for the parent operation
pi.agent.children.active             # active children at observation time
pi.agent.parent_id                   # current pi.agent.id
pi.agent.root_id
pi.workflow.id
pi.workflow.root_agent_id
pi.agent.depth
pi.session.id
pi.agent.spawn.trace_context_propagated
```

If W3C trace context is propagated to the child, the child `pi.session` span should continue the trace. If not, link the child trace back using span links/log attributes and the lineage fields above.

### 5.3 Agent Wait and Join Spans

When a parent agent waits for a child or collects child results, emit wait/join spans or span events so the multi-agent critical path is visible.

Span names:

```text
pi.agent.wait
pi.agent.join
```

Attributes:

```text
pi.workflow.id
pi.agent.id
pi.agent.child.id                  # high-cardinality span/log attribute only
pi.agent.spawn.id                  # high-cardinality span/log attribute only
pi.agent.wait.reason               # dependency|rate_limit|child_running|unknown
pi.agent.join.status               # ok|error|cancelled|timeout|partial|unknown
pi.agent.child.status              # ok|error|cancelled|timeout|unknown
pi.agent.failure.propagated         # true if child failure failed the parent operation
pi.agent.children.active
pi.agent.child.count
```

## 6. Turn Span

Span name:

```text
pi.turn
```

Attributes:

```text
pi.turn.id
pi.turn.index
pi.turn.branch_path_hash
pi.turn.user_message.hash
pi.turn.user_message.length
pi.turn.user_message.image_count
pi.model.provider.current
pi.model.id.current
```

Status:

- OK if completed without error
- ERROR if LLM/tool fatal error ends the turn
- UNSET if interrupted or unknown

## 7. LLM / GenAI Request Span

Span name:

```text
pi.llm.request
```

For backend interoperability, also follow the OpenTelemetry GenAI client-span guidance where practical: the provider call span may be named `{gen_ai.operation.name} {gen_ai.request.model}` (for example `chat claude-sonnet-4-5`) or kept as `pi.llm.request` with the official `gen_ai.*` attributes below. If both an internal Pi wrapper span and a provider client span are emitted, make the provider span a child of the turn span and avoid double-counting metrics.

Required or recommended official GenAI attributes:

```text
gen_ai.operation.name                         # chat|generate_content|text_completion
gen_ai.provider.name
gen_ai.request.model
gen_ai.response.model                         # if provider reports a different response model
gen_ai.response.id                            # if available; high-cardinality span/log attribute only
gen_ai.response.finish_reasons                # map Pi stopReason to array where possible
gen_ai.request.temperature
gen_ai.request.max_tokens
gen_ai.usage.input_tokens
gen_ai.usage.output_tokens
gen_ai.usage.cache_read.input_tokens
gen_ai.usage.cache_creation.input_tokens
gen_ai.usage.reasoning.output_tokens          # if provider reports reasoning/thinking tokens
gen_ai.conversation.id                        # pi.session.id when safe to expose in spans/logs
error.type                                    # error class when the operation fails
```

ObservMe/Pi-specific LLM attributes:

```text
pi.llm.api
pi.llm.request.thinking_level
pi.llm.request.message_count
pi.llm.request.tool_schema_count
pi.llm.request.input_chars
pi.llm.stop_reason
pi.llm.error_message_hash
pi.llm.usage.total_tokens
pi.llm.usage.cache_write_1h_tokens            # Anthropic-specific when available
pi.llm.cost.input_usd
pi.llm.cost.output_usd
pi.llm.cost.cache_read_usd
pi.llm.cost.cache_write_usd
pi.llm.cost.total_usd
```

Optional content fields when enabled and redacted:

```text
gen_ai.input.messages                         # only if explicit content capture is enabled
gen_ai.output.messages                        # only if explicit content capture is enabled
pi.llm.prompt.redacted
pi.llm.response.redacted
pi.llm.thinking.redacted
pi.llm.content.kind                         # log attribute: prompt|response|thinking
```

When prompt, response, or thinking capture is explicitly enabled, ObservMe exports already-redacted content to both the LLM span attributes above and correlated OTEL logs. Keep capture disabled by default; for high-volume production deployments, prefer dashboards and retention policies that treat these opt-in attributes and log bodies as sensitive even after redaction.

## 8. Tool Call Span

Span name:

```text
pi.tool.call
```

Attributes:

```text
pi.tool.call.id
pi.tool.name
pi.tool.category                 # shell|filesystem|network|custom|unknown
pi.tool.arguments.hash
pi.tool.arguments.size
pi.tool.result.size
pi.tool.result.hash
pi.tool.success
pi.tool.error
pi.tool.error_class
gen_ai.tool.call.id                 # optional official alias for GenAI tool-call correlation
gen_ai.tool.name                    # optional official alias
gen_ai.tool.type                    # function|extension|datastore when applicable
```

Optional:

```text
pi.tool.arguments.redacted
pi.tool.result.redacted
gen_ai.tool.call.arguments          # only when explicit content capture is enabled and redacted
gen_ai.tool.call.result             # only when explicit content capture is enabled and redacted
```

## 9. Bash Execution Span

Span name:

```text
pi.bash.execution
```

Attributes:

```text
pi.bash.command.hash
pi.bash.command.redacted          # optional
pi.bash.exit_code
pi.bash.cancelled
pi.bash.truncated
pi.bash.output.size
pi.bash.output.hash
pi.bash.output.redacted           # optional
pi.bash.full_output_path_present
pi.bash.exclude_from_context
```

## 10. Branch Span

Span name:

```text
pi.branch
```

Attributes:

```text
pi.branch.from_id
pi.branch.to_id
pi.branch.common_ancestor_id        # if available
pi.branch.path_hash
pi.leaf.id
pi.branch.summary.hash
pi.branch.summary.length
pi.branch.from_hook
pi.branch.read_files_count
pi.branch.modified_files_count
```

## 11. Compaction Span

Span name:

```text
pi.compaction
```

Attributes:

```text
pi.compaction.first_kept_entry_id
pi.compaction.tokens_before
pi.compaction.summary.hash
pi.compaction.summary.length
pi.compaction.from_hook
pi.compaction.reason
pi.compaction.will_retry
pi.compaction.read_files_count
pi.compaction.modified_files_count
```

## 12. Metrics

### 12.1 Counters

```text
observme_sessions_started_total
observme_sessions_shutdown_total
observme_workflows_started_total
observme_workflows_completed_total
observme_workflow_errors_total
observme_agent_runs_total
observme_agent_run_errors_total
observme_subagents_spawned_total
observme_subagent_spawn_failures_total
observme_orphan_agents_total
observme_trace_context_propagation_failures_total
observme_child_agent_failures_total
observme_parent_recovered_from_child_failure_total
observme_turns_started_total
observme_turns_completed_total
observme_llm_requests_total
observme_llm_errors_total
observme_tool_calls_total
observme_tool_failures_total
observme_bash_executions_total
observme_bash_failures_total
observme_model_changes_total
observme_thinking_level_changes_total
observme_compactions_total
observme_branches_total
observme_telemetry_dropped_total
observme_export_errors_total
observme_redaction_failures_total
observme_events_observed_total
observme_handler_errors_total
```

### 12.2 Token and Cost Counters

```text
observme_llm_input_tokens_total
observme_llm_output_tokens_total
observme_llm_cache_read_tokens_total
observme_llm_cache_write_tokens_total
observme_llm_cache_write_1h_tokens_total
observme_llm_reasoning_tokens_total
observme_llm_total_tokens_total
observme_llm_cost_usd_total
```

### 12.3 Histograms

```text
observme_workflow_duration_ms
observme_agent_run_duration_ms
observme_agent_lifetime_duration_ms
observme_subagent_spawn_duration_ms
observme_agent_wait_duration_ms
observme_agent_join_duration_ms
observme_agent_tree_depth
observme_agent_tree_width
observme_agent_fanout_count
observme_turn_duration_ms
observme_llm_request_duration_ms
observme_tool_duration_ms
observme_bash_duration_ms
observme_compaction_tokens_before
observme_prompt_size_chars
observme_response_size_chars
observme_tool_result_size_chars
observme_handler_duration_ms
```

### 12.4 Gauges

```text
observme_active_spans
observme_active_agents
```

### 12.5 Export Health self-observability contract

The `ObservMe Export Health` dashboard is a self-observability contract for the ObservMe runtime, not a replacement for `/obs status` or `/obs health`. A healthy local session should still produce positive liveness signals while failure-only signals remain at zero or no matching log rows.

Dashboard-driving signals:

```text
observme_events_observed_total              # counter; one handled Pi event observed by a live telemetry session
observme_handler_duration_ms                # histogram; handler lifecycle latency
observme_handler_errors_total               # counter; safe-handler failures
observme_active_spans                       # gauge; active SDK spans by bounded operation
observme_telemetry_dropped_total            # counter; local queue/registry drops by bounded reason
observme_export_errors_total                # counter; exporter failures by bounded reason/error class
observme_redaction_failures_total           # counter; dropped fields caused by redaction exceptions
```

Export Health Loki events:

```text
telemetry.dropped                           # emitted with telemetry-drop counter updates
redaction.failed                            # emitted with redaction-failure counter updates
export.failed                               # emitted with export-error counter updates
trace_context.propagation_failed            # emitted when subagent trace propagation fails
handler.failed                              # emitted when safe handler isolation catches an exception
```

Healthy-state semantics:

- `observme_events_observed_total` is the primary liveness denominator for the dashboard and Observability Export SLO.
- Failure counters should be queryable as zero when no matching failures happened in the selected range.
- Failure log tables can be empty in a healthy range; empty `telemetry.dropped`, `redaction.failed`, `export.failed`, and `trace_context.propagation_failed` tables mean no matching failures were observed, not that ingestion is broken.
- Collector/export health is considered healthy when events are observed and local drop/export-error rates remain zero.

Metric labels for these signals are restricted to the low-cardinality allowlist below. In practice, Export Health metrics may use only `operation`, `reason`, `error_class`, and `status` as needed. High-cardinality identifiers such as session, workflow, agent, trace, span, entry, prompt, raw path, raw command, and raw error-message values must stay out of Prometheus labels.

This telemetry contract must not require changing project trust behavior, `/obs status`, `/obs health`, the configured local OTLP endpoint, Grafana authentication/profile, or intentionally enabled local debug capture settings.

### 12.6 Optional official GenAI metrics

Emit these in addition to ObservMe metrics only when the SDK/backend path handles dotted OTEL metric names correctly:

```text
gen_ai.client.token.usage                     # histogram, unit {token}, attribute gen_ai.token.type=input|output
gen_ai.client.operation.duration              # histogram, unit s
```

## 13. Metric Labels

Allowed low-cardinality labels:

```text
provider
model
tool_name
tool_category
environment
operation
status
error_class
reason                                       # bounded enum only, e.g. span_registry_full|export_timeout
agent_role                                  # root|subagent|orchestrator|worker|reviewer|unknown
agent_capability                            # bounded configured capability enum/string
subagent_depth                              # bounded bucket or small integer
spawn_type                                  # tool|command|extension|unknown
spawn_reason                                # delegated_task|parallel_search|review|tool_wrapper|unknown
pi_version
observme_version
token_type                                    # Prometheus-normalized alias for gen_ai.token.type when applicable
```

Forbidden high-cardinality labels:

```text
session_id
workflow_id
workflow_root_agent_id
agent_id
parent_agent_id
child_agent_id
agent_run_id
spawn_id
spawn_tool_call_id
trace_id
span_id
entry_id
tool_call_id
raw_command
raw_prompt
raw_path
raw_error_message
```

High-cardinality values belong in span attributes or logs, not metrics. If a backend/exporter converts resource attributes into metric labels, drop `pi.workflow.*`, `pi.agent.*`, `pi.session.id`, trace IDs, span IDs, and spawn IDs from the metrics pipeline first. Generated `service.instance.id` / `observme.instance.id` may remain as backend labels when needed to keep concurrent metric streams distinct; dashboard PromQL must aggregate over them instead of grouping by them.

## 14. Logs

Log body should be a short event summary. Detailed data goes into structured OTEL log attributes.

Common log attributes:

```text
event.name
event.category
pi.session.id
pi.workflow.id
pi.workflow.root_agent_id
pi.agent.id
pi.agent.parent_id
pi.agent.root_id
pi.agent.run.id
pi.turn.id
trace_id
span_id
severity
error.type
```

Event names:

```text
session.started
session.shutdown
workflow.started
workflow.completed
workflow.failed
agent.run.started
agent.run.completed
agent.run.failed
agent.spawn.started
agent.spawn.completed
agent.spawn.failed
agent.wait.started
agent.wait.completed
agent.join.started
agent.join.completed
agent.orphaned
trace_context.propagation_failed
turn.started
turn.completed
llm.request.started
llm.request.completed
llm.request.failed
llm.prompt.captured
llm.response.captured
llm.thinking.captured
tool.call.started
tool.call.completed
tool.call.failed
bash.completed
model.changed
thinking.changed
branch.created
compaction.created
redaction.failed
export.failed
handler.failed
telemetry.dropped
```

## 15. Exemplars

Metrics that correspond to traces should include exemplars where supported:

- `observme_workflow_duration_ms`
- `observme_agent_run_duration_ms`
- `observme_agent_wait_duration_ms`
- `observme_agent_join_duration_ms`
- `observme_llm_request_duration_ms`
- `observme_tool_duration_ms`
- `observme_turn_duration_ms`
- `observme_llm_cost_usd_total`
- `gen_ai.client.operation.duration`

For Loki OTLP ingestion, remember that attribute names containing dots are normalized with underscores in Loki queries (for example `event.name` becomes `event_name`, and `pi.session.id` becomes `pi_session_id`).

## 16. Versioning

Semantic conventions are versioned independently:

```text
observme.semconv.version = 1.0.0
```

Breaking changes require major version increments.
