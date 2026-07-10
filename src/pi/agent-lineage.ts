import { randomUUID } from "node:crypto";
import type { ObservMeConfig } from "../config/schema.ts";
import type { ValidationIssue } from "../config/validate.ts";
import { validateObservMeConfig } from "../config/validate.ts";
import { AGENT_LINEAGE_ATTRIBUTES, COMMON_SPAN_ATTRIBUTES, RESOURCE_ATTRIBUTES } from "../semconv/attributes.ts";

export type AgentRole = "root" | "subagent" | "orchestrator" | "worker" | "reviewer" | "unknown";
export type ParentPropagationFailureReason = "partial_envelope" | "malformed_envelope" | "stale_envelope";

export interface ValidatedParentTraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
  readonly tracestate?: string;
}

export interface AgentLineageContext {
  readonly workflowId: string;
  readonly workflowRootAgentId: string;
  readonly agentId: string;
  readonly parentAgentId?: string;
  readonly rootAgentId: string;
  readonly depth: number;
  readonly role: AgentRole;
  readonly capability?: string;
  readonly parentSessionId?: string;
  readonly parentTraceId?: string;
  readonly parentSpanId?: string;
  readonly spawnId?: string;
  readonly propagatedTraceContext?: ValidatedParentTraceContext;
  readonly propagationFailure?: ParentPropagationFailureReason;
  readonly orphaned: boolean;
}

export interface CreateAgentLineageContextOptions {
  readonly config: ObservMeConfig;
  readonly env?: NodeJS.ProcessEnv;
  readonly trustedParentContext?: boolean;
  readonly role?: AgentRole;
  readonly capability?: string;
  readonly generateId?: () => string;
  readonly requireCompletePropagationEnvelope?: boolean;
  readonly failOpenInvalidPropagation?: boolean;
}

export interface PropagatedLineageEnvironment {
  readonly workflowId?: string;
  readonly agentId?: string;
  readonly parentAgentId?: string;
  readonly rootAgentId?: string;
  readonly parentSessionId?: string;
  readonly parentTraceId?: string;
  readonly parentSpanId?: string;
  readonly depth?: number;
  readonly spawnId?: string;
  readonly capability?: string;
  readonly traceContext?: ValidatedParentTraceContext;
}

export type LineageAttributeValue = boolean | number | string;
export type LineageAttributes = Record<string, LineageAttributeValue>;

export class LineageValidationError extends Error {
  readonly issues: ValidationIssue[];
  readonly reason: ParentPropagationFailureReason;

  constructor(issues: ValidationIssue[], reason: ParentPropagationFailureReason = "malformed_envelope") {
    super(`Invalid propagated ObservMe lineage: ${issues.map(issue => issue.message).join("; ")}`);
    this.name = "LineageValidationError";
    this.issues = issues;
    this.reason = reason;
  }
}

export function createAgentLineageContext(options: CreateAgentLineageContextOptions): AgentLineageContext {
  const env = options.env ?? process.env;
  const generateId = options.generateId ?? generateSafeLineageId;
  const propagation = resolveTrustedPropagation(options, env);
  const propagated = propagation.lineage;
  const parentAgentId = propagated.parentAgentId;
  const agentId = propagated.agentId ?? `agent-${generateId()}`;
  const workflowId = propagated.workflowId ?? `workflow-${generateId()}`;
  const rootAgentId = resolveRootAgentId(agentId, propagated.rootAgentId, parentAgentId);
  const depth = resolveDepth(propagated.depth, parentAgentId);
  const role = options.role ?? resolveDefaultRole(parentAgentId);
  const capability = options.capability ?? propagated.capability;
  const orphaned = Boolean(parentAgentId && !propagated.rootAgentId) || propagation.failure !== undefined;

  return {
    workflowId,
    workflowRootAgentId: rootAgentId,
    agentId,
    parentAgentId,
    rootAgentId,
    depth,
    role,
    capability,
    parentSessionId: propagated.parentSessionId,
    parentTraceId: propagated.parentTraceId,
    parentSpanId: propagated.parentSpanId,
    spawnId: propagated.spawnId,
    propagatedTraceContext: propagated.traceContext,
    propagationFailure: propagation.failure,
    orphaned,
  };
}

