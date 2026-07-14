import type {
  AgentEndEvent,
  AgentStartEvent,
  BeforeProviderRequestEvent,
  ExtensionEvent,
  SessionBeforeTreeEvent,
  SessionCompactEvent,
  SessionInfoChangedEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionTreeEvent,
  ToolCallEvent,
  ToolResultEvent,
  TurnEndEvent,
  TurnStartEvent,
  UserBashEvent,
} from "@earendil-works/pi-coding-agent";

type PiEvent<Name extends ExtensionEvent["type"]> = Extract<ExtensionEvent, { type: Name }>;

const fixtureModel = {
  id: "gpt-fixture",
  name: "GPT Fixture",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.invalid/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_192,
} satisfies PiEvent<"model_select">["model"];

const assistantMessage = {
  role: "assistant",
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-fixture",
  responseModel: "claude-fixture-20260714",
  responseId: "msg_fixture_usage",
  stopReason: "stop",
  usage: {
    input: 21,
    output: 34,
    cacheRead: 3,
    cacheWrite: 4,
    cacheWrite1h: 4,
    reasoning: 6,
    totalTokens: 59,
    cost: {
      input: 0.021,
      output: 0.034,
      cacheRead: 0.003,
      cacheWrite: 0.004,
      total: 0.062,
    },
  },
  content: [
    { type: "thinking", thinking: "api_key=hidden-thinking" },
    { type: "text", text: "Fixture assistant response with password=hidden-response" },
  ],
  timestamp: 1_750_000_001_000,
} satisfies PiEvent<"message_end">["message"];

const bashMessage = {
  role: "bashExecution",
  command: "echo password=hidden-bash-command",
  output: "api_key=hidden-bash-output",
  exitCode: 1,
  cancelled: false,
  truncated: true,
  fullOutputPath: "/tmp/fixture-bash-output.txt",
  excludeFromContext: true,
  timestamp: 1_750_000_001_250,
} satisfies PiEvent<"message_end">["message"];

export const sessionStartEvent = {
  type: "session_start",
  reason: "startup",
} satisfies SessionStartEvent;

export const sessionInfoChangedEvent = {
  type: "session_info_changed",
  name: "Renamed Fixture Session",
} satisfies SessionInfoChangedEvent;

export const agentEvents = {
  start: { type: "agent_start" } satisfies AgentStartEvent,
  end: { type: "agent_end", messages: [assistantMessage] } satisfies AgentEndEvent,
};

export const turnEvents = {
  start: {
    type: "turn_start",
    turnIndex: 1,
    timestamp: 1_750_000_000_000,
  } satisfies TurnStartEvent,
  end: {
    type: "turn_end",
    turnIndex: 1,
    message: assistantMessage,
    toolResults: [],
  } satisfies TurnEndEvent,
};

export const llmEvents = {
  beforeProviderRequest: {
    type: "before_provider_request",
    payload: {
      api: "messages",
      messages: [{ role: "user", content: "password=hidden-prompt" }],
      tools: [{ name: "read" }],
      temperature: 0.1,
      maxTokens: 1024,
    },
  } satisfies BeforeProviderRequestEvent,
  afterProviderResponse: {
    type: "after_provider_response",
    status: 200,
    headers: { "content-type": "application/json" },
  } satisfies PiEvent<"after_provider_response">,
  messageEnd: {
    type: "message_end",
    message: assistantMessage,
  } satisfies PiEvent<"message_end">,
};

export const toolEvents = {
  start: {
    type: "tool_execution_start",
    toolCallId: "fixture-tool-1",
    toolName: "read",
    args: { path: "/Users/alice/work/private-repo/README.md" },
  } satisfies PiEvent<"tool_execution_start">,
  call: {
    type: "tool_call",
    toolCallId: "fixture-tool-1",
    toolName: "read",
    input: { path: "/Users/alice/work/private-repo/README.md" },
  } satisfies ToolCallEvent,
  result: {
    type: "tool_result",
    toolCallId: "fixture-tool-1",
    toolName: "read",
    input: { path: "/Users/alice/work/private-repo/README.md" },
    content: [{ type: "text", text: "failed with api_key=hidden-tool-result" }],
    details: undefined,
    isError: true,
  } satisfies ToolResultEvent,
  end: {
    type: "tool_execution_end",
    toolCallId: "fixture-tool-1",
    toolName: "read",
    result: {
      content: [{ type: "text", text: "failed with api_key=hidden-tool-result" }],
      error: { name: "ToolError" },
    },
    isError: true,
  } satisfies PiEvent<"tool_execution_end">,
};

export const bashEvents = {
  start: {
    type: "user_bash",
    command: bashMessage.command,
    excludeFromContext: true,
    cwd: "/workspace/event-mapping",
  } satisfies UserBashEvent,
  messageEnd: {
    type: "message_end",
    message: bashMessage,
  } satisfies PiEvent<"message_end">,
};

export const compactionEvent = {
  type: "session_compact",
  reason: "overflow",
  willRetry: true,
  fromExtension: true,
  compactionEntry: {
    type: "compaction",
    id: "compaction-entry-1",
    parentId: "turn-entry-9",
    timestamp: "2026-07-14T00:00:00.000Z",
    summary: "User discussed a long implementation plan.",
    firstKeptEntryId: "entry-kept-123",
    tokensBefore: 50_000,
    fromHook: true,
    details: {
      readFiles: ["src/pi/handlers.ts"],
      modifiedFiles: ["test/event-mapping.test.ts"],
    },
  },
} satisfies SessionCompactEvent;

export const branchEvents = {
  before: {
    type: "session_before_tree",
    preparation: {
      targetId: "leaf-next",
      oldLeafId: "leaf-prev",
      commonAncestorId: "leaf-root",
      entriesToSummarize: [],
      userWantsSummary: true,
    },
    signal: new AbortController().signal,
  } satisfies SessionBeforeTreeEvent,
  after: {
    type: "session_tree",
    newLeafId: "leaf-next",
    oldLeafId: "leaf-prev",
    fromExtension: true,
    summaryEntry: {
      type: "branch_summary",
      id: "summary-entry-1",
      parentId: "leaf-next",
      timestamp: "2026-07-14T00:00:01.000Z",
      summary: "Branch summary text",
      fromId: "leaf-prev",
      fromHook: true,
    },
  } satisfies SessionTreeEvent,
};

export const modelThinkingEvents = {
  modelSelect: {
    type: "model_select",
    model: fixtureModel,
    previousModel: undefined,
    source: "set",
  } satisfies PiEvent<"model_select">,
  thinkingSelect: {
    type: "thinking_level_select",
    level: "high",
    previousLevel: "medium",
  } satisfies PiEvent<"thinking_level_select">,
};

export const sessionShutdownEvent = {
  type: "session_shutdown",
  reason: "quit",
} satisfies SessionShutdownEvent;
