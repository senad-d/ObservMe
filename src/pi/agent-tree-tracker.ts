import { BoundedMap } from "../util/bounded-map.ts";
import type { AgentLineageContext, AgentRole } from "./agent-lineage.ts";
import { isHighCardinalityLineageKey } from "./agent-lineage.ts";

export type AgentChildStatus = "starting" | "active" | "completed" | "failed" | "cancelled" | "orphaned";

export interface AgentTreeNode {
  readonly agentId: string;
  readonly workflowId: string;
  readonly rootAgentId: string;
  readonly parentAgentId?: string;
  readonly depth: number;
  readonly role: AgentRole;
  readonly capability?: string;
  readonly orphaned: boolean;
  readonly childIds: readonly string[];
  readonly activeChildren: number;
  readonly fanoutCount: number;
  readonly status: AgentChildStatus;
}

export interface AgentTreeSummary {
  readonly activeChildren: number;
  readonly fanoutCount: number;
  readonly treeDepth: number;
  readonly treeWidth: number;
  readonly orphanCount: number;
  readonly childStatuses: Readonly<Record<AgentChildStatus, number>>;
}

export interface AgentTreeTrackerOptions {
  readonly maxAgents: number;
  readonly onEvict?: (node: AgentTreeNode) => void;
}

interface MutableAgentTreeNode {
  agentId: string;
  workflowId: string;
  rootAgentId: string;
  parentAgentId?: string;
  depth: number;
  role: AgentRole;
  capability?: string;
  orphaned: boolean;
  childIds: Set<string>;
  fanoutCount: number;
  status: AgentChildStatus;
}

const activeChildStatuses = new Set<AgentChildStatus>(["starting", "active"]);
const terminalChildStatuses = new Set<AgentChildStatus>(["completed", "failed", "cancelled", "orphaned"]);
const agentStatusOrder: AgentChildStatus[] = ["starting", "active", "completed", "failed", "cancelled", "orphaned"];

export class AgentTreeTracker {
  readonly #nodes: BoundedMap<string, MutableAgentTreeNode>;

  constructor(options: AgentTreeTrackerOptions) {
    this.#nodes = new BoundedMap({
      maxSize: options.maxAgents,
      onEvict: eviction => {
        this.detachChildReference(eviction.key);
        options.onEvict?.(snapshotNode(eviction.value, this.#nodes));
      },
    });
  }

  get size(): number {
    return this.#nodes.size;
  }

