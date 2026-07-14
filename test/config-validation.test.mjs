import assert from "node:assert/strict";
import test from "node:test";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { loadSessionConfig } from "../src/config/load-config.ts";
import {
  ACTIVE_AGENT_LEASE_DURATION_MILLIS_MAXIMUM,
  ACTIVE_AGENT_LEASE_DURATION_MILLIS_MINIMUM,
  ACTIVE_AGENT_LEASE_EXPORT_SAFETY_MARGIN_MILLIS,
} from "../src/config/schema.ts";
import {
  emitUnsafeCaptureWarning,
  ensureValidObservMeConfig,
  normalizeConfigRejectionDiagnostic,
  validateObservMeConfig,
} from "../src/config/validate.ts";

function cloneDefault(overrides = {}) {
  return merge(structuredClone(defaultObservMeConfig), overrides);
}

function merge(base, overlay) {
  for (const [key, value] of Object.entries(overlay)) {
    if (isPlainObject(base[key]) && isPlainObject(value)) {
      merge(base[key], value);
      continue;
    }
    base[key] = value;
  }
  return base;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const documentedEnvironmentValues = ["production", "development", "test"];
const documentedPathModeValues = ["hash", "basename", "full", "drop"];

function assertValid(config, options) {
  assert.deepEqual(validateObservMeConfig(config, options), { valid: true, issues: [] });
}

function assertInvalid(config, code, options) {
  const result = validateObservMeConfig(config, options);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(issue => issue.code === code), `expected ${code} issue in ${JSON.stringify(result.issues)}`);
}

test("validation accepts safe defaults", () => {
  assertValid(defaultObservMeConfig, { env: {} });
});

test("validation enforces active-agent lease bounds and export relationship", () => {
  const minimumExportInterval =
    (ACTIVE_AGENT_LEASE_DURATION_MILLIS_MINIMUM - ACTIVE_AGENT_LEASE_EXPORT_SAFETY_MARGIN_MILLIS) / 2;
  const exactDefaultRelationship =
    (2 * defaultObservMeConfig.metrics.exportIntervalMillis) + ACTIVE_AGENT_LEASE_EXPORT_SAFETY_MARGIN_MILLIS;

  assertValid(
    cloneDefault({
      metrics: {
        exportIntervalMillis: minimumExportInterval,
        activeAgentLeaseDurationMillis: ACTIVE_AGENT_LEASE_DURATION_MILLIS_MINIMUM,
      },
    }),
  );
  assertValid(
    cloneDefault({ metrics: { activeAgentLeaseDurationMillis: ACTIVE_AGENT_LEASE_DURATION_MILLIS_MAXIMUM } }),
  );
  assertValid(cloneDefault({ metrics: { activeAgentLeaseDurationMillis: exactDefaultRelationship } }));

  for (const value of [
    ACTIVE_AGENT_LEASE_DURATION_MILLIS_MINIMUM - 1,
    ACTIVE_AGENT_LEASE_DURATION_MILLIS_MAXIMUM + 1,
    60000.5,
    -1,
    "not-a-number",
  ]) {
    assertInvalid(cloneDefault({ metrics: { activeAgentLeaseDurationMillis: value } }), "invalid_config_shape");
  }

  assertInvalid(
    cloneDefault({ metrics: { activeAgentLeaseDurationMillis: exactDefaultRelationship - 1 } }),
    "active_agent_lease_too_short_for_export_interval",
  );
});

for (const environment of documentedEnvironmentValues) {
  test(`validation accepts documented ${environment} environment`, () => {
    assertValid(cloneDefault({ environment }), { env: {} });
  });
}

for (const pathMode of documentedPathModeValues) {
  test(`validation accepts documented ${pathMode} privacy path mode`, () => {
    assertValid(cloneDefault({ privacy: { pathMode } }), { env: {} });
  });
}

test("unknown environment values fail structural validation and fall back safely", () => {
  const config = cloneDefault({ environment: "staging" });

  assertInvalid(config, "invalid_config_shape", { env: {} });
  assert.deepEqual(ensureValidObservMeConfig(config, { env: {} }), defaultObservMeConfig);
});

