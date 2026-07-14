import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import {
  CANONICAL_ACTIVE_AGENT_BY_DEPTH_PROMQL,
  CANONICAL_ACTIVE_AGENT_BY_ENVIRONMENT_PROMQL,
  CANONICAL_ACTIVE_AGENT_BY_ROLE_PROMQL,
  CANONICAL_ACTIVE_AGENT_TOTAL_PROMQL,
  CANONICAL_EXPIRED_ACTIVE_AGENT_CLAIMS_PROMQL,
  CANONICAL_RAW_ACTIVE_AGENT_CLAIMS_PROMQL,
  evaluateCanonicalActiveAgentBreakdown,
  evaluateCanonicalActiveAgentTotal,
} from "./support/active-agent-promql.mjs";

const dashboardsDirectory = "dashboards";
const overviewDashboardFile = "dashboards/observme-overview.json";
const traceJourneyDashboardFile = "dashboards/observme-trace-journey.json";
const dashboardFiles = [
  "dashboards/observme-overview.json",
  "dashboards/observme-cost.json",
  "dashboards/observme-latency.json",
  "dashboards/observme-tools.json",
  "dashboards/observme-agents.json",
  "dashboards/observme-agent-node-graphs.json",
  "dashboards/observme-models.json",
  "dashboards/observme-errors.json",
  "dashboards/observme-branches-compactions.json",
  "dashboards/observme-export-health.json",
  "dashboards/observme-slo-health.json",
  "dashboards/observme-logs-llm.json",
  "dashboards/observme-llm-conversations.json",
  traceJourneyDashboardFile,
];
const sessionLifecycleDashboardFiles = dashboardFiles;
const agentDashboardFile = "dashboards/observme-agents.json";
const nodeGraphDashboardFile = "dashboards/observme-agent-node-graphs.json";
const costDashboardFile = "dashboards/observme-cost.json";
const modelsDashboardFile = "dashboards/observme-models.json";
const logsLlmDashboardFile = "dashboards/observme-logs-llm.json";
const llmConversationsDashboardFile = "dashboards/observme-llm-conversations.json";
const branchesCompactionsDashboardFile = "dashboards/observme-branches-compactions.json";
const latencyDashboardFile = "dashboards/observme-latency.json";
const toolsDashboardFile = "dashboards/observme-tools.json";
const toolCapturedErrorPanelTitle = "Captured tool error output (opt-in, redacted)";
const errorsDashboardFile = "dashboards/observme-errors.json";
const exportHealthDashboardFile = "dashboards/observme-export-health.json";
const sloHealthDashboardFile = "dashboards/observme-slo-health.json";
const localCollectorConfigFile = "observability-stack/config/otel/otel-collector.yaml";
const datasourceInputVariablePattern = /\$\{DS_[A-Z_]+\}/u;
const lokiAttributePattern = /\b(?:event\.name|event\.category|pi\.session\.id|pi\.workflow\.id|pi\.agent\.id)\b/u;
const metricNamePattern = /\bobservme_[a-z0-9_]+(?:_(?:bucket|sum|count))?\b/gu;
const forbiddenAgentMetricLabelPattern =
  /\b(?:session_id|workflow_id|workflow_root_agent_id|agent_id|parent_agent_id|child_agent_id|agent_run_id|spawn_id|spawn_tool_call_id|trace_id|span_id|pi_workflow_id|pi_workflow_root_agent_id|pi_agent_id|pi_agent_parent_id|pi_agent_root_id|pi_agent_spawn_id)\b/u;
const histogramSuffixes = ["_bucket", "_sum", "_count"];
const lokiSelectorPattern = /\{([^{}]*)\}/gu;
const lokiLabelMatcherPattern = /\b([A-Za-z_][A-Za-z0-9_]*)\s*(?:=~|!~|!=|=)/gu;
const lokiJsonParserPattern = /\|\s*json\b/u;
const incorrectErrorCategoryPattern = /event_category\s*=\s*"error"/u;
const lokiLabelsHintPattern = /key: loki\.(?:attribute|resource)\.labels\s*\n\s*value: ([^\n]+)/gu;
const localServiceNameInsertPattern = /key: service\.name\s*\n\s*value: observme-pi-extension\s*\n\s*action: insert/u;
const zeroVectorFallbackPattern = /\bor\s+(?:on\(\)\s+)?vector\(0\)/u;
const rawActiveAgentSumPattern = /sum\s*\(\s*observme_active_agents(?:\s*>\s*0)?\s*\)/u;
const activeAgentMetricName = "observme_active_agents";
const activeAgentLeaseMetricName = "observme_agent_lease_expires_unixtime_seconds";
const activeAgentDiagnosticPanelPattern = /(?:raw active claims|expired active claims)/iu;
const sessionLifecycleMetricPattern = /\bobservme_sessions_(?:started|shutdown)_total\b/u;
const emptyFailureLogsDescriptionPattern = /empty means no matching failure logs in the selected time range/i;
const exportHealthZeroStatePanels = [
  { title: "Observed event liveness", metricName: "observme_events_observed_total" },
  { title: "Session lifecycle", metricName: "observme_sessions_started_total" },
  { title: "Session lifecycle", metricName: "observme_sessions_shutdown_total" },
  { title: "Collector/export health", metricName: "observme_events_observed_total" },
  { title: "Collector/export health", metricName: "observme_telemetry_dropped_total" },
  { title: "Telemetry drops", metricName: "observme_telemetry_dropped_total" },
  { title: "Redaction failures", metricName: "observme_redaction_failures_total" },
  { title: "Export failures", metricName: "observme_export_errors_total" },
  { title: "Handler error pressure", metricName: "observme_handler_errors_total" },
  { title: "Active spans by operation", metricName: "observme_active_spans" },
];
const exportHealthFailureLogPanels = [
  "Redaction failure logs",
  "Telemetry drop logs",
  "Trace-context propagation failure logs",
];
const exportHealthCompositeFailureMetrics = [
  "observme_telemetry_dropped_total",
  "observme_export_errors_total",
  "observme_redaction_failures_total",
];
const exportHealthVisibleSignalChips = [
  "Observed event liveness",
  "Telemetry drop ratio",
  "Export error rate",
  "Redaction failure rate",
  "Handler p99 latency",
];
const sloScorecardRequirements = [
  {
    title: "Observability Export SLO (30d)",
    unit: "percentunit",
    metricNames: ["observme_telemetry_dropped_total", "observme_events_observed_total"],
  },
  {
    title: "Agent Lineage SLO (30d)",
    unit: "percentunit",
    metricNames: [
      "observme_subagent_spawn_failures_total",
      "observme_orphan_agents_total",
      "observme_trace_context_propagation_failures_total",
      "observme_subagents_spawned_total",
    ],
  },
  {
    title: "Workflow Completion SLO (30d)",
    unit: "percentunit",
    metricNames: [
      "observme_workflows_completed_total",
      "observme_workflow_errors_total",
      "observme_workflows_started_total",
    ],
  },
  {
    title: "Instrumentation Overhead SLO p99 (30d)",
    unit: "ms",
    metricNames: ["observme_handler_duration_ms_bucket"],
  },
];
const sloBurnRatePanelRequirements = [
  {
    title: "Runtime SLO burn rate (1h)",
    window: "[1h]",
  },
  {
    title: "Runtime SLO burn rate (30d)",
    window: "[30d]",
  },
];
const sloBurnRateMetrics = [
  "observme_telemetry_dropped_total",
  "observme_events_observed_total",
  "observme_subagent_spawn_failures_total",
  "observme_orphan_agents_total",
  "observme_trace_context_propagation_failures_total",
  "observme_subagents_spawned_total",
  "observme_workflows_completed_total",
  "observme_workflow_errors_total",
  "observme_workflows_started_total",
  "observme_handler_duration_ms_bucket",
  "observme_handler_duration_ms_count",
];
const traceJourneyFilterLinkFragments = [
  "${__url_time_range}",
  "${session_id:queryparam}",
  "${agent_id:queryparam}",
  "${agent_run_id:queryparam}",
];
const traceJourneyLokiFilterFragments = [
  "pi_session_id=~\"${session_id:regex}\"",
  "pi_agent_id=~\"${agent_id:regex}\"",
  "pi_agent_run_id=~\"${agent_run_id:regex}\"",
];
const llmConversationFilterVariables = [
  "session_id",
  "workflow_id",
  "agent_id",
  "agent_run_id",
  "provider",
  "model",
  "content_kind",
];
const llmConversationLokiFilterFragments = [
  "pi_session_id=~\"${session_id:regex}\"",
  "pi_workflow_id=~\"${workflow_id:regex}\"",
  "pi_agent_id=~\"${agent_id:regex}\"",
  "pi_agent_run_id=~\"${agent_run_id:regex}\"",
  "gen_ai_provider_name=~\"${provider:regex}\"",
  "gen_ai_request_model=~\"${model:regex}\"",
  "pi_llm_content_kind=~\"${content_kind:regex}\"",
];
const llmConversationFilterLinkFragments = [
  "${__url_time_range}",
  "${session_id:queryparam}",
  "${workflow_id:queryparam}",
  "${agent_id:queryparam}",
  "${agent_run_id:queryparam}",
];
const llmConversationBodyLogPanelTitles = ["Conversation timeline (redacted, opt-in)", "Prompts", "Responses", "Thinking"];
const overviewLandingRowTitles = ["Health", "Workload", "Cost", "Latency", "Agent lineage", "Links"];
const overviewHealthChipTitles = [
  "Export health",
  "Agent lineage health",
  "Workflow completion health",
  "Error pressure",
  "Cost burn / hour",
  "Latency health",
];
const overviewDrilldownDashboardUids = [
  "observme-cost",
  "observme-models",
  "observme-latency",
  "observme-tools",
  "observme-agents",
  "observme-trace-journey",
  "observme-errors",
  "observme-export-health",
  "observme-llm-conversations",
];
const agentRatioPanelRequirements = [
  {
    title: "Spawn failure ratio",
    metricNames: ["observme_subagent_spawn_failures_total", "observme_subagents_spawned_total"],
  },
  {
    title: "Orphan ratio vs spawns/runs",
    metricNames: ["observme_orphan_agents_total", "observme_subagents_spawned_total", "observme_agent_runs_total"],
  },
  {
    title: "Propagation failure ratio",
    metricNames: ["observme_trace_context_propagation_failures_total", "observme_subagents_spawned_total"],
  },
  {
    title: "Child recovery ratio",
    metricNames: ["observme_parent_recovered_from_child_failure_total", "observme_child_agent_failures_total"],
  },
];
const agentTopTableRequirements = [
  {
    title: "Top slow agent roles",
    metricNames: ["observme_agent_run_duration_ms_bucket", "observme_agent_runs_total"],
  },
  {
    title: "Failing spawn reasons",
    metricNames: ["observme_subagent_spawn_failures_total"],
  },
  {
    title: "Orphan-prone depths",
    metricNames: ["observme_orphan_agents_total"],
  },
  {
    title: "High fan-out roles",
    metricNames: ["observme_agent_fanout_count_bucket"],
  },
];
const agentThresholdReferences = [
  { title: "Agent-tree depth and width", reference: "vector(5)" },
  { title: "Fan-out per parent operation", reference: "vector(20)" },
];
const nodeGraphHealthMetricNames = [
  "observme_subagent_spawn_failures_total",
  "observme_orphan_agents_total",
  "observme_trace_context_propagation_failures_total",
];
const llmTokenMetricNames = [
  "observme_llm_input_tokens_total",
  "observme_llm_output_tokens_total",
  "observme_llm_total_tokens_total",
  "observme_llm_reasoning_tokens_total",
  "observme_llm_cache_read_tokens_total",
  "observme_llm_cache_write_tokens_total",
  "observme_llm_cache_write_1h_tokens_total",
];
const modelThinkingAnnotationDashboardFiles = [costDashboardFile, modelsDashboardFile, latencyDashboardFile];
const latencyStageHistogramMetrics = [
  "observme_turn_duration_ms_bucket",
  "observme_llm_request_duration_ms_bucket",
  "observme_tool_duration_ms_bucket",
  "observme_bash_duration_ms_bucket",
  "observme_agent_run_duration_ms_bucket",
  "observme_subagent_spawn_duration_ms_bucket",
  "observme_agent_wait_duration_ms_bucket",
  "observme_agent_join_duration_ms_bucket",
];
const latencyVolumeMetrics = [
  "observme_turns_completed_total",
  "observme_llm_requests_total",
  "observme_tool_calls_total",
  "observme_bash_executions_total",
  "observme_agent_runs_total",
  "observme_subagents_spawned_total",
];
const latencyTopTableRequirements = [
  {
    title: "Top slow provider/model with volume",
    metricNames: ["observme_llm_request_duration_ms_bucket", "observme_llm_requests_total"],
    linkedDashboardUid: "observme-models",
  },
  {
    title: "Top slow tools with volume",
    metricNames: ["observme_tool_duration_ms_bucket", "observme_tool_calls_total"],
    linkedDashboardUid: "observme-tools",
  },
  {
    title: "Top slow agent roles with volume",
    metricNames: ["observme_agent_run_duration_ms_bucket", "observme_agent_runs_total"],
    linkedDashboardUid: "observme-agents",
  },
];
const parsedErrorLogPanelRequirements = [
  { title: "Parsed LLM failure logs", eventName: "llm.request.failed" },
  { title: "Parsed tool failure logs", eventName: "tool.call.failed" },
  { title: "Parsed export failure logs", eventName: "export.failed" },
  { title: "Parsed handler failure logs", eventName: "handler.failed" },
  { title: "Parsed propagation failure logs", eventName: "trace_context.propagation_failed" },
];
const provisionedDatasourceUidsByType = new Map([
  ["loki", "loki"],
  ["prometheus", "prometheus"],
  ["tempo", "tempo"],
]);
const canonicalActiveAgentFixtures = [
  {
    title: "live claim with valid lease",
    claims: [{ observmeInstanceId: "runtime-a", value: 1 }],
    leases: [{ observmeInstanceId: "runtime-a", value: 1_060 }],
    expected: 1,
  },
  {
    title: "clean shutdown claim",
    claims: [{ observmeInstanceId: "runtime-a", value: 0 }],
    leases: [{ observmeInstanceId: "runtime-a", value: 1_060 }],
    expected: 0,
  },
  {
    title: "expired positive claim",
    claims: [{ observmeInstanceId: "runtime-a", value: 1 }],
    leases: [{ observmeInstanceId: "runtime-a", value: 1_000 }],
    expected: 0,
  },
  {
    title: "positive claim without lease",
    claims: [{ observmeInstanceId: "runtime-a", value: 1 }],
    leases: [],
    expected: 0,
  },
  {
    title: "positive claim with pathological future lease",
    claims: [{ observmeInstanceId: "runtime-a", value: 1 }],
    leases: [{ observmeInstanceId: "runtime-a", value: 1_306 }],
    expected: 0,
  },
  {
    title: "duplicate exporter replicas",
    claims: [
      { observmeInstanceId: "runtime-a", value: 1, replica: "collector-a" },
      { observmeInstanceId: "runtime-a", value: 1, replica: "collector-b" },
    ],
    leases: [
      { observmeInstanceId: "runtime-a", value: 1_060, replica: "collector-a" },
      { observmeInstanceId: "runtime-a", value: 1_060, replica: "collector-b" },
    ],
    expected: 1,
  },
];

