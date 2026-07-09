import assert from "node:assert/strict";
import test from "node:test";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import { getObsRootCommandArgumentCompletions, registerObsCommand } from "../src/commands/obs.ts";
import {
  OBS_AGENTS_FANOUT_P95_PROMQL,
  OBS_AGENTS_ORPHAN_PROMQL,
  OBS_AGENTS_SPAWNED_PROMQL,
  getObsAgentsSnapshot,
  renderObsAgents,
} from "../src/commands/obs-agents.ts";
import {
  clearObsAgentsRuntimeState,
  getLocalObsAgentsRuntimeSnapshot,
  recordObsAgentWaitJoinHint,
  startObsAgentsRuntimeState,
} from "../src/commands/obs-agents-runtime.ts";
import { AgentTreeTracker } from "../src/pi/agent-tree-tracker.ts";
import { findForbiddenPrometheusLabels } from "../src/query/prometheus.ts";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const remoteTraceId = "11111111111111111111111111111111";

function cloneDefaultConfig() {
  return structuredClone(defaultObservMeConfig);
}

function createCommandContext(notifications) {
  return {
    cwd: "/workspace/demo",
    ui: {
      notify: (message, type) => notifications.push({ message, type }),
    },
    isProjectTrusted: () => false,
  };
}

function createFakeCommandPi() {
  const commands = new Map();
  return {
    commands,
    registerCommand: (name, options) => commands.set(name, options),
  };
}

function makeLineage(overrides = {}) {
  return {
    workflowId: "workflow-1",
    workflowRootAgentId: "agent-root",
    agentId: "agent-root",
    rootAgentId: "agent-root",
    depth: 0,
    role: "orchestrator",
    capability: "planning",
    orphaned: false,
    ...overrides,
  };
}

function createRuntimeSnapshot() {
  return {
    lineage: makeLineage(),
    currentAgent: {
      agentId: "agent-root",
      workflowId: "workflow-1",
      rootAgentId: "agent-root",
      depth: 0,
      role: "orchestrator",
      capability: "planning",
      orphaned: false,
      childIds: ["agent-child-a", "agent-child-b"],
      activeChildren: 1,
      fanoutCount: 2,
      status: "active",
    },
    summary: {
      activeChildren: 1,
      fanoutCount: 2,
      treeDepth: 2,
      treeWidth: 4,
      orphanCount: 0,
      childStatuses: {
        starting: 0,
        active: 1,
        completed: 1,
        failed: 0,
        cancelled: 0,
        orphaned: 0,
      },
    },
    children: [
      {
        agentId: "agent-child-a",
        workflowId: "workflow-1",
        rootAgentId: "agent-root",
        parentAgentId: "agent-root",
        depth: 1,
        role: "worker",
        orphaned: false,
        childIds: [],
        activeChildren: 0,
        fanoutCount: 0,
        status: "active",
      },
      {
        agentId: "agent-child-b",
        workflowId: "workflow-1",
        rootAgentId: "agent-root",
        parentAgentId: "agent-root",
        depth: 1,
        role: "reviewer",
        orphaned: false,
        childIds: [],
        activeChildren: 0,
        fanoutCount: 0,
        status: "completed",
      },
    ],
    waitJoinHints: [
      {
        kind: "join",
        id: "join-1",
        active: false,
        childAgentId: "agent-child-b",
        childStatus: "completed",
        joinStatus: "completed",
        durationMs: 1200,
      },
    ],
    sessionId: "session-1",
    traceId,
  };
}

function createPrometheusResponse(labels, value) {
  return new Response(
    JSON.stringify({
      status: "success",
      data: {
        resultType: "vector",
        result: [
          {
            metric: labels,
            value: [1783422000.25, value],
          },
          {
            metric: { ...labels, extra_series: "capped" },
            value: [1783422000.25, "999"],
          },
        ],
      },
    }),
    { status: 200, statusText: "OK", headers: { "content-type": "application/json" } },
  );
}

function createTempoSearchResponse() {
  return new Response(
    JSON.stringify({
      traces: [
        {
          traceID: remoteTraceId,
          rootServiceName: "observme-pi-extension",
          rootTraceName: "pi.agent.run",
          durationMs: 42,
        },
      ],
    }),
    { status: 200, statusText: "OK", headers: { "content-type": "application/json" } },
  );
}

