import { randomUUID } from "node:crypto";
import type { ObservMeConfig } from "../config/schema.ts";
import type { ValidationIssue } from "../config/validate.ts";
import { validateObservMeConfig } from "../config/validate.ts";
import { COMMON_SPAN_ATTRIBUTES, RESOURCE_ATTRIBUTES } from "../semconv/attributes.ts";

export type AgentRole = "root" | "subagent" | "orchestrator" | "worker" | "reviewer" | "unknown";

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
  readonly orphaned: boolean;
}

export interface CreateAgentLineageContextOptions {
  readonly config: ObservMeConfig;
  readonly env?: NodeJS.ProcessEnv;
  readonly trustedParentContext?: boolean;
  readonly role?: AgentRole;
  readonly capability?: string;
  readonly generateId?: () => string;
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
}

export type LineageAttributeValue = boolean | number | string;
export type LineageAttributes = Record<string, LineageAttributeValue>;

export class LineageValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(`Invalid propagated ObservMe lineage: ${issues.map(issue => issue.message).join("; ")}`);
    this.name = "LineageValidationError";
    this.issues = issues;
  }
}

export function createAgentLineageContext(options: CreateAgentLineageContextOptions): AgentLineageContext {
  const env = options.env ?? process.env;
  const generateId = options.generateId ?? generateSafeLineageId;
  const propagated = readTrustedPropagatedLineage(options.config, env, options.trustedParentContext === true);
  const parentAgentId = propagated.parentAgentId;
  const agentId = propagated.agentId ?? `agent-${generateId()}`;
  const workflowId = propagated.workflowId ?? `workflow-${generateId()}`;
  const rootAgentId = resolveRootAgentId(agentId, propagated.rootAgentId, parentAgentId);
  const depth = resolveDepth(propagated.depth, parentAgentId);
  const role = options.role ?? resolveDefaultRole(parentAgentId);
  const capability = options.capability ?? propagated.capability;
  const orphaned = Boolean(parentAgentId && !propagated.rootAgentId);

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

  return {
    workflowId: env[config.workflow.idEnv],
    agentId: env[config.agent.idEnv],
    parentAgentId: env[config.agent.parentIdEnv],
    rootAgentId: env[config.agent.rootIdEnv],
    parentSessionId: env[config.agent.parentSessionIdEnv],
    parentTraceId: env[config.agent.parentTraceIdEnv],
    parentSpanId: env[config.agent.parentSpanIdEnv],
    depth: parsePropagatedDepth(env[config.agent.depthEnv]),
    spawnId: env[config.agent.spawnIdEnv],
    capability: env[config.agent.capabilityEnv],
  };
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
  if (lineage.capability) attributes["pi.agent.capability"] = lineage.capability;
  if (lineage.orphaned) attributes["pi.agent.orphaned"] = true;

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
  if (lineage.capability) attributes["pi.agent.capability"] = lineage.capability;

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
