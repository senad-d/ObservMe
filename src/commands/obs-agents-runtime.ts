import type { AgentLineageContext } from "../pi/agent-lineage.ts";
import type { AgentChildStatus, AgentTreeNode, AgentTreeSummary, AgentTreeTracker } from "../pi/agent-tree-tracker.ts";

export type ObsAgentWaitJoinKind = "wait" | "join";

export interface ObsAgentWaitJoinHint {
  readonly kind: ObsAgentWaitJoinKind;
  readonly id: string;
  readonly active: boolean;
  readonly spawnId?: string;
  readonly childAgentId?: string;
  readonly childStatus?: AgentChildStatus;
  readonly joinStatus?: string;
  readonly reason?: string;
  readonly durationMs?: number;
}

export interface StartObsAgentsRuntimeStateOptions {
  readonly lineage: AgentLineageContext;
  readonly agentTree?: AgentTreeTracker;
  readonly sessionId?: string;
  readonly traceId?: string;
}

export interface UpdateObsAgentsRuntimeTreeOptions {
  readonly sessionId?: string;
  readonly traceId?: string;
}

export interface ObsAgentsRuntimeSnapshot {
  readonly lineage?: AgentLineageContext;
  readonly currentAgent?: AgentTreeNode;
  readonly summary?: AgentTreeSummary;
  readonly children: readonly AgentTreeNode[];
  readonly waitJoinHints: readonly ObsAgentWaitJoinHint[];
  readonly sessionId?: string;
  readonly traceId?: string;
}

interface MutableObsAgentsRuntimeState {
  lineage?: AgentLineageContext;
  currentAgent?: AgentTreeNode;
  summary?: AgentTreeSummary;
  children: AgentTreeNode[];
  waitJoinHints: ObsAgentWaitJoinHint[];
  sessionId?: string;
  traceId?: string;
}

const maxWaitJoinHints = 10;
const runtimeAgentsState: MutableObsAgentsRuntimeState = createEmptyObsAgentsRuntimeState();

export function startObsAgentsRuntimeState(options: StartObsAgentsRuntimeStateOptions): void {
  replaceObsAgentsRuntimeState(createEmptyObsAgentsRuntimeState());
  runtimeAgentsState.lineage = options.lineage;
  runtimeAgentsState.sessionId = normalizeString(options.sessionId);
  runtimeAgentsState.traceId = normalizeString(options.traceId);
  if (options.agentTree) updateObsAgentsRuntimeStateFromTree(options.lineage, options.agentTree, options);
}

export function updateObsAgentsRuntimeStateFromTree(
  lineage: AgentLineageContext,
  agentTree: AgentTreeTracker,
  options: UpdateObsAgentsRuntimeTreeOptions = {},
): void {
  runtimeAgentsState.lineage = lineage;
  runtimeAgentsState.currentAgent = agentTree.getAgent(lineage.agentId);
  runtimeAgentsState.summary = agentTree.summarize(lineage.rootAgentId);
  runtimeAgentsState.children = agentTree.getChildren(lineage.agentId);
  updateOptionalRuntimeString("sessionId", options.sessionId);
  updateOptionalRuntimeString("traceId", options.traceId);
}

export function recordObsAgentWaitJoinHint(hint: ObsAgentWaitJoinHint): void {
  const normalized = normalizeObsAgentWaitJoinHint(hint);
  if (!normalized) return;

  const existingIndex = runtimeAgentsState.waitJoinHints.findIndex(item => item.kind === normalized.kind && item.id === normalized.id);
  if (existingIndex >= 0) {
    runtimeAgentsState.waitJoinHints.splice(existingIndex, 1, normalized);
  } else {
    runtimeAgentsState.waitJoinHints.push(normalized);
  }

  runtimeAgentsState.waitJoinHints = runtimeAgentsState.waitJoinHints.slice(-maxWaitJoinHints);
}

export function getLocalObsAgentsRuntimeSnapshot(): ObsAgentsRuntimeSnapshot {
  return {
    lineage: runtimeAgentsState.lineage,
    currentAgent: runtimeAgentsState.currentAgent,
    summary: runtimeAgentsState.summary,
    children: [...runtimeAgentsState.children],
    waitJoinHints: [...runtimeAgentsState.waitJoinHints],
    sessionId: runtimeAgentsState.sessionId,
    traceId: runtimeAgentsState.traceId,
  };
}

export function clearObsAgentsRuntimeState(): void {
  replaceObsAgentsRuntimeState(createEmptyObsAgentsRuntimeState());
}

function normalizeObsAgentWaitJoinHint(hint: ObsAgentWaitJoinHint): ObsAgentWaitJoinHint | undefined {
  const id = normalizeString(hint.id);
  if (!id) return undefined;

  return {
    kind: hint.kind,
    id,
    active: hint.active,
    spawnId: normalizeString(hint.spawnId),
    childAgentId: normalizeString(hint.childAgentId),
    childStatus: hint.childStatus,
    joinStatus: normalizeString(hint.joinStatus),
    reason: normalizeString(hint.reason),
    durationMs: normalizeDurationMs(hint.durationMs),
  };
}

function normalizeDurationMs(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return Math.trunc(value);
}

function updateOptionalRuntimeString(key: "sessionId" | "traceId", value: string | undefined): void {
  if (value !== undefined) runtimeAgentsState[key] = normalizeString(value);
}

function replaceObsAgentsRuntimeState(state: MutableObsAgentsRuntimeState): void {
  runtimeAgentsState.lineage = state.lineage;
  runtimeAgentsState.currentAgent = state.currentAgent;
  runtimeAgentsState.summary = state.summary;
  runtimeAgentsState.children = state.children;
  runtimeAgentsState.waitJoinHints = state.waitJoinHints;
  runtimeAgentsState.sessionId = state.sessionId;
  runtimeAgentsState.traceId = state.traceId;
}

function createEmptyObsAgentsRuntimeState(): MutableObsAgentsRuntimeState {
  return {
    children: [],
    waitJoinHints: [],
  };
}

function normalizeString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
