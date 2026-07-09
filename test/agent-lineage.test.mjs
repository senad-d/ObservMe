import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { defaultObservMeConfig } from "../src/config/defaults.ts";
import {
  clearObsAgentsRuntimeState,
  getLocalObsAgentsRuntimeSnapshot,
  updateObsAgentsRuntimeStateFromTree,
} from "../src/commands/obs-agents-runtime.ts";
import {
  buildLineageAttributes,
  createAgentLineageContext,
  createPropagationEnvironment,
  LineageValidationError,
} from "../src/pi/agent-lineage.ts";
import { AgentTreeTracker, assertNoHighCardinalityMetricLabels } from "../src/pi/agent-tree-tracker.ts";

let generatedIdCounter = 0;

function nextGeneratedId() {
  generatedIdCounter += 1;
  return `generated-${generatedIdCounter}`;
}

function resetGeneratedIds() {
  generatedIdCounter = 0;
}

function makeLineage(overrides = {}) {
  return {
    workflowId: "workflow-1",
    workflowRootAgentId: "root-1",
    agentId: "root-1",
    rootAgentId: "root-1",
    depth: 0,
    role: "root",
    orphaned: false,
    ...overrides,
  };
}

test("root workflow and agent IDs are generated from safe ID sources when parent context is untrusted", () => {
  resetGeneratedIds();
  const lineage = createAgentLineageContext({
    config: defaultObservMeConfig,
    env: {
      OBSERVME_WORKFLOW_ID: "workflow-from-untrusted-parent",
      OBSERVME_AGENT_ID: "agent-from-untrusted-parent",
      USER: "alice",
      PWD: "/Users/alice/sensitive-project",
    },
    trustedParentContext: false,
    generateId: nextGeneratedId,
  });

  assert.equal(lineage.workflowId, "workflow-generated-2");
  assert.equal(lineage.agentId, "agent-generated-1");
  assert.notEqual(lineage.workflowId, "workflow-from-untrusted-parent");
  assert.notEqual(lineage.agentId, "agent-from-untrusted-parent");
  assert.equal(lineage.rootAgentId, lineage.agentId);
  assert.equal(lineage.workflowRootAgentId, lineage.agentId);
  assert.equal(lineage.depth, 0);
  assert.equal(lineage.role, "root");
});

test("trusted parent lineage creates a subagent that preserves workflow and root IDs while incrementing depth", () => {
  resetGeneratedIds();
  const lineage = createAgentLineageContext({
    config: defaultObservMeConfig,
    env: {
      OBSERVME_WORKFLOW_ID: "workflow-parent-1",
      OBSERVME_PARENT_AGENT_ID: "agent-parent-1",
      OBSERVME_ROOT_AGENT_ID: "agent-root-1",
      OBSERVME_AGENT_DEPTH: "1",
      OBSERVME_AGENT_CAPABILITY: "code-review",
    },
    trustedParentContext: true,
    role: "worker",
    generateId: nextGeneratedId,
  });

  assert.equal(lineage.workflowId, "workflow-parent-1");
  assert.equal(lineage.agentId, "agent-generated-1");
  assert.equal(lineage.parentAgentId, "agent-parent-1");
  assert.equal(lineage.rootAgentId, "agent-root-1");
  assert.equal(lineage.workflowRootAgentId, "agent-root-1");
  assert.equal(lineage.depth, 2);
  assert.equal(lineage.role, "worker");
  assert.equal(lineage.capability, "code-review");
});

test("lineage attributes include root-agent and subagent correlation fields", () => {
  const root = makeLineage({ agentId: "agent-root", rootAgentId: "agent-root", workflowRootAgentId: "agent-root" });
  const child = makeLineage({
    agentId: "agent-child",
    parentAgentId: "agent-root",
    rootAgentId: "agent-root",
    workflowRootAgentId: "agent-root",
    depth: 1,
    role: "subagent",
    capability: "analysis",
  });

  assert.deepEqual(buildLineageAttributes(root), {
    "pi.workflow.id": "workflow-1",
    "pi.workflow.root_agent_id": "agent-root",
    "pi.agent.id": "agent-root",
    "pi.agent.root_id": "agent-root",
    "pi.agent.role": "root",
    "pi.agent.depth": 0,
  });
  assert.equal(buildLineageAttributes(child)["pi.agent.parent_id"], "agent-root");
  assert.equal(buildLineageAttributes(child)["pi.agent.capability"], "analysis");
});

test("propagation environment sends only generated workflow and parent lineage to child agents", () => {
  const lineage = makeLineage({ agentId: "agent-parent", rootAgentId: "agent-root", depth: 3, capability: "planning" });
  const env = createPropagationEnvironment(lineage, defaultObservMeConfig, { PATH: "/usr/bin" });

  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.OBSERVME_WORKFLOW_ID, "workflow-1");
  assert.equal(env.OBSERVME_PARENT_AGENT_ID, "agent-parent");
  assert.equal(env.OBSERVME_ROOT_AGENT_ID, "agent-root");
  assert.equal(env.OBSERVME_AGENT_DEPTH, "3");
  assert.equal(env.OBSERVME_AGENT_CAPABILITY, "planning");
  assert.equal(env.OBSERVME_AGENT_ID, undefined);
});

