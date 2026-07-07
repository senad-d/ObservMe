import assert from "node:assert/strict";
import test from "node:test";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { loadSessionConfig } from "../src/config/load-config.ts";
import {
  emitUnsafeCaptureWarning,
  ensureValidObservMeConfig,
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

test("validation rejects content capture without redaction unless unsafe capture is explicit", () => {
  assertValid(cloneDefault({ capture: { prompts: true }, privacy: { allowUnsafeCapture: true, redactionEnabled: false } }));
  assertInvalid(
    cloneDefault({ capture: { prompts: true }, privacy: { allowUnsafeCapture: false, redactionEnabled: false } }),
    "unsafe_capture_without_redaction",
  );
});

test("validation rejects insecure production transport unless explicitly allowed", () => {
  assertValid(cloneDefault({ otlp: { endpoint: "http://collector.example.test:4318" }, privacy: { allowInsecureTransport: true } }));
  assertInvalid(
    cloneDefault({ otlp: { endpoint: "http://collector.example.test:4318" }, privacy: { allowInsecureTransport: false } }),
    "insecure_production_transport",
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
  };
  assertValid(defaultObservMeConfig, { env });
  assertInvalid(defaultObservMeConfig, "malformed_lineage_value", { env: { ...env, OBSERVME_WORKFLOW_ID: "bad/value" } });
  assertInvalid(defaultObservMeConfig, "malformed_lineage_value", { env: { ...env, OBSERVME_PARENT_TRACE_ID: "not-a-trace" } });
  assertInvalid(defaultObservMeConfig, "malformed_lineage_value", { env: { ...env, OBSERVME_AGENT_DEPTH: "999" } });
});

test("validation rejects queue sizes that exceed memory guardrails", () => {
  assertValid(cloneDefault({ traces: { batch: { maxQueueSize: 10_000, maxExportBatchSize: 512 } } }));
  assertInvalid(cloneDefault({ traces: { batch: { maxQueueSize: 10_001 } } }), "queue_size_exceeds_guardrail");
  assertInvalid(
    cloneDefault({ logs: { batch: { maxQueueSize: 100, maxExportBatchSize: 101 } } }),
    "queue_size_exceeds_guardrail",
  );
});

test("unsafe capture warning is visible only when explicit unsafe capture and capture flags are active", async () => {
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
  assert.equal(notifications[0].level, "warning");
  assert.match(notifications[0].message, /unsafe capture/i);
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
    cloneDefault({ metrics: { labels: ["trace_id"] } }),
    { logger: { warn: message => warnings.push(message) } },
  );

  assert.deepEqual(config, defaultObservMeConfig);
  assert.ok(warnings.some(message => message.includes("high_cardinality_metric_label")));
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