export function readTrustedPropagatedLineage(
  config: ObservMeConfig,
  env: NodeJS.ProcessEnv = process.env,
  trustedParentContext = false,
): PropagatedLineageEnvironment {
  if (!trustedParentContext) return {};

  assertValidPropagatedLineage(config, env);
  const traceContext = readValidatedParentTraceContext(env);
  assertConsistentParentTraceMetadata(config, env, traceContext);

  return {
    workflowId: env[config.workflow.idEnv],
    agentId: env[config.agent.idEnv],
    parentAgentId: env[config.agent.parentIdEnv],
    rootAgentId: env[config.agent.rootIdEnv],
    parentSessionId: env[config.agent.parentSessionIdEnv],
    parentTraceId: traceContext?.traceId ?? env[config.agent.parentTraceIdEnv],
    parentSpanId: traceContext?.spanId ?? env[config.agent.parentSpanIdEnv],
    depth: parsePropagatedDepth(env[config.agent.depthEnv]),
    spawnId: env[config.agent.spawnIdEnv],
    capability: env[config.agent.capabilityEnv],
    traceContext,
  };
}

function resolveTrustedPropagation(
  options: CreateAgentLineageContextOptions,
  env: NodeJS.ProcessEnv,
): { readonly lineage: PropagatedLineageEnvironment; readonly failure?: ParentPropagationFailureReason } {
  if (options.trustedParentContext !== true) return { lineage: {} };

  try {
    const lineage = readTrustedPropagatedLineage(options.config, env, true);
    if (options.requireCompletePropagationEnvelope) assertCompletePropagationEnvelope(options.config, env);
    return { lineage };
  } catch (error) {
    if (!options.failOpenInvalidPropagation || !(error instanceof LineageValidationError)) throw error;
    return { lineage: {}, failure: error.reason };
  }
}

function assertCompletePropagationEnvelope(config: ObservMeConfig, env: NodeJS.ProcessEnv): void {
  if (!hasAnyPropagationValue(config, env)) return;

  if (env[config.agent.idEnv]) {
    throwPropagationError("stale_envelope", `${config.agent.idEnv} must not be inherited by a child process.`);
  }

  const requiredNames = [
    config.workflow.idEnv,
    config.agent.parentIdEnv,
    config.agent.rootIdEnv,
    config.agent.depthEnv,
    config.agent.spawnIdEnv,
  ];
  if (config.agent.propagateTraceContext) requiredNames.push("traceparent");

  const missingNames = requiredNames.filter(name => !env[name]);
  if (missingNames.length > 0) {
    throwPropagationError("partial_envelope", `Propagated child context is missing ${missingNames.join(", ")}.`);
  }
}

function hasAnyPropagationValue(config: ObservMeConfig, env: NodeJS.ProcessEnv): boolean {
  return propagationEnvironmentKeys(config).some(name => Boolean(env[name]));
}

function readValidatedParentTraceContext(env: NodeJS.ProcessEnv): ValidatedParentTraceContext | undefined {
  if (env.TRACEPARENT || env.TRACESTATE) {
    throwPropagationError("stale_envelope", "Uppercase W3C propagation variables are stale or ambiguous.");
  }

  const traceparent = env.traceparent;
  const tracestate = env.tracestate;
  if (!traceparent) {
    if (tracestate) throwPropagationError("partial_envelope", "tracestate requires traceparent.");
    return undefined;
  }

  const match = /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/iu.exec(traceparent);
  if (!match || /^0{32}$/u.test(match[1]) || /^0{16}$/u.test(match[2])) {
    throwPropagationError("malformed_envelope", "traceparent is malformed or contains an invalid zero identifier.");
  }
  if (tracestate && !isValidTracestate(tracestate)) {
    throwPropagationError("malformed_envelope", "tracestate is malformed or oversized.");
  }

  return {
    traceId: match[1].toLowerCase(),
    spanId: match[2].toLowerCase(),
    traceFlags: Number.parseInt(match[3], 16),
    ...(tracestate ? { tracestate } : {}),
  };
}

