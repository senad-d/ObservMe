# ObservMe Extension Implementation Blueprint

## 1. Runtime Assumptions

ObservMe is a TypeScript Pi extension loaded by Pi. It registers event handlers and commands using Pi's extension API, initializes OpenTelemetry SDK components only after `session_start`, and exports telemetry to an OTLP endpoint.

Pi extension factories may run in invocations that never start a session. Therefore ObservMe must not start background resources such as metric readers, exporter timers, sockets, or file watchers directly from the factory. The factory should register handlers and commands; session-scoped telemetry startup belongs in `session_start`, and cleanup belongs in `session_shutdown`.

## 2. Repository Layout

```text
observme/
├── src/
│   ├── extension.ts               # Pi extension entrypoint
│   ├── integration.ts             # public inter-extension API/types
│   ├── commands/                  # /obs routing and subcommands
│   ├── config/                    # defaults, schema, loading, validation, bootstrap
│   ├── diagnostics/               # bounded diagnostic sanitization
│   ├── otel/                      # session-scoped traces, metrics, logs, shutdown
│   ├── pi/
│   │   ├── event-handlers/        # lifecycle, agent/turn, LLM, tool/Bash, session
│   │   ├── handlers.ts            # registration facade
│   │   ├── handler-runtime.ts     # runtime state and metric instruments
│   │   ├── handler-internals.ts   # event mapping helpers
│   │   ├── agent-lineage.ts
│   │   ├── agent-tree-tracker.ts
│   │   ├── integration-api.ts
│   │   └── subagent-spawn.ts
│   ├── privacy/                   # capture policy, redaction, hashing, truncation
│   ├── query/                     # Grafana, Tempo, Loki, Prometheus clients
│   ├── safety/                    # display and query-input bounds
│   ├── semconv/                   # attributes, metric/event names, span names
│   └── util/                      # bounded data structures
├── test/                          # unit, contract, smoke-support, and integration tests
├── dashboards/                    # Grafana dashboards, alerts, and SLOs
├── examples/                      # extension and Collector examples
├── skills/observme-docs/          # packaged documentation router
└── observability-stack/           # repository-only local Docker Compose stack
```

[`../STRUCTURE.md`](../STRUCTURE.md) gives the maintained directory map. File names in this blueprint are descriptive only when explicitly shown above; use the repository tree and `package.json` as the package-surface source of truth.

## 3. Dependencies

`package.json` and `package-lock.json` are authoritative. The current runtime uses the OpenTelemetry API/API-logs packages, resources, trace/metric/log SDK packages, and the three `*-otlp-proto` exporters. It does **not** depend on `@opentelemetry/sdk-node`, `@opentelemetry/semantic-conventions`, a gRPC exporter, or Vitest. Tests use Node's built-in test runner, and TypeScript is pinned in development dependencies.

Pi core packages and TypeBox are peer dependencies. Exact tested versions and the mixed OpenTelemetry package version lines are recorded in [`../compatibility-matrix.md`](../compatibility-matrix.md); do not infer one shared OpenTelemetry major version.

## 4. Entrypoint Pattern

The synchronous factory in `src/extension.ts` checks required Pi API capabilities, registers event handlers, and registers the single `/obs` root command. It does not load project config or start OpenTelemetry resources:

```typescript
export default function observme(pi: ExtensionAPI): void {
  assertObservMePiCapabilities(pi);
  registerHandlers(pi, { trustedParentContext: true });
  registerObsCommandWithPartialInitializationDiagnostic(pi);
}
```

`registerObsCommand()` owns all subcommand dispatch. OpenTelemetry startup and trusted project config loading occur from `session_start`; bounded cleanup occurs from `session_shutdown`.

## 5. Telemetry Runtime Interface

The internal `ObservMeTelemetrySession` in `src/pi/handler-types.ts` owns the effective config, validated lineage, scoped OpenTelemetry objects, metrics, bounded registries, optional lease controller, root span, and active correlation state. Flush and shutdown are methods on its controller:

```typescript
interface ObservMeTelemetrySession {
  readonly config: ObservMeConfig;
  readonly lineage: AgentLineageContext;
  readonly controller: Pick<ObservMeOtelSdkController, "flush" | "shutdown">;
  readonly tracer: TelemetryTracer;
  readonly meter: TelemetryMeter;
  readonly logger: TelemetryLogger;
  readonly metrics: ObservMeMetrics;
  readonly spans: SpanRegistry;
  readonly activeAgentLease?: ActiveAgentLeaseController;
  sessionSpan?: Span;
  sessionAttributes?: AttributeMap;
  agentTree: AgentTreeTracker;
}
```

