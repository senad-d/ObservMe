import { SpanStatusCode, type Span } from "@opentelemetry/api";
import type {
  AgentEndEvent,
  SessionShutdownEvent,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { TerminalOutcome } from "./handler-types.ts";

type TerminalMessage = AgentEndEvent["messages"][number];

const terminalOutcomePriority: Record<TerminalOutcome, number> = {
  ok: 0,
  unknown: 1,
  cancelled: 2,
  error: 3,
};

export function deriveTurnOutcome(event: TurnEndEvent): TerminalOutcome {
  const toolResults = Array.isArray(event.toolResults) ? event.toolResults : [];
  return deriveMessageOutcome([event.message, ...toolResults]);
}

export function deriveAgentOutcome(event: AgentEndEvent): TerminalOutcome {
  return deriveMessageOutcome(Array.isArray(event.messages) ? event.messages : []);
}

export function deriveWorkflowOutcome(
  event: SessionShutdownEvent,
  observedOutcome: TerminalOutcome | undefined,
): TerminalOutcome {
  if (observedOutcome) return observedOutcome;

  // Pi shutdown reasons describe why the session runtime is being replaced or stopped,
  // not whether the workflow succeeded. Without an observed terminal agent/turn payload,
  // every real shutdown reason therefore remains unknown.
  switch (event.reason) {
    case "quit":
    case "reload":
    case "new":
    case "resume":
    case "fork":
      return "unknown";
  }
}

export function mergeTerminalOutcome(
  current: TerminalOutcome | undefined,
  observed: TerminalOutcome,
): TerminalOutcome {
  if (!current || terminalOutcomePriority[observed] > terminalOutcomePriority[current]) return observed;
  return current;
}

export function setTerminalSpanStatus(span: Span, outcome: TerminalOutcome): void {
  if (outcome === "ok") {
    span.setStatus({ code: SpanStatusCode.OK });
    return;
  }
  if (outcome === "error") {
    span.setStatus({ code: SpanStatusCode.ERROR, message: outcome });
    return;
  }

  span.setStatus({ code: SpanStatusCode.UNSET, message: outcome });
}

function deriveMessageOutcome(messages: readonly (TerminalMessage | undefined)[]): TerminalOutcome {
  let outcome: TerminalOutcome | undefined;

  for (const message of messages) {
    const observed = deriveSingleMessageOutcome(message);
    if (observed) outcome = mergeTerminalOutcome(outcome, observed);
  }

  return outcome ?? "unknown";
}

function deriveSingleMessageOutcome(message: TerminalMessage | undefined): TerminalOutcome | undefined {
  if (!message || typeof message !== "object") return undefined;
  if (message.role === "toolResult") return message.isError ? "error" : "ok";
  if (message.role !== "assistant") return undefined;
  if (message.stopReason === "error") return "error";
  if (message.stopReason === "aborted") return "cancelled";
  if (message.stopReason === "stop" || message.stopReason === "length" || message.stopReason === "toolUse") return "ok";
  return "unknown";
}
