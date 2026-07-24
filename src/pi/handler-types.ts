import type { Counter, Histogram, Meter, ObservableGauge, Span, Tracer, UpDownCounter } from "@opentelemetry/api";
import type { Logger } from "@opentelemetry/api-logs";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionEvent,
} from "@earendil-works/pi-coding-agent";
import type { EnsureProjectConfig as BootstrapEnsureProjectConfig } from "../config/bootstrap-project-config.ts";
import type {
  LoadSessionConfigOptions,
  LoadSessionConfigResult,
  SessionConfigDiagnostics,
} from "../config/load-config.ts";
import type { ObservMeConfig } from "../config/schema.ts";
import type { ObservMeLogSdk } from "../otel/logs.ts";
import type { ObservMeMetricSdk } from "../otel/metrics.ts";
import type { ObservMeOtelSdkController } from "../otel/sdk.ts";
import type { ObservMeTraceSdk } from "../otel/traces.ts";
import type { BoundedMap } from "../util/bounded-map.ts";
import type { AgentLineageContext } from "./agent-lineage.ts";
import type { ActiveAgentLeaseController } from "./active-agent-lease.ts";
import type { AgentTreeTracker } from "./agent-tree-tracker.ts";
import type { OtelOperationOwnership } from "./otel-operation-ownership.ts";
import type {
  AgentWaitJoinState,
  ChildFailureAccountingState,
  SubagentSpawnState,
} from "./subagent-types.ts";

export type AttributePrimitive = boolean | number | string | string[];
export type AttributeMap = Record<string, AttributePrimitive>;
export type TelemetryMeter = Pick<
  Meter,
  "createCounter" | "createHistogram" | "createObservableGauge" | "createUpDownCounter"
>;
export type TelemetryTracer = Pick<Tracer, "startSpan">;
export type TelemetryLogger = Pick<Logger, "emit">;
export type PiEventName = ExtensionEvent["type"];
export type PiEvent<Name extends PiEventName> = Extract<ExtensionEvent, { type: Name }>;
export type TerminalOutcome = "ok" | "error" | "cancelled" | "unknown";
export type Handler<Event = unknown, Context = ObservMeHandlerContext> = (
  event: Event,
  ctx: Context,
) => Promise<void> | void;
export type PiHandler<Name extends PiEventName> = Handler<PiEvent<Name>, ExtensionContext>;
export type RuntimeHandler = Handler<unknown, ExtensionContext>;
export type HandlerErrorRecorder = (name: string, error: unknown) => void;
export type AppendEntry = ExtensionAPI["appendEntry"];
export type GetThinkingLevel = ExtensionAPI["getThinkingLevel"];
export type ObservMeSessionManager = ExtensionContext["sessionManager"];
export type LoadSessionConfig = (
  options: LoadSessionConfigOptions,
) => Promise<ObservMeConfig | LoadSessionConfigResult>;
export type StartSessionTelemetry = (options: StartSessionTelemetryOptions) => Promise<ObservMeTelemetrySession>;
export type ReadSessionHeader = (sessionFile: string) => Promise<SessionRecoveryHeader | undefined>;
export type EnsureProjectConfig = BootstrapEnsureProjectConfig;

export interface MinimalSessionCorrelation {
  readonly workflowId?: string;
  readonly agentId?: string;
  readonly parentAgentId?: string;
  readonly rootAgentId?: string;
  readonly parentSessionId?: string;
  readonly depth?: number;
  readonly spawnId?: string;
  readonly capability?: string;
}

export interface SessionRecoveryHeader {
  readonly type?: string;
  readonly version?: number | string;
  readonly id?: string;
  readonly timestamp?: string;
  readonly cwd?: string;
  readonly parentSession?: string;
}

export interface StartupRecoveryState {
  readonly resumed: boolean;
  readonly sessionFile?: string;
  readonly header?: SessionRecoveryHeader;
  readonly customCorrelation?: MinimalSessionCorrelation;
}

