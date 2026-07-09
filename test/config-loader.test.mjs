import assert from "node:assert/strict";
import test from "node:test";
import { PROJECT_OBSERVME_YAML_TEMPLATE } from "../src/config/bootstrap-project-config.ts";
import { loadFactoryConfig, loadSessionConfig, parseObservMeConfigText } from "../src/config/load-config.ts";

const globalConfigYaml = `
observme:
  tenant: global-tenant
  otlp:
    endpoint: https://global.example.test:4318
  resource:
    attributes:
      observme.tenant.id: global-resource-tenant
      deployment.environment.name: global-environment
  workflow:
    idEnv: GLOBAL_WORKFLOW_ID
  agent:
    capabilityEnv: GLOBAL_AGENT_CAPABILITY
`;

const projectConfigYaml = `
observme:
  tenant: project-tenant
  otlp:
    endpoint: https://project.example.test:4318
  resource:
    attributes:
      observme.tenant.id: project-resource-tenant
      deployment.environment.name: project-environment
  workflow:
    idEnv: PROJECT_WORKFLOW_ID
  agent:
    capabilityEnv: PROJECT_AGENT_CAPABILITY
`;

function createReader(files, calls = []) {
  return async path => {
    calls.push(path);
    if (Object.hasOwn(files, path)) return files[path];
    const error = new Error(`Missing fixture ${path}`);
    error.code = "ENOENT";
    throw error;
  };
}

test("session loader applies defaults, global config, project config, env, then runtime options", async () => {
  const config = await loadSessionConfig({
    globalConfigPath: "global.yaml",
    projectConfigPath: "project.yaml",
    isProjectTrusted: true,
    readText: createReader({
      "global.yaml": globalConfigYaml,
      "project.yaml": projectConfigYaml,
    }),
    env: {
      OBSERVME_TENANT: "env-tenant",
      OBSERVME_ENVIRONMENT: "development",
      OBSERVME_OTLP_ENDPOINT: "https://env.example.test:4318",
    },
    runtimeOptions: {
      otlp: {
        timeoutMs: 9000,
      },
      workflow: {
        idEnv: "RUNTIME_WORKFLOW_ID",
      },
      agent: {
        capabilityEnv: "RUNTIME_AGENT_CAPABILITY",
      },
    },
  });

  assert.equal(config.metrics.exportIntervalMillis, 15000, "defaults remain present when no layer overrides them");
  assert.equal(config.otlp.endpoint, "https://env.example.test:4318", "env overrides project config");
  assert.equal(config.resource.attributes["observme.tenant.id"], "env-tenant", "tenant env updates resource attr");
  assert.equal(
    config.resource.attributes["deployment.environment.name"],
    "development",
    "environment env updates deployment attr",
  );
  assert.equal(config.otlp.timeoutMs, 9000, "runtime options are the highest-precedence layer");
  assert.equal(config.workflow.idEnv, "RUNTIME_WORKFLOW_ID", "workflow id env key round-trips through loader");
  assert.equal(config.agent.capabilityEnv, "RUNTIME_AGENT_CAPABILITY", "agent capability env key round-trips through loader");
});

test("project config overrides global config when no env/runtime layer overrides the same key", async () => {
  const config = await loadSessionConfig({
    globalConfigPath: "global.yaml",
    projectConfigPath: "project.yaml",
    isProjectTrusted: true,
    readText: createReader({
      "global.yaml": globalConfigYaml,
      "project.yaml": projectConfigYaml,
    }),
    env: {},
  });

  assert.equal(config.tenant, "project-tenant");
  assert.equal(config.otlp.endpoint, "https://project.example.test:4318");
  assert.equal(config.resource.attributes["observme.tenant.id"], "project-resource-tenant");
  assert.equal(config.resource.attributes["deployment.environment.name"], "project-environment");
  assert.equal(config.workflow.idEnv, "PROJECT_WORKFLOW_ID");
  assert.equal(config.agent.capabilityEnv, "PROJECT_AGENT_CAPABILITY");
});

test("session loader maps Grafana auth and local transport environment variables", async () => {
  const config = await loadSessionConfig({
    globalConfigPath: "missing-global.yaml",
    projectConfigPath: "missing-project.yaml",
    isProjectTrusted: true,
    readText: createReader({}),
    env: {
      OBSERVME_GRAFANA_URL: "https://observability.local",
      OBSERVME_GRAFANA_USERNAME: "admin",
      OBSERVME_GRAFANA_PASSWORD: "local-password",
      OBSERVME_GRAFANA_TEMPO_DATASOURCE_UID: "tempo-custom",
      OBSERVME_GRAFANA_LOKI_DATASOURCE_UID: "loki-custom",
      OBSERVME_GRAFANA_PROMETHEUS_DATASOURCE_UID: "prometheus-custom",
      OBSERVME_GRAFANA_TLS_INSECURE_SKIP_VERIFY: "true",
      OBSERVME_GRAFANA_PREFER_IPV4: "true",
    },
  });

  assert.equal(config.query.grafana.url, "https://observability.local");
  assert.equal(config.query.grafana.username, "admin");
  assert.equal(config.query.grafana.password, "local-password");
  assert.deepEqual(config.query.grafana.datasourceUids, {
    tempo: "tempo-custom",
    loki: "loki-custom",
    prometheus: "prometheus-custom",
  });
  assert.equal(config.query.grafana.tls.insecureSkipVerify, true);
  assert.equal(config.query.grafana.transport.preferIPv4, true);
});

