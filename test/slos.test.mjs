import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sloFile = "dashboards/observme-slos.yaml";
const metricNamePattern = /\bobservme_[a-z0-9_]+(?:_(?:bucket|sum|count))?\b/gu;
const histogramSuffixes = ["_bucket", "_sum", "_count"];
const expectedPromqlSlos = [
  {
    id: "observability-export",
    expression:
      "1 - (sum(rate(observme_telemetry_dropped_total[30d])) / clamp_min(sum(rate(observme_events_observed_total[30d])), 1e-9))",
  },
  {
    id: "agent-lineage",
    expression:
      "1 - ((sum(rate(observme_subagent_spawn_failures_total{reason=\"lineage_missing\"}[30d])) + sum(rate(observme_orphan_agents_total[30d])) + sum(rate(observme_trace_context_propagation_failures_total[30d]))) / clamp_min(sum(rate(observme_subagents_spawned_total[30d])), 1e-9))",
  },
  {
    id: "workflow-completion",
    expression:
      "(sum(rate(observme_workflows_completed_total[30d])) + sum(rate(observme_workflow_errors_total[30d]))) / clamp_min(sum(rate(observme_workflows_started_total[30d])), 1e-9)",
  },
];
const expectedSloIds = [
  "observability-export",
  "agent-lineage",
  "workflow-completion",
  "instrumentation-overhead",
  "redaction",
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

function sloBlocksById(text) {
  const blocks = new Map();
  const matches = text.matchAll(/\n[ ]{2}- id: (?<id>\S+)\n(?<body>[\s\S]*?)(?=\n[ ]{2}- id:|\n$)/gu);

  for (const match of matches) {
    const id = match.groups?.id;
    if (id) blocks.set(id, match[0]);
  }

  return blocks;
}

function extractFoldedScalar(block, key) {
  const lines = block.split("\n");
  const scalarLineIndex = lines.findIndex(line => line.trim() === `${key}: >-`);
  assert.notEqual(scalarLineIndex, -1, `${key} folded scalar is required`);

  const indent = leadingSpaces(lines[scalarLineIndex]);
  const values = [];
  for (let index = scalarLineIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) continue;
    if (leadingSpaces(line) <= indent) break;
    values.push(line.trim());
  }

  return normalizeExpression(values.join(" "));
}

function leadingSpaces(value) {
  return value.length - value.trimStart().length;
}

function normalizeExpression(expression) {
  return expression.replace(/\s+/gu, " ").trim();
}

function metricNamesForText(text) {
  const names = [];
  const matches = text.matchAll(metricNamePattern);

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

async function sloArtifactContainsEveryDocumentedSlo() {
  const text = await readFile(sloFile, "utf8");
  const blocks = sloBlocksById(text);

  assert.deepEqual([...blocks.keys()].sort(), [...expectedSloIds].sort(), "SLO artifact must contain exactly the documented SLOs");
  for (const expected of expectedPromqlSlos) {
    const block = blocks.get(expected.id);
    assert.ok(block, `${expected.id} SLO block is required`);
    assert.equal(extractFoldedScalar(block, "expr"), expected.expression, `${expected.id} PromQL must match the docs`);
  }
}

async function sloMetricReferencesAreDocumented() {
  const [semanticConventionText, sloText] = await Promise.all([
    readFile("docs/reference/04-telemetry-semantic-conventions.md", "utf8"),
    readFile(sloFile, "utf8"),
  ]);
  const documentedNames = documentedMetricNames(semanticConventionText);
  const metricNames = metricNamesForText(sloText);

  assert.ok(metricNames.length > 0, "SLO artifact should reference ObservMe metrics");
  for (const metricName of metricNames) {
    const normalizedName = normalizedMetricName(metricName, documentedNames);
    assert.ok(documentedNames.has(normalizedName), `${metricName} is not documented in semantic conventions`);
  }
}

async function instrumentationAndRedactionSlosUseCorrectMeasurementSources() {
  const text = await readFile(sloFile, "utf8");
  const blocks = sloBlocksById(text);
  const instrumentationBlock = blocks.get("instrumentation-overhead");
  const redactionBlock = blocks.get("redaction");

  assert.ok(instrumentationBlock?.includes("metric: observme_handler_duration_ms"), "instrumentation overhead SLO must use the documented metric");
  assert.ok(instrumentationBlock?.includes("threshold_ms: 10"), "instrumentation overhead SLO must capture the 10ms threshold");
  assert.match(redactionBlock ?? "", /ci_test_time: true/u, "redaction SLO must be marked as CI/test-time");
  assert.match(redactionBlock ?? "", /runtime_only: false/u, "redaction SLO must not be runtime-only");
  assert.match(redactionBlock ?? "", /This is a test SLO, not runtime-only/u, "redaction SLO must preserve production-doc wording");
}

test("SLO artifact contains every documented SLO indicator", sloArtifactContainsEveryDocumentedSlo);
test("SLO metric references are documented semantic-convention metrics", sloMetricReferencesAreDocumented);
test("instrumentation and redaction SLOs use the documented measurement sources", instrumentationAndRedactionSlosUseCorrectMeasurementSources);