test("unknown privacy path modes fail structural validation and fall back safely", () => {
  const config = cloneDefault({ privacy: { pathMode: "relative" } });

  assertInvalid(config, "invalid_config_shape", { env: {} });
  assert.deepEqual(ensureValidObservMeConfig(config, { env: {} }), defaultObservMeConfig);
});

test("validation rejects content capture without redaction unless unsafe capture is explicit", () => {
  assertValid(cloneDefault({ capture: { prompts: true }, privacy: { allowUnsafeCapture: true, redactionEnabled: false } }));
  assertInvalid(
    cloneDefault({ capture: { prompts: true }, privacy: { allowUnsafeCapture: false, redactionEnabled: false } }),
    "unsafe_capture_without_redaction",
  );
});

test("validation rejects insecure production transport unless explicitly allowed", () => {
  assertValid(
    cloneDefault({
      otlp: { endpoint: "http://collector.example.test:4318" },
      privacy: { allowInsecureTransport: true },
    }),
  );
  assertInvalid(
    cloneDefault({ otlp: { endpoint: "http://collector.example.test:4318" }, privacy: { allowInsecureTransport: false } }),
    "insecure_production_transport",
  );
  assertValid(
    cloneDefault({
      query: {
        grafana: {
          url: "http://grafana.example.test",
          token: "grafana-token",
          username: "admin",
          password: "grafana-password",
        },
      },
      privacy: { allowInsecureTransport: true },
    }),
  );
  assertInvalid(
    cloneDefault({
      query: {
        grafana: {
          url: "http://grafana.example.test",
          token: "grafana-token",
          username: "admin",
          password: "grafana-password",
        },
      },
      privacy: { allowInsecureTransport: false },
    }),
    "insecure_production_transport",
  );
});

for (const signal of ["traces", "metrics", "logs"]) {
  test(`validation rejects insecure production ${signal} OTLP endpoint unless explicitly allowed`, () => {
    assertValid(
      cloneDefault({
        otlp: { signalEndpoints: { [signal]: `https://collector.example.test:4318/v1/${signal}` } },
        privacy: { allowInsecureTransport: false },
      }),
    );
    assertValid(
      cloneDefault({
        otlp: { signalEndpoints: { [signal]: `http://collector.example.test:4318/v1/${signal}` } },
        privacy: { allowInsecureTransport: true },
      }),
    );
    assertInvalid(
      cloneDefault({
        otlp: { signalEndpoints: { [signal]: `http://collector.example.test:4318/v1/${signal}` } },
        privacy: { allowInsecureTransport: false },
      }),
      "insecure_production_transport",
    );
  });
}

test("validation accepts explicit insecure local development transport", () => {
  assertValid(
    cloneDefault({
      environment: "development",
      otlp: {
        endpoint: "http://localhost:4318",
        signalEndpoints: {
          traces: "http://localhost:4318/v1/traces",
          metrics: "http://localhost:4318/v1/metrics",
          logs: "http://localhost:4318/v1/logs",
        },
      },
      privacy: { allowInsecureTransport: true },
      query: { grafana: { url: "http://localhost:3000" } },
    }),
  );
});

test("validation rejects signal-specific OTLP HTTP endpoints missing required paths", () => {
  assertValid(
    cloneDefault({
      otlp: {
        signalEndpoints: {
          traces: "https://collector.example.test:4318/v1/traces",
          metrics: "https://collector.example.test:4318/v1/metrics",
          logs: "https://collector.example.test:4318/v1/logs",
        },
      },
    }),
  );
  assertInvalid(
    cloneDefault({ otlp: { signalEndpoints: { traces: "https://collector.example.test:4318" } } }),
    "invalid_signal_endpoint_path",
  );
});

test("validation rejects high-cardinality metric labels", () => {
  assertValid(cloneDefault({ metrics: { labels: ["provider", "model", "status"] } }));
  assertInvalid(cloneDefault({ metrics: { labels: ["provider", "pi.workflow.id"] } }), "high_cardinality_metric_label");
});

