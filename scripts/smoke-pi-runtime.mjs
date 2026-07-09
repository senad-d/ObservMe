#!/usr/bin/env node
// Smoke check: launch a real Pi RPC process with the local ObservMe extension,
// verify /obs command discovery, lifecycle replacement, and command routing
// against a deterministic local backend without reading developer secrets.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";
import { once } from "node:events";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const rpcTimeoutMs = 15_000;
const smokeUsername = "smoke";
const smokePassword = "smoke";
const expectedGrafanaAuthorization = `Basic ${Buffer.from(`${smokeUsername}:${smokePassword}`).toString("base64")}`;

class SmokeBackendServer {
  constructor() {
    this.grafanaRequests = [];
    this.slowPrometheusQueryDelayMs = 0;
    this.server = createServer(this.handleRequest.bind(this));
  }

  get baseUrl() {
    const address = this.server.address();
    assert.ok(address && typeof address === "object", "smoke backend must have a TCP address");
    return `http://127.0.0.1:${address.port}`;
  }

  async start() {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
  }

  async close() {
    if (!this.server.listening) return;

    this.server.close();
    await once(this.server, "close");
  }

  delayPrometheusQueries(delayMs) {
    this.slowPrometheusQueryDelayMs = Math.max(0, Math.trunc(delayMs));
  }

  handleRequest(request, response) {
    const requestUrl = request.url ?? "/";
    const authorization = String(request.headers.authorization ?? "");

    if (requestUrl.startsWith("/api/")) {
      this.grafanaRequests.push({ url: requestUrl, authorization });
      if (this.shouldDelayPrometheusQuery(requestUrl)) {
        this.respondToDelayedGrafanaRequest(authorization, response);
        return;
      }

      this.respondToGrafanaRequest(authorization, response);
      return;
    }

    writeTextResponse(response, 200, "ok");
  }

  respondToGrafanaRequest(authorization, response) {
    if (authorization !== expectedGrafanaAuthorization) {
      writeJsonResponse(response, 401, { message: "unauthorized" });
      return;
    }

    writeJsonResponse(response, 200, { status: "ok" });
  }

  respondToDelayedGrafanaRequest(authorization, response) {
    const timeout = setTimeout(this.respondToDelayedGrafanaRequestNow.bind(this, authorization, response), this.slowPrometheusQueryDelayMs);
    timeout.unref?.();
  }

  respondToDelayedGrafanaRequestNow(authorization, response) {
    if (response.destroyed || response.writableEnded) return;
    this.respondToGrafanaRequest(authorization, response);
  }

  shouldDelayPrometheusQuery(requestUrl) {
    return this.slowPrometheusQueryDelayMs > 0 && requestUrl.startsWith("/api/datasources/proxy/uid/prometheus/api/v1/query");
  }

  assertAuthenticatedGrafanaProbes() {
    assert.ok(this.grafanaRequests.length >= 4, "Grafana health and datasource probes should use the smoke backend");

    for (const request of this.grafanaRequests) {
      assert.equal(request.authorization, expectedGrafanaAuthorization, `Grafana probe ${request.url} should use configured Basic auth`);
    }
  }
}

