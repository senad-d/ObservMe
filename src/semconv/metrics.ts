export const OBSERVME_COUNTER_METRIC_NAMES = {
  SESSIONS_STARTED_TOTAL: "observme_sessions_started_total",
  SESSIONS_SHUTDOWN_TOTAL: "observme_sessions_shutdown_total",
  WORKFLOWS_STARTED_TOTAL: "observme_workflows_started_total",
  WORKFLOWS_COMPLETED_TOTAL: "observme_workflows_completed_total",
  WORKFLOW_ERRORS_TOTAL: "observme_workflow_errors_total",
  AGENT_RUNS_TOTAL: "observme_agent_runs_total",
  AGENT_RUN_ERRORS_TOTAL: "observme_agent_run_errors_total",
  SUBAGENTS_SPAWNED_TOTAL: "observme_subagents_spawned_total",
  SUBAGENT_SPAWN_FAILURES_TOTAL: "observme_subagent_spawn_failures_total",
  ORPHAN_AGENTS_TOTAL: "observme_orphan_agents_total",
  TRACE_CONTEXT_PROPAGATION_FAILURES_TOTAL: "observme_trace_context_propagation_failures_total",
  CHILD_AGENT_FAILURES_TOTAL: "observme_child_agent_failures_total",
  PARENT_RECOVERED_FROM_CHILD_FAILURE_TOTAL: "observme_parent_recovered_from_child_failure_total",
  TURNS_STARTED_TOTAL: "observme_turns_started_total",
  TURNS_COMPLETED_TOTAL: "observme_turns_completed_total",
  LLM_REQUESTS_TOTAL: "observme_llm_requests_total",
  LLM_ERRORS_TOTAL: "observme_llm_errors_total",
  TOOL_CALLS_TOTAL: "observme_tool_calls_total",
  TOOL_FAILURES_TOTAL: "observme_tool_failures_total",
  BASH_EXECUTIONS_TOTAL: "observme_bash_executions_total",
  BASH_FAILURES_TOTAL: "observme_bash_failures_total",
  MODEL_CHANGES_TOTAL: "observme_model_changes_total",
  THINKING_LEVEL_CHANGES_TOTAL: "observme_thinking_level_changes_total",
  COMPACTIONS_TOTAL: "observme_compactions_total",
  BRANCHES_TOTAL: "observme_branches_total",
  TELEMETRY_DROPPED_TOTAL: "observme_telemetry_dropped_total",
  EXPORT_ERRORS_TOTAL: "observme_export_errors_total",
  REDACTION_FAILURES_TOTAL: "observme_redaction_failures_total",
  EVENTS_OBSERVED_TOTAL: "observme_events_observed_total",
  HANDLER_ERRORS_TOTAL: "observme_handler_errors_total",
} as const;

export const OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES = {
  LLM_INPUT_TOKENS_TOTAL: "observme_llm_input_tokens_total",
  LLM_OUTPUT_TOKENS_TOTAL: "observme_llm_output_tokens_total",
  LLM_CACHE_READ_TOKENS_TOTAL: "observme_llm_cache_read_tokens_total",
  LLM_CACHE_WRITE_TOKENS_TOTAL: "observme_llm_cache_write_tokens_total",
  LLM_CACHE_WRITE_1H_TOKENS_TOTAL: "observme_llm_cache_write_1h_tokens_total",
  LLM_REASONING_TOKENS_TOTAL: "observme_llm_reasoning_tokens_total",
  LLM_TOTAL_TOKENS_TOTAL: "observme_llm_total_tokens_total",
  LLM_COST_USD_TOTAL: "observme_llm_cost_usd_total",
} as const;

export const OBSERVME_HISTOGRAM_METRIC_NAMES = {
  WORKFLOW_DURATION_MS: "observme_workflow_duration_ms",
  AGENT_RUN_DURATION_MS: "observme_agent_run_duration_ms",
  AGENT_LIFETIME_DURATION_MS: "observme_agent_lifetime_duration_ms",
  SUBAGENT_SPAWN_DURATION_MS: "observme_subagent_spawn_duration_ms",
  AGENT_WAIT_DURATION_MS: "observme_agent_wait_duration_ms",
  AGENT_JOIN_DURATION_MS: "observme_agent_join_duration_ms",
  AGENT_TREE_DEPTH: "observme_agent_tree_depth",
  AGENT_TREE_WIDTH: "observme_agent_tree_width",
  AGENT_FANOUT_COUNT: "observme_agent_fanout_count",
  TURN_DURATION_MS: "observme_turn_duration_ms",
  LLM_REQUEST_DURATION_MS: "observme_llm_request_duration_ms",
  TOOL_DURATION_MS: "observme_tool_duration_ms",
  BASH_DURATION_MS: "observme_bash_duration_ms",
  COMPACTION_TOKENS_BEFORE: "observme_compaction_tokens_before",
  PROMPT_SIZE_CHARS: "observme_prompt_size_chars",
  RESPONSE_SIZE_CHARS: "observme_response_size_chars",
  TOOL_RESULT_SIZE_CHARS: "observme_tool_result_size_chars",
  HANDLER_DURATION_MS: "observme_handler_duration_ms",
} as const;