test("validation rejects unsafe custom redaction regex patterns", () => {
  assertValid(cloneDefault({ privacy: { customRedactionPatterns: [{ name: "safe", pattern: "(?i)customercredential\\([a-z0-9-]+\\)" }] } }));
  assertInvalid(
    cloneDefault({ privacy: { customRedactionPatterns: [{ name: "nested", pattern: "(a+)+b" }] } }),
    "custom_redaction_pattern_nested_quantifier",
  );
  assertInvalid(
    cloneDefault({ privacy: { customRedactionPatterns: [{ name: "broken", pattern: "(" }] } }),
    "invalid_custom_redaction_pattern",
  );
  assertInvalid(
    cloneDefault({ privacy: { customRedactionPatterns: [{ name: "empty", pattern: "a*" }] } }),
    "custom_redaction_pattern_empty_match",
  );
});

test("validation bounds custom redaction regex pattern count and length", () => {
  const tooManyPatterns = Array.from({ length: 17 }, (_value, index) => ({ name: `safe-${index}`, pattern: `token-${index}` }));

  assertInvalid(
    cloneDefault({ privacy: { customRedactionPatterns: tooManyPatterns } }),
    "custom_redaction_pattern_limit",
  );
  assertInvalid(
    cloneDefault({ privacy: { customRedactionPatterns: [{ name: "long", pattern: "a".repeat(257) }] } }),
    "custom_redaction_pattern_too_long",
  );
});

test("validation rejects reading project config across an untrusted project boundary", () => {
  assertValid(defaultObservMeConfig, { isProjectTrusted: false, projectConfigWasRead: false });
  assertInvalid(
    defaultObservMeConfig,
    "untrusted_project_config_read",
    { isProjectTrusted: false, projectConfigWasRead: true },
  );
});

test("validation rejects malformed propagated workflow and agent lineage values", () => {
  const env = {
    OBSERVME_WORKFLOW_ID: "workflow-123",
    OBSERVME_AGENT_ID: "agent-123",
    OBSERVME_PARENT_AGENT_ID: "parent-123",
    OBSERVME_ROOT_AGENT_ID: "root-123",
    OBSERVME_PARENT_SESSION_ID: "session-123",
    OBSERVME_PARENT_TRACE_ID: "0123456789abcdef0123456789abcdef",
    OBSERVME_PARENT_SPAN_ID: "0123456789abcdef",
    OBSERVME_AGENT_DEPTH: "2",
    OBSERVME_SPAWN_ID: "spawn-123",
    OBSERVME_AGENT_CAPABILITY: "review",
  };
  assertValid(defaultObservMeConfig, { env });
  assertInvalid(defaultObservMeConfig, "malformed_lineage_value", { env: { ...env, OBSERVME_WORKFLOW_ID: "bad/value" } });
  assertInvalid(defaultObservMeConfig, "malformed_lineage_value", { env: { ...env, OBSERVME_PARENT_TRACE_ID: "not-a-trace" } });
  assertInvalid(defaultObservMeConfig, "malformed_lineage_value", { env: { ...env, OBSERVME_PARENT_TRACE_ID: "0".repeat(32) } });
  assertInvalid(defaultObservMeConfig, "malformed_lineage_value", { env: { ...env, OBSERVME_PARENT_SPAN_ID: "0".repeat(16) } });
  assertInvalid(defaultObservMeConfig, "malformed_lineage_value", { env: { ...env, OBSERVME_AGENT_DEPTH: "999" } });
  assertInvalid(defaultObservMeConfig, "malformed_lineage_value", { env: { ...env, OBSERVME_AGENT_CAPABILITY: "x".repeat(129) } });
});

test("validation rejects malformed, duplicate, and W3C-reserved lineage environment names", () => {
  assertInvalid(cloneDefault({ workflow: { idEnv: "NOT SAFE" } }), "malformed_lineage_value", { env: {} });
  assertInvalid(
    cloneDefault({ agent: { parentIdEnv: defaultObservMeConfig.agent.rootIdEnv } }),
    "malformed_lineage_value",
    { env: {} },
  );
  assertInvalid(cloneDefault({ workflow: { idEnv: "traceparent" } }), "malformed_lineage_value", { env: {} });
});