function responseForPrometheusQuery(query) {
  if (query === OBS_AGENTS_SPAWNED_PROMQL) {
    return createPrometheusResponse(
      { agent_role: "orchestrator", subagent_depth: "1", spawn_type: "tool", spawn_reason: "review" },
      "0.5",
    );
  }

  if (query === OBS_AGENTS_FANOUT_P95_PROMQL) return createPrometheusResponse({ subagent_depth: "1" }, "4");
  if (query === OBS_AGENTS_ORPHAN_PROMQL) return createPrometheusResponse({ agent_role: "worker", subagent_depth: "1" }, "0");
  throw new Error(`Unexpected PromQL query: ${query}`);
}

function createChildRows(count) {
  return Array.from({ length: count }, (_value, index) => ({
    agentId: `agent-child-${String(index + 1).padStart(2, "0")}`,
    workflowId: "workflow-1",
    rootAgentId: "agent-root",
    parentAgentId: "agent-root",
    depth: 1 + (index % 3),
    role: index % 2 === 0 ? "worker" : "reviewer",
    orphaned: index % 11 === 0,
    childIds: [],
    activeChildren: index === count - 1 ? 1 : 0,
    fanoutCount: index % 4,
    status: index === count - 1 ? "active" : "completed",
  }));
}

function createRenderSnapshot(children, recentChildrenLimit = 4) {
  const latestChild = children.at(-1);
  return {
    workflowId: "workflow-1",
    workflowRootAgentId: "agent-root",
    agentId: "agent-root",
    rootAgentId: "agent-root",
    role: "orchestrator",
    capability: "planning",
    depth: 0,
    orphaned: false,
    sessionId: " session-1 ",
    traceId: ` ${traceId} `,
    activeChildren: latestChild ? 1 : 0,
    fanoutCount: children.length,
    treeDepth: 4,
    treeWidth: children.length,
    orphanCount: children.filter(child => child.orphaned).length,
    children,
    waitJoinHints: latestChild ? [{
      kind: "join",
      id: `join-${latestChild.agentId}`,
      active: false,
      childAgentId: latestChild.agentId,
      childStatus: latestChild.status,
      joinStatus: "completed",
      durationMs: 1200,
    }] : [],
    aggregateQueries: [OBS_AGENTS_SPAWNED_PROMQL, OBS_AGENTS_FANOUT_P95_PROMQL, OBS_AGENTS_ORPHAN_PROMQL],
    aggregateRows: {
      spawned: [{ labels: { agent_role: "orchestrator" }, value: 0.5 }],
      fanoutP95: [{ labels: { subagent_depth: "1" }, value: 4 }],
      orphaned: [{ labels: { agent_role: "worker" }, value: 0 }],
    },
    tempoSearchAttributes: { "pi.agent.id": "agent-root", "pi.workflow.id": "workflow-1" },
    traces: [{ traceId: ` ${remoteTraceId} `, rootServiceName: "observme-pi-extension" }],
    recentChildrenLimit,
  };
}

test("renderObsAgents reports current lineage, child relationships, and wait/join hints", () => {
  const output = renderObsAgents({
    workflowId: "workflow-1",
    workflowRootAgentId: "agent-root",
    agentId: "agent-root",
    rootAgentId: "agent-root",
    role: "orchestrator",
    capability: "planning",
    depth: 0,
    orphaned: false,
    sessionId: "session-1",
    traceId,
    activeChildren: 1,
    fanoutCount: 2,
    treeDepth: 2,
    treeWidth: 4,
    orphanCount: 0,
    children: createRuntimeSnapshot().children,
    waitJoinHints: createRuntimeSnapshot().waitJoinHints,
    aggregateQueries: [OBS_AGENTS_SPAWNED_PROMQL, OBS_AGENTS_FANOUT_P95_PROMQL, OBS_AGENTS_ORPHAN_PROMQL],
    aggregateRows: {
      spawned: [{ labels: { agent_role: "orchestrator" }, value: 0.5 }],
      fanoutP95: [{ labels: { subagent_depth: "1" }, value: 4 }],
      orphaned: [],
    },
    tempoSearchAttributes: { "pi.agent.id": "agent-root", "pi.workflow.id": "workflow-1" },
    traces: [{ traceId: remoteTraceId, rootServiceName: "observme-pi-extension" }],
  });

  assert.equal(
    output,
    [
      "Workflow: workflow-1 root=agent-root",
      "Agent: agent-root (orchestrator depth=0)",
      "Session: session-1",
      "Subagents spawned in current trace: 2",
      "Current tree: depth=2 width=4 active=1 orphaned=0",
      "Recent children: agent-child-a status=active depth=1; agent-child-b status=completed depth=1",
      "Latest child: agent-child-b status=completed active=0 join=1.2s",
      "Wait/join hints: active_waits=0 active_joins=0 latest=join:agent-child-b status=completed duration=1.2s",
      "Aggregate agent metrics (last 1h): spawn_series=1 fanout_series=1 orphan_series=0",
      `Lineage drill-down: Tempo attributes pi.agent.id, pi.workflow.id traces=1 latest_trace=${remoteTraceId}`,
    ].join("\n"),
  );
});