async function readJsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function listedDashboardFilesCoverDashboardJsonFiles() {
  const directoryEntries = await readdir(dashboardsDirectory, { withFileTypes: true });
  const dashboardJsonFiles = directoryEntries
    .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
    .map(entry => `${dashboardsDirectory}/${entry.name}`)
    .sort();

  assert.deepEqual(
    [...dashboardFiles].sort(),
    dashboardJsonFiles,
    "dashboard tests must cover every dashboards/*.json file",
  );
}

function assertDashboardShape(path, dashboard) {
  assert.equal(typeof dashboard.title, "string", `${path}: title is required`);
  assert.equal(typeof dashboard.uid, "string", `${path}: uid is required`);
  assert.equal(typeof dashboard.schemaVersion, "number", `${path}: schemaVersion is required`);
  assert.ok(Array.isArray(dashboard.panels), `${path}: panels must be an array`);
  assert.ok(dashboard.panels.length > 0, `${path}: at least one panel is required`);
  assert.equal(
    dashboard.__inputs,
    undefined,
    `${path}: provisioned dashboard must not declare import-time datasource inputs`,
  );
  assert.doesNotMatch(
    JSON.stringify(dashboard),
    datasourceInputVariablePattern,
    `${path}: provisioned dashboard must not contain unresolved datasource input variables`,
  );
  for (const panel of dashboard.panels) assertPanelShape(path, panel);

  assertDashboardPanelTitlesUnique(path, dashboard);
  assertDashboardDatasourceReferences(path, dashboard);
}

function assertDashboardDatasourceReferences(path, dashboard) {
  for (const panel of dashboard.panels) {
    assertDatasourceReference(path, panel.title, "panel", panel.datasource);

    for (const target of panel.targets ?? []) {
      assertDatasourceReference(path, panel.title, `target ${target.refId}`, target.datasource);
    }
  }
}

function assertDatasourceReference(path, panelTitle, source, datasource) {
  if (!datasource || typeof datasource !== "object") return;

  if (typeof datasource.uid === "string") {
    assert.doesNotMatch(
      datasource.uid,
      datasourceInputVariablePattern,
      `${path}: ${panelTitle} ${source} has an unresolved datasource input variable`,
    );
  }

  const expectedUid = provisionedDatasourceUidsByType.get(datasource.type);
  if (!expectedUid) return;

  assert.equal(
    datasource.uid,
    expectedUid,
    `${path}: ${panelTitle} ${source} must use provisioned ${datasource.type} datasource UID`,
  );
}

function assertPanelShape(path, panel) {
  assert.equal(typeof panel.id, "number", `${path}: panel id is required`);
  assert.equal(typeof panel.title, "string", `${path}: panel title is required`);
  assert.equal(typeof panel.type, "string", `${path}: panel type is required`);
  assertGridPosition(path, panel);

  if (!Array.isArray(panel.targets)) {
    assert.ok(panelCanOmitTargets(panel), `${path}: ${panel.title} targets must be an array`);
    return;
  }

  if (panel.targets.length === 0) {
    assert.ok(panelCanOmitTargets(panel), `${path}: ${panel.title} must have at least one target`);
    return;
  }

  assertTargetsAreNotSplit(path, panel);
  for (const target of panel.targets) assertTargetShape(path, panel, target);
}

function panelCanOmitTargets(panel) {
  return panel.type === "text" || panel.type === "row";
}

function assertGridPosition(path, panel) {
  assert.equal(typeof panel.gridPos?.h, "number", `${path}: ${panel.title} grid height is required`);
  assert.equal(typeof panel.gridPos?.w, "number", `${path}: ${panel.title} grid width is required`);
  assert.equal(typeof panel.gridPos?.x, "number", `${path}: ${panel.title} grid x is required`);
  assert.equal(typeof panel.gridPos?.y, "number", `${path}: ${panel.title} grid y is required`);
}

function assertTargetsAreNotSplit(path, panel) {
  for (let index = 0; index < panel.targets.length - 1; index += 1) {
    const currentTarget = panel.targets[index];
    const nextTarget = panel.targets[index + 1];

    assert.ok(
      !targetLooksSplitAcrossAdjacentObject(currentTarget, nextTarget),
      `${path}: ${panel.title} appears to split one query target across adjacent target objects`,
    );
  }
}

function targetLooksSplitAcrossAdjacentObject(currentTarget, nextTarget) {
  return hasTargetQuery(currentTarget) && !isNonEmptyString(currentTarget.refId)
    && isNonEmptyString(nextTarget.refId) && !hasTargetQuery(nextTarget);
}

function assertTargetShape(path, panel, target) {
  const datasourceType = target.datasource?.type ?? panel.datasource?.type;

  assert.equal(typeof target.refId, "string", `${path}: ${panel.title} target refId is required`);
  assert.ok(target.refId.length > 0, `${path}: ${panel.title} target refId must not be empty`);

  if (datasourceType === "tempo") {
    assert.equal(typeof target.query, "string", `${path}: ${panel.title} target ${target.refId} query is required for Tempo`);
    assert.ok(target.query.length > 0, `${path}: ${panel.title} target ${target.refId} query must not be empty`);
    return;
  }

  if (datasourceType === "loki" || datasourceType === "prometheus") {
    assert.equal(typeof target.expr, "string", `${path}: ${panel.title} target ${target.refId} expr is required for ${datasourceType}`);
    assert.ok(target.expr.length > 0, `${path}: ${panel.title} target ${target.refId} expr must not be empty`);
    return;
  }

  assert.ok(hasTargetQuery(target), `${path}: ${panel.title} target ${target.refId} must define expr or query`);
}