This is private implementation state, not part of the `@senad-d/observme/integration` public API.

## 6. Span Registry

Track active spans in memory only.

`ObservMeTelemetrySession.sessionSpan` stores the root span separately. `SpanRegistry` uses `BoundedMap` instances; simple lifecycles store spans, while tools, spawns, waits, and joins store state objects that include the span plus bounded correlation/timing data:

```typescript
interface SpanRegistry {
  activeAgentRuns: BoundedMap<string, Span>;
  activeTurns: BoundedMap<string, Span>;
  activeLlmRequests: BoundedMap<string, Span>;
  activeToolCalls: BoundedMap<string, ToolCallState>;
  activeSubagentSpawns: BoundedMap<string, SubagentSpawnState>;
  activeAgentWaits: BoundedMap<string, AgentWaitJoinState>;
  activeAgentJoins: BoundedMap<string, AgentWaitJoinState>;
}
```

Bound all maps:

```yaml
limits:
  maxActiveAgentRuns: 16
  maxActiveTurns: 128
  maxActiveToolCalls: 1024
  maxActiveLlmRequests: 128
  maxActiveSubagentSpawns: 128
  maxActiveAgentWaits: 128
  maxActiveAgentJoins: 128
```

When exceeded:

- End oldest span with error status `observme.evicted=true`
- Increment `observme_telemetry_dropped_total{reason="span_registry_full"}`

## 7. Event Handler Design

The snippets below are behavioral pseudocode, not importable public APIs. The live implementation is split across `src/pi/event-handlers/`, `src/pi/handler-runtime.ts`, and `src/pi/handler-internals.ts`.

### Session Start

```typescript
pi.on("session_start", async (event, ctx) => {
  // Load session-scoped config with ctx.cwd. Only read project-local config when
  // ctx.isProjectTrusted() is true; otherwise use global/env/default config.
  const config = await loadSessionConfig({ ctx, cwd: ctx.cwd });
  const agent = buildAgentLineageContext(config, process.env);
  const telemetry = await runtime.startSession(config, agent, ctx);

  const attrs = buildSessionAttributes(event, ctx, agent);
  telemetry.sessionSpan = telemetry.tracer.startSpan("pi.session", { attributes: attrs });
  telemetry.metrics.sessionsStarted.add(1, metricLabels(ctx, agent));
  if (agent.role === "root" || agent.role === "orchestrator") {
    telemetry.metrics.workflowsStarted.add(1, workflowMetricLabels(ctx, agent));
    emitLog("workflow.started", attrs);
  }
  telemetry.metrics.activeAgents.add(1, metricLabels(ctx, agent));
  emitLog("session.started", attrs);
});
```

### Agent Run and Turn Start

```typescript
pi.on("agent_start", async (_event, ctx) => {
  const telemetry = runtime.telemetryOrNoop();
  const runId = nextAgentRunId(ctx, telemetry.agent);
  const span = startChildSpan(
    telemetry.sessionSpan,
    "pi.agent.run",
    buildAgentRunAttributes(runId, ctx, telemetry.agent),
  );
  telemetry.spans.activeAgentRuns.set(runId, span);
  telemetry.metrics.agentRuns.add(1, metricLabels(ctx, telemetry.agent));
});

pi.on("turn_start", async (event, ctx) => {
  const telemetry = runtime.telemetryOrNoop();
  const runSpan = currentAgentRunSpan(ctx) ?? telemetry.sessionSpan;
  const turnId = getTurnId(event, ctx, currentAgentRunId(ctx));
  const span = startChildSpan(runSpan, "pi.turn", buildTurnAttributes(event, ctx, telemetry.agent));
  telemetry.spans.activeTurns.set(turnId, span);
  telemetry.metrics.turnsStarted.add(1, metricLabels(ctx, telemetry.agent));
});

pi.on("turn_end", async (event, ctx) => {
  const telemetry = runtime.telemetryOrNoop();
  const turnId = getTurnId(event, ctx, currentAgentRunId(ctx));
  const span = telemetry.spans.activeTurns.get(turnId);
  span?.setAttributes(buildTurnEndAttributes(event, ctx));
  span?.end();
  telemetry.spans.activeTurns.delete(turnId);
});

pi.on("agent_end", async (_event, ctx) => {
  const telemetry = runtime.telemetryOrNoop();
  const runId = currentAgentRunId(ctx);
  const span = telemetry.spans.activeAgentRuns.get(runId);
  span?.end();
  telemetry.spans.activeAgentRuns.delete(runId);
});
```

