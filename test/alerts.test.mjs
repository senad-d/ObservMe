import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const alertFile = "dashboards/observme-alerts.yaml";
const metricNamePattern = /\bobservme_[a-z0-9_]+(?:_(?:bucket|sum|count))?\b/gu;
const histogramSuffixes = ["_bucket", "_sum", "_count"];
const forbiddenMetricLabelPattern =
  /\b(?:session_id|workflow_id|workflow_root_agent_id|agent_id|parent_agent_id|child_agent_id|agent_run_id|spawn_id|spawn_tool_call_id|trace_id|span_id|pi_workflow_id|pi_workflow_root_agent_id|pi_agent_id|pi_agent_parent_id|pi_agent_root_id|pi_agent_spawn_id)\b/u;
const expectedAlertRules = [
  {
    name: "ObservMeHighLlmErrorRate",
    expression:
      "sum(rate(observme_llm_errors_total[10m])) / clamp_min(sum(rate(observme_llm_requests_total[10m])), 1e-9) > 0.05",
    severity: "warning",
    guidance: "warning",
  },
  {
    name: "ObservMeHighToolFailureRate",
    expression:
      "sum(rate(observme_tool_failures_total[10m])) by (tool_name) / clamp_min(sum(rate(observme_tool_calls_total[10m])) by (tool_name), 1e-9) > 0.10",
    severity: "warning",
    guidance: "warning",
  },
  {
    name: "ObservMeSubagentSpawnFailures",
    expression: "sum(rate(observme_subagent_spawn_failures_total[10m])) > 0",
    severity: "warning",
    guidance: "warning",
  },
  {
    name: "ObservMeExportDropsDetected",
    expression: "sum(rate(observme_telemetry_dropped_total[5m])) > 0",
    severity: "warning",
    guidance: "warning",
  },
  {
    name: "ObservMeCostSpike",
    expression: "sum(increase(observme_llm_cost_usd_total[1h])) > 50",
    severity: "budget-dependent",
    guidance: "depends on organization budget",
  },
  {
    name: "ObservMeRedactionFailures",
    expression: "sum(rate(observme_redaction_failures_total[5m])) > 0",
    severity: "critical",
    guidance: "critical if content capture is enabled",
  },
  {
    name: "ObservMeRunawayAgentFanOut",
    expression: "histogram_quantile(0.95, sum(rate(observme_agent_fanout_count_bucket[10m])) by (le)) > 20",
    severity: "warning",
    guidance: "tune the threshold to the organization's normal orchestrator workload",
  },
  {
    name: "ObservMeExcessiveAgentTreeDepth",
    expression: "histogram_quantile(0.95, sum(rate(observme_agent_tree_depth_bucket[10m])) by (le)) > 5",
    severity: "warning",
    guidance: "tune the threshold to expected maximum delegation depth",
  },
  {
    name: "ObservMeOrphanAgentsDetected",
    expression: "sum(rate(observme_orphan_agents_total[10m])) > 0",
    severity: "warning",
    guidance: "warning",
  },
  {
    name: "ObservMeTraceContextPropagationFailures",
    expression: "sum(rate(observme_trace_context_propagation_failures_total[10m])) > 0",
    severity: "warning",
    guidance: "warning",
  },
  {
    name: "ObservMeActiveAgentsStuckHigh",
    expression: "sum(observme_active_agents) > 100",
    severity: "deployment-dependent",
    guidance: "depends on normal fleet size; tune per deployment",
  },
];

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

function alertBlocksByName(text) {
  const blocks = new Map();
  const matches = text.matchAll(/\n[ ]{6}- alert: (?<name>\S+)\n(?<body>[\s\S]*?)(?=\n[ ]{6}- alert:|\n$)/gu);

  for (const match of matches) {
    const name = match.groups?.name;
    if (name) blocks.set(name, match[0]);
  }

  return blocks;
}

function extractFoldedScalar(block, key) {
  const lines = block.split("\n");
  const scalarLineIndex = lines.findIndex(line => line.trim() === `${key}: >-`);
  assert.notEqual(scalarLineIndex, -1, `${key} folded scalar is required`);

  const values = [];
  for (let index = scalarLineIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith("          ")) break;
    values.push(line.trim());
  }

  return normalizeExpression(values.join(" "));
}

function extractSeverity(block) {
  const match = block.match(/\n[ ]{10}severity: (?<severity>[^\n]+)/u);
  assert.ok(match?.groups?.severity, "severity label is required");
  return match.groups.severity;
}

function normalizeExpression(expression) {
  return expression.replace(/\s+/gu, " ").trim();
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

async function alertRulesMatchProductionDocs() {
  const text = await readFile(alertFile, "utf8");
  const blocks = alertBlocksByName(text);

  assert.equal(blocks.size, expectedAlertRules.length, "alert artifact should contain only the documented alert rules");
  for (const expected of expectedAlertRules) assertExpectedAlertRule(blocks, expected);
}

function assertExpectedAlertRule(blocks, expected) {
  const block = blocks.get(expected.name);
  assert.ok(block, `${expected.name} alert rule is required`);
  assert.equal(extractFoldedScalar(block, "expr"), expected.expression, `${expected.name} expression must match the docs`);
  assert.equal(extractSeverity(block), expected.severity, `${expected.name} severity label must match guidance`);
  assert.match(block, new RegExp(escapeRegExp(expected.guidance), "u"), `${expected.name} severity guidance annotation is required`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function alertRulesUseOnlyDocumentedMetricNames() {
  const [semanticConventionText, alertText] = await Promise.all([
    readFile("ObservMe-Production-Docs/04-telemetry-semantic-conventions.md", "utf8"),
    readFile(alertFile, "utf8"),
  ]);
  const documentedNames = documentedMetricNames(semanticConventionText);
  const metricNames = metricNamesForExpression(alertText);

  assert.ok(metricNames.length > 0, "alert rules should reference ObservMe metrics");
  for (const metricName of metricNames) {
    const normalizedName = normalizedMetricName(metricName, documentedNames);
    assert.ok(documentedNames.has(normalizedName), `${metricName} is not documented in semantic conventions`);
  }
}

async function alertRulesAvoidForbiddenHighCardinalityLabels() {
  const text = await readFile(alertFile, "utf8");
  assert.doesNotMatch(text, forbiddenMetricLabelPattern, "alert rules must not group or filter by high-cardinality labels");
}

test("alert rules match every documented production alert", alertRulesMatchProductionDocs);
test("alert rule expressions only use documented ObservMe metric names", alertRulesUseOnlyDocumentedMetricNames);
test("alert rules avoid forbidden high-cardinality metric labels", alertRulesAvoidForbiddenHighCardinalityLabels);