function hasTargetQuery(target) {
  return isNonEmptyString(target.expr) || isNonEmptyString(target.query);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function assertDashboardPanelTitlesUnique(path, dashboard) {
  const panelTitlesByName = new Map();

  for (const panel of dashboard.panels) {
    const panelTitle = panel.title.trim();
    const previousPanelId = panelTitlesByName.get(panelTitle);

    assert.equal(
      previousPanelId,
      undefined,
      `${path}: panel title "${panelTitle}" duplicates panel ${previousPanelId}`,
    );

    panelTitlesByName.set(panelTitle, panel.id);
  }
}

function metricSection(text) {
  const start = text.indexOf("## 12. Metrics");
  const end = text.indexOf("## 13. Metric Labels");
  assert.notEqual(start, -1, "semantic convention metrics section is required");
  assert.notEqual(end, -1, "semantic convention metric-label section is required");
  return text.slice(start, end);
}

function documentedMetricNames(text) {
  const names = new Set();
  const matches = metricSection(text).matchAll(/\bobservme_[a-z0-9_]+\b/gu);

  for (const match of matches) names.add(match[0]);

  return names;
}

function prometheusTargetsForDashboard(dashboard) {
  return targetsForDashboard(dashboard, "prometheus");
}

function lokiTargetsForDashboard(dashboard) {
  return targetsForDashboard(dashboard, "loki");
}

function targetsForDashboard(dashboard, type) {
  const targets = [];

  for (const panel of dashboard.panels) {
    for (const target of panel.targets ?? []) {
      const datasourceType = target.datasource?.type ?? panel.datasource?.type;
      if (datasourceType === type) targets.push({ panel, target });
    }
  }

  return targets;
}

function panelByTitle(dashboard, title) {
  for (const panel of dashboard.panels) {
    if (panel.title === title) return panel;
  }

  return undefined;
}

function assertPanelExists(dashboard, title) {
  const panel = panelByTitle(dashboard, title);
  assert.ok(panel, `${exportHealthDashboardFile}: ${title} panel is required`);
  return panel;
}

function assertTraceJourneyPanelExists(dashboard, title) {
  const panel = panelByTitle(dashboard, title);
  assert.ok(panel, `${traceJourneyDashboardFile}: ${title} panel is required`);
  return panel;
}

function expressionsForPanel(panel) {
  return (panel.targets ?? []).map((target) => target.expr);
}

function panelMarkdownContent(panel) {
  return panel.options?.content ?? "";
}

function dashboardVariableNames(dashboard) {
  return (dashboard.templating?.list ?? []).map(variable => variable.name);
}

function assertDashboardDefinesVariables(path, dashboard, variableNames) {
  const names = dashboardVariableNames(dashboard);

  for (const variableName of variableNames) {
    assert.ok(names.includes(variableName), `${path}: ${variableName} variable is required`);
  }
}

function dashboardAndPanelLinkUrls(dashboard) {
  const urls = [];

  for (const link of dashboard.links ?? []) urls.push(link.url ?? "");
  for (const panel of dashboard.panels) {
    for (const link of panel.links ?? []) urls.push(link.url ?? "");
  }

  return urls;
}

function hasZeroVectorFallback(expression) {
  return zeroVectorFallbackPattern.test(expression);
}

function assertPanelTargetUsesMetricWithZeroFallback(dashboard, title, metricName) {
  const panel = assertPanelExists(dashboard, title);
  const expressions = expressionsForPanel(panel).filter((expression) => expression.includes(metricName));

  assert.ok(expressions.length > 0, `${exportHealthDashboardFile}: ${title} must query ${metricName}`);
  assert.ok(
    expressions.some(hasZeroVectorFallback),
    `${exportHealthDashboardFile}: ${title} must provide an or vector(0) fallback for ${metricName}`,
  );
}

function assertPanelDescriptionMentionsEmptyLogRows(dashboard, title) {
  const panel = assertPanelExists(dashboard, title);

  assert.match(
    panel.description ?? "",
    emptyFailureLogsDescriptionPattern,
    `${exportHealthDashboardFile}: ${title} must document that empty log tables are healthy when no failures match`,
  );
}

function metricNamesForExpression(expression) {
  const names = [];
  const matches = expression.matchAll(metricNamePattern);

  for (const match of matches) names.push(match[0]);

  return names;
}

function normalizedMetricName(metricName, documentedNames) {
  if (documentedNames.has(metricName)) return metricName;

  for (const suffix of histogramSuffixes) {
    if (!metricName.endsWith(suffix)) continue;

    const baseName = metricName.slice(0, -suffix.length);
    if (documentedNames.has(baseName)) return baseName;
  }

  return metricName;
}

function provisionedLokiLabels(collectorText) {
  const labels = new Set();
  const matches = collectorText.matchAll(lokiLabelsHintPattern);

  for (const match of matches) addProvisionedLokiLabels(labels, match[1]);

  return labels;
}

function addProvisionedLokiLabels(labels, value) {
  for (const attributeName of value.split(",")) {
    const label = normalizeLokiLabelName(attributeName);
    if (label) labels.add(label);
  }
}

function normalizeLokiLabelName(attributeName) {
  return attributeName.trim().replaceAll(".", "_");
}

function lokiSelectorLabels(expression) {
  const labels = [];
  const selectors = expression.matchAll(lokiSelectorPattern);

  for (const selector of selectors) labels.push(...lokiMatcherLabels(selector[1]));

  return labels;
}

function lokiMatcherLabels(selector) {
  const labels = [];
  const matches = selector.matchAll(lokiLabelMatcherPattern);

  for (const match of matches) labels.push(match[1]);

  return labels;
}

function compactPromql(expression) {
  return expression.replace(/\s+/gu, "");
}

function assertCanonicalActiveAgentQuery(expression, context) {
  assert.ok(expression.includes(activeAgentMetricName), `${context} must query ${activeAgentMetricName}`);
  assert.ok(expression.includes(activeAgentLeaseMetricName), `${context} must query ${activeAgentLeaseMetricName}`);
  assert.match(expression, /and\s+on\s*\(observme_instance_id\)/u, `${context} must join by observme_instance_id`);
  assert.match(expression, /max\s+by\s*\([^)]*observme_instance_id/u, `${context} must deduplicate observme_instance_id`);
  assert.match(expression, />\s*time\(\)/u, `${context} must require an unexpired lease`);
  assert.match(expression, /<=\s*time\(\)\s*\+\s*305/u, `${context} must reject pathological future leases`);
  assert.doesNotMatch(expression, rawActiveAgentSumPattern, `${context} must not sum raw active-agent claims`);
}

async function canonicalActiveAgentPromqlIsDocumentedAndEvaluatesFailureCases() {
  const documentation = await readFile("docs/reference/09-dashboards-alerts-slos.md", "utf8");
  const compactDocumentation = compactPromql(documentation);
  const documentedQueries = [
    CANONICAL_ACTIVE_AGENT_TOTAL_PROMQL,
    CANONICAL_ACTIVE_AGENT_BY_ROLE_PROMQL,
    CANONICAL_ACTIVE_AGENT_BY_ENVIRONMENT_PROMQL,
    CANONICAL_ACTIVE_AGENT_BY_DEPTH_PROMQL,
    CANONICAL_RAW_ACTIVE_AGENT_CLAIMS_PROMQL,
    CANONICAL_EXPIRED_ACTIVE_AGENT_CLAIMS_PROMQL,
  ];

  for (const query of documentedQueries) {
    assert.ok(compactDocumentation.includes(compactPromql(query)), `dashboard reference must document ${query}`);
  }

  for (const query of [
    CANONICAL_ACTIVE_AGENT_TOTAL_PROMQL,
    CANONICAL_ACTIVE_AGENT_BY_ROLE_PROMQL,
    CANONICAL_ACTIVE_AGENT_BY_ENVIRONMENT_PROMQL,
    CANONICAL_ACTIVE_AGENT_BY_DEPTH_PROMQL,
  ]) {
    assertCanonicalActiveAgentQuery(query, "canonical active-agent query");
    assert.ok(hasZeroVectorFallback(query), "canonical active-agent queries must return zero when no series qualify");
  }

  assert.match(
    documentation,
    /do not emit the metric label `subagent_depth`/u,
    "dashboard reference must distinguish the conditional depth shape from currently emitted active labels",
  );
  for (const fixture of canonicalActiveAgentFixtures) {
    assert.equal(
      evaluateCanonicalActiveAgentTotal(fixture, 1_000),
      fixture.expected,
      `canonical active-agent total: ${fixture.title}`,
    );
  }
}

function canonicalActiveAgentBreakdownsRetainEmittedDimensions() {
  const fixture = {
    claims: [
      { observmeInstanceId: "runtime-a", value: 1, labels: { agent_role: "root", environment: "prod" } },
      { observmeInstanceId: "runtime-a", value: 1, labels: { agent_role: "root", environment: "prod" } },
      { observmeInstanceId: "runtime-b", value: 1, labels: { agent_role: "worker", environment: "ci" } },
    ],
    leases: [
      { observmeInstanceId: "runtime-a", value: 1_060 },
      { observmeInstanceId: "runtime-b", value: 1_060 },
    ],
  };

  assert.deepEqual(
    evaluateCanonicalActiveAgentBreakdown(fixture, 1_000, "agent_role"),
    new Map([
      ["root", 1],
      ["worker", 1],
    ]),
  );
  assert.deepEqual(
    evaluateCanonicalActiveAgentBreakdown(fixture, 1_000, "environment"),
    new Map([
      ["prod", 1],
      ["ci", 1],
    ]),
  );
  assert.match(CANONICAL_ACTIVE_AGENT_BY_ROLE_PROMQL, /sum by \(agent_role\).*max by \(observme_instance_id, agent_role\)/u);
  assert.match(CANONICAL_ACTIVE_AGENT_BY_ENVIRONMENT_PROMQL, /sum by \(environment\).*max by \(observme_instance_id, environment\)/u);
  assert.match(CANONICAL_ACTIVE_AGENT_BY_DEPTH_PROMQL, /sum by \(subagent_depth\).*max by \(observme_instance_id, subagent_depth\)/u);
}

async function currentActiveAgentDashboardQueriesRequireValidLeases() {
  let inspectedQueryCount = 0;

  for (const path of dashboardFiles) {
    const dashboard = await readJsonFile(path);
    assert.equal(
      dashboardVariableNames(dashboard).includes("observme_instance_id"),
      false,
      `${path}: observme_instance_id must remain an internal join key`,
    );

    for (const { panel, target } of prometheusTargetsForDashboard(dashboard)) {
      if (!target.expr.includes(activeAgentMetricName)) continue;
      if (activeAgentDiagnosticPanelPattern.test(panel.title)) continue;

      inspectedQueryCount += 1;
      assertCanonicalActiveAgentQuery(target.expr, `${path}: ${panel.title}`);
      assert.doesNotMatch(
        target.legendFormat ?? "",
        /observme_instance_id/u,
        `${path}: ${panel.title} must not display observme_instance_id`,
      );
      if (panel.type !== "nodeGraph") {
        assert.ok(hasZeroVectorFallback(target.expr), `${path}: ${panel.title} must return zero when no live lease qualifies`);
      }
    }
  }

  assert.ok(inspectedQueryCount > 0, "at least one current active-agent dashboard query must be inspected");
}

async function currentActiveAgentPanelsExplainLeaseConvergence() {
  let inspectedPanelCount = 0;

  for (const path of dashboardFiles) {
    const dashboard = await readJsonFile(path);

    for (const { panel, target } of prometheusTargetsForDashboard(dashboard)) {
      if (!target.expr.includes(activeAgentMetricName)) continue;
      if (activeAgentDiagnosticPanelPattern.test(panel.title)) continue;

      inspectedPanelCount += 1;
      const description = panel.description ?? "";
      assert.match(description, /leased/iu, `${path}: ${panel.title} must identify leased activity`);
      assert.match(description, /clean shutdown/iu, `${path}: ${panel.title} must explain the clean zero state`);
      assert.match(description, /(?:crash|ungraceful)/iu, `${path}: ${panel.title} must explain ungraceful convergence`);
      assert.match(
        description,
        /60-second lease plus one Prometheus scrape/iu,
        `${path}: ${panel.title} must state the default convergence window`,
      );
      assert.match(description, /\/obs agents/iu, `${path}: ${panel.title} must distinguish local child state`);
    }
  }

  assert.ok(inspectedPanelCount > 0, "at least one current active-agent panel description must be inspected");
}

async function agentDashboardShowsLeaseHealthDiagnostics() {
  const dashboard = await readJsonFile(agentDashboardFile);
  const rawClaimsPanel = assertAgentDashboardPanel(dashboard, "Raw active claims (diagnostic)");
  const expiredClaimsPanel = assertAgentDashboardPanel(dashboard, "Expired active claims (diagnostic)");

  assert.deepEqual(expressionsForPanel(rawClaimsPanel), [CANONICAL_RAW_ACTIVE_AGENT_CLAIMS_PROMQL]);
  assert.deepEqual(expressionsForPanel(expiredClaimsPanel), [CANONICAL_EXPIRED_ACTIVE_AGENT_CLAIMS_PROMQL]);
  assert.match(rawClaimsPanel.description ?? "", /not live-agent totals/iu);
  assert.match(rawClaimsPanel.description ?? "", /may remain cached/iu);
  assert.match(expiredClaimsPanel.description ?? "", /never contribute to leased active totals/iu);
  assert.match(expiredClaimsPanel.description ?? "", /ungraceful exits/iu);
  assert.match(expiredClaimsPanel.description ?? "", /deployment-tunable/iu);
  assert.match(expiredClaimsPanel.description ?? "", /Collector cleanup/iu);
  assert.match(expiredClaimsPanel.description ?? "", /\/obs agents/iu);
  assert.deepEqual(expiredClaimsPanel.fieldConfig?.defaults?.thresholds?.steps, [
    { color: "green", value: null },
    { color: "yellow", value: 1 },
    { color: "red", value: 5 },
  ]);
  assertPanelLinksToDashboard(rawClaimsPanel, exportHealthDashboardFile.split("/").at(-1).replace(".json", ""), agentDashboardFile);
  assertPanelLinksToDashboard(expiredClaimsPanel, exportHealthDashboardFile.split("/").at(-1).replace(".json", ""), agentDashboardFile);
  for (const panel of [rawClaimsPanel, expiredClaimsPanel]) {
    assert.equal(panel.targets[0].instant, true, `${agentDashboardFile}: ${panel.title} must use an instant diagnostic query`);
    assert.equal(panel.targets[0].range, false, `${agentDashboardFile}: ${panel.title} must not use a range query`);
    assert.ok(
      panel.links.some(link => link.url?.includes("${__url_time_range}")),
      `${agentDashboardFile}: ${panel.title} must preserve the dashboard time range`,
    );
  }
}

async function dashboardFilesAreValidGrafanaDashboards() {
  for (const path of dashboardFiles) {
    const dashboard = await readJsonFile(path);
    assertDashboardShape(path, dashboard);
  }
}

async function dashboardPromqlQueriesUseDocumentedMetrics() {
  const semanticConventionText = await readFile("docs/reference/04-telemetry-semantic-conventions.md", "utf8");
  const documentedNames = documentedMetricNames(semanticConventionText);

  for (const path of dashboardFiles) {
    const dashboard = await readJsonFile(path);
    const targets = prometheusTargetsForDashboard(dashboard);

    for (const { target } of targets) {
      if (typeof target.expr !== "string") continue;

      const metricNames = metricNamesForExpression(target.expr);

      for (const metricName of metricNames) {
        const normalizedName = normalizedMetricName(metricName, documentedNames);
        assert.ok(documentedNames.has(normalizedName), `${path}: ${metricName} is not documented in semantic conventions`);
      }
    }
  }
}

async function agentDashboardPrometheusTargetsAvoidHighCardinalityLabels() {
  const dashboard = await readJsonFile(agentDashboardFile);
  const targets = prometheusTargetsForDashboard(dashboard);

  for (const { panel, target } of targets) {
    const inspectedText = `${target.expr} ${target.legendFormat ?? ""}`;
    assert.doesNotMatch(
      inspectedText,
      forbiddenAgentMetricLabelPattern,
      `${agentDashboardFile}: ${panel.title} uses a forbidden high-cardinality metric label`,
    );
  }
}

async function lokiDashboardTargetsUseNormalizedAttributeNames() {
  for (const path of dashboardFiles) {
    const dashboard = await readJsonFile(path);
    const targets = lokiTargetsForDashboard(dashboard);

    for (const { panel, target } of targets) {
      assert.doesNotMatch(target.expr, lokiAttributePattern, `${path}: ${panel.title} uses dotted OTEL attributes in Loki`);
    }
  }
}

async function lokiDashboardTargetsUseProvisionedLabels() {
  const collectorText = await readFile(localCollectorConfigFile, "utf8");
  const labels = provisionedLokiLabels(collectorText);

  assert.match(collectorText, localServiceNameInsertPattern, `${localCollectorConfigFile}: service.name fallback is required`);

  for (const path of dashboardFiles) {
    const dashboard = await readJsonFile(path);
    const targets = lokiTargetsForDashboard(dashboard);

    for (const { panel, target } of targets) {
      const parsesIntentionalContentBody =
        (path === llmConversationsDashboardFile && llmConversationBodyLogPanelTitles.includes(panel.title)) ||
        (path === toolsDashboardFile && panel.title === toolCapturedErrorPanelTitle);
      if (!parsesIntentionalContentBody) {
        assert.doesNotMatch(target.expr, lokiJsonParserPattern, `${path}: ${panel.title} must not parse non-JSON ObservMe log bodies`);
      }
      assert.doesNotMatch(target.expr, incorrectErrorCategoryPattern, `${path}: ${panel.title} must not treat event_category as error severity`);

      for (const label of lokiSelectorLabels(target.expr)) {
        assert.ok(labels.has(label), `${path}: ${panel.title} uses unprovisioned Loki label ${label}`);
      }
    }
  }
}

async function nodeGraphDashboardUsesGrafanaFrameTargets() {
  const dashboard = await readJsonFile(nodeGraphDashboardFile);
  const panels = dashboard.panels.filter(panel => panel.type === "nodeGraph");

  assert.ok(panels.length > 0, `${nodeGraphDashboardFile}: at least one Node Graph panel is required`);

  for (const panel of panels) {
    const refIds = panel.targets.map(target => target.refId).sort();

    assert.deepEqual(refIds, ["edges", "nodes"], `${nodeGraphDashboardFile}: ${panel.title} must expose nodes and edges frames`);

    for (const target of panel.targets) {
      assert.equal(target.format, "table", `${nodeGraphDashboardFile}: ${panel.title} ${target.refId} must use table format`);
      assert.equal(target.instant, true, `${nodeGraphDashboardFile}: ${panel.title} ${target.refId} must be instant`);
      assert.equal(target.range, false, `${nodeGraphDashboardFile}: ${panel.title} ${target.refId} must not be a range query`);

      if (target.refId === "nodes") assert.match(target.expr, /"id".*"title"/u, `${nodeGraphDashboardFile}: nodes query must expose id and title fields`);
      if (target.refId === "edges") assert.match(target.expr, /"source".*"target"/u, `${nodeGraphDashboardFile}: edges query must expose source and target fields`);
    }
  }
}

async function exportHealthDashboardUsesHealthyZeroStateQueries() {
  const dashboard = await readJsonFile(exportHealthDashboardFile);

  for (const { title, metricName } of exportHealthZeroStatePanels) {
    assertPanelTargetUsesMetricWithZeroFallback(dashboard, title, metricName);
  }

  for (const title of exportHealthFailureLogPanels) {
    assertPanelDescriptionMentionsEmptyLogRows(dashboard, title);
  }
}

async function exportHealthDashboardShowsCompositeSignalsSloAndAlerts() {
  const dashboard = await readJsonFile(exportHealthDashboardFile);
  const healthPanel = assertNamedPanel(exportHealthDashboardFile, dashboard, "Collector/export health");
  const healthExpression = expressionsForPanel(healthPanel).join("\n");
  const alertReferencePanel = assertNamedPanel(exportHealthDashboardFile, dashboard, "Alert threshold reference");
  const alertReferenceContent = panelMarkdownContent(alertReferencePanel);

  for (const title of exportHealthVisibleSignalChips) {
    assert.equal(
      assertNamedPanel(exportHealthDashboardFile, dashboard, title).type,
      "stat",
      `${exportHealthDashboardFile}: ${title} must be a visible stat chip`,
    );
  }

  for (const metricName of exportHealthCompositeFailureMetrics) {
    assert.ok(
      healthExpression.includes(metricName),
      `${exportHealthDashboardFile}: Collector/export health must include ${metricName}`,
    );
  }

  assert.ok(
    healthExpression.includes("== bool 0"),
    `${exportHealthDashboardFile}: Collector/export health must explicitly distinguish healthy idle from active failures`,
  );
  assertPanelExpressionsContainMetrics(exportHealthDashboardFile, assertNamedPanel(exportHealthDashboardFile, dashboard, "Handler p99 latency"), [
    "observme_handler_duration_ms_bucket",
  ]);
  assertPanelLinksToDashboard(healthPanel, "observme-slo-health", exportHealthDashboardFile);
  assert.equal(alertReferencePanel.type, "text", `${exportHealthDashboardFile}: alert threshold reference must be a text panel`);
  assert.match(alertReferenceContent, /ObservMeExportDropsDetected/u, `${exportHealthDashboardFile}: export drop alert threshold is required`);
  assert.match(alertReferenceContent, /ObservMeRedactionFailures/u, `${exportHealthDashboardFile}: redaction alert threshold is required`);
  assert.match(alertReferenceContent, /active agents > \*\*100\*\*/u, `${exportHealthDashboardFile}: active-agent alert threshold is required`);
}

async function sloHealthDashboardShowsScorecardsBurnRatesAndAlertThresholds() {
  const dashboard = await readJsonFile(sloHealthDashboardFile);
  const redactionPanel = assertNamedPanel(sloHealthDashboardFile, dashboard, "Redaction SLO (CI/test)");
  const alertReferencePanel = assertNamedPanel(sloHealthDashboardFile, dashboard, "Alert threshold reference");
  const alertReferenceContent = panelMarkdownContent(alertReferencePanel);

  for (const requirement of sloScorecardRequirements) {
    const panel = assertNamedPanel(sloHealthDashboardFile, dashboard, requirement.title);

    assert.equal(panel.type, "stat", `${sloHealthDashboardFile}: ${requirement.title} must be a stat scorecard`);
    assert.equal(
      panel.fieldConfig?.defaults?.unit,
      requirement.unit,
      `${sloHealthDashboardFile}: ${requirement.title} must use the SLO unit`,
    );
    assertPanelExpressionsContainMetrics(sloHealthDashboardFile, panel, requirement.metricNames);
  }

  for (const requirement of sloBurnRatePanelRequirements) {
    const panel = assertNamedPanel(sloHealthDashboardFile, dashboard, requirement.title);
    const expressionText = expressionsForPanel(panel).join("\n");

    assert.equal(panel.type, "bargauge", `${sloHealthDashboardFile}: ${requirement.title} must be a burn-rate bar gauge`);
    assert.ok(expressionText.includes(requirement.window), `${sloHealthDashboardFile}: ${requirement.title} must use ${requirement.window}`);
    assertPanelExpressionsContainMetrics(sloHealthDashboardFile, panel, sloBurnRateMetrics);
  }

  assert.equal(redactionPanel.type, "text", `${sloHealthDashboardFile}: Redaction SLO must be documented as CI/test status`);
  assert.match(panelMarkdownContent(redactionPanel), /100%/u, `${sloHealthDashboardFile}: Redaction SLO target must be visible`);
  assert.equal(alertReferencePanel.type, "text", `${sloHealthDashboardFile}: alert thresholds must be a text panel`);
  assert.match(alertReferenceContent, /ObservMeRunawayAgentFanOut/u, `${sloHealthDashboardFile}: fan-out alert threshold is required`);
  assert.match(alertReferenceContent, /> \*\*20\*\*/u, `${sloHealthDashboardFile}: fan-out threshold value is required`);
}

async function sessionLifecycleDashboardQueriesUseZeroFallbacks() {
  for (const path of sessionLifecycleDashboardFiles) {
    const dashboard = await readJsonFile(path);
    const targets = prometheusTargetsForDashboard(dashboard);

    for (const { panel, target } of targets) {
      if (!sessionLifecycleMetricPattern.test(target.expr)) continue;

      assert.ok(
        hasZeroVectorFallback(target.expr),
        `${path}: ${panel.title} session lifecycle query must treat missing start/shutdown series as zero`,
      );
    }
  }
}

async function traceJourneyActiveAgentsPanelUsesMatchingTitleAndGauge() {
  const dashboard = await readJsonFile(traceJourneyDashboardFile);
  const stalePanel = panelByTitle(dashboard, "Active sessions");
  const panel = panelByTitle(dashboard, "Active agents");
  const expressions = panel ? expressionsForPanel(panel) : [];

  assert.equal(
    stalePanel,
    undefined,
    `${traceJourneyDashboardFile}: active runtime gauge must not be titled Active sessions`,
  );
  assert.ok(panel, `${traceJourneyDashboardFile}: Active agents stat panel is required`);
  assert.ok(
    expressions.some(expression => expression.includes("observme_active_agents")),
    `${traceJourneyDashboardFile}: Active agents stat must use the active runtime gauge`,
  );
  assert.equal(
    expressions.some(expression => sessionLifecycleMetricPattern.test(expression)),
    false,
    `${traceJourneyDashboardFile}: Active agents stat must not count only sessions started during the range`,
  );
}

async function traceJourneyWorkflowStatsUseTerminalWorkflowSignals() {
  const dashboard = await readJsonFile(traceJourneyDashboardFile);

  assertTraceJourneyStatUsesMetric(dashboard, "Completed workflows", "observme_workflows_completed_total");
  assertTraceJourneyStatUsesMetric(dashboard, "Failed workflows", "observme_workflow_errors_total");

  const ratioPanel = assertTraceJourneyPanelExists(dashboard, "Workflow completion ratio");
  const ratioExpression = expressionsForPanel(ratioPanel).join(" ");

  assert.equal(ratioPanel.type, "stat", `${traceJourneyDashboardFile}: Workflow completion ratio must be a stat`);
  assert.equal(
    ratioPanel.fieldConfig?.defaults?.unit,
    "percentunit",
    `${traceJourneyDashboardFile}: Workflow completion ratio must render as a ratio`,
  );
  assert.ok(
    ratioExpression.includes("observme_workflows_completed_total") && ratioExpression.includes("observme_workflow_errors_total"),
    `${traceJourneyDashboardFile}: Workflow completion ratio must compare completed and failed workflows`,
  );
}

function assertTraceJourneyStatUsesMetric(dashboard, title, metricName) {
  const panel = assertTraceJourneyPanelExists(dashboard, title);
  const expressions = expressionsForPanel(panel);

  assert.equal(panel.type, "stat", `${traceJourneyDashboardFile}: ${title} must be a stat`);
  assert.ok(
    expressions.some(expression => expression.includes(metricName)),
    `${traceJourneyDashboardFile}: ${title} must query ${metricName}`,
  );
}

async function traceJourneyUsesLogsForJourneyEvents() {
  const dashboard = await readJsonFile(traceJourneyDashboardFile);
  const panel = assertTraceJourneyPanelExists(dashboard, "Execution journey events");
  const expression = expressionsForPanel(panel).join(" ");

  assert.equal(
    dashboard.__requires.some(entry => entry.id === "state-timeline"),
    false,
    `${traceJourneyDashboardFile}: Loki journey events should not require state-timeline frames`,
  );
  assert.equal(panel.type, "logs", `${traceJourneyDashboardFile}: Execution journey events must use a logs panel`);
  assert.match(
    panel.description ?? "",
    /logs panel/u,
    `${traceJourneyDashboardFile}: Execution journey events must document the logs-panel choice`,
  );

  for (const filterFragment of traceJourneyLokiFilterFragments) {
    assert.ok(
      expression.includes(filterFragment),
      `${traceJourneyDashboardFile}: Execution journey events must preserve ${filterFragment}`,
    );
  }
}

async function traceJourneyTraceAndLogPanelsKeepFilterLinks() {
  const dashboard = await readJsonFile(traceJourneyDashboardFile);

  assertPanelHasTraceJourneyFilterLink(dashboard, "Recent Tempo traces");
  assertPanelHasTraceJourneyFilterLink(dashboard, "Ordered journey log");
}

async function llmConversationDashboardSupportsSafeFilteredDrilldown() {
  const dashboard = await readJsonFile(llmConversationsDashboardFile);
  const expressionText = lokiTargetsForDashboard(dashboard).map(({ target }) => target.expr).join("\n");
  const timelinePanel = assertNamedPanel(llmConversationsDashboardFile, dashboard, "Conversation timeline (redacted, opt-in)");
  const traceLinksPanel = assertNamedPanel(llmConversationsDashboardFile, dashboard, "Conversation trace links");
  const traceLinkOverrides = JSON.stringify(traceLinksPanel.fieldConfig?.overrides ?? []);
  const traceLinkTransforms = (traceLinksPanel.transformations ?? []).map(transformation => transformation.id);

  assertDashboardDefinesVariables(llmConversationsDashboardFile, dashboard, llmConversationFilterVariables);
  for (const fragment of llmConversationLokiFilterFragments) {
    assert.ok(expressionText.includes(fragment), `${llmConversationsDashboardFile}: content logs must include ${fragment}`);
  }
  for (const title of llmConversationBodyLogPanelTitles) {
    const panel = assertNamedPanel(llmConversationsDashboardFile, dashboard, title);
    const panelExpressionText = expressionsForPanel(panel).join("\n");

    assert.match(
      panelExpressionText,
      /\|\s*json\s*\|\s*line_format\s+"\{\{\.body\}\}"/u,
      `${llmConversationsDashboardFile}: ${title} must show only the parsed body log line by default`,
    );
    assert.equal(panel.options?.showTime, false, `${llmConversationsDashboardFile}: ${title} must hide the log time column`);
    assert.equal(panel.options?.showLabels, false, `${llmConversationsDashboardFile}: ${title} must hide unique labels by default`);
  }

  assert.match(timelinePanel.description ?? "", /(?:redacted.*opt-in|opt-in.*redacted)/i, `${llmConversationsDashboardFile}: timeline must explain redacted opt-in content`);
  assert.match(timelinePanel.description ?? "", /do not query by raw/i, `${llmConversationsDashboardFile}: timeline must discourage raw-content queries`);
  assert.equal(traceLinksPanel.type, "table", `${llmConversationsDashboardFile}: content trace links must be a table`);
  assert.ok(traceLinkTransforms.includes("labelsToFields"), `${llmConversationsDashboardFile}: content trace table must expose Loki labels`);
  assert.ok(traceLinkOverrides.includes("Open Tempo trace"), `${llmConversationsDashboardFile}: trace_id data link must open Tempo`);
  assertPanelLinksToDashboard(traceLinksPanel, "observme-trace-journey", llmConversationsDashboardFile);
  assertPanelLinksToDashboard(timelinePanel, "observme-logs-llm", llmConversationsDashboardFile);

  for (const title of ["Prompts", "Responses", "Thinking"]) {
    const panel = assertNamedPanel(llmConversationsDashboardFile, dashboard, title);
    assert.match(panel.description ?? "", /do not query by raw/i, `${llmConversationsDashboardFile}: ${title} must discourage raw-content queries`);
  }
}

async function logsLlmDashboardRoutesContentToCanonicalConversationDashboard() {
  const dashboard = await readJsonFile(logsLlmDashboardFile);
  const canonicalPanel = assertNamedPanel(logsLlmDashboardFile, dashboard, "Canonical LLM conversation drill-down");
  const requestLogsPanel = assertNamedPanel(logsLlmDashboardFile, dashboard, "LLM request logs");
  const sessionLogsPanel = assertNamedPanel(logsLlmDashboardFile, dashboard, "Session logs");
  const requestLogExpression = expressionsForPanel(requestLogsPanel).join("\n");
  const sessionLogExpression = expressionsForPanel(sessionLogsPanel).join("\n");
  const canonicalContent = panelMarkdownContent(canonicalPanel);

  assertDashboardDefinesVariables(logsLlmDashboardFile, dashboard, llmConversationFilterVariables);
  assert.equal(panelByTitle(dashboard, "Captured prompts (redacted, opt-in)"), undefined, `${logsLlmDashboardFile}: prompt bodies belong in the canonical conversation dashboard`);
  assert.equal(panelByTitle(dashboard, "Captured responses (redacted, opt-in)"), undefined, `${logsLlmDashboardFile}: response bodies belong in the canonical conversation dashboard`);
  assert.equal(panelByTitle(dashboard, "Captured thinking (redacted, opt-in)"), undefined, `${logsLlmDashboardFile}: thinking bodies belong in the canonical conversation dashboard`);
  assert.equal(canonicalPanel.type, "text", `${logsLlmDashboardFile}: canonical conversation drill-down must be a text navigation panel`);
  assert.match(canonicalContent, /redacted, opt-in content/u, `${logsLlmDashboardFile}: content warning must be visible`);
  assert.match(canonicalContent, /Do not query by raw prompt, response, or thinking text/u, `${logsLlmDashboardFile}: raw-content queries must be discouraged`);
  assertPanelLinksToDashboard(canonicalPanel, "observme-llm-conversations", logsLlmDashboardFile);

  for (const fragment of llmConversationLokiFilterFragments.filter(fragment => !fragment.includes("pi_llm_content_kind"))) {
    assert.ok(requestLogExpression.includes(fragment), `${logsLlmDashboardFile}: LLM request logs must include ${fragment}`);
  }
  for (const fragment of llmConversationLokiFilterFragments.slice(0, 4)) {
    assert.ok(sessionLogExpression.includes(fragment), `${logsLlmDashboardFile}: session logs must include ${fragment}`);
  }

  assert.ok(sessionLogExpression.includes('event_category!~"llm_content|tool_content"'), `${logsLlmDashboardFile}: broad session logs must exclude LLM and tool content bodies`);
  assertPanelLinksToDashboard(requestLogsPanel, "observme-llm-conversations", logsLlmDashboardFile);
  assertPanelLinksToDashboard(requestLogsPanel, "observme-trace-journey", logsLlmDashboardFile);
  assertPanelLinksToDashboard(sessionLogsPanel, "observme-llm-conversations", logsLlmDashboardFile);
  assertPanelLinksToDashboard(sessionLogsPanel, "observme-trace-journey", logsLlmDashboardFile);
}

async function traceJourneyLinksToFilteredLlmConversations() {
  const dashboard = await readJsonFile(traceJourneyDashboardFile);
  const conversationLinks = dashboardAndPanelLinkUrls(dashboard).filter(url => url.includes("/d/observme-llm-conversations/"));
  const expressionText = lokiTargetsForDashboard(dashboard).map(({ target }) => target.expr).join("\n");

  assertDashboardDefinesVariables(traceJourneyDashboardFile, dashboard, ["workflow_id"]);
  assert.ok(conversationLinks.length > 0, `${traceJourneyDashboardFile}: Trace Journey must link to LLM Conversations`);
  for (const fragment of llmConversationFilterLinkFragments) {
    assert.ok(
      conversationLinks.some(url => url.includes(fragment)),
      `${traceJourneyDashboardFile}: LLM Conversation links must preserve ${fragment}`,
    );
  }
  assert.ok(expressionText.includes('pi_workflow_id=~"${workflow_id:regex}"'), `${traceJourneyDashboardFile}: Loki journey logs must support workflow filtering`);
}

async function overviewDashboardUsesLandingRowsAndDrilldownLinks() {
  const dashboard = await readJsonFile(overviewDashboardFile);
  const rowTitles = dashboard.panels.filter(panel => panel.type === "row").map(panel => panel.title);
  const dashboardLinkUrls = (dashboard.links ?? []).map(link => link.url ?? "").join("\n");

  assert.deepEqual(
    rowTitles,
    overviewLandingRowTitles,
    `${overviewDashboardFile}: overview must keep the operator landing-page row order`,
  );

  for (const title of overviewHealthChipTitles) {
    assert.ok(panelByTitle(dashboard, title), `${overviewDashboardFile}: ${title} health chip is required`);
  }

  for (const uid of overviewDrilldownDashboardUids) {
    assert.ok(
      dashboardLinkUrls.includes(`/d/${uid}/`),
      `${overviewDashboardFile}: dashboard links must include ${uid}`,
    );
  }
}

async function agentDashboardShowsLineageRatiosThresholdsAndDrilldowns() {
  const dashboard = await readJsonFile(agentDashboardFile);

  for (const requirement of agentRatioPanelRequirements) {
    const panel = assertAgentDashboardPanel(dashboard, requirement.title);
    const expressionText = expressionsForPanel(panel).join("\n");

    assert.equal(panel.type, "stat", `${agentDashboardFile}: ${requirement.title} must be a stat ratio`);
    assert.equal(panel.fieldConfig?.defaults?.unit, "percentunit", `${agentDashboardFile}: ${requirement.title} must render as a ratio`);
    assert.match(expressionText, /clamp_min/u, `${agentDashboardFile}: ${requirement.title} must guard sparse denominators`);
    assertPanelExpressionsContainMetrics(agentDashboardFile, panel, requirement.metricNames);
  }

  for (const requirement of agentTopTableRequirements) {
    const panel = assertAgentDashboardPanel(dashboard, requirement.title);
    const expressionText = expressionsForPanel(panel).join("\n");

    assert.equal(panel.type, "table", `${agentDashboardFile}: ${requirement.title} must be a top-offender table`);
    assert.match(expressionText, /topk\(10,/u, `${agentDashboardFile}: ${requirement.title} must rank the top offenders`);
    assertPanelExpressionsContainMetrics(agentDashboardFile, panel, requirement.metricNames);
  }

  for (const { title, reference } of agentThresholdReferences) {
    const panel = assertAgentDashboardPanel(dashboard, title);
    const expressionText = expressionsForPanel(panel).join("\n");

    assert.ok(expressionText.includes(reference), `${agentDashboardFile}: ${title} must include ${reference} alert reference`);
  }

  const handoffPanel = assertAgentDashboardPanel(dashboard, "Parent/child handoffs with trace links");
  const handoffExpression = expressionsForPanel(handoffPanel).join("\n");
  const handoffLinks = JSON.stringify(handoffPanel.links ?? []);
  const handoffTransforms = (handoffPanel.transformations ?? []).map(transformation => transformation.id);
  const handoffOverrides = JSON.stringify(handoffPanel.fieldConfig?.overrides ?? []);

  assert.equal(handoffPanel.type, "table", `${agentDashboardFile}: handoff drill-down must be a table`);
  assert.ok(handoffExpression.includes('event_category="agent-tree"'), `${agentDashboardFile}: handoff table must select agent-tree logs`);
  assert.ok(handoffExpression.includes("trace_context[.]propagation_failed"), `${agentDashboardFile}: handoff table must include propagation failures`);
  assert.ok(handoffTransforms.includes("labelsToFields"), `${agentDashboardFile}: handoff table must expose Loki labels as columns`);
  assert.ok(handoffLinks.includes("/d/observme-trace-journey/"), `${agentDashboardFile}: handoff table must link to Trace Journey`);
  assert.ok(handoffOverrides.includes("Open Tempo trace"), `${agentDashboardFile}: handoff table must define a Tempo trace data link`);
}

async function nodeGraphDashboardUsesCountsAndHealthSignals() {
  const dashboard = await readJsonFile(nodeGraphDashboardFile);
  const panels = dashboard.panels.filter(panel => panel.type === "nodeGraph");
  const rootTopologyPanel = panelByTitle(dashboard, "Pi root → agents → subagents");
  const spawnTopologyPanel = panelByTitle(dashboard, "Agent role → spawn reason → subagent depth");

  for (const panel of panels) {
    const expressionText = expressionsForPanel(panel).join("\n");

    assert.ok(expressionText.includes('"mainStat"'), `${nodeGraphDashboardFile}: ${panel.title} must expose node/edge mainStat fields`);
    assert.ok(expressionText.includes('"secondaryStat"'), `${nodeGraphDashboardFile}: ${panel.title} must expose secondary status fields`);
    assert.ok(expressionText.includes('"color", "red"'), `${nodeGraphDashboardFile}: ${panel.title} must color health-risk nodes or edges red`);
  }

  assert.ok(rootTopologyPanel, `${nodeGraphDashboardFile}: root topology panel is required`);
  assert.ok(spawnTopologyPanel, `${nodeGraphDashboardFile}: spawn topology panel is required`);
  assert.match(rootTopologyPanel.description ?? "", /not per-workflow truth/iu);
  assert.match(spawnTopologyPanel.description ?? "", /not per-workflow truth/iu);
  assertPanelExpressionsContainMetrics(nodeGraphDashboardFile, rootTopologyPanel, nodeGraphHealthMetricNames);
  assertPanelExpressionsContainMetrics(nodeGraphDashboardFile, spawnTopologyPanel, ["observme_subagent_spawn_failures_total"]);
}

async function traceJourneyAgentPanelsShowThresholdsAndAgentLinks() {
  const dashboard = await readJsonFile(traceJourneyDashboardFile);
  const treeShapePanel = assertTraceJourneyPanelExists(dashboard, "Agent tree shape");
  const handoffPanel = assertTraceJourneyPanelExists(dashboard, "Subagent handoffs by depth and reason");
  const treeExpressions = expressionsForPanel(treeShapePanel).join("\n");
  const handoffExpressions = expressionsForPanel(handoffPanel).join("\n");

  assert.ok(treeExpressions.includes("vector(5)"), `${traceJourneyDashboardFile}: Agent tree shape must include the depth alert reference`);
  assert.ok(treeExpressions.includes("vector(20)"), `${traceJourneyDashboardFile}: Agent tree shape must include the fan-out alert reference`);
  assertPanelLinksToDashboard(treeShapePanel, "observme-agents", traceJourneyDashboardFile);
  assertPanelLinksToDashboard(treeShapePanel, "observme-agent-node-graphs", traceJourneyDashboardFile);
  assert.ok(
    handoffExpressions.includes("observme_subagent_spawn_failures_total"),
    `${traceJourneyDashboardFile}: Subagent handoffs must show failed spawn volume beside handoffs`,
  );
  assertPanelLinksToDashboard(handoffPanel, "observme-agents", traceJourneyDashboardFile);
}

async function llmCostModelDashboardsExposeCostAndTokenInsights() {
  const costDashboard = await readJsonFile(costDashboardFile);
  const modelsDashboard = await readJsonFile(modelsDashboardFile);
  const logsLlmDashboard = await readJsonFile(logsLlmDashboardFile);
  const burnRatePanel = assertNamedPanel(costDashboardFile, costDashboard, "Cost burn rate per hour");
  const budgetPanel = assertNamedPanel(costDashboardFile, costDashboard, "Selected-range budget usage");
  const forecastPanel = assertNamedPanel(costDashboardFile, costDashboard, "Projected 24h cost");
  const costOverTimePanel = assertNamedPanel(costDashboardFile, costDashboard, "Cost over time");
  const tokenTotalsPanel = assertNamedPanel(costDashboardFile, costDashboard, "Token totals by type");
  const cacheRatioPanel = assertNamedPanel(costDashboardFile, costDashboard, "Cache read ratio");
  const cacheSavingsPanel = assertNamedPanel(costDashboardFile, costDashboard, "Estimated cache savings (tokens)");
  const stopReasonPanel = assertNamedPanel(modelsDashboardFile, modelsDashboard, "Stop reason distribution");
  const costPerRequestsPanel = assertNamedPanel(modelsDashboardFile, modelsDashboard, "Cost per 1k LLM requests");
  const costPerTurnPanel = assertNamedPanel(modelsDashboardFile, modelsDashboard, "Overall cost per completed turn");
  const tokenTrendPanel = assertNamedPanel(logsLlmDashboardFile, logsLlmDashboard, "LLM token trends by type");
  const stopReasonExpression = expressionsForPanel(stopReasonPanel).join("\n");
  const costPerRequestsExpression = expressionsForPanel(costPerRequestsPanel).join("\n");
  const costPerTurnExpression = expressionsForPanel(costPerTurnPanel).join("\n");
  const tokenTrendExpression = expressionsForPanel(tokenTrendPanel).join("\n");

  assert.equal(burnRatePanel.type, "stat", `${costDashboardFile}: Cost burn rate per hour must be a stat`);
  assert.equal(budgetPanel.fieldConfig?.defaults?.unit, "percentunit", `${costDashboardFile}: budget usage must render as a ratio`);
  assert.equal(forecastPanel.type, "stat", `${costDashboardFile}: Projected 24h cost must be a stat forecast`);
  assertPanelExpressionsContainMetrics(costDashboardFile, burnRatePanel, ["observme_llm_cost_usd_total"]);
  assertPanelExpressionsContainMetrics(costDashboardFile, budgetPanel, ["observme_llm_cost_usd_total"]);
  assertPanelExpressionsContainMetrics(costDashboardFile, forecastPanel, ["observme_llm_cost_usd_total"]);
  assert.match(expressionsForPanel(forecastPanel).join("\n"), /\$__range_s/u, `${costDashboardFile}: forecast must normalize by selected range length`);
  assert.deepEqual(
    costOverTimePanel.targets.map(target => ({ expression: target.expr, legend: target.legendFormat })),
    [{ expression: "sum(increase(observme_llm_cost_usd_total[$__rate_interval])) or vector(0)", legend: "all providers / models" }],
    `${costDashboardFile}: cost over time must sum every provider and model into one series`,
  );
  assert.equal(costOverTimePanel.fieldConfig?.defaults?.decimals, 6, `${costDashboardFile}: cost over time must preserve sub-cent precision`);
  assertPanelExpressionsContainMetrics(costDashboardFile, tokenTotalsPanel, llmTokenMetricNames);
  for (const expression of expressionsForPanel(tokenTotalsPanel)) {
    assert.match(expression, /sum\(max_over_time\([^[]+\[\$__range\]\)\) or vector\(0\)/u, `${costDashboardFile}: token totals must preserve first exports from short-lived sessions`);
    assert.doesNotMatch(expression, /increase\(/u, `${costDashboardFile}: token totals must not drop first counter samples`);
  }
  assertPanelExpressionsContainMetrics(costDashboardFile, cacheRatioPanel, [
    "observme_llm_cache_read_tokens_total",
    "observme_llm_input_tokens_total",
  ]);
  assert.equal(cacheRatioPanel.fieldConfig?.defaults?.unit, "percentunit", `${costDashboardFile}: cache read ratio must render as a ratio`);
  assertPanelExpressionsContainMetrics(costDashboardFile, cacheSavingsPanel, ["observme_llm_cache_read_tokens_total"]);

  assert.equal(panelByTitle(modelsDashboard, "Cost per 1k turns"), undefined, `${modelsDashboardFile}: misleading model cost per global turn panel must be removed`);
  assertPanelExpressionsContainMetrics(modelsDashboardFile, costPerRequestsPanel, [
    "observme_llm_cost_usd_total",
    "observme_llm_requests_total",
  ]);
  assert.doesNotMatch(costPerRequestsExpression, /observme_turns_completed_total/u, `${modelsDashboardFile}: cost per 1k LLM requests must not use turn counters`);
  assertPanelExpressionsContainMetrics(modelsDashboardFile, costPerTurnPanel, [
    "observme_llm_cost_usd_total",
    "observme_turns_completed_total",
  ]);
  assert.doesNotMatch(costPerTurnExpression, /by \(provider, model\)/u, `${modelsDashboardFile}: overall cost per completed turn must not pretend to be model-attributed`);
  assert.match(stopReasonExpression, /\$__range/u, `${modelsDashboardFile}: stop reason distribution must use selected-range totals`);
  assert.doesNotMatch(stopReasonExpression, /\$__interval/u, `${modelsDashboardFile}: stop reason distribution must not use interval totals in a bar gauge`);
  assert.equal(stopReasonPanel.targets[0].instant, true, `${modelsDashboardFile}: stop reason totals must be an instant query over the selected range`);
  assertPanelExpressionsContainMetrics(logsLlmDashboardFile, tokenTrendPanel, llmTokenMetricNames);
  assert.match(tokenTrendExpression, /\$__interval/u, `${logsLlmDashboardFile}: token trend panel must use interval deltas for a time series`);
}

async function modelThinkingChangeAnnotationsAreSurfacedOnCostLatencyAndModels() {
  for (const path of modelThinkingAnnotationDashboardFiles) {
    const dashboard = await readJsonFile(path);
    const annotations = dashboard.annotations?.list ?? [];
    const expressionText = annotations.map(annotation => annotation.expr ?? "").join("\n");

    assert.ok(annotations.some(annotation => annotation.name === "Model changes"), `${path}: Model changes annotation is required`);
    assert.ok(annotations.some(annotation => annotation.name === "Thinking level changes"), `${path}: Thinking level changes annotation is required`);
    assert.ok(expressionText.includes("observme_model_changes_total"), `${path}: annotations must query model-change telemetry`);
    assert.ok(expressionText.includes("observme_thinking_level_changes_total"), `${path}: annotations must query thinking-level-change telemetry`);
    for (const annotation of annotations) assertDatasourceReference(path, annotation.name, "annotation", annotation.datasource);
  }

  const branchesDashboard = await readJsonFile(branchesCompactionsDashboardFile);
  const changePanel = assertNamedPanel(branchesCompactionsDashboardFile, branchesDashboard, "Model changes and thinking level changes");

  assertPanelLinksToDashboard(changePanel, "observme-cost", branchesCompactionsDashboardFile);
  assertPanelLinksToDashboard(changePanel, "observme-models", branchesCompactionsDashboardFile);
  assertPanelLinksToDashboard(changePanel, "observme-latency", branchesCompactionsDashboardFile);
}

async function latencyDashboardShowsQuantilesVolumesAndTraceLinks() {
  const dashboard = await readJsonFile(latencyDashboardFile);
  const quantilePanel = assertNamedPanel(latencyDashboardFile, dashboard, "Stage latency quantiles");
  const volumePanel = assertNamedPanel(latencyDashboardFile, dashboard, "Stage operation volume");
  const quantileExpressions = expressionsForPanel(quantilePanel).join("\n");

  assert.equal(quantilePanel.type, "table", `${latencyDashboardFile}: Stage latency quantiles must be a table`);
  assert.equal(quantilePanel.fieldConfig?.defaults?.unit, "ms", `${latencyDashboardFile}: latency quantiles must render in milliseconds`);
  assert.match(quantileExpressions, /0[.]50/u, `${latencyDashboardFile}: quantile table must include p50`);
  assert.match(quantileExpressions, /0[.]95/u, `${latencyDashboardFile}: quantile table must include p95`);
  assert.match(quantileExpressions, /0[.]99/u, `${latencyDashboardFile}: quantile table must include p99`);
  assertPanelExpressionsContainMetrics(latencyDashboardFile, quantilePanel, latencyStageHistogramMetrics);
  assertPanelLinksToDashboard(quantilePanel, "observme-trace-journey", latencyDashboardFile);

  assert.equal(volumePanel.type, "table", `${latencyDashboardFile}: Stage operation volume must be a table`);
  assertPanelExpressionsContainMetrics(latencyDashboardFile, volumePanel, latencyVolumeMetrics);

  for (const requirement of latencyTopTableRequirements) {
    const panel = assertNamedPanel(latencyDashboardFile, dashboard, requirement.title);
    const expressionText = expressionsForPanel(panel).join("\n");

    assert.equal(panel.type, "table", `${latencyDashboardFile}: ${requirement.title} must be a top table`);
    assert.match(expressionText, /topk\(10,/u, `${latencyDashboardFile}: ${requirement.title} must rank top offenders`);
    assertPanelExpressionsContainMetrics(latencyDashboardFile, panel, requirement.metricNames);
    assertPanelLinksToDashboard(panel, requirement.linkedDashboardUid, latencyDashboardFile);
    assertPanelLinksToDashboard(panel, "observme-trace-journey", latencyDashboardFile);
  }

  assertPanelLinksToDashboard(assertNamedPanel(latencyDashboardFile, dashboard, "p95 turn latency"), "observme-trace-journey", latencyDashboardFile);
  assertPanelLinksToDashboard(assertNamedPanel(latencyDashboardFile, dashboard, "p95 LLM latency"), "observme-trace-journey", latencyDashboardFile);
  assertPanelLinksToDashboard(assertNamedPanel(latencyDashboardFile, dashboard, "p95 tool latency"), "observme-trace-journey", latencyDashboardFile);
}

async function toolsDashboardShowsFailureSeverityAndCharacterSizes() {
  const dashboard = await readJsonFile(toolsDashboardFile);
  const failurePanel = assertNamedPanel(toolsDashboardFile, dashboard, "Tool failures by severity");
  const latencyPanel = assertNamedPanel(toolsDashboardFile, dashboard, "Tool latency percentiles with volume");
  const sizePanel = assertNamedPanel(toolsDashboardFile, dashboard, "Tool result size distribution");
  const capturedErrorPanel = assertNamedPanel(toolsDashboardFile, dashboard, toolCapturedErrorPanelTitle);
  const failureExpressions = expressionsForPanel(failurePanel).join("\n");
  const latencyExpressions = expressionsForPanel(latencyPanel).join("\n");
  const capturedErrorExpression = expressionsForPanel(capturedErrorPanel).join("\n");

  assert.equal(failurePanel.type, "table", `${toolsDashboardFile}: Tool failures by severity must be a table`);
  assert.match(failureExpressions, /topk\(10,/u, `${toolsDashboardFile}: Tool failures by severity must rank failure counts`);
  assertPanelExpressionsContainMetrics(toolsDashboardFile, failurePanel, [
    "observme_tool_failures_total",
    "observme_tool_calls_total",
  ]);
  assertPanelLinksToDashboard(failurePanel, "observme-errors", toolsDashboardFile);
  assertPanelLinksToDashboard(failurePanel, "observme-trace-journey", toolsDashboardFile);

  assert.equal(latencyPanel.type, "table", `${toolsDashboardFile}: Tool latency percentiles with volume must be a table`);
  assert.match(latencyExpressions, /0[.]50/u, `${toolsDashboardFile}: tool latency table must include p50`);
  assert.match(latencyExpressions, /0[.]95/u, `${toolsDashboardFile}: tool latency table must include p95`);
  assert.match(latencyExpressions, /0[.]99/u, `${toolsDashboardFile}: tool latency table must include p99`);
  assertPanelExpressionsContainMetrics(toolsDashboardFile, latencyPanel, [
    "observme_tool_duration_ms_bucket",
    "observme_tool_calls_total",
  ]);
  assertPanelLinksToDashboard(latencyPanel, "observme-latency", toolsDashboardFile);
  assertPanelLinksToDashboard(latencyPanel, "observme-trace-journey", toolsDashboardFile);

  assert.equal(sizePanel.fieldConfig?.defaults?.unit, "short", `${toolsDashboardFile}: *_size_chars panels must not use byte units`);
  assert.match(sizePanel.description ?? "", /characters/u, `${toolsDashboardFile}: size panel must explain character units`);

  assert.equal(capturedErrorPanel.type, "logs", `${toolsDashboardFile}: captured tool error output must preserve multiline log output`);
  assert.match(capturedErrorExpression, /event_name="tool[.]error[.]captured"/u, `${toolsDashboardFile}: captured tool errors must use the dedicated event`);
  assert.match(capturedErrorExpression, /event_category="tool_content"/u, `${toolsDashboardFile}: captured tool errors must use the isolated content category`);
  assert.ok(capturedErrorExpression.includes('line_format "{{.body}}"'), `${toolsDashboardFile}: captured tool errors must render the policy-processed body`);
  assert.match(capturedErrorPanel.description ?? "", /capture[.]toolResults/u, `${toolsDashboardFile}: captured tool error output must document the opt-in`);
  assert.match(capturedErrorPanel.description ?? "", /Redaction/u, `${toolsDashboardFile}: captured tool error output must document redaction`);
}

async function errorsDashboardUsesParsedLogTablesAndTraceLinks() {
  const dashboard = await readJsonFile(errorsDashboardFile);

  for (const requirement of parsedErrorLogPanelRequirements) {
    const panel = assertNamedPanel(errorsDashboardFile, dashboard, requirement.title);
    const expressionText = expressionsForPanel(panel).join("\n");
    const transformations = (panel.transformations ?? []).map(transformation => transformation.id);
    const overrides = JSON.stringify(panel.fieldConfig?.overrides ?? []);

    assert.equal(panel.type, "table", `${errorsDashboardFile}: ${requirement.title} must be a table`);
    assert.ok(expressionText.includes(`event_name="${requirement.eventName}"`), `${errorsDashboardFile}: ${requirement.title} must select ${requirement.eventName}`);
    assert.ok(transformations.includes("labelsToFields"), `${errorsDashboardFile}: ${requirement.title} must expose Loki labels as fields`);
    assert.ok(overrides.includes("Open Tempo trace"), `${errorsDashboardFile}: ${requirement.title} must define Tempo trace data links`);
    assertPanelLinksToDashboard(panel, "observme-trace-journey", errorsDashboardFile);
  }
}

async function repairedLifecycleMetricsMatchDashboardNamesAndGroupingLabels() {
  const agentDashboard = await readJsonFile(agentDashboardFile);
  const errorsDashboard = await readJsonFile(errorsDashboardFile);
  const spawnDurationPanel = assertAgentDashboardPanel(agentDashboard, "p95 subagent-spawn duration");
  const childFailurePanel = assertAgentDashboardPanel(agentDashboard, "Child-agent failures and recovered child failures");
  const errorRatePanel = assertNamedPanel(errorsDashboardFile, errorsDashboard, "Error rate");
  const spawnDurationExpression = expressionsForPanel(spawnDurationPanel).join("\n");
  const childFailureExpressions = expressionsForPanel(childFailurePanel);
  const errorRateExpression = expressionsForPanel(errorRatePanel).join("\n");

  assert.ok(
    spawnDurationExpression.includes("observme_subagent_spawn_duration_ms_bucket"),
    `${agentDashboardFile}: spawn duration panel must use the production histogram name`,
  );
  assert.match(
    spawnDurationExpression,
    /by\s*\(agent_role,\s*spawn_type,\s*spawn_reason,\s*le\)/u,
    `${agentDashboardFile}: spawn duration grouping must match production labels`,
  );
  assert.ok(
    childFailureExpressions.some(expression => expression.includes("observme_child_agent_failures_total")),
    `${agentDashboardFile}: child failure panel must use the production counter name`,
  );
  assert.ok(
    childFailureExpressions.some(expression => expression.includes("observme_parent_recovered_from_child_failure_total")),
    `${agentDashboardFile}: recovery panel must use the production counter name`,
  );
  assert.ok(
    childFailureExpressions.every(expression => /by\s*\(agent_role,\s*subagent_depth\)/u.test(expression)),
    `${agentDashboardFile}: child failure and recovery grouping must match production labels`,
  );
  assert.ok(
    errorRateExpression.includes("observme_agent_run_errors_total"),
    `${errorsDashboardFile}: error rate must query the production agent-run error counter`,
  );
}

async function sizeCharPanelsUseCharacterUnits() {
  for (const path of dashboardFiles) {
    const dashboard = await readJsonFile(path);

    for (const panel of dashboard.panels) {
      const expressionText = expressionsForPanel(panel).join("\n");
      if (!expressionText.includes("_size_chars")) continue;

      assert.notEqual(panel.fieldConfig?.defaults?.unit, "decbytes", `${path}: ${panel.title} must not use byte units for *_size_chars`);
      assert.match(
        `${panel.title} ${panel.description ?? ""}`,
        /char/i,
        `${path}: ${panel.title} must describe *_size_chars values as characters`,
      );
    }
  }
}

function assertNamedPanel(path, dashboard, title) {
  const panel = panelByTitle(dashboard, title);
  assert.ok(panel, `${path}: ${title} panel is required`);
  return panel;
}

function assertAgentDashboardPanel(dashboard, title) {
  const panel = panelByTitle(dashboard, title);
  assert.ok(panel, `${agentDashboardFile}: ${title} panel is required`);
  return panel;
}

function assertPanelExpressionsContainMetrics(path, panel, metricNames) {
  const expressionText = expressionsForPanel(panel).join("\n");

  for (const metricName of metricNames) {
    assert.ok(expressionText.includes(metricName), `${path}: ${panel.title} must query ${metricName}`);
  }
}

function assertPanelLinksToDashboard(panel, dashboardUid, path) {
  const hasDashboardLink = (panel.links ?? []).some(link => link.url?.includes(`/d/${dashboardUid}/`));

  assert.ok(hasDashboardLink, `${path}: ${panel.title} must link to ${dashboardUid}`);
}

function assertPanelHasTraceJourneyFilterLink(dashboard, title) {
  const panel = assertTraceJourneyPanelExists(dashboard, title);
  const hasFilterLink = (panel.links ?? []).some(link => traceJourneyFilterLinkFragments.every(fragment => link.url?.includes(fragment)));

  assert.ok(hasFilterLink, `${traceJourneyDashboardFile}: ${title} must link with current session/agent filters`);
}

test("dashboard file list covers every dashboard JSON file", listedDashboardFilesCoverDashboardJsonFiles);
test("dashboard JSON files are valid Grafana dashboard documents", dashboardFilesAreValidGrafanaDashboards);
test("dashboard PromQL queries only use documented ObservMe metric names", dashboardPromqlQueriesUseDocumentedMetrics);
test(
  "canonical active-agent PromQL is documented and evaluates lease failure cases",
  canonicalActiveAgentPromqlIsDocumentedAndEvaluatesFailureCases,
);
test("canonical active-agent breakdowns retain emitted dimensions", canonicalActiveAgentBreakdownsRetainEmittedDimensions);
test("current active-agent dashboard queries require valid leases", currentActiveAgentDashboardQueriesRequireValidLeases);
test("current active-agent panels explain lease convergence", currentActiveAgentPanelsExplainLeaseConvergence);
test("agent dashboard shows lease-health diagnostics", agentDashboardShowsLeaseHealthDiagnostics);
test(
  "agent dashboard Prometheus targets avoid high-cardinality workflow and agent labels",
  agentDashboardPrometheusTargetsAvoidHighCardinalityLabels,
);
test("dashboard Loki targets use normalized OTLP attribute names", lokiDashboardTargetsUseNormalizedAttributeNames);
test("dashboard Loki targets use labels provisioned by the local Collector", lokiDashboardTargetsUseProvisionedLabels);
test("node graph dashboard uses Grafana nodes and edges frame targets", nodeGraphDashboardUsesGrafanaFrameTargets);
test("export health dashboard uses healthy zero-state queries", exportHealthDashboardUsesHealthyZeroStateQueries);
test(
  "export health dashboard shows composite health inputs, SLO links, and alert thresholds",
  exportHealthDashboardShowsCompositeSignalsSloAndAlerts,
);
test("SLO health dashboard shows scorecards, burn rates, and alert thresholds", sloHealthDashboardShowsScorecardsBurnRatesAndAlertThresholds);
test("session lifecycle dashboard queries use zero fallbacks", sessionLifecycleDashboardQueriesUseZeroFallbacks);
test("trace journey active runtime panel has a matching title and gauge", traceJourneyActiveAgentsPanelUsesMatchingTitleAndGauge);
test("trace journey workflow stats use terminal workflow signals", traceJourneyWorkflowStatsUseTerminalWorkflowSignals);
test("trace journey uses logs for journey events", traceJourneyUsesLogsForJourneyEvents);
test("trace journey trace and log panels keep filter links", traceJourneyTraceAndLogPanelsKeepFilterLinks);
test("LLM conversations dashboard supports safe filtered content drill-down", llmConversationDashboardSupportsSafeFilteredDrilldown);
test("Logs and LLM dashboard routes content to canonical conversations", logsLlmDashboardRoutesContentToCanonicalConversationDashboard);
test("Trace Journey links to filtered LLM conversations", traceJourneyLinksToFilteredLlmConversations);
test("overview dashboard uses landing rows and drill-down links", overviewDashboardUsesLandingRowsAndDrilldownLinks);
test(
  "agent dashboard shows lineage ratios, thresholds, top tables, and drill-downs",
  agentDashboardShowsLineageRatiosThresholdsAndDrilldowns,
);
test("node graph dashboard uses counts and health signals", nodeGraphDashboardUsesCountsAndHealthSignals);
test("trace journey agent panels show thresholds and agent links", traceJourneyAgentPanelsShowThresholdsAndAgentLinks);
test("LLM cost and model dashboards expose cost, token, cache, and stop-reason insights", llmCostModelDashboardsExposeCostAndTokenInsights);
test("model and thinking change annotations are surfaced on cost, latency, and model dashboards", modelThinkingChangeAnnotationsAreSurfacedOnCostLatencyAndModels);
test("latency dashboard shows percentile tables, volume companions, and trace links", latencyDashboardShowsQuantilesVolumesAndTraceLinks);
test("tools dashboard shows failure severity, latency volume, and character-size units", toolsDashboardShowsFailureSeverityAndCharacterSizes);
test("errors dashboard uses parsed log tables with trace links", errorsDashboardUsesParsedLogTablesAndTraceLinks);
test(
  "repaired lifecycle metrics match dashboard names and grouping labels",
  repairedLifecycleMetricsMatchDashboardNamesAndGroupingLabels,
);
test("size character metrics use character units instead of byte units", sizeCharPanelsUseCharacterUnits);