export interface ObservMeHandlerContext {
  readonly cwd?: ExtensionContext["cwd"];
  readonly hasUI?: ExtensionContext["hasUI"];
  readonly sessionManager?: ObservMeSessionManager;
  readonly model?: Exclude<ExtensionContext["model"], undefined>;
  readonly ui?: {
    notify?: (message: string, level?: "warning" | "info" | "error") => Promise<void> | void;
    setStatus?: (key: string, value: string | undefined) => Promise<void> | void;
  };
  readonly isProjectTrusted?: () => boolean | Promise<boolean>;
}

export interface ObservMePiApi {
  on: <Name extends PiEventName>(eventName: Name, handler: PiHandler<Name>) => void;
  appendEntry?: AppendEntry;
  getThinkingLevel?: GetThinkingLevel;
}

export interface RegisterHandlersOptions {
  readonly loadConfig?: LoadSessionConfig;
  readonly startTelemetry?: StartSessionTelemetry;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly wallClockNow?: () => number;
  readonly configDirName?: string;
  readonly trustedParentContext?: boolean;
  readonly requireCompleteParentEnvelope?: boolean;
  readonly readSessionHeader?: ReadSessionHeader;
  readonly ensureProjectConfig?: EnsureProjectConfig;
  readonly onHandlerError?: HandlerErrorRecorder;
  readonly appendEntry?: AppendEntry;
  readonly getThinkingLevel?: GetThinkingLevel;
  readonly otelOperationOwnership?: OtelOperationOwnership;
}

export interface StartSessionTelemetryOptions {
  readonly config: ObservMeConfig;
  readonly lineage: AgentLineageContext;
  readonly now?: () => number;
  readonly wallClockNow?: () => number;
}

export interface TurnSequenceRegistry {
  readonly size: number;
  get: (runId: string) => number | undefined;
  set: (runId: string, sequence: number) => unknown;
  delete: (runId: string) => boolean;
  clear: () => void;
}

export interface ObservMeTelemetrySession {
  readonly config: ObservMeConfig;
  readonly lineage: AgentLineageContext;
  readonly controller: Pick<ObservMeOtelSdkController, "flush" | "shutdown">;
  readonly tracer: TelemetryTracer;
  readonly meter: TelemetryMeter;
  readonly logger: TelemetryLogger;
  readonly metrics: ObservMeMetrics;
  readonly spans: SpanRegistry;
  readonly activeAgentLease?: ActiveAgentLeaseController;
  agentTree: AgentTreeTracker;
  sessionSpan?: Span;
  sessionAttributes?: AttributeMap;
  workflowStartedAtMs?: number;
  workflowOutcome?: TerminalOutcome;
  now?: () => number;
  activeAgentRecorded: boolean;
  currentAgentRunId?: string;
  currentTurnId?: string;
  currentLlmRequestId?: string;
  currentToolCallId?: string;
  pendingUserBash?: PendingBashOperationState;
  currentBranchPreparation?: BranchPreparationState;
  pendingUserPromptImageCount?: number;
  nextTurnImageCount?: number;
  agentRunSequence: number;
  llmRequestSequence: number;
  toolCallSequence: number;
  turnSequences: TurnSequenceRegistry;
  childFailureAccounting?: BoundedMap<string, ChildFailureAccountingState>;
}