test("renderObsAgents bounds recent child rows while preserving useful agent fields", () => {
  const zeroOutput = renderObsAgents(createRenderSnapshot([], 4));
  const fewerOutput = renderObsAgents(createRenderSnapshot(createChildRows(3), 4));
  const exactOutput = renderObsAgents(createRenderSnapshot(createChildRows(4), 4));
  const greaterOutput = renderObsAgents(createRenderSnapshot(createChildRows(7), 4));
  const largeOutput = renderObsAgents(createRenderSnapshot(createChildRows(60), 4));

  assert.match(zeroOutput, /Recent children: none/u);
  assert.doesNotMatch(fewerOutput, /omitted/u);
  assert.match(fewerOutput, /agent-child-01 status=completed depth=1/u);
  assert.match(fewerOutput, /agent-child-03 status=active depth=3/u);
  assert.doesNotMatch(exactOutput, /omitted/u);
  assert.match(exactOutput, /agent-child-04 status=active depth=1/u);

  assert.match(greaterOutput, /Recent children: .*agent-child-01.*agent-child-02.*agent-child-06.*agent-child-07/u);
  assert.match(greaterOutput, /omitted 3 child row\(s\)/u);
  assert.doesNotMatch(greaterOutput, /agent-child-03/u);
  assert.doesNotMatch(greaterOutput, /agent-child-05/u);
  assert.match(greaterOutput, /Latest child: agent-child-07 status=active active=1 join=1\.2s/u);

  assert.ok(largeOutput.length < 1200);
  assert.match(largeOutput, /Workflow: workflow-1 root=agent-root/u);
  assert.match(largeOutput, /Session: session-1/u);
  assert.match(largeOutput, /Current tree: depth=4 width=60 active=1 orphaned=6/u);
  assert.match(largeOutput, /Wait\/join hints: active_waits=0 active_joins=0 latest=join:agent-child-60 status=completed duration=1\.2s/u);
  assert.match(largeOutput, /Aggregate agent metrics \(last 1h\): spawn_series=1 fanout_series=1 orphan_series=1/u);
  assert.match(largeOutput, new RegExp(`Lineage drill-down: .*latest_trace=${remoteTraceId}`, "u"));
});

