import { randomUUID } from "node:crypto";

export interface RunBudget {
  maxTokens: number;
  maxCostUsd: number;
}

export interface SubagentNode {
  runId: string;
  parentRunId?: string;
  depth: number;
  budget: RunBudget;
  status: "running" | "succeeded" | "failed" | "cancelled";
  children: readonly string[];
}

export class SubagentGraph {
  readonly #nodes = new Map<string, SubagentNode>();

  constructor(private readonly maxDepth = 3) {}

  addRoot(runId: string, budget: RunBudget): SubagentNode {
    if (this.#nodes.has(runId)) throw new Error(`Run already exists in graph: ${runId}`);
    const node: SubagentNode = { runId, depth: 0, budget: { ...budget }, status: "running", children: [] };
    this.#nodes.set(runId, node);
    return node;
  }

  createChild(parentRunId: string, budget: RunBudget): SubagentNode {
    const parent = this.#require(parentRunId);
    if (parent.status !== "running") throw new Error("Cannot create a child for a terminal parent");
    if (parent.depth >= this.maxDepth) throw new Error("Subagent nesting limit reached");
    if (budget.maxTokens > parent.budget.maxTokens || budget.maxCostUsd > parent.budget.maxCostUsd) {
      throw new Error("Child budget cannot exceed parent budget");
    }
    const runId = `run_${randomUUID().replaceAll("-", "")}`;
    const child: SubagentNode = {
      runId,
      parentRunId,
      depth: parent.depth + 1,
      budget: { ...budget },
      status: "running",
      children: [],
    };
    this.#nodes.set(runId, child);
    this.#nodes.set(parentRunId, { ...parent, children: [...parent.children, runId] });
    return child;
  }

  complete(runId: string, status: "succeeded" | "failed"): void {
    const node = this.#require(runId);
    this.#nodes.set(runId, { ...node, status });
  }

  cancel(runId: string): string[] {
    const cancelled: string[] = [];
    const visit = (id: string) => {
      const node = this.#require(id);
      for (const child of node.children) visit(child);
      if (node.status === "running") {
        this.#nodes.set(id, { ...node, status: "cancelled" });
        cancelled.push(id);
      }
    };
    visit(runId);
    return cancelled;
  }

  get(runId: string): SubagentNode | undefined {
    const node = this.#nodes.get(runId);
    return node ? { ...node, budget: { ...node.budget }, children: [...node.children] } : undefined;
  }

  #require(runId: string): SubagentNode {
    const node = this.#nodes.get(runId);
    if (!node) throw new Error(`Run is not in the subagent graph: ${runId}`);
    return node;
  }
}