test("validation rejects queue sizes that exceed memory guardrails", () => {
  assertValid(cloneDefault({ traces: { batch: { maxQueueSize: 10_000, maxExportBatchSize: 512 } } }));
  assertInvalid(cloneDefault({ traces: { batch: { maxQueueSize: 10_001 } } }), "queue_size_exceeds_guardrail");
  assertInvalid(
    cloneDefault({ logs: { batch: { maxQueueSize: 100, maxExportBatchSize: 101 } } }),
    "queue_size_exceeds_guardrail",
  );
});

test("unsafe capture warning describes redaction state only when unsafe capture is active", async () => {
  const notifications = [];
  const ctx = {
    ui: {
      notify: (message, level) => notifications.push({ message, level }),
    },
  };

  assert.equal(await emitUnsafeCaptureWarning(defaultObservMeConfig, ctx), false);
  assert.deepEqual(notifications, []);
  assert.equal(
    await emitUnsafeCaptureWarning(cloneDefault({ capture: { prompts: true }, privacy: { allowUnsafeCapture: true } }), ctx),
    true,
  );
  assert.equal(
    await emitUnsafeCaptureWarning(
      cloneDefault({ capture: { responses: true }, privacy: { allowUnsafeCapture: true, redactionEnabled: false } }),
      ctx,
    ),
    true,
  );

  assert.deepEqual(notifications.map(notification => notification.level), ["warning", "warning"]);
  assert.match(notifications[0].message, /after configured redaction/u);
  assert.doesNotMatch(notifications[0].message, /unredacted sensitive/u);
  assert.match(notifications[1].message, /redaction disabled/u);
  assert.match(notifications[1].message, /Unredacted sensitive prompt, response, tool, bash, or path content may be exported\./u);
  assert.doesNotMatch(JSON.stringify(notifications), /secret-token|password|api_key/u);
});

test("invalid loaded config falls back to safe defaults and logs rejection reasons", async () => {
  const warnings = [];
  const config = await loadSessionConfig({
    env: {},
    isProjectTrusted: false,
    readText: async () => undefined,
    runtimeOptions: {
      capture: { prompts: true },
      privacy: { redactionEnabled: false, allowUnsafeCapture: false },
    },
    logger: {
      warn: message => warnings.push(message),
    },
  });

  assert.deepEqual(config, defaultObservMeConfig);
  assert.ok(warnings.some(message => message.includes("unsafe_capture_without_redaction")));
});

test("ensureValidObservMeConfig never throws for invalid configuration", () => {
  const warnings = [];
  const config = ensureValidObservMeConfig(
    cloneDefault({ metrics: { labels: ["trace_id.private-label-secret"] } }),
    { logger: { warn: message => warnings.push(message) } },
  );

  assert.deepEqual(config, defaultObservMeConfig);
  assert.ok(warnings.some(message => message.includes("high_cardinality_metric_label")));
  assert.doesNotMatch(warnings.join("\n"), /private-label-secret/u);

  assert.doesNotThrow(() =>
    ensureValidObservMeConfig(cloneDefault({ metrics: { labels: ["pi.session.id"] } }), {
      logger: { warn: () => { throw new Error("diagnostic sink failed"); } },
    }),
  );
});

test("config rejection diagnostics bound and normalize untrusted issue metadata", () => {
  const diagnostic = normalizeConfigRejectionDiagnostic({
    issueCodes: Array.from({ length: 1_000 }, (_value, index) => `private-secret-code-${index}`),
    issueCount: Number.POSITIVE_INFINITY,
  });

  assert.deepEqual(diagnostic, {
    issueCodes: ["unknown_config_validation_issue"],
    issueCount: 1,
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /private-secret/u);
});

test("ensureValidObservMeConfig falls back to defaults for rejected custom redaction regex", () => {
  const warnings = [];
  const config = ensureValidObservMeConfig(
    cloneDefault({ privacy: { customRedactionPatterns: [{ name: "nested", pattern: "(a+)+b" }] } }),
    { logger: { warn: message => warnings.push(message) } },
  );

  assert.deepEqual(config, defaultObservMeConfig);
  assert.ok(warnings.some(message => message.includes("custom_redaction_pattern_nested_quantifier")));
});