export interface ObservMeMetrics {
  readonly handlerErrors: Counter;
  readonly telemetryDropped: Counter;
  readonly exportErrors: Counter;
  readonly sessionsStarted: Counter;
  readonly sessionsShutdown: Counter;
  readonly workflowsStarted: Counter;
  readonly workflowsCompleted: Counter;
  readonly workflowErrors: Counter;
  readonly agentRuns: Counter;
  readonly agentRunErrors: Counter;
  readonly turnsStarted: Counter;
  readonly turnsCompleted: Counter;
  readonly llmRequests: Counter;
  readonly llmErrors: Counter;
  readonly llmInputTokens: Counter;
  readonly llmOutputTokens: Counter;
  readonly llmCacheReadTokens: Counter;
  readonly llmCacheWriteTokens: Counter;
  readonly llmCacheWrite1hTokens: Counter;
  readonly llmReasoningTokens: Counter;
  readonly llmTotalTokens: Counter;
  readonly llmCostUsd: Counter;
  readonly toolCalls: Counter;
  readonly toolFailures: Counter;
  readonly bashExecutions: Counter;
  readonly bashFailures: Counter;
  readonly modelChanges: Counter;
  readonly thinkingLevelChanges: Counter;
  readonly compactions: Counter;
  readonly branches: Counter;
  readonly subagentsSpawned: Counter;
  readonly subagentSpawnFailures: Counter;
  readonly orphanAgents: Counter;
  readonly traceContextPropagationFailures: Counter;
  readonly childAgentFailures: Counter;
  readonly parentRecoveredFromChildFailure: Counter;
  readonly redactionFailures: Counter;
  readonly eventsObserved: Counter;
  readonly activeSpans: UpDownCounter;
  readonly activeAgents: UpDownCounter;
  readonly agentLeaseExpiresUnixTimeSeconds: ObservableGauge;
  readonly workflowDurationMs: Histogram;
  readonly agentRunDurationMs: Histogram;
  readonly agentLifetimeDurationMs: Histogram;
  readonly subagentSpawnDurationMs: Histogram;
  readonly agentFanoutCount: Histogram;
  readonly agentTreeDepth: Histogram;
  readonly agentTreeWidth: Histogram;
  readonly agentWaitDurationMs: Histogram;
  readonly agentJoinDurationMs: Histogram;
  readonly turnDurationMs: Histogram;
  readonly llmRequestDurationMs: Histogram;
  readonly toolDurationMs: Histogram;
  readonly bashDurationMs: Histogram;
  readonly compactionTokensBefore: Histogram;
  readonly promptSizeChars: Histogram;
  readonly responseSizeChars: Histogram;
  readonly toolResultSizeChars: Histogram;
  readonly handlerDurationMs: Histogram;
  readonly genAiClientTokenUsage: Histogram;
  readonly genAiClientOperationDuration: Histogram;
}

export interface SpanRegistry {
  readonly activeAgentRuns: BoundedMap<string, Span>;
  readonly activeTurns: BoundedMap<string, Span>;
  readonly activeLlmRequests: BoundedMap<string, Span>;
  readonly activeToolCalls: BoundedMap<string, ToolCallState>;
  readonly activeSubagentSpawns: BoundedMap<string, SubagentSpawnState>;
  readonly activeAgentWaits: BoundedMap<string, AgentWaitJoinState>;
  readonly activeAgentJoins: BoundedMap<string, AgentWaitJoinState>;
}

export interface CapturedContent {
  readonly value: string;
  readonly truncated: boolean;
  readonly originalLength?: number;
}

export interface ToolCallState {
  readonly span: Span;
  labels: Record<string, string>;
  completionLogAttributes: AttributeMap;
  capturedResult?: CapturedContent;
  inputEvent?: unknown;
  inputReconciled?: boolean;
}

export interface PendingBashOperationState {
  readonly span: Span;
  readonly startedAtMs: number;
  readonly observedStartedAtUnixMs: number;
  readonly eventStartedAtMs?: number;
  readonly readSessionEntries?: () => ReturnType<ObservMeSessionManager["getEntries"]>;
  nextSessionEntryIndex?: number;
  completionPollDelayMs: number;
  completionPollTimer?: ReturnType<typeof setTimeout>;
}

export interface BranchPreparationState {
  readonly targetId?: string;
  readonly oldLeafId?: string;
  readonly commonAncestorId?: string;
  readonly pathHash?: string;
}

export interface CompositeOtelSignalSdk {
  readonly traceSdk: ObservMeTraceSdk;
  readonly metricSdk: ObservMeMetricSdk;
  readonly logSdk: ObservMeLogSdk;
  readonly state: "idle" | "starting" | "started" | "failed" | "shutting_down" | "shutdown_failed" | "shutdown";
  start: () => Promise<void>;
  forceFlush: () => Promise<void>;
  shutdown: () => Promise<void>;
}

export interface HandlerSessionState {
  readonly otelOperationOwnership: OtelOperationOwnership;
  session?: ObservMeTelemetrySession;
  integrationSessionPhase?: "closing";
}

export interface HandlerRegistration {
  readonly eventName: PiEventName;
  readonly handler: RuntimeHandler;
}

export interface SessionConfigLoadResult {
  readonly config: ObservMeConfig;
  readonly diagnostics?: SessionConfigDiagnostics;
}
