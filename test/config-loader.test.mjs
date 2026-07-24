import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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
import {
  OBSERVME_CONFIG_FILE_MAX_BYTES,
  OBSERVME_ENV_FILE_MAX_BYTES,
} from "../src/config/read-source-file.ts";
import { applyContentCapturePolicy } from "../src/privacy/content-capture.ts";
import { createEnvTenantSaltSource, trySha256 } from "../src/privacy/hash.ts";

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
  metrics:
    activeAgentLeaseDurationMillis: 40000
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
  metrics:
    activeAgentLeaseDurationMillis: 45000
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

async function createTempConfigProject() {
  return mkdtemp(join(tmpdir(), "observme-config-loader-"));
}

async function removeTempConfigProject(path) {
  await rm(path, { force: true, recursive: true });
}

function padSourceTextToBytes(text, byteLimit) {
  const remainingBytes = byteLimit - Buffer.byteLength(text);
  assert.ok(remainingBytes >= 0);
  return `${text}${"#".repeat(remainingBytes)}`;
}

async function createSizedConfigSources(sizeOffset, sparseMultiplier = 1) {
  const cwd = await createTempConfigProject();
  const globalConfigPath = join(cwd, "global-observme.yaml");
  const projectConfigPath = join(cwd, CONFIG_DIR_NAME, "observme.yaml");
  const envFilePath = join(cwd, ".env");
  await mkdir(join(cwd, CONFIG_DIR_NAME));

  if (sparseMultiplier === 1) {
    await writeFile(
      globalConfigPath,
      padSourceTextToBytes("observme:\n  tenant: global-limit\n", OBSERVME_CONFIG_FILE_MAX_BYTES + sizeOffset),
    );
    await writeFile(
      projectConfigPath,
      padSourceTextToBytes("observme:\n  tenant: project-limit\n", OBSERVME_CONFIG_FILE_MAX_BYTES + sizeOffset),
    );
    await writeFile(
      envFilePath,
      padSourceTextToBytes("OBSERVME_TENANT=env-limit\n", OBSERVME_ENV_FILE_MAX_BYTES + sizeOffset),
    );
  } else {
    await Promise.all([
      writeFile(globalConfigPath, ""),
      writeFile(projectConfigPath, ""),
      writeFile(envFilePath, ""),
    ]);
    await Promise.all([
      truncate(globalConfigPath, OBSERVME_CONFIG_FILE_MAX_BYTES * sparseMultiplier + sizeOffset),
      truncate(projectConfigPath, OBSERVME_CONFIG_FILE_MAX_BYTES * sparseMultiplier + sizeOffset),
      truncate(envFilePath, OBSERVME_ENV_FILE_MAX_BYTES * sparseMultiplier + sizeOffset),
    ]);
  }

  return { cwd, globalConfigPath };
}

async function assertOversizedConfigSourcesRejected(sparseMultiplier = 1) {
  const { cwd, globalConfigPath } = await createSizedConfigSources(1, sparseMultiplier);
  const warnings = [];

  try {
    const loaded = await loadSessionConfigWithDiagnostics({
      cwd,
      globalConfigPath,
      isProjectTrusted: true,
      env: {},
      logger: { warn: message => warnings.push(message) },
    });

    assert.deepEqual(loaded.config, defaultObservMeConfig);
    assert.equal(loaded.diagnostics.globalConfigStatus, "rejected");
    assert.equal(loaded.diagnostics.projectConfigStatus, "rejected");
    assert.equal(loaded.diagnostics.envFileStatus, "rejected");
    assert.deepEqual(loaded.diagnostics.rejection, {
      issueCodes: ["config_source_too_large"],
      issueCount: 3,
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /config_source_too_large/u);
    assert.doesNotMatch(warnings[0], /observme-config-loader|global-observme|observme\.yaml|\.env/u);
  } finally {
    await removeTempConfigProject(cwd);
  }
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
    expectedCodes: ["insecure_production_transport", "invalid_otlp_endpoint"],
    sensitiveFragments: ["private-user", "private-endpoint-password", "private-path", "private-token"],
  },
  {
    name: "embedded Grafana URL credentials",
    runtimeOptions: {
      query: { grafana: { url: "https://private-grafana-user:private-grafana-password@grafana.test" } },
    },
    expectedCode: "embedded_grafana_url_credentials",
    sensitiveFragments: ["private-grafana-user", "private-grafana-password"],
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
  {
    name: "lease shorter than the export window",
    runtimeOptions: { metrics: { activeAgentLeaseDurationMillis: 34999 } },
    expectedCode: "active_agent_lease_too_short_for_export_interval",
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

    const expectedCodes = diagnosticCase.expectedCodes ?? [diagnosticCase.expectedCode];
    assert.deepEqual(loaded.config, defaultObservMeConfig);
    assert.deepEqual(loaded.diagnostics.rejection?.issueCodes, expectedCodes);
    assert.equal(loaded.diagnostics.rejection?.issueCount, expectedCodes.length);
    assert.equal(warnings.length, 1);
    for (const expectedCode of expectedCodes) assert.match(warnings[0], new RegExp(expectedCode, "u"));

    const serializedDiagnostics = JSON.stringify({ diagnostics: loaded.diagnostics, warnings });
    for (const fragment of diagnosticCase.sensitiveFragments) {
      assert.equal(serializedDiagnostics.includes(fragment), false);
    }
  });
}

