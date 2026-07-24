import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { loadFactoryConfig, parseObservMeConfigText } from "../src/config/load-config.ts";
import { getGrafanaQueryReadiness } from "../src/query/grafana-readiness.ts";

const observmeExampleFile = "examples/observme.yaml";
const environmentExampleFile = ".env.example";
const collectorExampleFile = "examples/collector.yaml";
const stackDatasourcesFile = "observability-stack/config/grafana/provisioning/datasources/datasources.yaml";
const stackCollectorFile = "observability-stack/config/otel/otel-collector.yaml";
const stackEnvironmentExampleFile = "observability-stack/.env.example";
const stackNginxFile = "observability-stack/nginx/nginx.conf";
const productionCollectorHeading = "## 6. Production Collector for Grafana Stack";
const supportedLocalGrafanaUrl = "http://localhost";
const supportedLocalDatasourceUids = {
  tempo: "tempo",
  loki: "loki",
  prometheus: "prometheus",
};
const requiredLocalLokiAttributeLabels = ["event.name", "event.category", "pi.session.id"];
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
const resourceToTelemetryConversionPattern = /resource_to_telemetry_conversion:\s*\n\s*enabled: true/u;
const recommendedMetricExpiration = "5m";
const collectorDurationUnitMillis = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

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
  assert.equal(config.metrics.activeAgentLeaseDurationMillis, 60000);
  assert.deepEqual(Object.values(config.capture), [false, false, false, false, false, false, false, false]);
  assert.equal(config.privacy.redactionEnabled, true);
  assert.equal(config.privacy.allowUnsafeCapture, false);
  assert.equal(config.privacy.allowInsecureTransport, true);
  assert.equal(config.query.grafana.url, supportedLocalGrafanaUrl);
  assert.equal(config.query.grafana.token, "${OBSERVME_GRAFANA_TOKEN}");
  assert.equal(config.query.grafana.username, "admin");
  assert.equal(config.query.grafana.password, "${OBSERVME_GRAFANA_PASSWORD}");
  assert.deepEqual(config.query.grafana.datasourceUids, supportedLocalDatasourceUids);
  assert.equal(config.query.grafana.tls.insecureSkipVerify, false);
  assert.equal(config.query.grafana.transport.preferIPv4, false);
}

async function observmeExampleMatchesSupportedLocalQueryProfile() {
  const [config, datasources, collector, stackEnvironment, nginx] = await Promise.all([
    loadFactoryConfig({
      env: {},
      globalConfigPath: observmeExampleFile,
      readText,
    }),
    readText(stackDatasourcesFile),
    readText(stackCollectorFile),
    readText(stackEnvironmentExampleFile),
    readText(stackNginxFile),
  ]);
  const grafanaUrl = new URL(config.query.grafana.url);
  const stackDatasourceUids = extractGrafanaDatasourceUidsByType(datasources);
  const lokiResourceLabels = extractOtelCsvAttributeValue(collector, "loki.resource.labels");
  const lokiAttributeLabels = extractOtelCsvAttributeValue(collector, "loki.attribute.labels");

  assert.equal(grafanaUrl.protocol, "http:");
  assert.equal(grafanaUrl.hostname, "localhost");
  assert.equal(config.query.links.traceUrlTemplate, `${supportedLocalGrafanaUrl}/explore?left=...`);
  assert.equal(config.query.grafana.tls.insecureSkipVerify, false);
  assert.equal(config.query.grafana.transport.preferIPv4, false);
  assert.match(stackEnvironment, /^OBSERVABILITY_URL=http:\/\/localhost$/mu);
  assert.match(stackEnvironment, /^NGINX_HTTP_PORT=80$/mu);
  assert.match(nginx, /listen 80 default_server;/u);
  assert.equal(stackDatasourceUids.tempo, config.query.grafana.datasourceUids.tempo);
  assert.equal(stackDatasourceUids.loki, config.query.grafana.datasourceUids.loki);
  assert.equal(stackDatasourceUids.prometheus, config.query.grafana.datasourceUids.prometheus);
  assert.equal(config.resource.attributes["service.name"], "observme-pi-extension");
  assert.ok(lokiResourceLabels.includes("service.name"), "Loki resource labels should include service.name");
  assert.match(
    collector,
    resourceToTelemetryConversionPattern,
    "local Prometheus exporter should preserve safe resource labels for concurrent session metrics",
  );

  for (const label of requiredLocalLokiAttributeLabels) {
    assert.ok(lokiAttributeLabels.includes(label), `Loki attribute labels should include ${label}`);
  }
}

