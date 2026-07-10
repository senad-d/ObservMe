import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PROJECT_OBSERVME_YAML_TEMPLATE } from "../src/config/bootstrap-project-config.ts";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import {
  loadFactoryConfig,
  loadSessionConfig,
  loadSessionConfigWithDiagnostics,
  parseObservMeConfigText,
} from "../src/config/load-config.ts";
import { applyContentCapturePolicy } from "../src/privacy/content-capture.ts";

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

const malformedProjectConfigCases = [
  {
    name: "wrong nested object type",
    text: "observme:\n  query: bad\n",
  },
  {
    name: "wrong capture scalar type",
    text: "observme:\n  capture: false\n",
  },
  {
    name: "invalid custom redaction patterns type",
    text: "observme:\n  privacy:\n    customRedactionPatterns: bad\n",
  },
  {
    name: "unknown top-level property",
    text: "observme:\n  unsupportedFeature: true\n",
  },
  {
    name: "invalid array element type",
    text: "observme:\n  metrics:\n    labels:\n      - provider\n      - 123\n",
  },
  {
    name: "prototype-like key",
    text: '{"observme":{"__proto__":{"polluted":true}}}',
  },
];

const rejectionDiagnosticCases = [
  {
    name: "invalid structure",
    runtimeOptions: { environment: "private-invalid-environment" },
    expectedCode: "invalid_config_shape",
    sensitiveFragments: ["private-invalid-environment"],
  },
  {
    name: "unsafe capture",
    runtimeOptions: {
      capture: { prompts: true },
      privacy: { redactionEnabled: false, allowUnsafeCapture: false },
    },
    expectedCode: "unsafe_capture_without_redaction",
    sensitiveFragments: [],
  },
  {
    name: "insecure transport",
    runtimeOptions: {
      otlp: { endpoint: "http://private-user:private-endpoint-password@collector.test/private-path?token=private-token" },
    },
    expectedCode: "insecure_production_transport",
    sensitiveFragments: ["private-user", "private-endpoint-password", "private-path", "private-token"],
  },
  {
    name: "forbidden metric labels",
    runtimeOptions: { metrics: { labels: ["pi.session.id.private-label-secret"] } },
    expectedCode: "high_cardinality_metric_label",
    sensitiveFragments: ["private-label-secret"],
  },
  {
    name: "malformed lineage",
    env: { OBSERVME_WORKFLOW_ID: "private-lineage-secret/unsafe" },
    expectedCode: "malformed_lineage_value",
    sensitiveFragments: ["private-lineage-secret"],
  },
  {
    name: "oversized queues",
    runtimeOptions: { traces: { batch: { maxQueueSize: 10_001 } } },
    expectedCode: "queue_size_exceeds_guardrail",
    sensitiveFragments: [],
  },
];

for (const diagnosticCase of rejectionDiagnosticCases) {
  test(`session loader preserves sanitized rejection diagnostics for ${diagnosticCase.name}`, async () => {
    const warnings = [];
    const loaded = await loadSessionConfigWithDiagnostics({
      globalConfigPath: "missing-global.yaml",
      isProjectTrusted: false,
      readText: createReader({}),
      env: diagnosticCase.env ?? {},
      runtimeOptions: diagnosticCase.runtimeOptions,
      logger: { warn: message => warnings.push(message) },
    });

    assert.deepEqual(loaded.config, defaultObservMeConfig);
    assert.deepEqual(loaded.diagnostics.rejection?.issueCodes, [diagnosticCase.expectedCode]);
    assert.equal(loaded.diagnostics.rejection?.issueCount, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], new RegExp(diagnosticCase.expectedCode, "u"));

    const serializedDiagnostics = JSON.stringify({ diagnostics: loaded.diagnostics, warnings });
    for (const fragment of diagnosticCase.sensitiveFragments) {
      assert.equal(serializedDiagnostics.includes(fragment), false);
    }
  });
}

test("session loader emits no rejection diagnostic for safe valid configuration", async () => {
  const loaded = await loadSessionConfigWithDiagnostics({
    globalConfigPath: "missing-global.yaml",
    isProjectTrusted: false,
    readText: createReader({}),
    env: {},
  });

  assert.equal(loaded.diagnostics.rejection, undefined);
});

for (const malformedProjectConfig of malformedProjectConfigCases) {
  test(`session loader falls back for structurally invalid trusted project config: ${malformedProjectConfig.name}`, async () => {
    const warnings = [];
    const config = await loadSessionConfig({
      globalConfigPath: "missing-global.yaml",
      projectConfigPath: "project.yaml",
      isProjectTrusted: true,
      readText: createReader({ "project.yaml": malformedProjectConfig.text }),
      env: {},
      loadEnvFile: false,
      logger: {
        warn: message => warnings.push(message),
      },
    });

    assert.deepEqual(config, defaultObservMeConfig);
    assert.equal({}.polluted, undefined);
    assert.ok(warnings.some(message => message.includes("invalid_config_shape")));
    assert.doesNotMatch(warnings.join("\n"), /bad|unsupportedFeature|polluted|123/u);
  });
}

