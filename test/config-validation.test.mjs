import assert from "node:assert/strict";
import test from "node:test";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { loadSessionConfig } from "../src/config/load-config.ts";
import { QUERY_RESULT_COUNT_MAXIMUM } from "../src/config/query-limits.ts";
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

test("validation enforces explicit query result-count upper bounds", () => {
  const queryLimitNames = ["maxLogs", "maxTraces", "maxMetricSeries", "maxAgents"];
  const maximums = Object.fromEntries(queryLimitNames.map(name => [name, QUERY_RESULT_COUNT_MAXIMUM]));

  assertValid(cloneDefault({ query: maximums }));
  for (const name of queryLimitNames) {
    assertInvalid(
      cloneDefault({ query: { [name]: QUERY_RESULT_COUNT_MAXIMUM + 1 } }),
      "invalid_config_shape",
    );
  }
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

test("removed automatic replay configuration fails structural validation", () => {
  assertInvalid(cloneDefault({ replayOnStart: true }), "invalid_config_shape", { env: {} });
});

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

test("validation rejects credentials embedded in Grafana URLs without exposing configuration values", () => {
  const credentialCases = [
    {
      url: "https://private-url-user-value@private-url-host-value.example.test/private-url-path-value?tenant=private-url-query-value",
      sensitiveValues: [
        "private-url-user-value",
        "private-url-host-value",
        "private-url-path-value",
        "private-url-query-value",
      ],
    },
    {
      url: "https://:private-url-password-value@private-password-host-value.example.test/private-password-path-value?tenant=private-password-query-value",
      sensitiveValues: [
        "private-url-password-value",
        "private-password-host-value",
        "private-password-path-value",
        "private-password-query-value",
      ],
    },
  ];
  const configuredAuthValues = [
    "private-bearer-token-value",
    "private-basic-user-value",
    "private-basic-password-value",
  ];

  for (const credentialCase of credentialCases) {
    const result = validateObservMeConfig(cloneDefault({
      query: {
        grafana: {
          url: credentialCase.url,
          token: configuredAuthValues[0],
          username: configuredAuthValues[1],
          password: configuredAuthValues[2],
        },
      },
    }));
    const issue = result.issues.find(candidate => candidate.code === "embedded_grafana_url_credentials");
    const diagnostic = JSON.stringify(result);

    assert.equal(result.valid, false);
    assert.deepEqual(issue, {
      code: "embedded_grafana_url_credentials",
      message:
        "query.grafana.url is invalid (embedded_credentials). Configure authentication through query.grafana.token or query.grafana.username/password.",
    });
    for (const sensitiveValue of [...credentialCase.sensitiveValues, ...configuredAuthValues]) {
      assert.equal(diagnostic.includes(sensitiveValue), false);
    }
  }

  assertValid(cloneDefault({ query: { grafana: { url: "https://grafana.example.test", token: "bearer-token" } } }));
  assertValid(cloneDefault({
    query: {
      grafana: {
        url: "https://grafana.example.test",
        token: "",
        username: "basic-user",
        password: "basic-password",
      },
    },
  }));
});

test("validation requires production acknowledgement for every certificate-verification bypass", () => {
  const otlpBypass = cloneDefault({
    otlp: { tls: { insecureSkipVerify: true } },
    privacy: { allowInsecureTransport: false },
  });
  const grafanaBypass = cloneDefault({
    query: { grafana: { tls: { insecureSkipVerify: true } } },
    privacy: { allowInsecureTransport: false },
  });

  const otlpResult = validateObservMeConfig(otlpBypass);
  const grafanaResult = validateObservMeConfig(grafanaBypass);

  assert.equal(otlpResult.valid, false);
  assert.deepEqual(otlpResult.issues, [
    {
      code: "insecure_production_transport",
      message: "otlp.tls.insecureSkipVerify must be false in production unless privacy.allowInsecureTransport is true.",
    },
  ]);
  assert.equal(grafanaResult.valid, false);
  assert.deepEqual(grafanaResult.issues, [
    {
      code: "insecure_production_transport",
      message: "query.grafana.tls.insecureSkipVerify must be false in production unless privacy.allowInsecureTransport is true.",
    },
  ]);
  assert.doesNotMatch(JSON.stringify([otlpResult, grafanaResult]), /token|password|Authorization/u);

  assertValid(cloneDefault({
    otlp: { tls: { insecureSkipVerify: true } },
    query: { grafana: { tls: { insecureSkipVerify: true } } },
    privacy: { allowInsecureTransport: true },
  }));
  assertValid(cloneDefault({
    environment: "development",
    otlp: { tls: { insecureSkipVerify: true } },
    query: { grafana: { tls: { insecureSkipVerify: true } } },
    privacy: { allowInsecureTransport: false },
  }));
});

test("validation rejects the removed no-op otlp.tls.enabled setting", () => {
  const config = cloneDefault();
  config.otlp.tls.enabled = true;

  assertInvalid(config, "invalid_config_shape");
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

test("validation accepts absolute OTLP base URLs with supported URL semantics", () => {
  const endpoints = [
    "https://collector.example.test",
    "https://collector.example.test/tenant/otlp///",
    "http://127.0.0.1:4318/base",
    "http://[2001:db8::1]:4318/base",
    "https://collector.example.test/tenant%20one/%2Froot",
  ];

  for (const endpoint of endpoints) {
    assertValid(cloneDefault({ environment: "development", otlp: { endpoint } }));
  }
});

test("validation rejects unsafe OTLP base URLs with bounded secret-free failure classes", () => {
  const endpointCases = [
    {
      endpoint: "relative/private-malformed-path",
      failureClass: "malformed_url",
      sensitiveFragment: "private-malformed-path",
    },
    {
      endpoint: "ftp://private-unsupported.example.test/base",
      failureClass: "unsupported_protocol",
      sensitiveFragment: "private-unsupported",
    },
    {
      endpoint: "https://private-user:private-password@collector.example.test/base",
      failureClass: "embedded_credentials",
      sensitiveFragment: "private-password",
    },
    {
      endpoint: "https://collector.example.test/base?token=private-query",
      failureClass: "query_not_supported",
      sensitiveFragment: "private-query",
    },
    {
      endpoint: "https://collector.example.test/base#private-fragment",
      failureClass: "fragment_not_supported",
      sensitiveFragment: "private-fragment",
    },
    {
      endpoint: "https://collector.example.test/${PRIVATE_ENDPOINT}",
      failureClass: "unresolved_placeholder",
      sensitiveFragment: "PRIVATE_ENDPOINT",
    },
  ];

  for (const endpointCase of endpointCases) {
    const result = validateObservMeConfig(
      cloneDefault({ environment: "development", otlp: { endpoint: endpointCase.endpoint } }),
    );
    const endpointIssue = result.issues.find(issue => issue.code === "invalid_otlp_endpoint");

    assert.equal(result.valid, false);
    assert.deepEqual(endpointIssue, {
      code: "invalid_otlp_endpoint",
      message: `otlp.endpoint is invalid (${endpointCase.failureClass}).`,
    });
    assert.equal(JSON.stringify(result).includes(endpointCase.sensitiveFragment), false);
  }
});

for (const signal of ["traces", "metrics", "logs"]) {
  test(`validation accepts an absolute explicit ${signal} OTLP endpoint`, () => {
    assertValid(
      cloneDefault({
        otlp: {
          signalEndpoints: {
            [signal]: `https://[2001:db8::1]:4318/tenant%20one/v1/${signal}`,
          },
        },
      }),
    );
  });

  test(`validation rejects query-bearing explicit ${signal} OTLP endpoints without exposing values`, () => {
    const result = validateObservMeConfig(
      cloneDefault({
        otlp: {
          signalEndpoints: {
            [signal]: `https://collector.example.test/v1/${signal}?token=private-${signal}-query`,
          },
        },
      }),
    );

    assert.ok(result.issues.some(issue =>
      issue.code === "invalid_otlp_endpoint"
      && issue.message === `otlp.signalEndpoints.${signal} is invalid (query_not_supported).`
    ));
    assert.equal(JSON.stringify(result).includes(`private-${signal}-query`), false);
  });
}

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
  assertValid(cloneDefault({
    privacy: {
      customRedactionPatterns: [
        { name: "safe", pattern: "(?i)customercredential\\([a-z0-9-]+\\)" },
        { name: "safe-alternation", pattern: "(?:customer|tenant)label\\([a-z0-9-]+\\)" },
        { name: "safe-quantified-alternation", pattern: "(?i)(?:foo|bar)+" },
        { name: "safe-disjoint-repetition", pattern: "[a-z]+[0-9]+" },
      ],
    },
  }));
  assertInvalid(
    cloneDefault({ privacy: { customRedactionPatterns: [{ name: "nested", pattern: "(a+)+b" }] } }),
    "custom_redaction_pattern_nested_quantifier",
  );
  assertInvalid(
    cloneDefault({ privacy: { customRedactionPatterns: [{ name: "wrapped-nested", pattern: "((a+))+b" }] } }),
    "custom_redaction_pattern_nested_quantifier",
  );
  for (const pattern of ["^(?:a|aa)+$", "(?i)^(?:(?:aa|a)){2,}$"]) {
    assertInvalid(
      cloneDefault({ privacy: { customRedactionPatterns: [{ name: "ambiguous", pattern }] } }),
      "custom_redaction_pattern_ambiguous_alternation",
    );
  }
  for (const pattern of ["^a+a+$", "^(?:ab)+(?:ab)+$", "^a+b*a+$"]) {
    assertInvalid(
      cloneDefault({ privacy: { customRedactionPatterns: [{ name: "overlapping", pattern }] } }),
      "custom_redaction_pattern_ambiguous_repetition",
    );
  }
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
