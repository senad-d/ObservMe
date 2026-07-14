export const OBSERVME_CORRELATION_ENTRY_TYPE = "observme.correlation";

export const SUBAGENT_SPAWN_REASON_VALUES = [
  "delegated_task",
  "parallel_search",
  "review",
  "tool_wrapper",
  "unknown",
] as const;

export type SubagentSpawnReason = (typeof SUBAGENT_SPAWN_REASON_VALUES)[number];

export const AGENT_WAIT_REASON_VALUES = ["dependency", "rate_limit", "child_running", "unknown"] as const;

export type AgentWaitReason = (typeof AGENT_WAIT_REASON_VALUES)[number];