### Provider Request

```typescript
pi.on("before_provider_request", async (event, ctx) => {
  const telemetry = runtime.telemetryOrNoop();
  const turnId = currentTurnId(ctx);
  const parent = telemetry.spans.activeTurns.get(turnId) ?? currentAgentRunSpan(ctx) ?? telemetry.sessionSpan;
  // Pi's event exposes the provider-specific payload; use ctx.model plus safe payload inspection.
  const span = startChildSpan(parent, "pi.llm.request", buildLlmRequestAttrs(event.payload, ctx.model, ctx));
  telemetry.spans.activeLlmRequests.set(makeLlmKey(event, ctx), span);
});
```

### Tool Execution Start and Tool Call Metadata

```typescript
pi.on("tool_execution_start", async (event, ctx) => {
  const telemetry = runtime.telemetryOrNoop();
  const parent = currentTurnSpan(ctx) ?? currentAgentRunSpan(ctx) ?? telemetry.sessionSpan;
  const span = startChildSpan(parent, "pi.tool.call", buildToolExecutionAttrs(event, ctx, telemetry.agent));
  telemetry.spans.activeToolCalls.set(event.toolCallId, span);
  telemetry.metrics.toolCalls.add(1, { tool_name: safeToolName(event.toolName), agent_role: telemetry.agent.role });
});

pi.on("tool_call", async (event, ctx) => {
  const telemetry = runtime.telemetryOrNoop();
  const span = telemetry.spans.activeToolCalls.get(event.toolCallId);
  span?.setAttributes(buildToolCallInputAttrs(event, ctx));
});

pi.on("tool_execution_end", async (event, ctx) => {
  const telemetry = runtime.telemetryOrNoop();
  const span = telemetry.spans.activeToolCalls.get(event.toolCallId);
  span?.setAttributes(buildToolResultAttrs(event, ctx));
  if (event.isError) span?.setStatus({ code: SpanStatusCode.ERROR, message: safeErrorClass(event.result) });
  span?.end();
  telemetry.spans.activeToolCalls.delete(event.toolCallId);
});
```

### Subagent Spawn

There is no dedicated Pi event for "subagent spawned", and ObservMe does not launch child processes itself. An orchestrator requests the public versioned API and calls it around its own transport:

```typescript
const observme = requestObservMeIntegration(pi);
const started = observme?.startSubagent({
  command: "pi",
  spawnType: "extension",
  spawnReason: "delegated_task",
  env: process.env,
});

if (started?.ok) {
  await launchChildPi({ env: started.env });
}
```

The returned environment contains the validated ObservMe lineage fields and W3C `traceparent`/`tracestate` when enabled. The launcher must pass it unchanged and must not log command lines or environment values. Launcher failure uses `failSubagent()`; terminal child completion uses `completeSubagent()`. See [`../extension-integration.md`](../extension-integration.md) for the complete transition contract.

When the parent waits for a child or receives child results, create `pi.agent.wait` and `pi.agent.join` spans/events with child status, propagated-failure status, active-child count, and join status. These spans make the critical path visible in orchestrator traces.

### Session Shutdown

```typescript
pi.on("session_shutdown", async (_event, _ctx) => {
  const telemetry = runtime.telemetryOrNoop();
  endAllActiveSpans(telemetry.spans);
  telemetry.sessionSpan?.end();
  await withTimeout(runtime.shutdownSession(), runtime.config.shutdown.flushTimeoutMs);
});
```

## 8. Handling Assistant Messages

Assistant messages are important because finalized `message_end` events contain provider/model metadata, usage, stop reason, diagnostics, tool calls, and cost. ObservMe should update and end the active GenAI span from the finalized assistant message, not from partial streaming data alone.

Pseudo-flow:

```typescript
function onAssistantMessage(message: AssistantMessage, context: PiContext) {
  const span = findCurrentLlmSpan(context);
  span?.setAttributes(extractUsageAttributes(message.usage));
  span?.setAttribute("pi.llm.stop_reason", message.stopReason);
  span?.setAttribute("gen_ai.response.finish_reasons", [mapStopReason(message.stopReason)]);

  metrics.inputTokens.add(message.usage.input, labels);
  metrics.outputTokens.add(message.usage.output, labels);
  metrics.cacheReadTokens.add(message.usage.cacheRead, labels);
  metrics.cacheWriteTokens.add(message.usage.cacheWrite, labels);
  if (message.usage.cacheWrite1h !== undefined) metrics.cacheWrite1hTokens.add(message.usage.cacheWrite1h, labels);
  if (message.usage.reasoning !== undefined) metrics.reasoningTokens.add(message.usage.reasoning, labels);
  metrics.totalCost.add(message.usage.cost.total, labels);

  if (message.stopReason === "error") {
    span?.setAttribute("error.type", classifyError(message.errorMessage));
    span?.setAttribute("pi.llm.error_message_hash", hashError(message.errorMessage));
    span?.setStatus({ code: SpanStatusCode.ERROR });
    metrics.llmErrors.add(1, labels);
  }

  span?.end();
}
```

## 9. Logs

Use OTEL logs for structured event streams.

```typescript
logger.emit({
  severityText: "INFO",
  body: "tool.call.completed",
  attributes: {
    "event.name": "tool.call.completed",
    "pi.session.id": sessionId,
    "pi.agent.id": agentId,
    "pi.agent.run.id": agentRunId,
    "pi.turn.id": turnId,
    "pi.tool.name": toolName,
    "pi.tool.success": success,
  },
});
```

## 10. Error Handling

All handlers must catch errors.

```typescript
function safeHandler(name: string, fn: Handler): Handler {
  return async (event, ctx) => {
    try {
      await fn(event, ctx);
    } catch (err) {
      recordInternalError(name, err);
    }
  };
}
```

Never throw from an ObservMe event handler into Pi.

## 11. Config Loading Order

1. Built-in defaults
2. Global config `~/.pi/agent/observme.yaml`
3. Project config `<cwd>/<CONFIG_DIR_NAME>/observme.yaml` only when `ctx.isProjectTrusted()` is true (normally `.pi/observme.yaml`; use Pi's exported `CONFIG_DIR_NAME` instead of hardcoding `.pi`)
4. Trusted project `<cwd>/.env`
5. System environment variables
6. Explicit runtime options

Factory-safe config loading reads defaults, global config, system environment variables, and runtime options. Session-scoped loading on `session_start` may add trusted project config and `.env` because it has `ctx.cwd` and `ctx.isProjectTrusted()`. System environment values override trusted `.env`, and runtime options remain highest precedence.

## 12. Backfill Command

The backfill subcommand is registered by default, but every run is explicit and confirmation-gated. It exports current-session OTEL log records only and skips when ObservMe, log export, interactive confirmation, or current session state is unavailable.

Command:

```text
/obs backfill --current-session --since 1h
```

Rules:

- Mark telemetry with `observme.replayed=true`
- Do not backfill content unless capture settings allow it
- Require `--current-session` and interactive confirmation before export
- Accept an optional positive `--since` duration up to 30 days
- Export at most 100 records by default and bound cancellation/operations
- Do not reconstruct historical traces or metrics

## 13. Inter-extension integration

Other Pi extensions must not import ObservMe's private telemetry session or `src/pi/subagent-spawn.ts` directly. ObservMe exposes a versioned request/response API through Pi's shared `pi.events` bus and the `@senad-d/observme/integration` package export.

The public API covers current context plus subagent start, launcher failure, terminal child completion, wait, and join transitions. `startSubagent()` returns the sanitized process environment that the launcher passes to the child. Runtime negotiation lets an orchestrator remain optional when ObservMe is absent or inactive.

See [`../extension-integration.md`](../extension-integration.md) for the public contract and [`../../examples/integrations/subagent-runner.ts`](../../examples/integrations/subagent-runner.ts) for a transport-agnostic consumer example.

## 14. Versioning

Extension versioning:

```text
MAJOR.MINOR.PATCH
```

Breaking semantic-convention changes require MAJOR. Incompatible inter-extension API changes require a newly negotiated integration API version.

## 15. Package surface

Selected published Pi package paths include:

```text
src/extension.ts                         # Pi extension entry
src/integration.ts                       # public inter-extension types and discovery helper
skills/observme-docs/SKILL.md            # progressive documentation routing
docs/extension-integration.md            # integration contract
examples/integrations/subagent-runner.ts
examples/observme.yaml
examples/collector.yaml
dashboards/*
```