export const OBSERVME_GAUGE_METRIC_NAMES = {
  ACTIVE_SPANS: "observme_active_spans",
  ACTIVE_AGENTS: "observme_active_agents",
} as const;

export const OFFICIAL_GENAI_METRIC_NAMES = {
  CLIENT_TOKEN_USAGE: "gen_ai.client.token.usage",
  CLIENT_OPERATION_DURATION: "gen_ai.client.operation.duration",
} as const;

export const LOG_EVENT_NAMES = {
  SESSION_STARTED: "session.started",
  SESSION_SHUTDOWN: "session.shutdown",
  WORKFLOW_STARTED: "workflow.started",
  WORKFLOW_COMPLETED: "workflow.completed",
  WORKFLOW_FAILED: "workflow.failed",
  AGENT_RUN_STARTED: "agent.run.started",
  AGENT_RUN_COMPLETED: "agent.run.completed",
  AGENT_RUN_FAILED: "agent.run.failed",
  AGENT_SPAWN_STARTED: "agent.spawn.started",
  AGENT_SPAWN_COMPLETED: "agent.spawn.completed",
  AGENT_SPAWN_FAILED: "agent.spawn.failed",
  AGENT_WAIT_STARTED: "agent.wait.started",
  AGENT_WAIT_COMPLETED: "agent.wait.completed",
  AGENT_JOIN_STARTED: "agent.join.started",
  AGENT_JOIN_COMPLETED: "agent.join.completed",
  AGENT_ORPHANED: "agent.orphaned",
  TRACE_CONTEXT_PROPAGATION_FAILED: "trace_context.propagation_failed",
  TURN_STARTED: "turn.started",
  TURN_COMPLETED: "turn.completed",
  LLM_REQUEST_STARTED: "llm.request.started",
  LLM_REQUEST_COMPLETED: "llm.request.completed",
  LLM_REQUEST_FAILED: "llm.request.failed",
  LLM_PROMPT_CAPTURED: "llm.prompt.captured",
  LLM_RESPONSE_CAPTURED: "llm.response.captured",
  LLM_THINKING_CAPTURED: "llm.thinking.captured",
  TOOL_CALL_STARTED: "tool.call.started",
  TOOL_CALL_COMPLETED: "tool.call.completed",
  TOOL_CALL_FAILED: "tool.call.failed",
  BASH_COMPLETED: "bash.completed",
  MODEL_CHANGED: "model.changed",
  THINKING_CHANGED: "thinking.changed",
  BRANCH_CREATED: "branch.created",
  COMPACTION_CREATED: "compaction.created",
  REDACTION_FAILED: "redaction.failed",
  EXPORT_FAILED: "export.failed",
  HANDLER_FAILED: "handler.failed",
  TELEMETRY_DROPPED: "telemetry.dropped",
} as const;

export const OBSERVME_METRIC_NAME_GROUPS = {
  COUNTERS: OBSERVME_COUNTER_METRIC_NAMES,
  TOKEN_COST_COUNTERS: OBSERVME_TOKEN_COST_COUNTER_METRIC_NAMES,
  HISTOGRAMS: OBSERVME_HISTOGRAM_METRIC_NAMES,
  GAUGES: OBSERVME_GAUGE_METRIC_NAMES,
} as const;

export const ALL_OBSERVME_METRIC_NAMES = [
  ...new Set(Object.values(OBSERVME_METRIC_NAME_GROUPS).flatMap(group => Object.values(group))),
].sort((left, right) => left.localeCompare(right));

export const ALL_OFFICIAL_GENAI_METRIC_NAMES = Object.values(OFFICIAL_GENAI_METRIC_NAMES).sort((left, right) =>
  left.localeCompare(right),
);

export const ALL_METRIC_NAMES = [...ALL_OBSERVME_METRIC_NAMES, ...ALL_OFFICIAL_GENAI_METRIC_NAMES].sort((left, right) =>
  left.localeCompare(right),
);

export const ALL_LOG_EVENT_NAMES = Object.values(LOG_EVENT_NAMES).sort((left, right) => left.localeCompare(right));

export type ObservMeMetricName = (typeof ALL_OBSERVME_METRIC_NAMES)[number];
export type OfficialGenAiMetricName = (typeof ALL_OFFICIAL_GENAI_METRIC_NAMES)[number];
export type MetricName = (typeof ALL_METRIC_NAMES)[number];
export type LogEventName = (typeof ALL_LOG_EVENT_NAMES)[number];
