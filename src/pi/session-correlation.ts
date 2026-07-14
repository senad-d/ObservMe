import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OBSERVME_CORRELATION_ENTRY_TYPE } from "../semconv/values.ts";
import type { AgentLineageContext } from "./agent-lineage.ts";
import type { MinimalSessionCorrelation } from "./handler-types.ts";

export { OBSERVME_CORRELATION_ENTRY_TYPE } from "../semconv/values.ts";
export const OBSERVME_CORRELATION_ENTRY_SCHEMA_VERSION = 1;

const maximumCorrelationValueLength = 128;
const correlationValuePattern = /^[A-Za-z0-9._:-]+$/u;
const correlationDataKeys = new Set([
  "schemaVersion",
  "workflowId",
  "agentId",
  "parentAgentId",
  "rootAgentId",
  "parentSessionId",
  "depth",
  "spawnId",
  "capability",
]);

export interface ObservMeCorrelationEntryData extends MinimalSessionCorrelation {
  readonly schemaVersion: typeof OBSERVME_CORRELATION_ENTRY_SCHEMA_VERSION;
  readonly workflowId: string;
  readonly agentId: string;
  readonly rootAgentId: string;
  readonly depth: number;
}

export function readLatestSessionCorrelation(entries: readonly unknown[] | undefined): MinimalSessionCorrelation | undefined {
  if (!entries) return undefined;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const correlation = readSessionCorrelationEntry(entries[index]);
    if (correlation) return correlation;
  }

  return undefined;
}

export function appendSessionCorrelationEntry(
  appendEntry: ExtensionAPI["appendEntry"] | undefined,
  lineage: AgentLineageContext,
  recovered: MinimalSessionCorrelation | undefined,
): void {
  if (!appendEntry) return;

  const data = buildSessionCorrelationEntryData(lineage);
  if (!data || correlationsEqual(data, recovered)) return;

  try {
    appendEntry(OBSERVME_CORRELATION_ENTRY_TYPE, data);
  } catch {
    return;
  }
}

export function buildSessionCorrelationEntryData(
  lineage: AgentLineageContext,
): ObservMeCorrelationEntryData | undefined {
  return normalizeSessionCorrelationData({
    schemaVersion: OBSERVME_CORRELATION_ENTRY_SCHEMA_VERSION,
    workflowId: lineage.workflowId,
    agentId: lineage.agentId,
    parentAgentId: lineage.parentAgentId,
    rootAgentId: lineage.rootAgentId,
    parentSessionId: lineage.parentSessionId,
    depth: lineage.depth,
    spawnId: lineage.spawnId,
    capability: lineage.capability,
  });
}

function readSessionCorrelationEntry(value: unknown): ObservMeCorrelationEntryData | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type !== "custom" || value.customType !== OBSERVME_CORRELATION_ENTRY_TYPE) return undefined;
  return normalizeSessionCorrelationData(value.data);
}

function normalizeSessionCorrelationData(value: unknown): ObservMeCorrelationEntryData | undefined {
  if (!isRecord(value) || !hasOnlyCorrelationDataKeys(value)) return undefined;
  if (value.schemaVersion !== OBSERVME_CORRELATION_ENTRY_SCHEMA_VERSION) return undefined;

  const workflowId = readCorrelationString(value, "workflowId");
  const agentId = readCorrelationString(value, "agentId");
  const parentAgentId = readOptionalCorrelationString(value, "parentAgentId");
  const rootAgentId = readCorrelationString(value, "rootAgentId");
  const parentSessionId = readOptionalCorrelationString(value, "parentSessionId");
  const depth = readCorrelationDepth(value.depth);
  const spawnId = readOptionalCorrelationString(value, "spawnId");
  const capability = readOptionalCorrelationString(value, "capability");

  if (!workflowId || !agentId || !rootAgentId || depth === undefined) return undefined;
  if (parentAgentId === null || parentSessionId === null || spawnId === null || capability === null) return undefined;
  if (!isConsistentCorrelationLineage(agentId, parentAgentId, rootAgentId, depth)) return undefined;

  return withoutUndefinedValues({
    schemaVersion: OBSERVME_CORRELATION_ENTRY_SCHEMA_VERSION,
    workflowId,
    agentId,
    parentAgentId,
    rootAgentId,
    parentSessionId,
    depth,
    spawnId,
    capability,
  }) as ObservMeCorrelationEntryData;
}

function hasOnlyCorrelationDataKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).every(key => correlationDataKeys.has(key));
}

function readCorrelationString(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  if (typeof candidate !== "string") return undefined;
  if (candidate.length === 0 || candidate.length > maximumCorrelationValueLength) return undefined;
  return correlationValuePattern.test(candidate) ? candidate : undefined;
}

function readOptionalCorrelationString(
  value: Record<string, unknown>,
  key: string,
): string | undefined | null {
  if (!Object.hasOwn(value, key) || value[key] === undefined) return undefined;
  return readCorrelationString(value, key) ?? null;
}

function readCorrelationDepth(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return value >= 0 && value <= 64 ? value : undefined;
}

function isConsistentCorrelationLineage(
  agentId: string,
  parentAgentId: string | undefined,
  rootAgentId: string,
  depth: number,
): boolean {
  if (depth === 0) return parentAgentId === undefined && rootAgentId === agentId;
  return parentAgentId !== undefined && parentAgentId !== agentId;
}

function correlationsEqual(
  left: ObservMeCorrelationEntryData,
  right: MinimalSessionCorrelation | undefined,
): boolean {
  if (!right) return false;

  return left.workflowId === right.workflowId
    && left.agentId === right.agentId
    && left.parentAgentId === right.parentAgentId
    && left.rootAgentId === right.rootAgentId
    && left.parentSessionId === right.parentSessionId
    && left.depth === right.depth
    && left.spawnId === right.spawnId
    && left.capability === right.capability;
}

function withoutUndefinedValues<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(entry => entry[1] !== undefined)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