  registerAgent(lineage: AgentLineageContext, status: AgentChildStatus = "active"): AgentTreeNode {
    const existingNode = this.#nodes.get(lineage.agentId);
    if (existingNode && !isAgentStatusTransitionAllowed(existingNode.status, status)) {
      return snapshotNode(existingNode, this.#nodes);
    }

    const node = createMutableNode(lineage, status, this.isOrphan(lineage));
    this.retainParentForInsertion(node.parentAgentId);
    this.#nodes.set(lineage.agentId, node);
    this.linkParentToChild(node);
    return snapshotNode(node, this.#nodes);
  }

  updateStatus(agentId: string, status: AgentChildStatus): AgentTreeNode | undefined {
    const node = this.#nodes.get(agentId);
    if (!node || !isAgentStatusTransitionAllowed(node.status, status)) return undefined;

    node.status = status;
    if (status === "orphaned") node.orphaned = true;
    return snapshotNode(node, this.#nodes);
  }

  getAgent(agentId: string): AgentTreeNode | undefined {
    const node = this.#nodes.get(agentId);
    return node ? snapshotNode(node, this.#nodes) : undefined;
  }

  getChildren(parentAgentId: string): AgentTreeNode[] {
    const parent = this.#nodes.get(parentAgentId);
    if (!parent) return [];

    return [...parent.childIds].flatMap(childId => this.getExistingChildSnapshot(childId));
  }

  summarize(rootAgentId?: string): AgentTreeSummary {
    const nodes = this.nodesForSummary(rootAgentId);
    const childStatuses = createEmptyStatusCounts();
    const widthByDepth = new Map<number, number>();
    let activeChildren = 0;
    let fanoutCount = 0;
    let treeDepth = 0;
    let orphanCount = 0;

    for (const node of nodes) {
      childStatuses[node.status] += 1;
      activeChildren += countActiveChildren(retainedChildIds(node, this.#nodes), this.#nodes);
      fanoutCount += node.fanoutCount;
      treeDepth = Math.max(treeDepth, node.depth);
      orphanCount += node.orphaned ? 1 : 0;
      widthByDepth.set(node.depth, (widthByDepth.get(node.depth) ?? 0) + 1);
    }

    return {
      activeChildren,
      fanoutCount,
      treeDepth,
      treeWidth: maxMapValue(widthByDepth),
      orphanCount,
      childStatuses,
    };
  }

  metricLabels(status: AgentChildStatus, orphaned: boolean): Record<string, string> {
    const labels = {
      status,
      reason: orphaned ? "orphaned" : "attached",
    };

    assertNoHighCardinalityMetricLabels(labels);
    return labels;
  }

  private isOrphan(lineage: AgentLineageContext): boolean {
    if (lineage.orphaned) return true;
    if (!lineage.parentAgentId) return false;
    return !this.#nodes.has(lineage.parentAgentId);
  }

  private retainParentForInsertion(parentAgentId: string | undefined): void {
    if (!parentAgentId) return;

    const parent = this.#nodes.get(parentAgentId);
    if (!parent) return;

    this.#nodes.delete(parentAgentId);
    this.#nodes.set(parentAgentId, parent);
  }

  private linkParentToChild(node: MutableAgentTreeNode): void {
    if (!node.parentAgentId) return;

    const parent = this.#nodes.get(node.parentAgentId);
    if (!parent) return;

    const knownChild = parent.childIds.has(node.agentId);
    parent.childIds.add(node.agentId);
    if (!knownChild) parent.fanoutCount += 1;
  }

  private detachChildReference(agentId: string): void {
    for (const node of this.#nodes.values()) node.childIds.delete(agentId);
  }

  private getExistingChildSnapshot(childId: string): AgentTreeNode[] {
    const child = this.#nodes.get(childId);
    return child ? [snapshotNode(child, this.#nodes)] : [];
  }

  private nodesForSummary(rootAgentId?: string): MutableAgentTreeNode[] {
    const nodes = [...this.#nodes.values()];
    if (!rootAgentId) return nodes;
    return nodes.filter(node => node.rootAgentId === rootAgentId || node.agentId === rootAgentId);
  }
}

export function isAgentStatusTransitionAllowed(current: AgentChildStatus, next: AgentChildStatus): boolean {
  if (current === next) return true;
  if (terminalChildStatuses.has(current)) return false;
  if (current === "starting") return true;
  return next !== "starting";
}

export function assertNoHighCardinalityMetricLabels(labels: Record<string, string>): void {
  const forbiddenKey = Object.keys(labels).find(isHighCardinalityLineageKey);
  if (forbiddenKey) throw new Error(`High-cardinality lineage value must not be used as a metric label: ${forbiddenKey}`);
}

function createMutableNode(
  lineage: AgentLineageContext,
  status: AgentChildStatus,
  orphaned: boolean,
): MutableAgentTreeNode {
  return {
    agentId: lineage.agentId,
    workflowId: lineage.workflowId,
    rootAgentId: lineage.rootAgentId,
    parentAgentId: lineage.parentAgentId,
    depth: lineage.depth,
    role: lineage.role,
    capability: lineage.capability,
    orphaned,
    childIds: new Set(),
    fanoutCount: 0,
    status: orphaned ? "orphaned" : status,
  };
}

function snapshotNode(node: MutableAgentTreeNode, nodes?: BoundedMap<string, MutableAgentTreeNode>): AgentTreeNode {
  const childIds = retainedChildIds(node, nodes);

  return {
    agentId: node.agentId,
    workflowId: node.workflowId,
    rootAgentId: node.rootAgentId,
    parentAgentId: node.parentAgentId,
    depth: node.depth,
    role: node.role,
    capability: node.capability,
    orphaned: node.orphaned,
    childIds,
    activeChildren: countActiveChildren(childIds, nodes),
    fanoutCount: node.fanoutCount,
    status: node.status,
  };
}

function retainedChildIds(
  node: MutableAgentTreeNode,
  nodes?: BoundedMap<string, MutableAgentTreeNode>,
): string[] {
  if (!nodes) return [...node.childIds];
  return [...node.childIds].filter(childId => nodes.has(childId));
}

function countActiveChildren(childIds: readonly string[], nodes?: BoundedMap<string, MutableAgentTreeNode>): number {
  if (!nodes) return childIds.length;

  return childIds.filter(childId => isActiveChild(childId, nodes)).length;
}

function isActiveChild(childId: string, nodes: BoundedMap<string, MutableAgentTreeNode>): boolean {
  const child = nodes.get(childId);
  return Boolean(child && activeChildStatuses.has(child.status));
}

function createEmptyStatusCounts(): Record<AgentChildStatus, number> {
  return {
    starting: 0,
    active: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    orphaned: 0,
  };
}

function maxMapValue(values: Map<number, number>): number {
  return Math.max(0, ...values.values());
}

export const AGENT_TREE_STATUSES = agentStatusOrder;