const invalidActiveAgentLeaseEnvironmentCases = [
  { name: "below the absolute minimum", value: "9999", expectedCode: "invalid_config_shape" },
  { name: "above the absolute maximum", value: "300001", expectedCode: "invalid_config_shape" },
  { name: "fractional", value: "60000.5", expectedCode: "invalid_config_shape" },
  { name: "negative", value: "-1", expectedCode: "invalid_config_shape" },
  { name: "non-numeric", value: "private-lease-value", expectedCode: "invalid_config_shape" },
  {
    name: "below the export relationship",
    value: "34999",
    expectedCode: "active_agent_lease_too_short_for_export_interval",
  },
];

for (const invalidLease of invalidActiveAgentLeaseEnvironmentCases) {
  test(`session loader safely rejects ${invalidLease.name} active-agent lease env values`, async () => {
    const warnings = [];
    const loaded = await loadSessionConfigWithDiagnostics({
      globalConfigPath: "missing-global.yaml",
      isProjectTrusted: false,
      readText: createReader({}),
      env: { OBSERVME_ACTIVE_AGENT_LEASE_DURATION_MS: invalidLease.value },
      logger: { warn: message => warnings.push(message) },
    });

    assert.deepEqual(loaded.config, defaultObservMeConfig);
    assert.ok(loaded.diagnostics.rejection?.issueCodes.includes(invalidLease.expectedCode));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], new RegExp(invalidLease.expectedCode, "u"));
    assert.doesNotMatch(JSON.stringify({ diagnostics: loaded.diagnostics, warnings }), /private-lease-value/u);
  });
}

const malformedTypedEnvironmentCases = [
  ["top-level enablement", "OBSERVME_ENABLED", "private-enabled-typo"],
  ["empty tenant", "OBSERVME_TENANT", ""],
  ["OTLP protocol", "OBSERVME_OTLP_PROTOCOL", "private-protocol-typo"],
  ["capture flag", "OBSERVME_CAPTURE_PROMPTS", "private-capture-typo"],
  ["privacy flag", "OBSERVME_REDACTION_ENABLED", "private-redaction-typo"],
  ["trace propagation flag", "OBSERVME_PROPAGATE_TRACE_CONTEXT", "private-trace-propagation-typo"],
  ["subagent propagation flag", "OBSERVME_PROPAGATE_TO_SUBAGENTS", "private-subagent-propagation-typo"],
  ["OTLP timeout", "OBSERVME_OTLP_TIMEOUT_MS", "private-timeout-value"],
  ["workflow depth", "OBSERVME_WORKFLOW_MAX_DEPTH_WARNING", "1.5"],
  ["workflow fanout", "OBSERVME_WORKFLOW_MAX_FANOUT_WARNING", "private-fanout-value"],
  ["Grafana TLS flag", "OBSERVME_GRAFANA_TLS_INSECURE_SKIP_VERIFY", "private-tls-typo"],
  ["empty boolean", "OBSERVME_WRITE_CORRELATION_ENTRY", ""],
];