function isValidTracestate(value: string): boolean {
  if (value.length > 512) return false;
  const members = value.split(",");
  if (members.length > 32) return false;
  const keys = new Set<string>();

  for (const rawMember of members) {
    const member = rawMember.trim();
    const separator = member.indexOf("=");
    if (separator <= 0 || separator !== member.lastIndexOf("=")) return false;
    const key = member.slice(0, separator);
    const memberValue = member.slice(separator + 1);
    if (!isValidTracestateKey(key) || !isValidTracestateValue(memberValue) || keys.has(key)) return false;
    keys.add(key);
  }

  return true;
}

function isValidTracestateKey(value: string): boolean {
  return /^[a-z][a-z0-9_*/-]{0,255}$/u.test(value) || /^[a-z0-9][a-z0-9_*/-]{0,240}@[a-z][a-z0-9_*/-]{0,13}$/u.test(value);
}

function isValidTracestateValue(value: string): boolean {
  if (value.length === 0 || value.length > 256 || value.endsWith(" ")) return false;

  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code > 0x7e || character === "," || character === "=") return false;
  }

  return true;
}

function assertConsistentParentTraceMetadata(
  config: ObservMeConfig,
  env: NodeJS.ProcessEnv,
  traceContext: ValidatedParentTraceContext | undefined,
): void {
  const parentTraceId = env[config.agent.parentTraceIdEnv];
  const parentSpanId = env[config.agent.parentSpanIdEnv];
  if (Boolean(parentTraceId) !== Boolean(parentSpanId)) {
    throwPropagationError("partial_envelope", "Parent trace and span metadata must be supplied together.");
  }
  if (!traceContext || !parentTraceId || !parentSpanId) return;
  if (parentTraceId.toLowerCase() !== traceContext.traceId || parentSpanId.toLowerCase() !== traceContext.spanId) {
    throwPropagationError("stale_envelope", "Parent trace metadata does not match traceparent.");
  }
}

function throwPropagationError(reason: ParentPropagationFailureReason, message: string): never {
  throw new LineageValidationError([{ code: "malformed_lineage_value", message }], reason);
}

export function buildLineageAttributes(lineage: AgentLineageContext): LineageAttributes {
  const attributes: LineageAttributes = {
    [COMMON_SPAN_ATTRIBUTES.PI_WORKFLOW_ID]: lineage.workflowId,
    [COMMON_SPAN_ATTRIBUTES.PI_WORKFLOW_ROOT_AGENT_ID]: lineage.workflowRootAgentId,
    [COMMON_SPAN_ATTRIBUTES.PI_AGENT_ID]: lineage.agentId,
    [COMMON_SPAN_ATTRIBUTES.PI_AGENT_ROOT_ID]: lineage.rootAgentId,
    [RESOURCE_ATTRIBUTES.PI_AGENT_ROLE]: lineage.role,
    [RESOURCE_ATTRIBUTES.PI_AGENT_DEPTH]: lineage.depth,
  };

  if (lineage.parentAgentId) attributes[COMMON_SPAN_ATTRIBUTES.PI_AGENT_PARENT_ID] = lineage.parentAgentId;
  if (lineage.capability) attributes[AGENT_LINEAGE_ATTRIBUTES.PI_AGENT_CAPABILITY] = lineage.capability;
  if (lineage.orphaned) attributes[AGENT_LINEAGE_ATTRIBUTES.PI_AGENT_ORPHANED] = true;

  return attributes;
}

