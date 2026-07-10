import type { Span } from "@opentelemetry/api";
import type { AgentWaitReason, SubagentSpawnReason } from "../semconv/values.ts";

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
  readonly span: TestableSpan;
  readonly startedAtMs: number;
  readonly labels: Record<string, string>;
  readonly reason: AgentWaitReason;
}

export interface ChildFailureAccountingState {
  readonly failureRecorded: boolean;
  readonly recoveryRecorded: boolean;
}
