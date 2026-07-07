import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadFactoryConfig, parseObservMeConfigText } from "../src/config/load-config.ts";

const observmeExampleFile = "examples/observme.yaml";
const collectorExampleFile = "examples/collector.yaml";
const productionCollectorHeading = "## 6. Production Collector for Grafana Stack";
const requiredHighCardinalityDrops = [
  "pi.workflow.id",
  "pi.workflow.root_agent_id",
  "pi.agent.id",
  "pi.agent.parent_id",
  "pi.agent.root_id",
  "pi.agent.run.id",
  "pi.agent.spawn.id",
  "pi.agent.spawn.tool_call_id",
  "pi.agent.child.id",
  "pi.session.id",
];
const requiredContentDrops = [
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "pi.llm.prompt.redacted",
  "pi.llm.response.redacted",
  "pi.llm.thinking.redacted",
  "pi.tool.arguments.redacted",
  "pi.tool.result.redacted",
];

async function readText(path) {
  return readFile(path, "utf8");
}

function normalizeYaml(text) {
  return text.trim().replace(/\r\n/gu, "\n");
}

function extractProductionCollectorReference(markdown) {
  const sectionStart = markdown.indexOf(productionCollectorHeading);
  assert.notEqual(sectionStart, -1, "production Collector section is required");

  const section = markdown.slice(sectionStart);
  const match = section.match(/```yaml\n(?<yaml>[\s\S]*?)\n```/u);
  assert.ok(match?.groups?.yaml, "production Collector YAML code block is required");

  return match.groups.yaml;
}

function assertYamlParses(path, text) {
  assert.doesNotThrow(() => parseObservMeConfigText(text), `${path} should parse as YAML`);
}

async function examplesHaveValidYamlSyntax() {
  const examples = [observmeExampleFile, collectorExampleFile];

  for (const path of examples) {
    const text = await readText(path);
    assertYamlParses(path, text);
  }
}

async function observmeExampleLoadsAsValidSafeConfig() {
  const config = await loadFactoryConfig({
    env: {},
    globalConfigPath: observmeExampleFile,
    readText,
  });

  assert.equal(config.environment, "development");
  assert.equal(config.otlp.endpoint, "http://localhost:4318");
  assert.equal(config.otlp.signalEndpoints?.traces, "http://localhost:4318/v1/traces");
  assert.equal(config.otlp.signalEndpoints?.metrics, "http://localhost:4318/v1/metrics");
  assert.equal(config.otlp.signalEndpoints?.logs, "http://localhost:4318/v1/logs");
  assert.equal(config.resource.attributes["service.name"], "observme-pi-extension");
  assert.equal(config.resource.attributes["observme.tenant.id"], "local-dev");
  assert.equal(config.resource.attributes["deployment.environment.name"], "development");
  assert.equal(config.workflow.enabled, true);
  assert.equal(config.agent.propagateTraceContext, true);
  assert.equal(config.agent.propagateToSubagents, true);
  assert.equal(config.agent.writeCorrelationEntry, false);
  assert.deepEqual(Object.values(config.capture), [false, false, false, false, false, false, false, false]);
  assert.equal(config.privacy.redactionEnabled, true);
  assert.equal(config.privacy.allowUnsafeCapture, false);
  assert.equal(config.privacy.allowInsecureTransport, true);
}

async function collectorExampleMatchesProductionReference() {
  const [docs, collector] = await Promise.all([
    readText("ObservMe-Production-Docs/05-otel-pipeline-and-collector.md"),
    readText(collectorExampleFile),
  ]);
  const reference = extractProductionCollectorReference(docs);

  assert.equal(normalizeYaml(collector), normalizeYaml(reference));
}

async function collectorExampleIncludesCardinalityAndContentDropProcessors() {
  const collector = await readText(collectorExampleFile);

  assert.match(collector, /resource\/drop_high_cardinality_metric_attrs:/u);
  assert.match(collector, /attributes\/drop_content_attributes:/u);
  assert.match(
    collector,
    /processors: \[memory_limiter, resource\/observme, resource\/drop_high_cardinality_metric_attrs, batch\]/u,
  );
  assert.match(
    collector,
    /processors: \[memory_limiter, resource\/observme, attributes\/drop_content_attributes, batch\]/u,
  );

  for (const key of requiredHighCardinalityDrops) assert.match(collector, new RegExp(`key: ${escapeRegExp(key)}`, "u"));
  for (const key of requiredContentDrops) assert.match(collector, new RegExp(`key: ${escapeRegExp(key)}`, "u"));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

test("example YAML files have parseable YAML syntax", examplesHaveValidYamlSyntax);
test("ObservMe example config loads as a valid minimal local config", observmeExampleLoadsAsValidSafeConfig);
test("Collector example matches the documented production Grafana-stack reference", collectorExampleMatchesProductionReference);
test(
  "Collector example includes high-cardinality and content drop processors",
  collectorExampleIncludesCardinalityAndContentDropProcessors,
);