for (const [name, environmentName, value] of malformedTypedEnvironmentCases) {
  test(`session loader rejects malformed ${name} environment overrides`, async () => {
    const warnings = [];
    const loaded = await loadSessionConfigWithDiagnostics({
      globalConfigPath: "missing-global.yaml",
      isProjectTrusted: false,
      readText: createReader({}),
      env: { [environmentName]: value },
      logger: { warn: message => warnings.push(message) },
    });

    assert.deepEqual(loaded.config, defaultObservMeConfig);
    assert.equal(loaded.diagnostics.environmentStatus, "rejected");
    assert.equal(loaded.diagnostics.environmentOverrides, true);
    assert.deepEqual(loaded.diagnostics.rejection?.issueCodes, ["invalid_config_shape"]);
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(JSON.stringify({ diagnostics: loaded.diagnostics, warnings }), /private-|1\.5/u);
  });
}

test("session diagnostics distinguish malformed, structurally rejected, and malformed .env sources", async () => {
  const warnings = [];
  const loaded = await loadSessionConfigWithDiagnostics({
    globalConfigPath: "global.yaml",
    projectConfigPath: "project.yaml",
    envFilePath: "project.env",
    isProjectTrusted: true,
    readText: createReader({
      "global.yaml": "{",
      "project.yaml": "observme:\n  query: bad\n",
      "project.env": 'OBSERVME_ENABLED="true" private-trailing-garbage\n',
    }),
    env: {},
    logger: { warn: message => warnings.push(message) },
  });

  assert.deepEqual(loaded.config, defaultObservMeConfig);
  assert.equal(loaded.diagnostics.globalConfigStatus, "malformed");
  assert.equal(loaded.diagnostics.projectConfigStatus, "rejected");
  assert.equal(loaded.diagnostics.envFileStatus, "malformed");
  assert.equal(loaded.diagnostics.environmentStatus, "missing");
  assert.deepEqual(loaded.diagnostics.rejection?.issueCodes, ["invalid_config_shape", "config_source_malformed"]);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(JSON.stringify({ diagnostics: loaded.diagnostics, warnings }), /trailing-garbage|global\.yaml|project\.yaml|project\.env/u);
});

test("session diagnostics distinguish unreadable config and .env sources without exposing paths", async () => {
  const warnings = [];
  const privateReadError = new Error("EACCES /workspace/private-project/.env");
  privateReadError.code = "EACCES";
  const loaded = await loadSessionConfigWithDiagnostics({
    globalConfigPath: "private-global.yaml",
    projectConfigPath: "private-project.yaml",
    envFilePath: "private-project.env",
    isProjectTrusted: true,
    readText: async () => {
      throw privateReadError;
    },
    env: {},
    logger: { warn: message => warnings.push(message) },
  });

  assert.deepEqual(loaded.config, defaultObservMeConfig);
  assert.equal(loaded.diagnostics.globalConfigStatus, "unreadable");
  assert.equal(loaded.diagnostics.projectConfigStatus, "unreadable");
  assert.equal(loaded.diagnostics.envFileStatus, "unreadable");
  assert.equal(loaded.diagnostics.environmentStatus, "missing");
  assert.deepEqual(loaded.diagnostics.rejection, {
    issueCodes: ["config_source_unreadable"],
    issueCount: 3,
  });
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(JSON.stringify({ diagnostics: loaded.diagnostics, warnings }), /EACCES|private|workspace|\.env/u);
});

test("session diagnostics classify malformed YAML separately from a missing source", async () => {
  const loaded = await loadSessionConfigWithDiagnostics({
    globalConfigPath: "missing-global.yaml",
    projectConfigPath: "project.yaml",
    isProjectTrusted: true,
    loadEnvFile: false,
    readText: createReader({ "project.yaml": "observme:\n  capture\n" }),
    env: {},
  });

  assert.equal(loaded.diagnostics.globalConfigStatus, "missing");
  assert.equal(loaded.diagnostics.projectConfigStatus, "malformed");
  assert.equal(loaded.diagnostics.envFileStatus, "skipped_disabled");
  assert.deepEqual(loaded.diagnostics.rejection?.issueCodes, ["config_source_malformed"]);
});

const malformedEnvFileSyntaxCases = [
  ["quoted trailing garbage", 'OBSERVME_ENABLED="true" trailing\n'],
  ["unsupported non-assignment syntax", "export OBSERVME_ENABLED true\n"],
];

