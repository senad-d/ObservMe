import assert from "node:assert/strict";
import test from "node:test";
import {
  ALL_LOG_EVENT_NAMES,
  ALL_METRIC_NAMES,
  ALL_OBSERVME_METRIC_NAMES,
  LOG_EVENT_NAMES,
  OBSERVME_COUNTER_METRIC_NAMES,
  OBSERVME_HISTOGRAM_METRIC_NAMES,
  OFFICIAL_GENAI_METRIC_NAMES,
} from "../src/semconv/metrics.ts";

const documentedMetricNames = [
  "gen_ai.client.operation.duration",
  "gen_ai.client.token.usage",
  "observme_active_agents",
  "observme_active_spans",
  "observme_agent_fanout_count",
  "observme_agent_join_duration_ms",
  "observme_agent_lifetime_duration_ms",
  "observme_agent_run_duration_ms",
  "observme_agent_run_errors_total",
  "observme_agent_runs_total",
  "observme_agent_tree_depth",
  "observme_agent_tree_width",
  "observme_agent_wait_duration_ms",
  "observme_bash_duration_ms",
  "observme_bash_executions_total",
  "observme_bash_failures_total",
  "observme_branches_total",
  "observme_child_agent_failures_total",
  "observme_compaction_tokens_before",
  "observme_compactions_total",
  "observme_events_observed_total",
  "observme_export_errors_total",
  "observme_handler_duration_ms",
  "observme_handler_errors_total",
  "observme_llm_cache_read_tokens_total",
  "observme_llm_cache_write_1h_tokens_total",
  "observme_llm_cache_write_tokens_total",
  "observme_llm_cost_usd_total",
  "observme_llm_errors_total",
  "observme_llm_input_tokens_total",
  "observme_llm_output_tokens_total",
  "observme_llm_reasoning_tokens_total",
  "observme_llm_request_duration_ms",
  "observme_llm_requests_total",
  "observme_llm_total_tokens_total",
  "observme_model_changes_total",
  "observme_orphan_agents_total",
  "observme_parent_recovered_from_child_failure_total",
  "observme_prompt_size_chars",
  "observme_redaction_failures_total",
  "observme_response_size_chars",
  "observme_sessions_shutdown_total",
  "observme_sessions_started_total",
  "observme_subagent_spawn_duration_ms",
  "observme_subagent_spawn_failures_total",
  "observme_subagents_spawned_total",
  "observme_telemetry_dropped_total",
  "observme_thinking_level_changes_total",
  "observme_tool_calls_total",
  "observme_tool_duration_ms",
  "observme_tool_failures_total",
  "observme_tool_result_size_chars",
  "observme_trace_context_propagation_failures_total",
  "observme_turn_duration_ms",
  "observme_turns_completed_total",
  "observme_turns_started_total",
  "observme_workflow_duration_ms",
  "observme_workflow_errors_total",
  "observme_workflows_completed_total",
  "observme_workflows_started_total",
].sort((left, right) => left.localeCompare(right));

const documentedLogEventNames = [
  "agent.join.completed",
  "agent.join.started",
  "agent.orphaned",
  "agent.run.completed",
  "agent.run.failed",
  "agent.run.started",
  "agent.spawn.completed",
  "agent.spawn.failed",
  "agent.spawn.started",
  "agent.wait.completed",
  "agent.wait.started",
  "bash.completed",
  "branch.created",
  "compaction.created",
  "export.failed",
  "handler.failed",
  "llm.prompt.captured",
  "llm.request.completed",
  "llm.request.failed",
  "llm.request.started",
  "llm.response.captured",
  "llm.thinking.captured",
  "model.changed",
  "redaction.failed",
  "session.shutdown",
  "session.started",
  "telemetry.dropped",
  "thinking.changed",
  "tool.call.completed",
  "tool.call.failed",
  "tool.call.started",
  "trace_context.propagation_failed",
  "turn.completed",
  "turn.started",
  "workflow.completed",
  "workflow.failed",
  "workflow.started",
].sort((left, right) => left.localeCompare(right));

const snakeCaseObservMeMetricName = /^observme_[a-z0-9]+(?:_[a-z0-9]+)*$/;

test("exports every metric name documented in semantic convention section 12", () => {
  assert.deepEqual(ALL_METRIC_NAMES, documentedMetricNames);
  assert.equal(OBSERVME_COUNTER_METRIC_NAMES.SESSIONS_STARTED_TOTAL, "observme_sessions_started_total");
  assert.equal(OBSERVME_HISTOGRAM_METRIC_NAMES.AGENT_TREE_DEPTH, "observme_agent_tree_depth");
  assert.equal(OFFICIAL_GENAI_METRIC_NAMES.CLIENT_TOKEN_USAGE, "gen_ai.client.token.usage");
});

test("exports every log event name documented in semantic convention section 14", () => {
  assert.deepEqual(ALL_LOG_EVENT_NAMES, documentedLogEventNames);
  assert.equal(LOG_EVENT_NAMES.SESSION_STARTED, "session.started");
  assert.equal(LOG_EVENT_NAMES.TRACE_CONTEXT_PROPAGATION_FAILED, "trace_context.propagation_failed");
});

test("ObservMe-owned metric names are snake_case and prefixed observme_", () => {
  for (const metricName of ALL_OBSERVME_METRIC_NAMES) {
    assert.match(metricName, snakeCaseObservMeMetricName);
  }
});

test("metric and log event names are unique", () => {
  assert.equal(new Set(ALL_METRIC_NAMES).size, ALL_METRIC_NAMES.length);
  assert.equal(new Set(ALL_LOG_EVENT_NAMES).size, ALL_LOG_EVENT_NAMES.length);
});
