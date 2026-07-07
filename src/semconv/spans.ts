export const SPAN_NAMES = {
  PI_SESSION: "pi.session",
  PI_AGENT_RUN: "pi.agent.run",
  PI_AGENT_SPAWN: "pi.agent.spawn",
  PI_AGENT_WAIT: "pi.agent.wait",
  PI_AGENT_JOIN: "pi.agent.join",
  PI_TURN: "pi.turn",
  PI_LLM_REQUEST: "pi.llm.request",
  PI_TOOL_CALL: "pi.tool.call",
  PI_BASH_EXECUTION: "pi.bash.execution",
  PI_COMPACTION: "pi.compaction",
  PI_BRANCH: "pi.branch",
  PI_MODEL_CHANGE: "pi.model.change",
  PI_THINKING_CHANGE: "pi.thinking.change",
} as const;

export const ALL_SPAN_NAMES = Object.values(SPAN_NAMES).sort((left, right) => left.localeCompare(right));

export type SpanName = (typeof ALL_SPAN_NAMES)[number];
