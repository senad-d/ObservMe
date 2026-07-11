# ObservMe Extension Implementation Blueprint

## 1. Runtime Assumptions

ObservMe is a TypeScript Pi extension loaded by Pi. It registers event handlers and commands using Pi's extension API, initializes OpenTelemetry SDK components only after `session_start`, and exports telemetry to an OTLP endpoint.

Pi extension factories may run in invocations that never start a session. Therefore ObservMe must not start background resources such as metric readers, exporter timers, sockets, or file watchers directly from the factory. The factory should register handlers and commands; session-scoped telemetry startup belongs in `session_start`, and cleanup belongs in `session_shutdown`.

## 2. Repository Layout

```text
observme/
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── index.ts                    # Pi extension entrypoint
│   ├── config/
│   │   ├── load-config.ts
│   │   ├── schema.ts
│   │   └── defaults.ts
│   ├── otel/
│   │   ├── sdk.ts
│   │   ├── traces.ts
│   │   ├── metrics.ts
│   │   ├── logs.ts
│   │   └── shutdown.ts
│   ├── pi/
│   │   ├── handlers.ts
│   │   ├── session.ts
│   │   ├── event-normalizer.ts
│   │   ├── agent-lineage.ts
│   │   ├── agent-tree-tracker.ts
│   │   └── turn-tracker.ts
│   ├── semconv/
│   │   ├── attributes.ts
│   │   ├── metrics.ts
│   │   └── spans.ts
│   ├── privacy/
│   │   ├── redact.ts
│   │   ├── secret-patterns.ts
│   │   ├── hash.ts
│   │   └── truncate.ts
│   ├── commands/
│   │   ├── obs-status.ts
│   │   ├── obs-health.ts
│   │   ├── obs-session.ts
│   │   ├── obs-cost.ts
│   │   ├── obs-agents.ts
│   │   └── obs-link.ts
│   ├── query/
│   │   ├── grafana.ts
│   │   ├── tempo.ts
│   │   ├── loki.ts
│   │   └── prometheus.ts
│   └── util/
│       ├── safe-json.ts
│       ├── time.ts
│       ├── trace-context.ts
│       └── bounded-map.ts
└── test/
    ├── redaction.test.ts
    ├── event-mapping.test.ts
    ├── metrics.test.ts
    ├── exporter-failure.test.ts
    ├── agent-lineage.test.ts
    └── cardinality.test.ts
```

## 3. Dependencies

Required:

```json
{
  "dependencies": {
    "@opentelemetry/api": "1.x",
    "@opentelemetry/api-logs": "0.x",
    "@opentelemetry/sdk-node": "0.x",
    "@opentelemetry/sdk-trace-node": "2.x",
    "@opentelemetry/sdk-metrics": "2.x",
    "@opentelemetry/sdk-logs": "0.x",
    "@opentelemetry/exporter-trace-otlp-proto": "0.x",
    "@opentelemetry/exporter-metrics-otlp-proto": "0.x",
    "@opentelemetry/exporter-logs-otlp-proto": "0.x",
    "@opentelemetry/resources": "2.x",
    "@opentelemetry/semantic-conventions": "1.x"
  },
  "devDependencies": {
    "typescript": "^5.x",
    "vitest": "^latest"
  }
}
```

Pin exact versions in production and test upgrades before release. Do not assume all `@opentelemetry/*` packages share the same major version; OpenTelemetry JS commonly mixes stable API packages with SDK/exporter packages on different major/minor lines. Use the `*-otlp-proto` exporters for OTLP/HTTP protobuf per current OpenTelemetry JS docs, or the `*-otlp-grpc` exporters when using gRPC.

## 4. Entrypoint Pattern

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadBootstrapConfig, loadSessionConfig } from "./config/load-config";
import { createRuntime } from "./runtime";
import { registerHandlers } from "./pi/handlers";
import { registerObsCommands } from "./commands";

export default async function observme(pi: ExtensionAPI) {
  const bootstrapConfig = await loadBootstrapConfig();
  const runtime = createRuntime(bootstrapConfig);

  // Register handlers and commands in the factory, but defer OTEL SDK startup
  // until session_start so background exporters/timers are session-scoped.
  registerHandlers(pi, runtime, loadSessionConfig);
  registerObsCommands(pi, runtime);
}
```

## 5. Telemetry Runtime Interface

```typescript
export interface ObservMeTelemetry {
  tracer: Tracer;
  meter: Meter;
  logger: Logger;
  metrics: ObservMeMetrics;
  spans: SpanRegistry;
  agent: AgentLineageContext;
  flush(timeoutMs: number): Promise<void>;
  shutdown(timeoutMs: number): Promise<void>;
}

export interface AgentLineageContext {
  workflowId: string;
  workflowRootAgentId: string;
  agentId: string;
  parentAgentId?: string;
  rootAgentId: string;
  depth: number;
  role: "root" | "subagent" | "orchestrator" | "worker" | "reviewer" | "unknown";
  capability?: string;
}
```

## 6. Span Registry

Track active spans in memory only.

```typescript
type SpanKey = string;