const envFileText = `
# Trusted project-local extension variables.
OBSERVME_GRAFANA_URL=https://env-file.local
OBSERVME_GRAFANA_USERNAME=admin
OBSERVME_GRAFANA_PASSWORD="local password"
OBSERVME_GRAFANA_TEMPO_DATASOURCE_UID=tempo-file
OBSERVME_GRAFANA_LOKI_DATASOURCE_UID=loki-file
OBSERVME_GRAFANA_PROMETHEUS_DATASOURCE_UID=prometheus-file
OBSERVME_GRAFANA_TLS_INSECURE_SKIP_VERIFY=true
OBSERVME_GRAFANA_PREFER_IPV4=true
`;

test("session loader reads trusted project .env and lets system env override it", async () => {
  const calls = [];
  const config = await loadSessionConfig({
    globalConfigPath: "missing-global.yaml",
    projectConfigPath: "missing-project.yaml",
    envFilePath: "project.env",
    isProjectTrusted: true,
    readText: createReader({ "project.env": envFileText }, calls),
    env: {
      OBSERVME_GRAFANA_PASSWORD: "system-password",
    },
  });

  assert.deepEqual(calls, ["missing-global.yaml", "missing-project.yaml", "project.env"]);
  assert.equal(config.query.grafana.url, "https://env-file.local");
  assert.equal(config.query.grafana.username, "admin");
  assert.equal(config.query.grafana.password, "system-password");
  assert.deepEqual(config.query.grafana.datasourceUids, {
    tempo: "tempo-file",
    loki: "loki-file",
    prometheus: "prometheus-file",
  });
  assert.equal(config.query.grafana.tls.insecureSkipVerify, true);
  assert.equal(config.query.grafana.transport.preferIPv4, true);
});

test("factory-safe loader excludes project config and still applies global/env/runtime layers", async () => {
  const calls = [];
  const config = await loadFactoryConfig({
    globalConfigPath: "global.yaml",
    readText: createReader({ "global.yaml": globalConfigYaml, "project.yaml": projectConfigYaml }, calls),
    env: {
      OBSERVME_TENANT: "factory-env-tenant",
    },
  });

  assert.deepEqual(calls, ["global.yaml"]);
  assert.equal(config.otlp.endpoint, "https://global.example.test:4318");
  assert.equal(config.tenant, "factory-env-tenant");
  assert.equal(config.resource.attributes["observme.tenant.id"], "factory-env-tenant");
  assert.equal(config.workflow.idEnv, "GLOBAL_WORKFLOW_ID");
});

test("session loader does not read project-local config or .env when project is untrusted", async () => {
  const calls = [];
  const config = await loadSessionConfig({
    globalConfigPath: "global.yaml",
    projectConfigPath: "project.yaml",
    envFilePath: "project.env",
    isProjectTrusted: false,
    readText: createReader({
      "global.yaml": globalConfigYaml,
      "project.yaml": projectConfigYaml,
      "project.env": "OBSERVME_GRAFANA_PASSWORD=untrusted-password",
    }, calls),
    env: {},
  });

  assert.deepEqual(calls, ["global.yaml"]);
  assert.equal(config.tenant, "global-tenant");
  assert.equal(config.otlp.endpoint, "https://global.example.test:4318");
  assert.notEqual(config.query.grafana.password, "untrusted-password");
});

test("session loader accepts ctx.isProjectTrusted as the Pi trust boundary", async () => {
  const calls = [];
  const config = await loadSessionConfig({
    globalConfigPath: "global.yaml",
    projectConfigPath: "project.yaml",
    ctx: {
      isProjectTrusted: () => true,
    },
    readText: createReader({ "global.yaml": globalConfigYaml, "project.yaml": projectConfigYaml }, calls),
    env: {},
    loadEnvFile: false,
  });

  assert.deepEqual(calls, ["global.yaml", "project.yaml"]);
  assert.equal(config.tenant, "project-tenant");
});

test("config parser unwraps the documented observme yaml root", () => {
  const parsed = parseObservMeConfigText(`
observme:
  workflow:
    idEnv: OBSERVME_WORKFLOW_ID
  agent:
    capabilityEnv: OBSERVME_AGENT_CAPABILITY
`);

  assert.deepEqual(parsed, {
    workflow: { idEnv: "OBSERVME_WORKFLOW_ID" },
    agent: { capabilityEnv: "OBSERVME_AGENT_CAPABILITY" },
  });
});

test("generated project starter parses with privacy-preserving capture defaults", () => {
  const parsed = parseObservMeConfigText(PROJECT_OBSERVME_YAML_TEMPLATE);

  assert.deepEqual(parsed.capture, {
    prompts: false,
    responses: false,
    thinking: false,
    toolArguments: false,
    toolResults: false,
    bashCommands: false,
    bashOutput: false,
    filePaths: false,
  });
  assert.equal(parsed.privacy.redactionEnabled, true);
  assert.equal(parsed.privacy.allowUnsafeCapture, false);
});

test("generated project starter supports redacted explicit content-capture opt-in", () => {
  const text = PROJECT_OBSERVME_YAML_TEMPLATE.replace("prompts: false", "prompts: true").replace(
    "toolArguments: false",
    "toolArguments: true",
  );
  const parsed = parseObservMeConfigText(text);

  assert.equal(parsed.capture.prompts, true);
  assert.equal(parsed.capture.toolArguments, true);
  assert.equal(parsed.privacy.redactionEnabled, true);
  assert.equal(parsed.privacy.allowUnsafeCapture, false);
});