test("/obs agents queries low-cardinality PromQL and Tempo lineage attributes", async () => {
  const config = cloneDefaultConfig();
  config.query.timeoutMs = 987;
  config.query.maxAgents = 1;
  config.query.maxTraces = 1;
  config.query.grafana.url = "http://grafana.local/grafana/";
  config.query.grafana.token = "grafana-token";
  config.query.grafana.datasourceUids.prometheus = "mimir/main";
  config.query.grafana.datasourceUids.tempo = "tempo/main";

  const calls = [];
  const fetcher = async (input, init) => {
    calls.push({ input: String(input), init });
    assert.equal(init.method, "GET");
    assert.ok(init.signal instanceof AbortSignal);

    const url = new URL(String(input));
    if (url.pathname.endsWith("/api/v1/query")) return responseForPrometheusQuery(url.searchParams.get("query"));
    if (url.pathname.endsWith("/api/search")) return createTempoSearchResponse();
    throw new Error(`Unexpected query URL: ${url.toString()}`);
  };

  const snapshot = await getObsAgentsSnapshot(createCommandContext([]), {
    loadConfig: async () => config,
    fetch: fetcher,
    getRuntime: () => createRuntimeSnapshot(),
    now: () => new Date("2026-07-07T12:00:00.000Z"),
  });

  const prometheusCalls = calls.filter(call => new URL(call.input).pathname.endsWith("/api/v1/query"));
  const tempoCalls = calls.filter(call => new URL(call.input).pathname.endsWith("/api/search"));

  assert.equal(prometheusCalls.length, 3);
  assert.equal(tempoCalls.length, 1);
  assert.deepEqual(
    prometheusCalls.map(call => new URL(call.input).searchParams.get("query")).sort(),
    [OBS_AGENTS_FANOUT_P95_PROMQL, OBS_AGENTS_ORPHAN_PROMQL, OBS_AGENTS_SPAWNED_PROMQL].sort(),
  );

  for (const call of prometheusCalls) {
    const url = new URL(call.input);
    const query = url.searchParams.get("query");
    assert.deepEqual(findForbiddenPrometheusLabels(query), []);
    assert.equal(query.includes("workflow"), false);
    assert.equal(query.includes("agent_id"), false);
    assert.equal(url.searchParams.get("limit"), "1");
    assert.equal(url.searchParams.get("timeout"), "0.987s");
    assert.equal(call.init.headers.Authorization, "Bearer grafana-token");
  }

  const tempoUrl = new URL(tempoCalls[0].input);
  assert.equal(tempoUrl.origin + tempoUrl.pathname, "http://grafana.local/grafana/api/datasources/proxy/uid/tempo%2Fmain/api/search");
  assert.equal(tempoUrl.searchParams.get("tags"), 'pi.agent.id="agent-root" pi.workflow.id="workflow-1"');
  assert.equal(tempoUrl.searchParams.get("limit"), "1");
  assert.equal(tempoCalls[0].init.headers.Authorization, "Bearer grafana-token");
  assert.equal(snapshot.aggregateRows.spawned.length, 1);
  assert.equal(snapshot.aggregateRows.fanoutP95.length, 1);
  assert.equal(snapshot.aggregateRows.orphaned.length, 1);
  assert.equal(snapshot.traces[0].traceId, remoteTraceId);
  assert.deepEqual(snapshot.tempoSearchAttributes, { "pi.agent.id": "agent-root", "pi.workflow.id": "workflow-1" });
});

test("local agents runtime snapshots current tree state without importing query clients", t => {
  clearObsAgentsRuntimeState();
  t.after(() => clearObsAgentsRuntimeState());

  const tracker = new AgentTreeTracker({ maxAgents: 4 });
  const root = makeLineage();
  const child = makeLineage({
    agentId: "agent-child",
    parentAgentId: "agent-root",
    depth: 1,
    role: "worker",
  });

  tracker.registerAgent(root);
  tracker.registerAgent(child, "active");
  startObsAgentsRuntimeState({ lineage: root, agentTree: tracker, sessionId: "session-1", traceId });
  recordObsAgentWaitJoinHint({ kind: "wait", id: "wait-1", active: true, childAgentId: "agent-child" });

  const snapshot = getLocalObsAgentsRuntimeSnapshot();

  assert.equal(snapshot.lineage.agentId, "agent-root");
  assert.equal(snapshot.currentAgent.fanoutCount, 1);
  assert.equal(snapshot.summary.activeChildren, 1);
  assert.equal(snapshot.children[0].agentId, "agent-child");
  assert.equal(snapshot.waitJoinHints[0].active, true);
});

test("root obs command dispatches agents subcommand", async () => {
  const pi = createFakeCommandPi();
  registerObsCommand(pi, {
    agents: {
      getAgents: () => ({
        workflowId: "workflow-root",
        workflowRootAgentId: "agent-root",
        agentId: "agent-root",
        rootAgentId: "agent-root",
        role: "root",
        depth: 0,
        orphaned: false,
        activeChildren: 0,
        fanoutCount: 0,
        treeDepth: 0,
        treeWidth: 1,
        orphanCount: 0,
        children: [],
        waitJoinHints: [],
        aggregateQueries: [OBS_AGENTS_SPAWNED_PROMQL, OBS_AGENTS_FANOUT_P95_PROMQL, OBS_AGENTS_ORPHAN_PROMQL],
        aggregateRows: { spawned: [], fanoutP95: [], orphaned: [] },
        tempoSearchAttributes: { "pi.agent.id": "agent-root", "pi.workflow.id": "workflow-root" },
        traces: [],
      }),
    },
  });

  const command = pi.commands.get("obs");
  const notifications = [];
  await command.handler("agents", createCommandContext(notifications));

  assert.deepEqual(getObsRootCommandArgumentCompletions("ag"), [{ value: "agents", label: "agents" }]);
  assert.equal(notifications[0].type, "info");
  assert.match(notifications[0].message, /Workflow: workflow-root root=agent-root/u);
  assert.match(notifications[0].message, /Lineage drill-down: Tempo attributes pi.agent.id, pi.workflow.id traces=0/u);
});