interface SpanRegistry {
  sessionSpan?: Span;
  activeAgentRuns: Map<string, Span>;
  activeTurns: Map<string, Span>;
  activeToolCalls: Map<string, Span>;
  activeLlmRequests: Map<string, Span>;
  activeSubagentSpawns: Map<string, Span>;
  activeAgentWaits: Map<string, Span>;
  activeAgentJoins: Map<string, Span>;
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

### Session Start

```typescript
pi.on("session_start", async (event, ctx) => {
  // Load session-scoped config with ctx.cwd. Only read project-local config when
  // ctx.isProjectTrusted() is true; otherwise use global/env/default config.
  const config = await loadSessionConfig(ctx, runtime.bootstrapConfig);
  const agent = buildAgentLineageContext(config, process.env);
  const telemetry = await runtime.startSession(config, agent, ctx);

  const attrs = buildSessionAttributes(event, ctx, agent);
  telemetry.spans.sessionSpan = telemetry.tracer.startSpan("pi.session", { attributes: attrs });
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
    telemetry.spans.sessionSpan,
    "pi.agent.run",
    buildAgentRunAttributes(runId, ctx, telemetry.agent),
  );
  telemetry.spans.activeAgentRuns.set(runId, span);
  telemetry.metrics.agentRuns.add(1, metricLabels(ctx, telemetry.agent));
});

pi.on("turn_start", async (event, ctx) => {
  const telemetry = runtime.telemetryOrNoop();
  const runSpan = currentAgentRunSpan(ctx) ?? telemetry.spans.sessionSpan;
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
  const parent = telemetry.spans.activeTurns.get(turnId) ?? currentAgentRunSpan(ctx) ?? telemetry.spans.sessionSpan;
  // Pi's event exposes the provider-specific payload; use ctx.model plus safe payload inspection.
  const span = startChildSpan(parent, "pi.llm.request", buildLlmRequestAttrs(event.payload, ctx.model, ctx));
  telemetry.spans.activeLlmRequests.set(makeLlmKey(event, ctx), span);
});
```

### Tool Execution Start and Tool Call Metadata

```typescript
pi.on("tool_execution_start", async (event, ctx) => {
  const telemetry = runtime.telemetryOrNoop();
  const parent = currentTurnSpan(ctx) ?? currentAgentRunSpan(ctx) ?? telemetry.spans.sessionSpan;
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

There is no dedicated Pi event for "subagent spawned". Detect this at the point ObservMe wraps a subagent tool/command or an extension intentionally launches another Pi process.

```typescript
async function runSubagent(command: string, args: string[], ctx: ExtensionContext) {
  const telemetry = runtime.telemetryOrNoop();
  const spawnId = newSpawnId();
  const parent = currentTurnSpan(ctx) ?? currentAgentRunSpan(ctx) ?? telemetry.spans.sessionSpan;
  const span = startChildSpan(parent, "pi.agent.spawn", buildSpawnAttrs(spawnId, ctx, telemetry.agent));

  const env = buildChildEnv(process.env, telemetry.agent, span.spanContext(), spawnId);
  recordAgentTreeSpawn(telemetry, spawnId, ctx);
  try {
    telemetry.metrics.subagentsSpawned.add(1, { agent_role: "subagent", spawn_type: "command" });
    // Use a child_process/spawn helper or tool operation that supports explicit env.
    // pi.exec() is useful for simple commands but does not currently accept env.
    return await spawnProcessWithEnv(command, args, { env, signal: ctx.signal });
  } catch (err) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: safeErrorClass(err) });
    telemetry.metrics.subagentSpawnFailures.add(1, { spawn_type: "command", error_class: safeErrorClass(err) });
    throw err;
  } finally {
    span.end();
  }
}
```

Propagate W3C `traceparent`/`tracestate`, `OBSERVME_WORKFLOW_ID`, `OBSERVME_PARENT_AGENT_ID`, `OBSERVME_ROOT_AGENT_ID`, `OBSERVME_PARENT_SESSION_ID`, `OBSERVME_AGENT_DEPTH`, and `OBSERVME_SPAWN_ID`. Do not place raw command lines or inherited environment values into telemetry.

When the parent waits for a child or receives child results, create `pi.agent.wait` and `pi.agent.join` spans/events with child status, propagated-failure status, active-child count, and join status. These spans make the critical path visible in orchestrator traces.

### Session Shutdown

```typescript
pi.on("session_shutdown", async (_event, _ctx) => {
  const telemetry = runtime.telemetryOrNoop();
  endAllActiveSpans(telemetry.spans);
  telemetry.spans.sessionSpan?.end();
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
4. Environment variables
5. CLI or Pi extension options if available

Factory-safe config loading may read only defaults, global config, and environment variables. Session-scoped loading on `session_start` may add trusted project config because it has access to `ctx.cwd` and `ctx.isProjectTrusted()`. Reapply environment/runtime overrides after project config so the precedence order remains correct.

## 12. Backfill Command

Backfill is optional and disabled by default.

Command:

```text
/obs backfill --current-session --since 1h
```

Rules:

- Mark telemetry with `observme.replayed=true`
- Do not backfill content unless capture settings allow it
- Rate limit export
- Confirm with user before sending historical content

## 13. Inter-extension integration

Other Pi extensions must not import ObservMe's private telemetry session or `src/pi/subagent-spawn.ts` directly. ObservMe exposes a versioned request/response API through Pi's shared `pi.events` bus and the `@senad-d/observme/integration` package export.

The public API covers current context plus subagent spawn, launcher completion/failure, wait, and join transitions. `startSubagent()` returns the sanitized process environment that the launcher passes to the child. Runtime negotiation lets an orchestrator remain optional when ObservMe is absent or inactive.

See [`../extension-integration.md`](../extension-integration.md) for the public contract and [`../../examples/integrations/subagent-runner.ts`](../../examples/integrations/subagent-runner.ts) for a transport-agnostic consumer example.

## 14. Versioning

Extension versioning:

```text
MAJOR.MINOR.PATCH
```

Breaking semantic-convention changes require MAJOR. Incompatible inter-extension API changes require a newly negotiated integration API version.

## 15. Package surface

The published Pi package includes:

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