export function buildResourceLineageAttributes(lineage: AgentLineageContext): LineageAttributes {
  const attributes: LineageAttributes = {
    [RESOURCE_ATTRIBUTES.PI_WORKFLOW_ID]: lineage.workflowId,
    [RESOURCE_ATTRIBUTES.PI_WORKFLOW_ROOT_AGENT_ID]: lineage.workflowRootAgentId,
    [RESOURCE_ATTRIBUTES.PI_AGENT_ID]: lineage.agentId,
    [RESOURCE_ATTRIBUTES.PI_AGENT_ROOT_ID]: lineage.rootAgentId,
    [RESOURCE_ATTRIBUTES.PI_AGENT_ROLE]: lineage.role,
    [RESOURCE_ATTRIBUTES.PI_AGENT_DEPTH]: lineage.depth,
  };

  if (lineage.parentAgentId) attributes[RESOURCE_ATTRIBUTES.PI_AGENT_PARENT_ID] = lineage.parentAgentId;
  if (lineage.capability) attributes[AGENT_LINEAGE_ATTRIBUTES.PI_AGENT_CAPABILITY] = lineage.capability;

  return attributes;
}

export function createPropagationEnvironment(
  lineage: AgentLineageContext,
  config: ObservMeConfig,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const sanitizedExtra = sanitizePropagationEnvironment(config, extra);

  if (!config.workflow.enabled || !config.agent.propagateToSubagents) return sanitizedExtra;

  return {
    ...sanitizedExtra,
    [config.workflow.idEnv]: lineage.workflowId,
    [config.agent.parentIdEnv]: lineage.agentId,
    [config.agent.rootIdEnv]: lineage.rootAgentId,
    [config.agent.depthEnv]: String(lineage.depth),
    ...(lineage.capability ? { [config.agent.capabilityEnv]: lineage.capability } : {}),
  };
}

export function sanitizePropagationEnvironment(config: ObservMeConfig, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitized = { ...env };

  for (const key of propagationEnvironmentKeys(config)) delete sanitized[key];

  return sanitized;
}

const highCardinalityLineageKeyPatterns = [
  /(?:workflow|session|trace|span|entry|spawn|tool_call)[._-]id/iu,
  /agent[._-](?:id|parent[._-]id|root[._-]id|child[._-]id)/iu,
  /(?:parent|child|root)[._-]agent[._-]id/iu,
  /(?:^|[._-])id$/iu,
] as const;

export function isHighCardinalityLineageKey(key: string): boolean {
  return highCardinalityLineageKeyPatterns.some(pattern => pattern.test(key));
}

function propagationEnvironmentKeys(config: ObservMeConfig): string[] {
  return [
    ...new Set([
      config.workflow.idEnv,
      config.agent.idEnv,
      config.agent.parentIdEnv,
      config.agent.rootIdEnv,
      config.agent.parentSessionIdEnv,
      config.agent.parentTraceIdEnv,
      config.agent.parentSpanIdEnv,
      config.agent.depthEnv,
      config.agent.spawnIdEnv,
      config.agent.capabilityEnv,
      "traceparent",
      "tracestate",
      "TRACEPARENT",
      "TRACESTATE",
    ]),
  ];
}

function assertValidPropagatedLineage(config: ObservMeConfig, env: NodeJS.ProcessEnv): void {
  const result = validateObservMeConfig(config, { env });
  const lineageIssues = result.issues.filter(issue => issue.code === "malformed_lineage_value");
  if (lineageIssues.length > 0) throw new LineageValidationError(lineageIssues);
}

function parsePropagatedDepth(value: string | undefined): number | undefined {
  if (!value) return undefined;
  return Number(value);
}

function resolveRootAgentId(agentId: string, propagatedRootAgentId: string | undefined, parentAgentId: string | undefined): string {
  if (propagatedRootAgentId) return propagatedRootAgentId;
  if (parentAgentId) return agentId;
  return agentId;
}

function resolveDepth(propagatedDepth: number | undefined, parentAgentId: string | undefined): number {
  if (!parentAgentId) return 0;
  return (propagatedDepth ?? 0) + 1;
}

function resolveDefaultRole(parentAgentId: string | undefined): AgentRole {
  return parentAgentId ? "subagent" : "root";
}

function generateSafeLineageId(): string {
  return randomUUID();
}