async function observmeExampleIsQueryReadyWithDocumentedSecretInputs() {
  const basicAuthConfig = await loadFactoryConfig({
    env: { OBSERVME_GRAFANA_PASSWORD: "local-password" },
    globalConfigPath: observmeExampleFile,
    readText,
  });
  const tokenAuthConfig = await loadFactoryConfig({
    env: { OBSERVME_GRAFANA_TOKEN: "grafana-service-token" },
    globalConfigPath: observmeExampleFile,
    readText,
  });

  assert.equal(basicAuthConfig.query.grafana.password, "local-password");
  assert.equal(tokenAuthConfig.query.grafana.token, "grafana-service-token");
  assertSupportedDatasourceReadiness(basicAuthConfig);
  assertSupportedDatasourceReadiness(tokenAuthConfig);
}

async function environmentExampleDocumentsLocalProfileAndActiveAgentLease() {
  const environmentExample = await readText(environmentExampleFile);

  assert.match(environmentExample, /^OBSERVME_OTLP_TIMEOUT_MS=3000$/mu);
  assert.match(environmentExample, /^OBSERVME_GRAFANA_URL=http:\/\/localhost$/mu);
  assert.match(environmentExample, /^OBSERVME_GRAFANA_TLS_INSECURE_SKIP_VERIFY=false$/mu);
  assert.match(environmentExample, /^OBSERVME_GRAFANA_PREFER_IPV4=false$/mu);
  assert.match(environmentExample, /^OBSERVME_ACTIVE_AGENT_LEASE_DURATION_MS=60000$/mu);
  assert.doesNotMatch(environmentExample, /^OBSERVME_ACTIVE_AGENT_LEASE_DURATION_MS=.*(?:token|password|secret)/miu);
}

async function collectorExampleMatchesProductionReference() {
  const [docs, collector] = await Promise.all([
    readText("docs/reference/05-otel-pipeline-and-collector.md"),
    readText(collectorExampleFile),
  ]);
  const reference = extractProductionCollectorReference(docs);

  assert.equal(normalizeYaml(collector), normalizeYaml(reference));
}

async function collectorExamplesUseLeaseIndependentCleanupExpiration() {
  const collectors = await Promise.all([
    readText(stackCollectorFile),
    readText(collectorExampleFile),
  ]);

  for (const collector of collectors) {
    const exporterBlock = extractPrometheusExporterBlock(collector);
    const expiration = extractMetricExpiration(exporterBlock);

    assert.equal(expiration, recommendedMetricExpiration);
    assert.ok(
      parseCollectorDurationMillis(expiration) > defaultObservMeConfig.metrics.activeAgentLeaseDurationMillis,
      "Prometheus cleanup expiration should exceed the default active-agent lease",
    );
    assert.match(exporterBlock, /Exporter-wide stale-series\/cardinality cleanup for gauges, counters, and/u);
    assert.match(exporterBlock, /lease-aware PromQL, not expiration, determines liveness/u);
    assert.match(collector, /metrics:[\s\S]*?exporters: \[prometheus\]/u);
  }
}