class PiRpcClient {
  constructor(options) {
    this.records = [];
    this.waiters = [];
    this.stderr = "";
    this.stdoutBuffer = "";
    this.decoder = new StringDecoder("utf8");
    this.exitCode = undefined;
    this.exitSignal = undefined;
    this.nextId = 1;
    this.child = spawn("pi", options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.on("data", this.handleStdoutData.bind(this));
    this.child.stderr.on("data", this.handleStderrData.bind(this));
    this.child.on("error", this.handleError.bind(this));
    this.child.on("exit", this.handleExit.bind(this));
  }

  handleStdoutData(chunk) {
    this.stdoutBuffer += this.decoder.write(chunk);
    this.drainStdoutBuffer();
  }

  handleStderrData(chunk) {
    this.stderr += chunk.toString();
  }

  handleExit(code, signal) {
    this.exitCode = code;
    this.exitSignal = signal;
    this.rejectWaiters(new Error(`Pi RPC process exited early (${formatExit(code, signal)}).${this.formatStderr()}`));
  }

  handleError(error) {
    this.rejectWaiters(new Error(`Failed to start Pi RPC process: ${formatError(error)}.${this.formatStderr()}`));
  }

  drainStdoutBuffer() {
    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) return;

      const rawLine = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      this.handleStdoutLine(stripTrailingCarriageReturn(rawLine));
    }
  }

  handleStdoutLine(line) {
    if (!line.trim()) return;

    try {
      this.records.push(JSON.parse(line));
      this.resolveWaiters();
    } catch (error) {
      this.stderr += `\nNon-JSON stdout from Pi RPC: ${line}\n${formatError(error)}`;
    }
  }

  send(command) {
    assert.ok(this.child.stdin.writable, "Pi RPC stdin should be writable");
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  async request(command) {
    const id = `smoke-${this.nextId}`;
    this.nextId += 1;
    this.send({ id, ...command });

    const response = await this.waitForRecord(record => isResponseForId(record, id), `response ${id}`);
    assert.equal(response.success, true, `RPC ${command.type} should succeed: ${response.error ?? "unknown error"}`);
    return response;
  }

  async waitForNotifyMessage(prefix) {
    const startIndex = this.recordCount();
    const record = await this.waitForRecordAfter(record => isNotifyMessageWithPrefix(record, prefix), `notify ${prefix}`, startIndex);
    return String(record.message);
  }

  async waitForStatusLoaded() {
    return this.waitForRecord(isObservMeLoadedStatus, "ObservMe status indicator");
  }

  async waitForStatusLoadedAfter(startIndex) {
    return this.waitForRecordAfter(isObservMeLoadedStatus, "replacement ObservMe status indicator", startIndex);
  }

  async waitForStatusClearedAfter(startIndex) {
    return this.waitForRecordAfter(isObservMeClearedStatus, "ObservMe status clear", startIndex);
  }

  recordCount() {
    return this.records.length;
  }

  waitForRecordAfter(predicate, label, startIndex) {
    return this.waitForRecord(predicate, label, startIndex);
  }

  waitForRecord(predicate, label, startIndex = 0) {
    const existing = this.records.slice(startIndex).find(predicate);
    if (existing) return Promise.resolve(existing);
    if (this.exitCode !== undefined) {
      return Promise.reject(new Error(`Pi RPC process exited before ${label} (${formatExit(this.exitCode, this.exitSignal)}).${this.formatStderr()}`));
    }

    return new Promise((resolvePromise, rejectPromise) => {
      const waiter = {
        predicate,
        label,
        startIndex,
        resolve: resolvePromise,
        reject: rejectPromise,
        timeout: setTimeout(() => this.rejectWaiterByLabel(label), rpcTimeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  resolveWaiters() {
    for (const waiter of [...this.waiters]) {
      const match = this.records.slice(waiter.startIndex).find(waiter.predicate);
      if (!match) continue;

      this.removeWaiter(waiter);
      waiter.resolve(match);
    }
  }

  rejectWaiterByLabel(label) {
    const waiter = this.waiters.find(candidate => candidate.label === label);
    if (!waiter) return;

    this.removeWaiter(waiter);
    waiter.reject(new Error(`Timed out waiting for ${label}.${this.formatStderr()}`));
  }

  rejectWaiters(error) {
    for (const waiter of [...this.waiters]) {
      this.removeWaiter(waiter);
      waiter.reject(error);
    }
  }

  removeWaiter(waiter) {
    clearTimeout(waiter.timeout);
    this.waiters = this.waiters.filter(candidate => candidate !== waiter);
  }

  formatStderr() {
    const trimmed = this.stderr.trim();
    return trimmed ? `\nStderr:\n${trimmed}` : "";
  }

  async stop() {
    if (this.exitCode !== undefined) return;

    this.child.kill("SIGTERM");
    await waitForProcessExit(this.child, 5_000);
    if (this.exitCode !== undefined) return;

    this.child.kill("SIGKILL");
    await waitForProcessExit(this.child, 5_000);
  }
}

async function main() {
  const backend = new SmokeBackendServer();
  let client;
  let temporaryRoot;

  try {
    await backend.start();
    temporaryRoot = await createTemporaryPiProject(backend.baseUrl);
    client = new PiRpcClient(createPiRpcOptions(temporaryRoot.projectDir, temporaryRoot.homeDir, temporaryRoot.sessionDir));

    await client.waitForStatusLoaded();
    await assertObsCommandIsDiscoverable(client);
    await assertObsStatusCommand(client, backend.baseUrl);
    await assertObsSessionCommand(client);
    await assertObsReloadLifecycle(client, backend.baseUrl);
    await assertObsNewSessionLifecycle(client, backend.baseUrl);
    await assertObsHealthCommand(client);
    backend.assertAuthenticatedGrafanaProbes();
    await assertObsCostTimeoutCommand(client, backend);
    await assertPiRuntimeEventShapeCoverage(client);

    console.log(
      "Pi runtime smoke passed: real RPC process discovered /obs, verified reload and new-session lifecycle replacement, executed status/session/health/bounded query commands, and covered sanitized current Pi event shapes.",
    );
  } finally {
    await client?.stop();
    await backend.close();
    await removeTemporaryRoot(temporaryRoot?.rootDir);
  }
}

async function createTemporaryPiProject(baseUrl) {
  const rootDir = await mkdtemp(join(tmpdir(), "observme-pi-runtime-"));
  const homeDir = join(rootDir, "home");
  const projectDir = join(rootDir, "project");
  const sessionDir = join(rootDir, "sessions");
  const configDir = join(projectDir, ".pi");
  const extensionDir = join(configDir, "extensions");

  await mkdir(homeDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await mkdir(extensionDir, { recursive: true });
  await writeFile(join(configDir, "observme.yaml"), renderSmokeObservMeConfig(baseUrl), "utf8");
  await writeFile(join(projectDir, "observme-smoke-input.txt"), "ObservMe smoke fixture input.\n", "utf8");
  await writeFile(join(extensionDir, "observme.ts"), renderSmokeObservMeExtension(), "utf8");
  await writeFile(join(extensionDir, "observme-smoke-events.ts"), renderSmokeEventShapeExtension(), "utf8");
  await writeFile(join(extensionDir, "observme-smoke-reload.ts"), renderSmokeReloadExtension(), "utf8");

  return { rootDir, homeDir, projectDir, sessionDir };
}

function createPiRpcOptions(projectDir, homeDir, sessionDir) {
  return {
    cwd: projectDir,
    env: createSanitizedEnvironment(homeDir),
    args: [
      "--mode",
      "rpc",
      "--session-dir",
      sessionDir,
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--approve",
    ],
  };
}

function createSanitizedEnvironment(homeDir) {
  const env = {
    ...process.env,
    HOME: homeDir,
    NO_COLOR: "1",
    PI_CODING_AGENT_DIR: join(homeDir, ".pi", "agent"),
    PI_CODING_AGENT_SESSION_DIR: join(homeDir, ".pi", "agent", "sessions"),
    PI_OFFLINE: "1",
  };

  for (const key of Object.keys(env)) {
    if (key.startsWith("OBSERVME_")) delete env[key];
  }

  return env;
}

function renderSmokeObservMeExtension() {
  const extensionUrl = pathToFileURL(join(repoRoot, "src", "extension.ts")).href;
  return `export { default } from ${JSON.stringify(extensionUrl)};\n`;
}

function renderSmokeReloadExtension() {
  return `export default function observmeSmokeReload(pi) {
  pi.registerCommand("observme-smoke-reload", {
    description: "Reload extension runtime for ObservMe smoke validation.",
    handler: handleObservMeSmokeReload,
  });
}

async function handleObservMeSmokeReload(_args, ctx) {
  await ctx.reload();
}
`;
}

function renderSmokeEventShapeExtension() {
  const piAiUrl = pathToFileURL(join(repoRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js")).href;

  return `import { createAssistantMessageEventStream } from ${JSON.stringify(piAiUrl)};

const observedEvents = new Map();
const observedCounts = new Map();
const observedEventNames = [
  "session_start",
  "agent_start",
  "turn_start",
  "before_provider_request",
  "after_provider_response",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_call",
  "tool_result",
  "tool_execution_end",
  "user_bash",
  "model_select",
  "thinking_level_select",
  "turn_end",
  "agent_end",
  "session_compact",
  "session_tree",
];
const fixtureBackedEvents = new Map([
  ["session_compact", "session_compact is covered by test/fixtures/events/session-compact.json; the minimal credential-free RPC smoke does not force a compaction summary."],
  ["session_tree", "session_tree is covered by test/fixtures/events/session-tree.json; interactive tree navigation is not exposed as a bounded RPC smoke action."],
  ["user_bash", "user_bash is emitted by interactive !/!! handling, not by Pi RPC bash or prompt commands; the smoke verifies the installed Pi UserBashEvent type contract and docs/review-validation.md records the manual TUI recipe."],
]);
let providerCallCount = 0;
let smokePi;

export default function observmeSmokeEventShapes(pi) {
  smokePi = pi;
  for (const eventName of observedEventNames) registerShapeHandler(pi, eventName);
  pi.registerProvider("observme-smoke", {
    name: "ObservMe Smoke Provider",
    baseUrl: "http://127.0.0.1",
    apiKey: "observme-smoke-key",
    api: "observme-smoke-api",
    models: [
      {
        id: "offline",
        name: "ObservMe Offline Smoke",
        reasoning: true,
        input: ["text"],
        contextWindow: 10000,
        maxTokens: 1000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "offline-alt",
        name: "ObservMe Offline Smoke Alternate",
        reasoning: true,
        input: ["text"],
        contextWindow: 10000,
        maxTokens: 1000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple: streamSmokeProvider,
  });
  pi.registerCommand("observme-smoke-event-shapes", {
    description: "Report sanitized Pi runtime event shapes for ObservMe smoke validation.",
    handler: handleEventShapesCommand,
  });
  pi.registerCommand("observme-smoke-select-model", {
    description: "Select the deterministic ObservMe smoke provider and thinking level.",
    handler: handleSelectModelCommand,
  });
}

function registerShapeHandler(pi, eventName) {
  pi.on(eventName, recordShapeEvent.bind(undefined, eventName));
}

function recordShapeEvent(eventName, event, ctx) {
  observedCounts.set(eventName, (observedCounts.get(eventName) ?? 0) + 1);
  observedEvents.set(eventName, summarizeEvent(eventName, event, ctx));
}

async function handleEventShapesCommand(_args, ctx) {
  await ctx.ui.notify("ObservMe smoke event shapes: " + JSON.stringify(createEventShapeReport()), "info");
}

async function handleSelectModelCommand(_args, ctx) {
  const alternateModel = ctx.modelRegistry.find("observme-smoke", "offline-alt");
  const model = ctx.modelRegistry.find("observme-smoke", "offline");
  const alternateSelected = alternateModel ? await smokePi.setModel(alternateModel) : false;
  const selected = model ? await smokePi.setModel(model) : false;

  if (selected) smokePi.setThinkingLevel("high");
  await ctx.ui.notify("ObservMe smoke model selection: " + JSON.stringify({ alternateFound: Boolean(alternateModel), alternateSelected, modelFound: Boolean(model), selected }), selected ? "info" : "error");
}

function createEventShapeReport() {
  return {
    version: 1,
    events: Object.fromEntries([...observedEvents.entries()].sort(compareEntriesByKey)),
    counts: Object.fromEntries([...observedCounts.entries()].sort(compareEntriesByKey)),
    fixtureBackedEvents: Object.fromEntries([...fixtureBackedEvents.entries()].filter(isMissingObservedEvent).sort(compareEntriesByKey)),
  };
}

function isMissingObservedEvent(entry) {
  return !observedEvents.has(entry[0]);
}

function compareEntriesByKey(left, right) {
  return left[0].localeCompare(right[0]);
}

function streamSmokeProvider(model, _context, options) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(emitSmokeProviderStream.bind(undefined, stream, model, options));
  return stream;
}

function emitSmokeProviderStream(stream, model, options) {
  const output = createAssistantOutput(model);

  try {
    if (options?.signal?.aborted) throw new Error("smoke provider aborted");
    stream.push({ type: "start", partial: output });
    if (providerCallCount === 0) emitSmokeToolCall(stream, output);
    else emitSmokeText(stream, output);
    providerCallCount += 1;
    stream.push({ type: "done", reason: output.stopReason, message: output });
  } catch (error) {
    output.stopReason = options?.signal?.aborted ? "aborted" : "error";
    output.errorMessage = error instanceof Error ? error.message : String(error);
    stream.push({ type: "error", reason: output.stopReason, error: output });
  } finally {
    stream.end();
  }
}

function createAssistantOutput(model) {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 7,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function emitSmokeToolCall(stream, output) {
  const contentIndex = output.content.length;
  const toolCall = { type: "toolCall", id: "observme-smoke-read-call", name: "read", arguments: {} };
  const args = { path: "observme-smoke-input.txt" };

  output.content.push(toolCall);
  stream.push({ type: "toolcall_start", contentIndex, partial: output });
  toolCall.arguments = args;
  stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(args), partial: output });
  stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
  output.stopReason = "toolUse";
}

function emitSmokeText(stream, output) {
  const contentIndex = output.content.length;
  const text = "ObservMe smoke provider completed after the read tool.";

  output.content.push({ type: "text", text: "" });
  stream.push({ type: "text_start", contentIndex, partial: output });
  output.content[contentIndex].text = text;
  stream.push({ type: "text_delta", contentIndex, delta: text, partial: output });
  stream.push({ type: "text_end", contentIndex, content: text, partial: output });
  output.stopReason = "stop";
}

function summarizeEvent(eventName, event, ctx) {
  const record = asRecord(event);
  const base = {
    eventName,
    keys: sortedKeys(record),
    ctx: summarizeContext(ctx),
  };

  if (eventName === "user_bash") return withoutUndefined({ ...base, ...summarizeUserBash(record) });
  if (eventName.startsWith("tool_")) return withoutUndefined({ ...base, ...summarizeToolEvent(record) });
  if (eventName === "message_end") return withoutUndefined({ ...base, ...summarizeMessageEvent(record) });
  if (eventName === "before_provider_request") return withoutUndefined({ ...base, ...summarizeProviderRequest(record) });
  if (eventName === "after_provider_response") return withoutUndefined({ ...base, ...summarizeProviderResponse(record) });
  if (eventName === "model_select") return withoutUndefined({ ...base, ...summarizeModelSelect(record) });
  if (eventName === "thinking_level_select") return withoutUndefined({ ...base, ...summarizeThinkingSelect(record) });
  if (eventName === "agent_start") return withoutUndefined({ ...base, ...summarizeAgentStart(record) });
  if (eventName === "turn_start" || eventName === "turn_end") return withoutUndefined({ ...base, ...summarizeTurnEvent(record) });
  if (eventName === "agent_end") return withoutUndefined({ ...base, ...summarizeAgentEnd(record) });
  if (eventName === "session_start") return withoutUndefined({ ...base, ...summarizeSessionStart(record) });

  return withoutUndefined(base);
}

function summarizeContext(ctx) {
  const record = asRecord(ctx);

  return withoutUndefined({
    mode: stringValue(record.mode),
    hasUIType: valueType(record.hasUI),
    cwdType: valueType(record.cwd),
    sessionFileType: valueType(record.sessionFile ?? record.session_file),
    modelProvider: stringValue(asRecord(record.model).provider),
    modelId: stringValue(asRecord(record.model).id ?? asRecord(record.model).model),
    thinkingLevel: stringValue(asRecord(record.thinking).level),
  });
}

function summarizeSessionStart(record) {
  return {
    reason: stringValue(record.reason),
    previousSessionFileType: valueType(record.previousSessionFile),
    targetSessionFileType: valueType(record.targetSessionFile),
    sessionIdType: valueType(record.sessionId ?? record.session_id),
  };
}

function summarizeAgentStart(record) {
  const prompt = stringValue(record.prompt ?? record.userPrompt ?? record.message);

  return {
    source: stringValue(record.source),
    promptType: valueType(prompt),
    promptLength: prompt?.length,
  };
}

function summarizeTurnEvent(record) {
  return {
    turnIndexType: valueType(record.turnIndex ?? record.turn_index),
    hasMessage: record.message !== undefined,
    toolResultCount: Array.isArray(record.toolResults) ? record.toolResults.length : undefined,
  };
}

function summarizeAgentEnd(record) {
  return {
    messageCount: Array.isArray(record.messages) ? record.messages.length : undefined,
    status: stringValue(record.status ?? record.outcome),
  };
}

function summarizeProviderRequest(record) {
  const payload = asRecord(record.payload);

  return {
    payloadKeys: sortedKeys(payload),
    payloadMessageCount: countItems(payload.messages ?? payload.contents ?? payload.input ?? payload.prompt),
    payloadToolSchemaCount: countItems(payload.tools ?? payload.toolSchemas),
  };
}

function summarizeProviderResponse(record) {
  return {
    statusType: valueType(record.status),
    headerKeys: sortedKeys(asRecord(record.headers)),
  };
}

function summarizeMessageEvent(record) {
  const message = asRecord(record.message ?? record);

  return {
    role: stringValue(message.role),
    provider: stringValue(message.provider),
    model: stringValue(message.model),
    stopReason: stringValue(message.stopReason),
    contentTypes: contentTypes(message.content),
    usageKeys: sortedKeys(asRecord(message.usage)),
  };
}

function summarizeToolEvent(record) {
  const args = readToolArgs(record);
  const result = readToolResult(record);

  return {
    toolCallIdType: valueType(record.toolCallId ?? record.tool_call_id ?? record.callId ?? record.id ?? asRecord(record.toolCall).id),
    toolName: stringValue(record.toolName ?? record.tool_name ?? record.name ?? asRecord(record.toolCall).name),
    argumentSource: args.source,
    argumentKeys: sortedKeys(asRecord(args.value)),
    hasResultPayload: result.value !== undefined,
    resultSource: result.source,
    resultKeys: sortedKeys(asRecord(result.value)),
    resultContentTypes: contentTypes(asRecord(result.value).content ?? record.content),
    isErrorType: valueType(record.isError),
    successType: valueType(record.success),
  };
}

function summarizeUserBash(record) {
  const command = stringValue(record.command ?? record.cmd ?? record.input);

  return {
    commandType: valueType(command),
    commandLength: command?.length,
    cwdType: valueType(record.cwd),
    excludeFromContextType: valueType(record.excludeFromContext ?? record.exclude_from_context),
    hasCompletedResult: record.result !== undefined || record.output !== undefined || record.exitCode !== undefined || record.exit_code !== undefined || record.cancelled !== undefined || record.truncated !== undefined,
  };
}

function summarizeModelSelect(record) {
  const model = asRecord(record.model);
  const previousModel = asRecord(record.previousModel);

  return {
    provider: stringValue(model.provider),
    modelId: stringValue(model.id ?? model.model),
    previousProviderType: valueType(previousModel.provider),
    source: stringValue(record.source),
  };
}

function summarizeThinkingSelect(record) {
  return {
    level: stringValue(record.level),
    previousLevelType: valueType(record.previousLevel),
  };
}

function readToolArgs(record) {
  if (record.arguments !== undefined) return { source: "arguments", value: record.arguments };
  if (record.args !== undefined) return { source: "args", value: record.args };
  if (record.input !== undefined) return { source: "input", value: record.input };
  if (record.parameters !== undefined) return { source: "parameters", value: record.parameters };
  if (record.params !== undefined) return { source: "params", value: record.params };
  if (asRecord(record.toolCall).arguments !== undefined) return { source: "toolCall.arguments", value: asRecord(record.toolCall).arguments };
  if (asRecord(record.toolCall).input !== undefined) return { source: "toolCall.input", value: asRecord(record.toolCall).input };
  return { source: undefined, value: undefined };
}

function readToolResult(record) {
  if (record.result !== undefined) return { source: "result", value: record.result };
  if (record.output !== undefined) return { source: "output", value: record.output };
  if (record.response !== undefined) return { source: "response", value: record.response };
  if (record.content !== undefined) return { source: "content", value: { content: record.content } };
  return { source: undefined, value: undefined };
}

function countItems(value) {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "string" && value.trim() !== "") return 1;
  if (isRecord(value)) return 1;
  return undefined;
}

function contentTypes(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(contentType).filter(Boolean))].sort();
}

function contentType(value) {
  return stringValue(asRecord(value).type);
}

function sortedKeys(value) {
  return Object.keys(asRecord(value)).sort();
}

function stringValue(value) {
  return typeof value === "string" ? value : undefined;
}

function valueType(value) {
  if (value === undefined) return undefined;
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function asRecord(value) {
  return isRecord(value) ? value : {};
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(entry => entry[1] !== undefined));
}
`;
}

function renderSmokeObservMeConfig(baseUrl) {
  return `observme:
  environment: development
  tenant: pi-runtime-smoke
  otlp:
    endpoint: ${baseUrl}
    headers: {}
  resource:
    attributes:
      service.name: observme-pi-runtime-smoke
      observme.tenant.id: pi-runtime-smoke
      deployment.environment.name: development
  traces:
    enabled: false
  metrics:
    enabled: false
  logs:
    enabled: false
  privacy:
    allowInsecureTransport: true
    customRedactionPatterns: []
  query:
    timeoutMs: 500
    links:
      traceUrlTemplate: ${baseUrl}/explore?traceId=\${traceId}
    grafana:
      url: ${baseUrl}
      token: ""
      username: ${smokeUsername}
      password: ${smokePassword}
      datasourceUids:
        tempo: tempo
        loki: loki
        prometheus: prometheus
`;
}

async function assertObsCommandIsDiscoverable(client) {
  await assertSingleExtensionCommand(client, "obs");
  await assertSingleExtensionCommand(client, "observme-smoke-event-shapes");
  await assertSingleExtensionCommand(client, "observme-smoke-select-model");
  await assertSingleExtensionCommand(client, "observme-smoke-reload");
}

async function assertSingleExtensionCommand(client, name) {
  const response = await client.request({ type: "get_commands" });
  const commands = response.data?.commands ?? [];
  const matches = commands.filter(command => command.name === name && command.source === "extension");

  assert.equal(matches.length, 1, `real Pi command registry should list exactly one /${name} extension command`);
}

async function assertObsStatusCommand(client, baseUrl) {
  const notification = client.waitForNotifyMessage("ObservMe:");
  await client.request({ type: "prompt", message: "/obs status" });
  const message = await notification;

  assert.match(message, /ObservMe: enabled/u, "/obs status should report ObservMe enabled from the trusted fixture config");
  assert.match(message, new RegExp(`OTLP endpoint: ${escapeRegExp(baseUrl)}`, "u"), "/obs status should use the trusted project config endpoint");
  assert.match(message, /Config source: trusted project config \(\.pi\/observme\.yaml\)/u, "/obs status should expose trusted project config source");
  assert.match(message, new RegExp(`Grafana URL: ${escapeRegExp(baseUrl)}/?`, "u"), "/obs status should expose the trusted local Grafana query URL");
  assert.match(message, /Grafana query readiness: ready/u, "/obs status should report configured Grafana query readiness");
  assert.match(message, /Traces: disabled/u, "/obs status should reflect the smoke fixture signal settings");
  assert.doesNotMatch(message, /unavailable|unknown state/iu, "/obs status should not report unloaded or unknown extension state");
}

async function assertObsSessionCommand(client) {
  const notification = client.waitForNotifyMessage("Session:");
  await client.request({ type: "prompt", message: "/obs session" });
  const message = await notification;

  assert.match(message, /^Session: session-/mu, "/obs session should expose session_start runtime state");
  assert.doesNotMatch(message, /Session: unknown/u, "/obs session should not report an unknown session while the extension is active");
  assert.doesNotMatch(message, /ObservMe session unavailable/iu, "/obs session should not fail through Pi command routing");

  return { message, sessionId: parseObsSessionId(message) };
}

async function assertObsReloadLifecycle(client, baseUrl) {
  const before = await assertObsSessionCommand(client);
  const startIndex = client.recordCount();

  await client.request({ type: "prompt", message: "/observme-smoke-reload" });
  await client.waitForStatusClearedAfter(startIndex);
  await client.waitForStatusLoadedAfter(startIndex);
  await assertSingleExtensionCommand(client, "obs");
  await assertSingleExtensionCommand(client, "observme-smoke-event-shapes");
  await assertSingleExtensionCommand(client, "observme-smoke-select-model");
  await assertSingleExtensionCommand(client, "observme-smoke-reload");
  await assertObsStatusCommand(client, baseUrl);

  const after = await assertObsSessionCommand(client);
  assert.notEqual(after.sessionId, before.sessionId, "reload should create a fresh ObservMe runtime session identity");
  assertFreshObsSessionCounters(after.message, "reload");
}

async function assertObsNewSessionLifecycle(client, baseUrl) {
  const before = await assertObsSessionCommand(client);
  const startIndex = client.recordCount();
  const response = await client.request({ type: "new_session" });

  assert.equal(response.data?.cancelled, false, "new_session should not be cancelled by extension lifecycle hooks");
  await client.waitForStatusClearedAfter(startIndex);
  await client.waitForStatusLoadedAfter(startIndex);
  await assertSingleExtensionCommand(client, "obs");
  await assertSingleExtensionCommand(client, "observme-smoke-event-shapes");
  await assertSingleExtensionCommand(client, "observme-smoke-select-model");
  await assertSingleExtensionCommand(client, "observme-smoke-reload");
  await assertObsStatusCommand(client, baseUrl);

  const after = await assertObsSessionCommand(client);
  assert.notEqual(after.sessionId, before.sessionId, "new_session should create a fresh Pi session identity");
  assertFreshObsSessionCounters(after.message, "new_session");
}

function parseObsSessionId(message) {
  const match = /^Session: (session-[^\s]+)/mu.exec(message);
  assert.ok(match?.[1], "/obs session should include a concrete session id");
  return match[1];
}

function assertFreshObsSessionCounters(message, lifecycleName) {
  assert.match(message, /^Turns: 0$/mu, `/obs session should reset turn count after ${lifecycleName}`);
  assert.match(message, /^LLM calls: 0$/mu, `/obs session should reset LLM count after ${lifecycleName}`);
  assert.match(message, /^Tool calls: 0$/mu, `/obs session should reset tool count after ${lifecycleName}`);
}

async function assertObsHealthCommand(client) {
  const notification = client.waitForNotifyMessage("Collector:");
  await client.request({ type: "prompt", message: "/obs health" });
  const message = await notification;

  assert.match(message, /Collector: reachable/u, "/obs health should verify the configured Collector endpoint");
  assert.match(message, /Grafana: reachable/u, "/obs health should verify configured Grafana auth and reachability");
  assert.match(message, /Tempo datasource: ok/u, "/obs health should verify the Tempo datasource");
  assert.match(message, /Loki datasource: ok/u, "/obs health should verify the Loki datasource");
  assert.match(message, /Metrics datasource: ok/u, "/obs health should verify the Prometheus datasource");
}

async function assertObsCostTimeoutCommand(client, backend) {
  const notification = client.waitForNotifyMessage("ObservMe cost unavailable:");
  const startedAtMs = Date.now();

  backend.delayPrometheusQueries(2_000);
  try {
    await client.request({ type: "prompt", message: "/obs cost" });
    const message = await notification;
    const elapsedMs = Date.now() - startedAtMs;

    assert.match(message, /Prometheus query timed out\./u, "/obs cost should surface the query timeout reason");
    assert.ok(elapsedMs < 1_500, `/obs cost should complete within the bounded query timeout, got ${elapsedMs}ms`);
  } finally {
    backend.delayPrometheusQueries(0);
  }
}

async function assertPiRuntimeEventShapeCoverage(client) {
  await assertSmokeModelAvailable(client);
  await assertSmokeModelSelectionCommand(client);

  const startIndex = client.recordCount();
  await client.request({ type: "prompt", message: "Use the smoke provider read tool once." });
  await client.waitForRecordAfter(record => record?.type === "agent_end", "mock provider agent_end", startIndex);
  await assertUserBashContractFromInstalledPiTypes();

  const report = await readSmokeEventShapeReport(client);
  assertSmokeEventShapeReport(report);
}

async function assertSmokeModelAvailable(client) {
  const response = await client.request({ type: "get_available_models" });
  const models = response.data?.models ?? [];
  const hasSmokeModel = models.some(model => model.provider === "observme-smoke" && model.id === "offline");

  assert.equal(hasSmokeModel, true, "real Pi model registry should include the credential-free ObservMe smoke provider");
}

async function assertSmokeModelSelectionCommand(client) {
  const prefix = "ObservMe smoke model selection: ";
  const notification = client.waitForNotifyMessage(prefix);

  await client.request({ type: "prompt", message: "/observme-smoke-select-model" });
  const message = await notification;
  const result = JSON.parse(message.slice(prefix.length));

  assert.deepEqual(
    result,
    { alternateFound: true, alternateSelected: true, modelFound: true, selected: true },
    "smoke extension command should select the deterministic provider without credentials",
  );
}

async function readSmokeEventShapeReport(client) {
  const prefix = "ObservMe smoke event shapes: ";
  const notification = client.waitForNotifyMessage(prefix);

  await client.request({ type: "prompt", message: "/observme-smoke-event-shapes" });
  const message = await notification;

  return JSON.parse(message.slice(prefix.length));
}

function assertSmokeEventShapeReport(report) {
  assert.equal(report.version, 1, "event-shape smoke report should use the expected schema version");
  assertRequiredEventShapes(report);
  assertUserBashBlocker(report);
  assertToolLifecycleShapes(report.events);
  assertModelAndThinkingShapes(report.events);
  assertAgentTurnShapes(report.events);
  assertEventShapeReportIsSanitized(report);
}

function assertRequiredEventShapes(report) {
  for (const eventName of ["session_start", "tool_execution_start", "tool_call", "tool_result", "tool_execution_end", "message_end", "model_select", "thinking_level_select", "agent_start", "turn_start", "turn_end", "agent_end"]) {
    assert.ok(report.events[eventName], `event-shape smoke should observe ${eventName}`);
    assert.ok(report.counts[eventName] >= 1, `event-shape smoke should count ${eventName}`);
  }

  assert.equal(
    typeof report.fixtureBackedEvents?.session_compact,
    "string",
    "credential-free event smoke should document session_compact fixture coverage instead of making live model-dependent compaction calls",
  );
  assert.equal(
    typeof report.fixtureBackedEvents?.session_tree,
    "string",
    "credential-free event smoke should document session_tree fixture coverage instead of requiring interactive tree navigation",
  );
}

async function assertUserBashContractFromInstalledPiTypes() {
  const typesPath = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "extensions", "types.d.ts");
  const types = await readFile(typesPath, "utf8");
  const match = /export interface UserBashEvent \{(?<body>[\s\S]*?)\n\}/u.exec(types);
  const body = match?.groups?.body ?? "";

  assert.ok(body, "installed Pi types should expose UserBashEvent for interactive !/!! compatibility checks");
  assert.match(body, /command:\s*string/u, "UserBashEvent should expose a command string");
  assert.match(body, /excludeFromContext:\s*boolean/u, "UserBashEvent should expose whether !! excluded the command from context");
  assert.match(body, /cwd:\s*string/u, "UserBashEvent should expose cwd");
  assert.doesNotMatch(body, /\b(result|output|exitCode|truncated|cancelled)\b/u, "UserBashEvent should remain a pre-execution event without completed-result fields");
}

function assertUserBashBlocker(report) {
  assert.equal(report.events.user_bash, undefined, "RPC event-shape smoke should not synthesize user_bash events");
  assert.equal(
    typeof report.fixtureBackedEvents?.user_bash,
    "string",
    "event-shape smoke should document the interactive user_bash blocker and rely on the installed Pi type-contract check",
  );
}

function assertToolLifecycleShapes(events) {
  assert.equal(events.tool_execution_start.toolCallIdType, "string", "tool_execution_start should expose a toolCallId");
  assert.equal(events.tool_execution_start.toolName, "read", "tool_execution_start should expose the built-in read tool name");
  assert.deepEqual(events.tool_execution_start.argumentKeys, ["path"], "tool_execution_start should expose sanitized read argument keys");

  assert.equal(events.tool_call.toolCallIdType, "string", "tool_call should expose a toolCallId");
  assert.equal(events.tool_call.toolName, "read", "tool_call should expose the built-in read tool name");
  assert.deepEqual(events.tool_call.argumentKeys, ["path"], "tool_call should expose sanitized input keys for ObservMe parser compatibility");

  assert.equal(events.tool_result.toolCallIdType, "string", "tool_result should expose a toolCallId");
  assert.equal(events.tool_result.toolName, "read", "tool_result should expose the built-in read tool name");
  assert.equal(events.tool_result.hasResultPayload, true, "tool_result should expose a result/content payload");
  assert.ok(events.tool_result.resultContentTypes.includes("text"), "tool_result should expose text content without raw output in the shape report");

  assert.equal(events.tool_execution_end.toolCallIdType, "string", "tool_execution_end should expose a toolCallId");
  assert.equal(events.tool_execution_end.toolName, "read", "tool_execution_end should expose the built-in read tool name");
  assert.equal(events.tool_execution_end.hasResultPayload, true, "tool_execution_end should expose a final result payload");
  assert.equal(events.tool_execution_end.isErrorType, "boolean", "tool_execution_end should expose boolean isError for parser failure detection");
}

function assertModelAndThinkingShapes(events) {
  assert.equal(events.model_select.provider, "observme-smoke", "model_select should expose the selected provider");
  assert.equal(events.model_select.modelId, "offline", "model_select should expose the selected model id");
  assert.equal(events.thinking_level_select.level, "high", "thinking_level_select should expose the selected thinking level");
}

function assertAgentTurnShapes(events) {
  assert.ok(events.agent_start.keys.includes("type"), "agent_start should expose its current runtime event type");
  assert.equal(events.message_end.role, "assistant", "message_end should expose the finalized assistant message role");
  assert.ok(events.message_end.contentTypes.includes("text"), "message_end should expose assistant content block types");
  assert.ok(events.message_end.usageKeys.includes("input"), "message_end should expose usage keys");
  assert.equal(events.turn_end.hasMessage, true, "turn_end should expose the finalized assistant turn message");
  assert.ok(events.agent_end.messageCount >= 1, "agent_end should expose generated message count");
}

function assertEventShapeReportIsSanitized(report) {
  const serialized = JSON.stringify(report);

  assert.doesNotMatch(serialized, /Use the smoke provider read tool once\./u, "event-shape report should not contain raw prompts");
  assert.doesNotMatch(serialized, /observme-user-bash-shape/u, "event-shape report should not contain raw user bash commands");
  assert.doesNotMatch(serialized, /ObservMe smoke fixture input\./u, "event-shape report should not contain raw tool output");
}

async function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null) return;

  const timeout = wait(timeoutMs);
  await Promise.race([once(child, "exit"), timeout]);
}

async function wait(timeoutMs) {
  await new Promise(resolvePromise => {
    const timeout = setTimeout(resolvePromise, timeoutMs);
    timeout.unref?.();
  });
}

async function removeTemporaryRoot(rootDir) {
  if (!rootDir) return;
  await rm(rootDir, { recursive: true, force: true });
}

function isResponseForId(record, id) {
  return record?.type === "response" && record.id === id;
}

function isNotifyMessageWithPrefix(record, prefix) {
  return record?.type === "extension_ui_request" && record.method === "notify" && typeof record.message === "string" && record.message.startsWith(prefix);
}

function isObservMeLoadedStatus(record) {
  return record?.type === "extension_ui_request" && record.method === "setStatus" && record.statusKey === "observme" && record.statusText === "🧿";
}

function isObservMeClearedStatus(record) {
  return (
    record?.type === "extension_ui_request" &&
    record.method === "setStatus" &&
    record.statusKey === "observme" &&
    (record.statusText === undefined || record.statusText === null)
  );
}

function writeJsonResponse(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function writeTextResponse(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "text/plain" });
  response.end(body);
}

function stripTrailingCarriageReturn(line) {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function formatExit(code, signal) {
  if (code !== null && code !== undefined) return `code ${code}`;
  return `signal ${signal ?? "unknown"}`;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

await main();
