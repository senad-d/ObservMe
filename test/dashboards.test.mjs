import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dashboardFiles = [
  "dashboards/observme-overview.json",
  "dashboards/observme-cost.json",
  "dashboards/observme-latency.json",
  "dashboards/observme-tools.json",
  "dashboards/observme-agents.json",
  "dashboards/observme-models.json",
  "dashboards/observme-errors.json",
  "dashboards/observme-branches-compactions.json",
  "dashboards/observme-export-health.json",
  "dashboards/observme-logs-llm.json",
  "dashboards/observme-llm-conversations.json",
];
const agentDashboardFile = "dashboards/observme-agents.json";
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
const provisionedDatasourceUidsByType = new Map([
  ["loki", "loki"],
  ["prometheus", "prometheus"],
]);

async function readJsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
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

  assertDashboardDatasourceReferences(path, dashboard);
}

function assertDashboardDatasourceReferences(path, dashboard) {
  for (const panel of dashboard.panels) {
    assertDatasourceReference(path, panel.title, "panel", panel.datasource);

    for (const target of panel.targets) {
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
  assert.ok(Array.isArray(panel.targets), `${path}: ${panel.title} targets must be an array`);
  assert.ok(panel.targets.length > 0, `${path}: ${panel.title} must have at least one target`);

  for (const target of panel.targets) assertTargetShape(path, panel, target);
}

function assertGridPosition(path, panel) {
  assert.equal(typeof panel.gridPos?.h, "number", `${path}: ${panel.title} grid height is required`);
  assert.equal(typeof panel.gridPos?.w, "number", `${path}: ${panel.title} grid width is required`);
  assert.equal(typeof panel.gridPos?.x, "number", `${path}: ${panel.title} grid x is required`);
  assert.equal(typeof panel.gridPos?.y, "number", `${path}: ${panel.title} grid y is required`);
}

function assertTargetShape(path, panel, target) {
  assert.equal(typeof target.refId, "string", `${path}: ${panel.title} target refId is required`);
  assert.equal(typeof target.expr, "string", `${path}: ${panel.title} target expr is required`);
  assert.ok(target.expr.length > 0, `${path}: ${panel.title} target expr must not be empty`);
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

function expressionsForDashboard(dashboard) {
  const expressions = [];

  for (const panel of dashboard.panels) {
    for (const target of panel.targets) expressions.push(target.expr);
  }

  return expressions;
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
    for (const target of panel.targets) {
      const datasourceType = target.datasource?.type ?? panel.datasource?.type;
      if (datasourceType === type) targets.push({ panel, target });
    }
  }

  return targets;
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

async function dashboardFilesAreValidGrafanaDashboards() {
  for (const path of dashboardFiles) {
    const dashboard = await readJsonFile(path);
    assertDashboardShape(path, dashboard);
  }
}

async function dashboardPromqlQueriesUseDocumentedMetrics() {
  const semanticConventionText = await readFile("ObservMe-Production-Docs/04-telemetry-semantic-conventions.md", "utf8");
  const documentedNames = documentedMetricNames(semanticConventionText);

  for (const path of dashboardFiles) {
    const dashboard = await readJsonFile(path);
    const expressions = expressionsForDashboard(dashboard);

    for (const expression of expressions) {
      const metricNames = metricNamesForExpression(expression);

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
      assert.doesNotMatch(target.expr, lokiJsonParserPattern, `${path}: ${panel.title} must not parse non-JSON ObservMe log bodies`);
      assert.doesNotMatch(target.expr, incorrectErrorCategoryPattern, `${path}: ${panel.title} must not treat event_category as error severity`);

      for (const label of lokiSelectorLabels(target.expr)) {
        assert.ok(labels.has(label), `${path}: ${panel.title} uses unprovisioned Loki label ${label}`);
      }
    }
  }
}

test("dashboard JSON files are valid Grafana dashboard documents", dashboardFilesAreValidGrafanaDashboards);
test("dashboard PromQL queries only use documented ObservMe metric names", dashboardPromqlQueriesUseDocumentedMetrics);
test(
  "agent dashboard Prometheus targets avoid high-cardinality workflow and agent labels",
  agentDashboardPrometheusTargetsAvoidHighCardinalityLabels,
);
test("dashboard Loki targets use normalized OTLP attribute names", lokiDashboardTargetsUseNormalizedAttributeNames);
test("dashboard Loki targets use labels provisioned by the local Collector", lokiDashboardTargetsUseProvisionedLabels);
