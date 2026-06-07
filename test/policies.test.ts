import { describe, expect, it } from "vitest";
import { preExecutionPhasesForCycle, resolveBranchPlan } from "../src/policies.js";
import type { ResolvedBenchmarkSpec } from "../src/types.js";

function makeSpec(): ResolvedBenchmarkSpec {
  return {
    id: "branching-demo",
    title: "Branching Demo",
    summary: "Demo benchmark for branch resolution tests",
    artifactTarget: "Repo",
    publicBriefFile: "benchmarks/branching-demo/brief.md",
    publicBriefPath: "/tmp/brief.md",
    publicBrief: "Demo",
    benchmarkDir: "/tmp/benchmarks/branching-demo",
    workspaceSeed: "seeds/branching-demo",
    workspaceSeedPath: "/tmp/seeds/branching-demo",
    budgets: { minMinutes: 20, maxMinutes: 60, defaultMinutes: 30 },
    acceptanceCriteria: [],
    branchTemplates: [
      {
        id: "architecture_choice",
        label: "Architecture choice",
        stage: "planning",
        maxKeep: 2,
        candidates: [
          {
            id: "thin_router",
            label: "Thin router",
            promptHint: "Prefer a thin router plus service module split.",
          },
          {
            id: "rich_handler",
            label: "Rich handler",
            promptHint: "Prefer a fatter handler with fewer files.",
          },
        ],
      },
    ],
    hiddenChecks: [],
    judgeWeights: {},
    expectedRoleOutputs: {},
    successThreshold: 80,
  };
}

describe("resolveBranchPlan", () => {
  it("does not branch when the planner says not to branch", () => {
    const plan = resolveBranchPlan(
      "branch_rank_revise",
      makeSpec(),
      1,
      [],
      {
        shouldBranch: false,
        rationale: "Not worth spending budget on branching yet.",
      },
    );

    expect(plan).toBeUndefined();
  });

  it("filters the selected branch candidates from the planning output", () => {
    const plan = resolveBranchPlan(
      "branch_rank_revise",
      makeSpec(),
      1,
      [],
      {
        shouldBranch: true,
        templateId: "architecture_choice",
        selectedCandidateIds: ["thin_router"],
        rationale: "Only one branch looks worth exploring.",
      },
    );

    expect(plan?.template.id).toBe("architecture_choice");
    expect(plan?.candidates.map((candidate) => candidate.id)).toEqual(["thin_router"]);
  });

  it("accepts a runtime-proposed branch hinge for repair-focus runs", () => {
    const plan = resolveBranchPlan(
      "repair_focus_loop",
      makeSpec(),
      2,
      [],
      {
        shouldBranch: true,
        proposedHinge: "UI shell vs simulation-first slice",
        proposedCandidates: [
          {
            id: "ui-shell",
            label: "UI shell first",
            promptHint: "Prove the navigable desktop shell and management loop framing first.",
          },
          {
            id: "sim-core",
            label: "Simulation core first",
            promptHint: "Prioritize the engine and progression model before broad UI shell work.",
          },
        ],
        selectedCandidateIds: ["ui-shell", "sim-core"],
        rationale: "The benchmark did not predeclare this hinge, but the run should compare it.",
      },
    );

    expect(plan?.template.id).toContain("dynamic-2-ui-shell-vs-simulation-first-slice");
    expect(plan?.template.label).toBe("UI shell vs simulation-first slice");
    expect(plan?.candidates.map((candidate) => candidate.id)).toEqual(["ui-shell", "sim-core"]);
  });
});

describe("preExecutionPhasesForCycle", () => {
  it("skips replanning on later repair-focus cycles", () => {
    expect(preExecutionPhasesForCycle("repair_focus_loop", 1)).toEqual([
      "pm_intake",
      "planning",
    ]);
    expect(preExecutionPhasesForCycle("repair_focus_loop", 2)).toEqual([]);
  });
});
