import assert from "node:assert/strict";
import test from "node:test";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import {
  BASH_ATTRIBUTES,
  BRANCH_ATTRIBUTES,
  COMMON_SPAN_ATTRIBUTES,
  COMPACTION_ATTRIBUTES,
  LLM_ATTRIBUTES,
  LOG_ATTRIBUTES,
  TOOL_ATTRIBUTES,
} from "../src/semconv/attributes.ts";
import { LOG_EVENT_NAMES } from "../src/semconv/metrics.ts";
import {
  bashErrorClass,
  bashExecutionFailed,
  buildBashExecutionAttributes,
  buildBranchAttributes,
  buildBranchPreparationState,
  buildCompactionAttributes,
  buildLlmFinalAttributes,
  buildLlmRequestAttributes,
  buildToolCallInputAttributes,
  buildToolFinalAttributes,
  buildToolResultAttributes,
  extractAssistantText,
  extractPayloadPromptText,
  hashValue,
  hasBashCompletionResult,
  isAssistantMessage,
  llmMetricLabels,
  metricLabels,
  readMessage,
  recordOptionalBashContent,
  recordOptionalLlmContent,
  recordOptionalPromptContent,
  recordOptionalToolArguments,
  recordOptionalToolResult,
  safeJsonLength,
  serializeToolPayload,
  toolMetricLabels,
} from "../src/pi/handler-internals.ts";
import type { ObservMeTelemetrySession } from "../src/pi/handlers.ts";
import { mergeRecordConfig } from "./support/telemetry-types.ts";
import type { TestLogRecord } from "./support/telemetry-types.ts";

const hexadecimalHash = /^[a-f0-9]{64}$/u;
const lowCardinalityLabelKeys = ["environment", "agent_role"];
process.env.OBSERVME_HASH_SALT = "handler-internals-test-salt";
const sessionAttributes = {
  "pi.session.id": "session-123",
  "pi.model.provider.current": "anthropic",
  "pi.model.id.current": "claude-3",
  "pi.thinking.level.current": "medium",
};

function cloneConfig(overrides: Record<string, unknown> = {}) {
  return mergeConfig(structuredClone(defaultObservMeConfig), overrides);
}

function mergeConfig<T extends Record<string, unknown>>(base: T, overlay: Record<string, unknown> = {}): T {
  return mergeRecordConfig(base, overlay);
}

function createSession(overrides: Record<string, unknown> = {}): ObservMeTelemetrySession {
  const { config, ...sessionOverrides } = overrides;

  return {
    config: cloneConfig(config as Record<string, unknown> | undefined),
    lineage: {
      workflowId: "workflow-1",
      workflowRootAgentId: "agent-root",
      agentId: "agent-1",
      parentAgentId: "agent-parent",
      rootAgentId: "agent-root",
      role: "worker",
      depth: 1,
    },
    logger: createFakeLogger(),
    metrics: createFakeMetrics(),
    sessionAttributes,
    currentAgentRunId: "run-1",
    currentTurnId: "turn-1",
    activeAgentRecorded: false,
    agentRunSequence: 1,
    llmRequestSequence: 0,
    toolCallSequence: 0,
    turnSequences: new Map(),
    ...sessionOverrides,
  } as unknown as ObservMeTelemetrySession;
}

function createFakeLogger() {
  const records: TestLogRecord[] = [];
  return {
    records,
    emit: (record: TestLogRecord) => records.push(record),
  };
}

function createFakeMetrics() {
  return {
    redactionFailures: createFakeCounter(),
  };
}

function createFakeCounter() {
  const records: Array<Record<string, unknown>> = [];
  return {
    records,
    add: (value: number, attributes: Record<string, unknown> = {}) => records.push({ value, attributes }),
  };
}

function createFakeSpan() {
  return {
    attributes: {} as Record<string, unknown>,
    setAttribute(key: string, value: unknown) {
      this.attributes[key] = value;
      return this;
    },
    setAttributes(values: Record<string, unknown>) {
      Object.assign(this.attributes, values);
      return this;
    },
    spanContext() {
      return { traceId: "11111111111111111111111111111111", spanId: "2222222222222222" };
    },
  };
}

