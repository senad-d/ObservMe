import type { Span } from "@opentelemetry/api";
import type { AgentWaitReason, SubagentSpawnReason } from "../semconv/values.ts";
import type { AgentChildStatus } from "./agent-tree-tracker.ts";

export type AgentWaitJoinKind = "wait" | "join";
export type AgentJoinStatus = "completed" | "failed" | "cancelled" | "timeout" | "unknown" | "waiting";

export type TestableSpan = Span & {
  readonly name?: string;
  readonly attributes?: Record<string, unknown>;
  readonly parentSpan?: Span;
};

export interface SubagentSpawnState {
  readonly span: TestableSpan;
  readonly childAgentId: string;
  readonly startedAtMs: number;
  readonly labels: Record<string, string>;
  readonly spawnReason: SubagentSpawnReason;
  readonly traceContextPropagated: boolean;
}

export interface AgentWaitJoinState {
  readonly id: string;
  readonly kind: AgentWaitJoinKind;
  readonly span: TestableSpan;
  readonly startedAtMs: number;
  readonly labels: Record<string, string>;
  readonly reason: AgentWaitReason;
  readonly spawnId?: string;
  readonly childAgentId?: string;
  readonly childStatus?: AgentChildStatus;
  readonly joinStatus?: AgentJoinStatus;
  readonly failurePropagated?: boolean;
}

export interface ChildFailureAccountingState {
  readonly failureRecorded: boolean;
  readonly recoveryRecorded: boolean;
}