async function collectorExampleIncludesCardinalityAndContentDropProcessors() {
  const collector = await readText(collectorExampleFile);

  assert.match(collector, /resource\/drop_high_cardinality_metric_attrs:/u);
  assert.match(collector, /attributes\/drop_content_attributes:/u);
  assert.match(collector, resourceToTelemetryConversionPattern);
  assert.match(
    collector,
    /processors: \[memory_limiter, resource\/observme, resource\/drop_high_cardinality_metric_attrs, batch\]/u,
  );
  assert.match(
    collector,
    /processors: \[memory_limiter, resource\/observme, batch\]/u,
  );
  assert.match(
    collector,
    /processors: \[memory_limiter, resource\/observme, attributes\/drop_content_attributes, batch\]/u,
  );

  for (const key of requiredHighCardinalityDrops) assert.match(collector, new RegExp(`key: ${escapeRegExp(key)}`, "u"));
  for (const key of requiredContentDrops) assert.match(collector, new RegExp(`key: ${escapeRegExp(key)}`, "u"));
}

function assertSupportedDatasourceReadiness(config) {
  for (const datasource of Object.keys(supportedLocalDatasourceUids)) {
    assert.equal(getGrafanaQueryReadiness(config, datasource).status, "ready", `${datasource} query config should be ready`);
  }
}

function extractPrometheusExporterBlock(text) {
  const match = text.match(/(?:^|\n) {2}prometheus:\n(?<block>[\s\S]*?)(?=\n {2}[a-z][^\n]*:\n|\nservice:\n)/u);
  assert.ok(match?.groups?.block, "Prometheus exporter block should be configured");
  return match.groups.block;
}

function extractMetricExpiration(exporterBlock) {
  const match = exporterBlock.match(/^ {4}metric_expiration:\s*(?<duration>\S+)\s*$/mu);
  assert.ok(match?.groups?.duration, "Prometheus exporter should configure metric_expiration");
  return match.groups.duration;
}

function parseCollectorDurationMillis(value) {
  const match = value.match(/^(?<amount>\d+)(?<unit>ms|s|m|h)$/u);
  assert.ok(match?.groups?.amount && match.groups.unit, `unsupported Collector duration: ${value}`);
  return Number(match.groups.amount) * collectorDurationUnitMillis[match.groups.unit];
}

function extractGrafanaDatasourceUidsByType(text) {
  const uidsByType = {};
  const blocks = text.split(/\n\s*-\s+name:\s+/u).slice(1);

  for (const block of blocks) {
    const type = extractYamlScalarByKey(block, "type");
    const uid = extractYamlScalarByKey(block, "uid");
    if (type && uid) uidsByType[type] = uid;
  }

  return uidsByType;
}

function extractYamlScalarByKey(text, key) {
  const match = text.match(new RegExp(`^\\s*${escapeRegExp(key)}:\\s*(?<value>[^\\n#]+)`, "mu"));
  return match?.groups?.value ? stripYamlQuotes(match.groups.value.trim()) : undefined;
}

function extractOtelCsvAttributeValue(text, key) {
  const match = text.match(new RegExp(`- key: ${escapeRegExp(key)}\\n\\s*value: (?<value>[^\\n]+)`, "u"));
  assert.ok(match?.groups?.value, `${key} should be configured in the Collector`);
  return stripYamlQuotes(match.groups.value.trim()).split(",").map(value => value.trim()).filter(Boolean);
}

function stripYamlQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  return value;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

test("example YAML files have parseable YAML syntax", examplesHaveValidYamlSyntax);
test("ObservMe example config loads as a valid supported local config", observmeExampleLoadsAsValidSafeConfig);
test("ObservMe example matches the supported local Grafana query profile", observmeExampleMatchesSupportedLocalQueryProfile);
test("ObservMe example is query-ready with documented secret inputs", observmeExampleIsQueryReadyWithDocumentedSecretInputs);
test("environment example documents the local profile and active-agent lease without credentials", environmentExampleDocumentsLocalProfileAndActiveAgentLease);
test("Collector example matches the documented production Grafana-stack reference", collectorExampleMatchesProductionReference);
test(
  "Collector examples use lease-independent cleanup expiration longer than the default lease",
  collectorExamplesUseLeaseIndependentCleanupExpiration,
);
test(
  "Collector example includes high-cardinality and content drop processors",
  collectorExampleIncludesCardinalityAndContentDropProcessors,
);