test("malformed and oversized propagated lineage values are rejected", () => {
  assert.throws(
    () =>
      createAgentLineageContext({
        config: defaultObservMeConfig,
        env: { OBSERVME_WORKFLOW_ID: "bad/workflow" },
        trustedParentContext: true,
      }),
    LineageValidationError,
  );
  assert.throws(
    () =>
      createAgentLineageContext({
        config: defaultObservMeConfig,
        env: { OBSERVME_PARENT_AGENT_ID: "a".repeat(129) },
        trustedParentContext: true,
      }),
    /malformed, oversized, or unsafe/u,
  );
});

test("agent tree tracker records active children, fan-out, depth, width, orphan state, and status", () => {
  const tracker = new AgentTreeTracker({ maxAgents: 8 });
  const root = makeLineage({ agentId: "agent-root", rootAgentId: "agent-root", workflowRootAgentId: "agent-root" });
  const childA = makeLineage({
    agentId: "agent-child-a",
    parentAgentId: "agent-root",
    rootAgentId: "agent-root",
    workflowRootAgentId: "agent-root",
    depth: 1,
    role: "subagent",
  });
  const childB = makeLineage({
    agentId: "agent-child-b",
    parentAgentId: "agent-root",
    rootAgentId: "agent-root",
    workflowRootAgentId: "agent-root",
    depth: 1,
    role: "subagent",
  });
  const orphan = makeLineage({
    agentId: "agent-orphan",
    parentAgentId: "missing-parent",
    rootAgentId: "agent-root",
    workflowRootAgentId: "agent-root",
    depth: 1,
    role: "subagent",
  });

  tracker.registerAgent(root);
  tracker.registerAgent(childA, "starting");
  tracker.registerAgent(childB, "active");
  tracker.updateStatus("agent-child-a", "completed");
  tracker.registerAgent(orphan, "active");

  const rootNode = tracker.getAgent("agent-root");
  const summary = tracker.summarize("agent-root");

  assert.deepEqual(rootNode.childIds, ["agent-child-a", "agent-child-b"]);
  assert.equal(rootNode.activeChildren, 1);
  assert.equal(rootNode.fanoutCount, 2);
  assert.equal(summary.activeChildren, 1);
  assert.equal(summary.fanoutCount, 2);
  assert.equal(summary.treeDepth, 1);
  assert.equal(summary.treeWidth, 3);
  assert.equal(summary.orphanCount, 1);
  assert.equal(summary.childStatuses.completed, 1);
  assert.equal(summary.childStatuses.active, 2);
  assert.equal(tracker.getAgent("agent-orphan").status, "orphaned");
});

test("agent tree eviction detaches stale child ids while preserving historical fan-out", t => {
  clearObsAgentsRuntimeState();
  t.after(clearObsAgentsRuntimeState);

  const evicted = [];
  const tracker = new AgentTreeTracker({ maxAgents: 3, onEvict: node => evicted.push(node.agentId) });
  const root = makeLineage({ agentId: "agent-root", rootAgentId: "agent-root", workflowRootAgentId: "agent-root" });

  tracker.registerAgent(root);
  for (let index = 1; index <= 12; index += 1) {
    tracker.registerAgent(makeLineage({
      agentId: `agent-child-${index}`,
      parentAgentId: "agent-root",
      rootAgentId: "agent-root",
      workflowRootAgentId: "agent-root",
      depth: 1,
      role: "subagent",
    }));
  }

  updateObsAgentsRuntimeStateFromTree(root, tracker);
  const rootNode = tracker.getAgent("agent-root");
  const summary = tracker.summarize("agent-root");
  const runtime = getLocalObsAgentsRuntimeSnapshot();

  assert.equal(tracker.size, 3);
  assert.deepEqual(evicted, Array.from({ length: 10 }, (_, index) => `agent-child-${index + 1}`));
  assert.deepEqual(rootNode.childIds, ["agent-child-11", "agent-child-12"]);
  assert.equal(rootNode.activeChildren, 2);
  assert.equal(rootNode.fanoutCount, 12);
  assert.equal(summary.activeChildren, 2);
  assert.equal(summary.fanoutCount, 12);
  assert.deepEqual(runtime.currentAgent.childIds, ["agent-child-11", "agent-child-12"]);
  assert.deepEqual(runtime.children.map(child => child.agentId), ["agent-child-11", "agent-child-12"]);
});

test("agent tree metric labels exclude lineage identifiers", () => {
  const tracker = new AgentTreeTracker({ maxAgents: 2 });
  const labels = tracker.metricLabels("active", false);

  assert.deepEqual(labels, { status: "active", reason: "attached" });
  assert.doesNotThrow(() => assertNoHighCardinalityMetricLabels(labels));
  assert.throws(() => assertNoHighCardinalityMetricLabels({ "pi.workflow.id": "workflow-1" }), /High-cardinality/u);
});

test("agent lineage modules are independent from Pi and OTEL packages", async () => {
  const lineageSource = await readFile("src/pi/agent-lineage.ts", "utf8");
  const treeSource = await readFile("src/pi/agent-tree-tracker.ts", "utf8");

  assert.equal(lineageSource.includes("@opentelemetry"), false);
  assert.equal(treeSource.includes("@opentelemetry"), false);
  assert.equal(lineageSource.includes("@earendil-works/pi"), false);
  assert.equal(treeSource.includes("@earendil-works/pi"), false);
});