test("factory loader falls back for structurally invalid global config", async () => {
  const warnings = [];
  const config = await loadFactoryConfig({
    globalConfigPath: "global.yaml",
    readText: createReader({ "global.yaml": "observme:\n  query: bad\n" }),
    env: {},
    logger: {
      warn: message => warnings.push(message),
    },
  });

  assert.deepEqual(config, defaultObservMeConfig);
  assert.ok(warnings.some(message => message.includes("invalid_config_shape")));
  assert.doesNotMatch(warnings.join("\n"), /bad/u);
});

test("config loaders derive global and project defaults from Pi's exported config directory", async () => {
  const factoryCalls = [];
  await loadFactoryConfig({ readText: createReader({}, factoryCalls), env: {} });

  assert.deepEqual(factoryCalls, [join(homedir(), CONFIG_DIR_NAME, "agent", "observme.yaml")]);

  const cwd = "/workspace/project";
  const sessionCalls = [];
  await loadSessionConfig({
    cwd,
    globalConfigPath: "missing-global.yaml",
    isProjectTrusted: true,
    readText: createReader({}, sessionCalls),
    env: {},
    loadEnvFile: false,
  });

  assert.deepEqual(sessionCalls, ["missing-global.yaml", join(cwd, CONFIG_DIR_NAME, "observme.yaml")]);
});

test("session loader keeps normal project config and env paths inside cwd", async () => {
  const calls = [];
  const cwd = "/workspace/project";
  const projectPath = `${cwd}/custom-pi/observme.yaml`;
  const envPath = `${cwd}/.env`;
  const config = await loadSessionConfig({
    cwd,
    configDirName: "custom-pi",
    globalConfigPath: "missing-global.yaml",
    isProjectTrusted: true,
    readText: createReader({ [projectPath]: projectConfigYaml, [envPath]: "OBSERVME_TENANT=env-file-tenant" }, calls),
    env: {},
  });

  assert.deepEqual(calls, ["missing-global.yaml", projectPath, envPath]);
  assert.equal(config.tenant, "env-file-tenant");
  assert.equal(config.otlp.endpoint, "https://project.example.test:4318");
});

test("session loader rejects traversal and absolute project config directories", async () => {
  for (const configDirName of ["../outside", "/tmp/observme-outside"])
    await assertSessionConfigDirectoryRejected(configDirName);
});

test("session loader rejects outside explicit project config and env overrides", async () => {
  const calls = [];
  const warnings = [];
  const config = await loadSessionConfig({
    cwd: "/workspace/private-demo",
    globalConfigPath: "missing-global.yaml",
    projectConfigPath: "../outside/observme.yaml",
    envFilePath: "/tmp/private.env",
    isProjectTrusted: true,
    readText: createReader({ "../outside/observme.yaml": projectConfigYaml, "/tmp/private.env": envFileText }, calls),
    env: {},
    logger: {
      warn: message => warnings.push(message),
    },
  });

  assert.deepEqual(config, defaultObservMeConfig);
  assert.deepEqual(calls, ["missing-global.yaml"]);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every(message => message.includes("Unsafe ObservMe project")));
  assert.doesNotMatch(warnings.join("\n"), /private-demo|outside|private\.env|workspace/u);
});

async function assertSessionConfigDirectoryRejected(configDirName) {
  const calls = [];
  const warnings = [];
  const config = await loadSessionConfig({
    cwd: "/workspace/private-demo",
    configDirName,
    globalConfigPath: "missing-global.yaml",
    isProjectTrusted: true,
    readText: createReader({}, calls),
    env: {},
    loadEnvFile: false,
    logger: {
      warn: message => warnings.push(message),
    },
  });

  assert.deepEqual(config, defaultObservMeConfig);
  assert.deepEqual(calls, ["missing-global.yaml"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Unsafe ObservMe project config path/u);
  assert.doesNotMatch(warnings[0], /private-demo|outside|tmp|workspace/u);
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

test("session loader registers trusted project .env tenant salt for redacted capture", async () => {
  const previousSalt = process.env.OBSERVME_HASH_SALT;
  delete process.env.OBSERVME_HASH_SALT;

  try {
    const config = await loadSessionConfig({
      globalConfigPath: "missing-global.yaml",
      projectConfigPath: "missing-project.yaml",
      envFilePath: "project.env",
      isProjectTrusted: true,
      readText: createReader({
        "project.env": "OBSERVME_CAPTURE_PROMPTS=true\nOBSERVME_HASH_SALT=trusted-project-salt\n",
      }),
      env: {},
    });
    const result = applyContentCapturePolicy({
      captureEnabled: config.capture.prompts,
      value: "password=prompt-secret",
      kind: "prompt",
      config,
    });

    assert.equal(result.mode, "redacted");
    assert.equal(result.captured, true);
    assert.match(result.value ?? "", /\[REDACTED:pass_word_assignment:[a-f0-9]{12}\]/u);
  } finally {
    if (previousSalt === undefined) delete process.env.OBSERVME_HASH_SALT;
    else process.env.OBSERVME_HASH_SALT = previousSalt;
  }
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