for (const [name, text] of malformedEnvFileSyntaxCases) {
  test(`session loader rejects ${name} in trusted project .env`, async () => {
    const loaded = await loadSessionConfigWithDiagnostics({
      globalConfigPath: "missing-global.yaml",
      projectConfigPath: "missing-project.yaml",
      envFilePath: "project.env",
      isProjectTrusted: true,
      readText: createReader({ "project.env": text }),
      env: {},
    });

    assert.equal(loaded.diagnostics.envFileStatus, "malformed");
    assert.deepEqual(loaded.diagnostics.rejection?.issueCodes, ["config_source_malformed"]);
    assert.doesNotMatch(JSON.stringify(loaded.diagnostics), /trailing|OBSERVME_ENABLED/u);
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

test("session loader accepts global, project, and env files at their exact byte limits", async () => {
  const { cwd, globalConfigPath } = await createSizedConfigSources(0);

  try {
    const loaded = await loadSessionConfigWithDiagnostics({
      cwd,
      globalConfigPath,
      isProjectTrusted: true,
      env: {},
    });

    assert.equal(loaded.diagnostics.globalConfigStatus, "loaded");
    assert.equal(loaded.diagnostics.projectConfigStatus, "loaded");
    assert.equal(loaded.diagnostics.envFileStatus, "loaded");
    assert.equal(loaded.config.tenant, "env-limit", "normal source precedence remains intact at the limit");
    assert.equal(loaded.diagnostics.rejection, undefined);
  } finally {
    await removeTempConfigProject(cwd);
  }
});

test("session loader rejects allocated global, project, and env files over their byte limits", async () => {
  await assertOversizedConfigSourcesRejected();
});

test("session loader rejects oversized sparse config and env files before reading their contents", async () => {
  await assertOversizedConfigSourcesRejected(64);
});

test("session loader rejects out-of-root directory and environment file symlinks", async () => {
  const cwd = await createTempConfigProject();
  const outsideDirectory = await createTempConfigProject();
  const warnings = [];

  try {
    await writeFile(join(outsideDirectory, "observme.yaml"), projectConfigYaml, "utf8");
    await writeFile(join(outsideDirectory, ".env"), "OBSERVME_TENANT=outside-env\n", "utf8");
    await symlink(outsideDirectory, join(cwd, CONFIG_DIR_NAME), "dir");
    await symlink(join(outsideDirectory, ".env"), join(cwd, ".env"), "file");

    const loaded = await loadSessionConfigWithDiagnostics({
      cwd,
      globalConfigPath: join(cwd, "missing-global.yaml"),
      isProjectTrusted: true,
      env: {},
      logger: { warn: message => warnings.push(message) },
    });

    assert.deepEqual(loaded.config, defaultObservMeConfig);
    assert.equal(loaded.diagnostics.projectConfigStatus, "rejected");
    assert.equal(loaded.diagnostics.envFileStatus, "rejected");
    assert.deepEqual(loaded.diagnostics.rejection, {
      issueCodes: ["config_source_rejected"],
      issueCount: 2,
    });
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings[0], /observme-config-loader|outside-env|\.env/u);
  } finally {
    await Promise.all([removeTempConfigProject(cwd), removeTempConfigProject(outsideDirectory)]);
  }
});

test("session loader rejects project config and environment file symlinks outside the project root", async () => {
  const cwd = await createTempConfigProject();
  const outsideDirectory = await createTempConfigProject();

  try {
    await mkdir(join(cwd, CONFIG_DIR_NAME));
    await writeFile(join(outsideDirectory, "project.yaml"), projectConfigYaml, "utf8");
    await writeFile(join(outsideDirectory, "project.env"), "OBSERVME_TENANT=outside-env\n", "utf8");
    await symlink(join(outsideDirectory, "project.yaml"), join(cwd, CONFIG_DIR_NAME, "observme.yaml"), "file");
    await symlink(join(outsideDirectory, "project.env"), join(cwd, ".env"), "file");

    const loaded = await loadSessionConfigWithDiagnostics({
      cwd,
      globalConfigPath: join(cwd, "missing-global.yaml"),
      isProjectTrusted: true,
      env: {},
    });

    assert.deepEqual(loaded.config, defaultObservMeConfig);
    assert.equal(loaded.diagnostics.projectConfigStatus, "rejected");
    assert.equal(loaded.diagnostics.envFileStatus, "rejected");
  } finally {
    await Promise.all([removeTempConfigProject(cwd), removeTempConfigProject(outsideDirectory)]);
  }
});

test("session loader supports project config and environment symlinks that resolve inside the project root", async () => {
  const cwd = await createTempConfigProject();
  const inRootConfigDirectory = join(cwd, "config-target");
  const inRootEnvPath = join(cwd, "environment-target");

  try {
    await mkdir(inRootConfigDirectory);
    await writeFile(join(inRootConfigDirectory, "observme.yaml"), projectConfigYaml, "utf8");
    await writeFile(inRootEnvPath, "OBSERVME_TENANT=in-root-env\n", "utf8");
    await symlink(inRootConfigDirectory, join(cwd, CONFIG_DIR_NAME), "dir");
    await symlink(inRootEnvPath, join(cwd, ".env"), "file");

    const loaded = await loadSessionConfigWithDiagnostics({
      cwd,
      globalConfigPath: join(cwd, "missing-global.yaml"),
      isProjectTrusted: true,
      env: {},
    });

    assert.equal(loaded.diagnostics.projectConfigStatus, "loaded");
    assert.equal(loaded.diagnostics.envFileStatus, "loaded");
    assert.equal(loaded.config.tenant, "in-root-env");
    assert.equal(loaded.config.otlp.endpoint, "https://project.example.test:4318");
  } finally {
    await removeTempConfigProject(cwd);
  }
});

test("session loader rejects config and env files swapped to outside symlinks before open", async () => {
  const cwd = await createTempConfigProject();
  const outsideDirectory = await createTempConfigProject();
  const configPath = join(cwd, CONFIG_DIR_NAME, "observme.yaml");
  const envPath = join(cwd, ".env");
  const warnings = [];

  try {
    await mkdir(join(cwd, CONFIG_DIR_NAME));
    await writeFile(configPath, projectConfigYaml, "utf8");
    await writeFile(envPath, "OBSERVME_TENANT=in-root-env\n", "utf8");
    await writeFile(join(outsideDirectory, "observme.yaml"), "observme:\n  tenant: private-outside-config\n", "utf8");
    await writeFile(join(outsideDirectory, ".env"), "OBSERVME_TENANT=private-outside-env\n", "utf8");

    const loaded = await loadSessionConfigWithDiagnostics({
      cwd,
      globalConfigPath: join(cwd, "missing-global.yaml"),
      isProjectTrusted: true,
      env: {},
      logger: { warn: message => warnings.push(message) },
      projectFileOperationHooks: {
        projectConfig: {
          beforeOpen: async () => {
            await rename(configPath, `${configPath}.stable`);
            await symlink(join(outsideDirectory, "observme.yaml"), configPath, "file");
          },
        },
        environmentFile: {
          beforeOpen: async () => {
            await rename(envPath, `${envPath}.stable`);
            await symlink(join(outsideDirectory, ".env"), envPath, "file");
          },
        },
      },
    });

    assert.deepEqual(loaded.config, defaultObservMeConfig);
    assert.equal(loaded.diagnostics.projectConfigStatus, "rejected");
    assert.equal(loaded.diagnostics.envFileStatus, "rejected");
    assert.doesNotMatch(
      JSON.stringify({ diagnostics: loaded.diagnostics, warnings }),
      /private-outside|observme-config-loader|\.stable/u,
    );
  } finally {
    await Promise.all([removeTempConfigProject(cwd), removeTempConfigProject(outsideDirectory)]);
  }
});

test("session loader rejects a config ancestor swapped outside the project before open", async () => {
  const cwd = await createTempConfigProject();
  const outsideDirectory = await createTempConfigProject();
  const configDirectory = join(cwd, CONFIG_DIR_NAME);
  const stableConfigDirectory = join(cwd, "stable-config");
  const outsideConfigPath = join(outsideDirectory, "observme.yaml");

  try {
    await mkdir(configDirectory);
    await writeFile(join(configDirectory, "observme.yaml"), projectConfigYaml, "utf8");
    await writeFile(outsideConfigPath, "observme:\n  tenant: private-outside-ancestor\n", "utf8");

    const loaded = await loadSessionConfigWithDiagnostics({
      cwd,
      globalConfigPath: join(cwd, "missing-global.yaml"),
      isProjectTrusted: true,
      loadEnvFile: false,
      env: {},
      projectFileOperationHooks: {
        projectConfig: {
          beforeOpen: async () => {
            await rename(configDirectory, stableConfigDirectory);
            await symlink(outsideDirectory, configDirectory, "dir");
          },
        },
      },
    });

    assert.deepEqual(loaded.config, defaultObservMeConfig);
    assert.equal(loaded.diagnostics.projectConfigStatus, "rejected");
    assert.equal(loaded.diagnostics.envFileStatus, "skipped_disabled");
    assert.equal(await readFile(outsideConfigPath, "utf8"), "observme:\n  tenant: private-outside-ancestor\n");
  } finally {
    await Promise.all([removeTempConfigProject(cwd), removeTempConfigProject(outsideDirectory)]);
  }
});

test("session loader treats normal missing canonical project paths as missing", async () => {
  const cwd = await createTempConfigProject();

  try {
    const loaded = await loadSessionConfigWithDiagnostics({
      cwd,
      globalConfigPath: join(cwd, "missing-global.yaml"),
      isProjectTrusted: true,
      env: {},
    });

    assert.deepEqual(loaded.config, defaultObservMeConfig);
    assert.equal(loaded.diagnostics.projectConfigStatus, "missing");
    assert.equal(loaded.diagnostics.envFileStatus, "missing");
  } finally {
    await removeTempConfigProject(cwd);
  }
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
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /config_source_rejected/u);
  assert.match(warnings[0], /2 issue\(s\)/u);
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
  assert.match(warnings[0], /config_source_rejected/u);
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
      OBSERVME_ACTIVE_AGENT_LEASE_DURATION_MS: "50000",
    },
    runtimeOptions: {
      otlp: {
        timeoutMs: 9000,
      },
      metrics: {
        activeAgentLeaseDurationMillis: 55000,
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
  assert.equal(config.metrics.activeAgentLeaseDurationMillis, 55000, "runtime options override the lease env value");
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
  assert.equal(config.metrics.activeAgentLeaseDurationMillis, 45000);
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
      OBSERVME_ALLOW_INSECURE_TRANSPORT: "true",
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
  assert.equal(config.privacy.allowInsecureTransport, true);
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
OBSERVME_ALLOW_INSECURE_TRANSPORT=true
OBSERVME_ACTIVE_AGENT_LEASE_DURATION_MS=50000
`;

const validProcessLineageEnvironment = {
  OBSERVME_WORKFLOW_ID: "workflow-process",
  OBSERVME_AGENT_ID: "agent-process",
  OBSERVME_PARENT_AGENT_ID: "agent-parent-process",
  OBSERVME_ROOT_AGENT_ID: "agent-root-process",
  OBSERVME_PARENT_SESSION_ID: "session-parent-process",
  OBSERVME_PARENT_TRACE_ID: "0123456789abcdef0123456789abcdef",
  OBSERVME_PARENT_SPAN_ID: "0123456789abcdef",
  OBSERVME_AGENT_DEPTH: "2",
  OBSERVME_SPAWN_ID: "spawn-process",
  OBSERVME_AGENT_CAPABILITY: "review",
};

const malformedProcessLineageEnvironment = {
  ...validProcessLineageEnvironment,
  OBSERVME_WORKFLOW_ID: "private-workflow/unsafe",
  OBSERVME_PARENT_TRACE_ID: "not-a-private-trace",
  OBSERVME_AGENT_DEPTH: "999",
};

test("session loader excludes trusted project .env lineage values from validation", async () => {
  const loaded = await loadSessionConfigWithDiagnostics({
    globalConfigPath: "missing-global.yaml",
    projectConfigPath: "missing-project.yaml",
    envFilePath: "project.env",
    isProjectTrusted: true,
    readText: createReader({
      "project.env": [
        ...Object.entries(malformedProcessLineageEnvironment).map(([name, value]) => `${name}=${value}`),
        "OBSERVME_TENANT=project-tenant",
        "OBSERVME_HASH_SALT=trusted-project-salt",
      ].join("\n"),
    }),
    env: { OBSERVME_TENANT: "process-tenant" },
    runtimeOptions: { capture: { prompts: true } },
  });
  const capture = applyContentCapturePolicy({
    captureEnabled: loaded.config.capture.prompts,
    value: "password=project-secret",
    kind: "prompt",
    config: loaded.config,
  });

  assert.equal(loaded.diagnostics.rejection, undefined);
  assert.equal(loaded.config.tenant, "process-tenant", "process config overrides retain precedence");
  assert.equal(loaded.config.resource.attributes["observme.tenant.id"], "process-tenant");
  assert.equal(capture.mode, "redacted", "the trusted project salt remains available to capture");
  assert.equal(capture.captured, true);
});

test("session loader validates lineage values only from the Pi process environment", async () => {
  const valid = await loadSessionConfigWithDiagnostics({
    globalConfigPath: "missing-global.yaml",
    isProjectTrusted: false,
    readText: createReader({}),
    env: validProcessLineageEnvironment,
  });
  const warnings = [];
  const malformed = await loadSessionConfigWithDiagnostics({
    globalConfigPath: "missing-global.yaml",
    isProjectTrusted: false,
    readText: createReader({}),
    env: malformedProcessLineageEnvironment,
    logger: { warn: message => warnings.push(message) },
  });

  assert.equal(valid.diagnostics.rejection, undefined);
  assert.deepEqual(malformed.config, defaultObservMeConfig, "malformed process provenance fails open to defaults");
  assert.deepEqual(malformed.diagnostics.rejection, {
    issueCodes: ["malformed_lineage_value"],
    issueCount: 3,
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /malformed_lineage_value/u);
  for (const value of Object.values(malformedProcessLineageEnvironment)) {
    assert.equal(warnings[0].includes(value), false);
  }
});

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
      OBSERVME_ACTIVE_AGENT_LEASE_DURATION_MS: "55000",
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
  assert.equal(config.privacy.allowInsecureTransport, true);
  assert.equal(config.metrics.activeAgentLeaseDurationMillis, 55000);
});

test("session loader maps active-agent lease duration from a trusted project .env", async () => {
  const config = await loadSessionConfig({
    globalConfigPath: "missing-global.yaml",
    projectConfigPath: "missing-project.yaml",
    envFilePath: "project.env",
    isProjectTrusted: true,
    readText: createReader({
      "project.env": "OBSERVME_ACTIVE_AGENT_LEASE_DURATION_MS=50000\n",
    }),
    env: {},
  });

  assert.equal(config.metrics.activeAgentLeaseDurationMillis, 50000);
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

test("session loader retains only the selected custom salt with process-over-project precedence", async () => {
  const config = await loadSessionConfig({
    globalConfigPath: "missing-global.yaml",
    projectConfigPath: "project.yaml",
    envFilePath: "project.env",
    isProjectTrusted: true,
    readText: createReader({
      "project.yaml": "observme:\n  privacy:\n    tenantSaltEnv: CUSTOM_OBSERVME_SALT\n",
      "project.env": [
        "OBSERVME_CAPTURE_PROMPTS=true",
        "OBSERVME_TENANT=project-tenant",
        "CUSTOM_OBSERVME_SALT=project-custom-salt",
        "DATABASE_URL=postgres://project-secret",
      ].join("\n"),
    }),
    env: {
      OBSERVME_TENANT: "process-tenant",
      CUSTOM_OBSERVME_SALT: "process-custom-salt",
      AWS_SECRET_ACCESS_KEY: "unrelated-process-secret",
    },
  });
  const retainedSource = createEnvTenantSaltSource(config);
  const expectedHash = createHash("sha256").update("process-custom-salt\0private-input").digest("hex");

  assert.equal(config.capture.prompts, true, "supported project overrides still apply");
  assert.equal(config.tenant, "process-tenant", "process overrides retain precedence over project .env");
  assert.deepEqual(retainedSource, {
    env: { CUSTOM_OBSERVME_SALT: "process-custom-salt" },
    envName: "CUSTOM_OBSERVME_SALT",
  });
  assert.equal(trySha256("private-input", config), expectedHash, "hashing uses the higher-precedence custom salt");
  assert.doesNotMatch(
    JSON.stringify(retainedSource),
    /DATABASE_URL|project-secret|AWS_SECRET_ACCESS_KEY|unrelated-process-secret/u,
  );
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
  assert.equal(config.metrics.activeAgentLeaseDurationMillis, 40000);
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
  assert.equal(parsed.metrics.activeAgentLeaseDurationMillis, 60000);
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