function assertNoRawPrivateContent(attributes: Record<string, unknown>): void {
  const rendered = JSON.stringify(attributes);
  assert.equal(rendered.includes("private summary"), false);
  assert.equal(rendered.includes("internal_token"), false);
  assert.equal(rendered.includes("/Users/alice"), false);
}

test("LLM parser and attribute helpers isolate message, prompt, usage, and cost behavior", () => {
  const session = createSession();
  const message = {
    role: "assistant",
    provider: "anthropic",
    model: "claude-3",
    responseModel: "claude-3-opus",
    responseId: "response-1",
    stopReason: "toolUse",
    content: [
      { type: "text", text: "First answer" },
      [{ text: "nested answer" }],
      { type: "thinking", thinking: "private reasoning" },
    ],
    usage: {
      input: "11",
      output: 7,
      cacheRead: 3,
      cacheWrite: 2,
      cacheWrite1h: 1,
      reasoning: 5,
      totalTokens: 29,
      cost: { input: 0.1, output: "0.2", cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
    },
  };

  assert.equal(readMessage({ message }), message);
  assert.equal(isAssistantMessage(message), true);
  assert.equal(extractAssistantText(message), "First answer\nnested answer");

  const finalAttributes = buildLlmFinalAttributes(message, session);
  assert.deepEqual(finalAttributes[LLM_ATTRIBUTES.GEN_AI_RESPONSE_FINISH_REASONS], ["tool_calls"]);
  assert.equal(finalAttributes[LLM_ATTRIBUTES.GEN_AI_USAGE_INPUT_TOKENS], 11);
  assert.equal(finalAttributes[LLM_ATTRIBUTES.GEN_AI_USAGE_OUTPUT_TOKENS], 7);
  assert.equal(finalAttributes[LLM_ATTRIBUTES.PI_LLM_COST_TOTAL_USD], 0.33);
  assert.equal(finalAttributes[LLM_ATTRIBUTES.ERROR_TYPE], undefined);

  const requestAttributes = buildLlmRequestAttributes(
    {
      payload: {
        messages: [{ content: "hello" }],
        contents: [{ content: [{ text: "world" }] }],
        tools: [{ name: "bash" }],
        toolSchemas: [{ name: "read" }],
        temperature: "0.4",
        maxTokens: 2048,
      },
    },
    {},
    session,
    "llm-1",
  );

  assert.equal(requestAttributes[LLM_ATTRIBUTES.GEN_AI_PROVIDER_NAME], "anthropic");
  assert.equal(requestAttributes[LLM_ATTRIBUTES.GEN_AI_REQUEST_MODEL], "claude-3");
  assert.equal(requestAttributes[LLM_ATTRIBUTES.PI_LLM_REQUEST_MESSAGE_COUNT], 2);
  assert.equal(requestAttributes[LLM_ATTRIBUTES.PI_LLM_REQUEST_TOOL_SCHEMA_COUNT], 2);

  const responsesRequestAttributes = buildLlmRequestAttributes(
    { payload: { input: [{ role: "user", content: [{ type: "input_text", text: "responses api prompt" }] }] } },
    {},
    session,
    "llm-2",
  );

  assert.equal(responsesRequestAttributes[LLM_ATTRIBUTES.PI_LLM_REQUEST_MESSAGE_COUNT], 1);
  assert.equal(extractPayloadPromptText({ messages: [{ content: ["hello", { text: "world" }] }] }), "hello\nworld");
  assert.equal(
    extractPayloadPromptText({ input: [{ role: "user", content: [{ type: "input_text", text: "responses api prompt" }] }] }),
    "responses api prompt",
  );
  assert.equal(extractPayloadPromptText({ input: "plain completion prompt" }), "plain completion prompt");
  assert.equal(safeJsonLength(undefined), undefined);

  const circularPayload: Record<string, unknown> = { prompt: "loop" };
  circularPayload.self = circularPayload;
  assert.equal(safeJsonLength(circularPayload), undefined);
});

test("tool attribute builders normalize identity, result payloads, failures, and labels", () => {
  const session = createSession();
  const callAttributes = buildToolCallInputAttributes(
    {
      toolCall: { name: "Read.File", input: { path: "/Users/alice/private.txt" } },
    },
    session.config,
  );

  assert.equal(callAttributes[TOOL_ATTRIBUTES.PI_TOOL_NAME], "read.file");
  assert.equal(callAttributes[TOOL_ATTRIBUTES.PI_TOOL_CATEGORY], "filesystem");
  assert.match(String(callAttributes[TOOL_ATTRIBUTES.PI_TOOL_ARGUMENTS_HASH]), hexadecimalHash);
  assert.equal(callAttributes[TOOL_ATTRIBUTES.PI_TOOL_ARGUMENTS_SIZE], JSON.stringify({ path: "/Users/alice/private.txt" }).length);

  const resultAttributes = buildToolResultAttributes(
    {
      name: "curl.fetch",
      result: { ok: false, token: "internal_token=abc123" },
    },
    session.config,
  );

  assert.equal(resultAttributes[TOOL_ATTRIBUTES.PI_TOOL_NAME], "curl.fetch");
  assert.equal(resultAttributes[TOOL_ATTRIBUTES.PI_TOOL_CATEGORY], "network");
  assert.match(String(resultAttributes[TOOL_ATTRIBUTES.PI_TOOL_RESULT_HASH]), hexadecimalHash);
  assert.equal(resultAttributes[TOOL_ATTRIBUTES.PI_TOOL_RESULT_SIZE], JSON.stringify({ ok: false, token: "internal_token=abc123" }).length);

  assert.deepEqual(buildToolFinalAttributes({ status: "timeout", error: { name: "Bad Class ???" } }), {
    [TOOL_ATTRIBUTES.PI_TOOL_SUCCESS]: false,
    [TOOL_ATTRIBUTES.PI_TOOL_ERROR]: true,
    [TOOL_ATTRIBUTES.PI_TOOL_ERROR_CLASS]: "tool_error",
  });
  assert.deepEqual(buildToolFinalAttributes({}), {
    [TOOL_ATTRIBUTES.PI_TOOL_SUCCESS]: true,
    [TOOL_ATTRIBUTES.PI_TOOL_ERROR]: false,
  });
  assert.deepEqual(toolMetricLabels(callAttributes), { tool_name: "read.file", tool_category: "filesystem" });
});

test("tool payload serialization avoids default object stringification fallbacks", () => {
  const circular: Record<string, unknown> = { ok: true };
  circular.self = circular;

  assert.equal(serializeToolPayload({ ok: true }), JSON.stringify({ ok: true }));
  assert.match(serializeToolPayload(circular) ?? "", /^\[Unserializable Object: TypeError\]$/u);
  assert.doesNotMatch(serializeToolPayload(circular) ?? "", /\[object Object\]/u);
});

test("bash payload normalization handles nested messages, streams, status, and partial events", () => {
  const session = createSession();
  const event = {
    entry: {
      message: {
        role: "bashExecution",
        cmd: "npm test",
        stdout: "ok",
        stderr: "warn",
        result: { exit_code: "2" },
        status: "failed",
        fullOutputPath: "/tmp/pi-output.log",
        exclude_from_context: true,
      },
    },
  };

  const attributes = buildBashExecutionAttributes(event, session);
  assert.match(String(attributes[BASH_ATTRIBUTES.PI_BASH_COMMAND_HASH]), hexadecimalHash);
  assert.equal(attributes[BASH_ATTRIBUTES.PI_BASH_EXIT_CODE], 2);
  assert.equal(attributes[BASH_ATTRIBUTES.PI_BASH_CANCELLED], false);
  assert.equal(attributes[BASH_ATTRIBUTES.PI_BASH_TRUNCATED], false);
  assert.equal(attributes[BASH_ATTRIBUTES.PI_BASH_OUTPUT_SIZE], "ok\nwarn".length);
  assert.match(String(attributes[BASH_ATTRIBUTES.PI_BASH_OUTPUT_HASH]), hexadecimalHash);
  assert.equal(attributes[BASH_ATTRIBUTES.PI_BASH_FULL_OUTPUT_PATH_PRESENT], true);
  assert.equal(attributes[BASH_ATTRIBUTES.PI_BASH_EXCLUDE_FROM_CONTEXT], true);
  assert.equal(bashExecutionFailed(event), true);
  assert.equal(bashErrorClass(event), "non_zero_exit");

  const partialEvent = { message: { role: "user", content: "not bash" } };
  const partialAttributes = buildBashExecutionAttributes(partialEvent, session);
  assert.equal(partialAttributes[BASH_ATTRIBUTES.PI_BASH_COMMAND_HASH], undefined);
  assert.equal(partialAttributes[BASH_ATTRIBUTES.PI_BASH_OUTPUT_HASH], undefined);
  assert.equal(partialAttributes[BASH_ATTRIBUTES.PI_BASH_CANCELLED], false);
  assert.equal(partialAttributes[BASH_ATTRIBUTES.PI_BASH_FULL_OUTPUT_PATH_PRESENT], false);
  assert.equal(hasBashCompletionResult({ command: "echo ok", cwd: "/workspace/demo" }), false);
  assert.equal(hasBashCompletionResult(partialEvent), false);
  assert.equal(hasBashCompletionResult(event), true);
  assert.equal(hasBashCompletionResult({ role: "bashExecution", command: "echo ok", output: "ok" }), true);
  assert.equal(hasBashCompletionResult({ role: "bashExecution", command: "echo ok", result: { exitCode: 0 } }), true);
});

test("branch and compaction builders hash summaries and paths while preserving structural fields", () => {
  const session = createSession();
  session.currentBranchPreparation = buildBranchPreparationState(
    {
      preparation: {
        targetId: "target-entry",
        oldLeafId: "old-entry",
        commonAncestorId: "root-entry",
        branchPath: ["root-entry", "old-entry", "target-entry"],
      },
    },
    session.config,
  );

  const branchAttributes = buildBranchAttributes(
    {
      summaryEntry: {
        id: "summary-entry",
        parent_id: "target-entry",
        type: "branch_summary",
        summary: "private summary with /Users/alice/project",
        from_hook: true,
        details: { read_files: ["a.ts", "b.ts"], modifiedFiles: ["c.ts"] },
      },
    },
    session,
  );

  assert.equal(branchAttributes[BRANCH_ATTRIBUTES.PI_BRANCH_FROM_ID], "old-entry");
  assert.equal(branchAttributes[BRANCH_ATTRIBUTES.PI_BRANCH_TO_ID], "summary-entry");
  assert.equal(branchAttributes[BRANCH_ATTRIBUTES.PI_BRANCH_COMMON_ANCESTOR_ID], "root-entry");
  assert.match(String(branchAttributes[BRANCH_ATTRIBUTES.PI_BRANCH_PATH_HASH]), hexadecimalHash);
  assert.equal(branchAttributes[BRANCH_ATTRIBUTES.PI_BRANCH_SUMMARY_HASH], hashValue("private summary with /Users/alice/project", session.config));
  assert.equal(branchAttributes[BRANCH_ATTRIBUTES.PI_BRANCH_SUMMARY_LENGTH], "private summary with /Users/alice/project".length);
  assert.equal(branchAttributes[BRANCH_ATTRIBUTES.PI_BRANCH_READ_FILES_COUNT], 2);
  assert.equal(branchAttributes[BRANCH_ATTRIBUTES.PI_BRANCH_MODIFIED_FILES_COUNT], 1);
  assertNoRawPrivateContent(branchAttributes);

  const compactionAttributes = buildCompactionAttributes(
    {
      compaction_entry: {
        id: "compact-1",
        parent_id: "turn-1",
        summary: "private summary with internal_token=abc123",
        first_kept_id: "kept-1",
        tokens_before: "42",
        from_hook: true,
        details: { readFiles: ["a.ts"], modified_files: ["b.ts", "c.ts"] },
      },
      reason: "manual",
      will_retry: false,
    },
    session,
  );

  assert.equal(compactionAttributes[COMMON_SPAN_ATTRIBUTES.PI_ENTRY_ID], "compact-1");
  assert.equal(compactionAttributes[COMPACTION_ATTRIBUTES.PI_COMPACTION_FIRST_KEPT_ENTRY_ID], "kept-1");
  assert.equal(compactionAttributes[COMPACTION_ATTRIBUTES.PI_COMPACTION_TOKENS_BEFORE], 42);
  assert.equal(compactionAttributes[COMPACTION_ATTRIBUTES.PI_COMPACTION_SUMMARY_HASH], hashValue("private summary with internal_token=abc123", session.config));
  assert.equal(compactionAttributes[COMPACTION_ATTRIBUTES.PI_COMPACTION_READ_FILES_COUNT], 1);
  assert.equal(compactionAttributes[COMPACTION_ATTRIBUTES.PI_COMPACTION_MODIFIED_FILES_COUNT], 2);
  assertNoRawPrivateContent(compactionAttributes);
});

test("telemetry hashes use tenant salt and fail closed when salt is missing", () => {
  const config = cloneConfig();
  const previousSalt = process.env.OBSERVME_HASH_SALT;

  try {
    process.env.OBSERVME_HASH_SALT = "tenant-a";
    const firstHash = hashValue("same private value", config);
    const firstAttributes = buildToolCallInputAttributes({ input: "same private value" }, config);

    process.env.OBSERVME_HASH_SALT = "tenant-b";
    const differentTenantHash = hashValue("same private value", config);

    process.env.OBSERVME_HASH_SALT = "tenant-a";
    const stableHash = hashValue("same private value", config);

    delete process.env.OBSERVME_HASH_SALT;
    const missingSaltAttributes = buildToolCallInputAttributes({ input: "same private value" }, config);

    assert.equal(firstHash, stableHash);
    assert.notEqual(firstHash, differentTenantHash);
    assert.equal(firstAttributes[TOOL_ATTRIBUTES.PI_TOOL_ARGUMENTS_HASH], firstHash);
    assert.equal(missingSaltAttributes[TOOL_ATTRIBUTES.PI_TOOL_ARGUMENTS_HASH], undefined);
    assert.equal(missingSaltAttributes[TOOL_ATTRIBUTES.PI_TOOL_ARGUMENTS_SIZE], "same private value".length);
    assert.doesNotMatch(JSON.stringify(missingSaltAttributes), /same private value/u);
  } finally {
    if (previousSalt === undefined) delete process.env.OBSERVME_HASH_SALT;
    else process.env.OBSERVME_HASH_SALT = previousSalt;
  }
});

test("optional content capture redacts values and metric labels stay low-cardinality", () => {
  const disabledSession = createSession();
  const disabledSpan = createFakeSpan();
  recordOptionalPromptContent(disabledSession, disabledSpan as never, { payload: { messages: [{ content: "do not capture" }] } });
  assert.deepEqual(disabledSpan.attributes, {});

  const session = createSession({
    config: {
      capture: { prompts: true, toolArguments: true },
      privacy: { pathMode: "hash" },
    },
  });
  const promptSpan = createFakeSpan();
  const toolSpan = createFakeSpan();

  recordOptionalPromptContent(session, promptSpan as never, {
    payload: { messages: [{ content: "token internal_token=abc123 in /Users/alice/project" }] },
  });
  recordOptionalToolArguments(session, toolSpan as never, {
    arguments: { prompt: "internal_token=abc123", path: "/Users/alice/project" },
  });

  assert.notEqual(promptSpan.attributes[LLM_ATTRIBUTES.PI_LLM_PROMPT_REDACTED], undefined);
  assert.notEqual(toolSpan.attributes[TOOL_ATTRIBUTES.PI_TOOL_ARGUMENTS_REDACTED], undefined);
  assert.equal(toolSpan.attributes[TOOL_ATTRIBUTES.PI_TOOL_ARGUMENTS_REDACTED], toolSpan.attributes[TOOL_ATTRIBUTES.GEN_AI_TOOL_CALL_ARGUMENTS]);
  assertNoRawPrivateContent(promptSpan.attributes);
  assertNoRawPrivateContent(toolSpan.attributes);
  const promptLog = (session.logger as ReturnType<typeof createFakeLogger>).records.find(record => record.attributes?.[LOG_ATTRIBUTES.EVENT_NAME] === LOG_EVENT_NAMES.LLM_PROMPT_CAPTURED);
  assert.equal(promptLog?.body, promptSpan.attributes[LLM_ATTRIBUTES.PI_LLM_PROMPT_REDACTED]);
  assert.equal(promptLog?.attributes?.[LOG_ATTRIBUTES.EVENT_CATEGORY], "llm_content");
  assert.equal(promptLog?.attributes?.[LLM_ATTRIBUTES.PI_LLM_CONTENT_KIND], "prompt");
  assert.equal(promptLog?.attributes?.[LOG_ATTRIBUTES.TRACE_ID], "11111111111111111111111111111111");
  assert.equal(promptLog?.attributes?.[LOG_ATTRIBUTES.SPAN_ID], "2222222222222222");

  const responsesPromptSpan = createFakeSpan();
  recordOptionalPromptContent(session, responsesPromptSpan as never, {
    payload: { input: [{ role: "user", content: [{ type: "input_text", text: "responses api prompt" }] }] },
  });
  const responsesPromptLog = (session.logger as ReturnType<typeof createFakeLogger>).records.find(
    record => record.body === responsesPromptSpan.attributes[LLM_ATTRIBUTES.PI_LLM_PROMPT_REDACTED],
  );

  assert.equal(responsesPromptSpan.attributes[LLM_ATTRIBUTES.PI_LLM_PROMPT_REDACTED], "responses api prompt");
  assert.equal(responsesPromptLog?.attributes?.[LOG_ATTRIBUTES.EVENT_NAME], LOG_EVENT_NAMES.LLM_PROMPT_CAPTURED);

  assert.deepEqual(Object.keys(metricLabels(session.config, session.lineage)).sort(), lowCardinalityLabelKeys.sort());
  assert.deepEqual(llmMetricLabels(session, { [LLM_ATTRIBUTES.GEN_AI_PROVIDER_NAME]: "anthropic", [LLM_ATTRIBUTES.GEN_AI_REQUEST_MODEL]: "claude" }), {
    environment: "production",
    agent_role: "worker",
    provider: "anthropic",
    model: "claude",
  });
  assert.equal(Object.keys(llmMetricLabels(session, {})).includes(LOG_ATTRIBUTES.PI_SESSION_ID), false);
});

test("unsafe live content capture exports the same truncated raw policy for prompt, tool result, and bash output", () => {
  const session = createSession({
    config: {
      capture: { prompts: true, toolResults: true, bashOutput: true },
      limits: { maxPromptChars: 12, maxToolResultChars: 12, maxBashOutputChars: 12 },
      privacy: { redactionEnabled: false, allowUnsafeCapture: true },
    },
  });
  const promptSpan = createFakeSpan();
  const toolSpan = createFakeSpan();
  const bashSpan = createFakeSpan();

  recordOptionalPromptContent(session, promptSpan as never, { payload: { messages: [{ content: "password=prompt-secret" }] } });
  recordOptionalToolResult(session, toolSpan as never, { result: "api_key=tool-secret" });
  recordOptionalBashContent(session, bashSpan as never, { output: "token=bash-secret" });

  assert.equal(promptSpan.attributes[LLM_ATTRIBUTES.PI_LLM_PROMPT_REDACTED], "password=pro");
  assert.equal(toolSpan.attributes[TOOL_ATTRIBUTES.PI_TOOL_RESULT_REDACTED], "api_key=tool");
  assert.equal(toolSpan.attributes[TOOL_ATTRIBUTES.GEN_AI_TOOL_CALL_RESULT], "api_key=tool");
  assert.equal(bashSpan.attributes[BASH_ATTRIBUTES.PI_BASH_OUTPUT_REDACTED], "token=bash-s");
  assert.equal(promptSpan.attributes[COMMON_SPAN_ATTRIBUTES.OBSERVME_TRUNCATED], true);
  assert.equal(toolSpan.attributes[COMMON_SPAN_ATTRIBUTES.OBSERVME_TRUNCATED], true);
  assert.equal(bashSpan.attributes[BASH_ATTRIBUTES.PI_BASH_TRUNCATED], true);
  assert.equal((session.metrics.redactionFailures as ReturnType<typeof createFakeCounter>).records.length, 0);
});

test("live content capture drops prompt, tool result, and bash output when redaction fails", () => {
  const previousSalt = process.env.OBSERVME_HASH_SALT;
  delete process.env.OBSERVME_HASH_SALT;

  try {
    const session = createSession({
      config: {
        capture: { prompts: true, toolResults: true, bashOutput: true },
        privacy: { redactionEnabled: true, allowUnsafeCapture: false },
      },
    });
    const promptSpan = createFakeSpan();
    const toolSpan = createFakeSpan();
    const bashSpan = createFakeSpan();

    recordOptionalPromptContent(session, promptSpan as never, { payload: { messages: [{ content: "password=prompt-secret" }] } });
    recordOptionalToolResult(session, toolSpan as never, { result: "api_key=tool-secret" });
    recordOptionalBashContent(session, bashSpan as never, { output: "token=bash-secret" });

    assert.equal(promptSpan.attributes[LLM_ATTRIBUTES.PI_LLM_PROMPT_REDACTED], undefined);
    assert.equal(toolSpan.attributes[TOOL_ATTRIBUTES.PI_TOOL_RESULT_REDACTED], undefined);
    assert.equal(bashSpan.attributes[BASH_ATTRIBUTES.PI_BASH_OUTPUT_REDACTED], undefined);
    assert.equal((session.metrics.redactionFailures as ReturnType<typeof createFakeCounter>).records.length, 3);
    assert.ok(
      (session.logger as ReturnType<typeof createFakeLogger>).records.every(record =>
        String(record.attributes?.reason ?? "").includes("tenant salt env var OBSERVME_HASH_SALT is not set"),
      ),
    );
  } finally {
    if (previousSalt === undefined) delete process.env.OBSERVME_HASH_SALT;
    else process.env.OBSERVME_HASH_SALT = previousSalt;
  }
});

test("LLM response and thinking capture emit redacted content logs with truncation metadata", () => {
  const session = createSession({
    config: {
      capture: { responses: true, thinking: true },
      limits: { maxResponseChars: 24 },
      privacy: { pathMode: "hash" },
    },
  });
  const span = createFakeSpan();

  recordOptionalLlmContent(session, span as never, {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "api_key=super-secret before a long reasoning tail" },
      { type: "text", text: "password=response-secret before a long response tail" },
    ],
  });

  const logger = session.logger as ReturnType<typeof createFakeLogger>;
  const responseLog = logger.records.find(record => record.attributes?.[LOG_ATTRIBUTES.EVENT_NAME] === LOG_EVENT_NAMES.LLM_RESPONSE_CAPTURED);
  const thinkingLog = logger.records.find(record => record.attributes?.[LOG_ATTRIBUTES.EVENT_NAME] === LOG_EVENT_NAMES.LLM_THINKING_CAPTURED);

  assert.equal(responseLog?.body, span.attributes[LLM_ATTRIBUTES.PI_LLM_RESPONSE_REDACTED]);
  assert.equal(thinkingLog?.body, span.attributes[LLM_ATTRIBUTES.PI_LLM_THINKING_REDACTED]);
  assert.equal(responseLog?.attributes?.[LLM_ATTRIBUTES.PI_LLM_CONTENT_KIND], "response");
  assert.equal(thinkingLog?.attributes?.[LLM_ATTRIBUTES.PI_LLM_CONTENT_KIND], "thinking");
  assert.equal(responseLog?.attributes?.[COMMON_SPAN_ATTRIBUTES.OBSERVME_TRUNCATED], true);
  assert.equal(thinkingLog?.attributes?.[COMMON_SPAN_ATTRIBUTES.OBSERVME_TRUNCATED], true);
  assert.match(String(responseLog?.body), /\[REDACTED:/u);
  assert.match(String(thinkingLog?.body), /\[REDACTED:/u);
  assert.doesNotMatch(JSON.stringify({ spans: span.attributes, logs: logger.records }), /response-secret|super-secret/u);
  assertNoRawPrivateContent({ spans: span.attributes, logs: logger.records });
});
