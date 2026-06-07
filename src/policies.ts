import type {
  BranchCandidate,
  BranchDecision,
  BranchTemplate,
  PolicyDefinition,
  PolicyId,
  ResolvedBenchmarkSpec,
} from "./types.js";

function slugifyBranchToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

const POLICIES: Record<PolicyId, PolicyDefinition> = {
  single_pass: {
    id: "single_pass",
    title: "Single Pass",
    description: "One PM-to-judge cycle with no branching and no repair loop.",
    phases: ["pm_intake", "planning", "execution", "review", "judging"],
    branching: "off",
  },
  gated_role_loop: {
    id: "gated_role_loop",
    title: "Gated Role Loop",
    description: "Role-based cycle with PM reprioritization and judge-informed repair queues.",
    phases: [
      "pm_intake",
      "planning",
      "execution",
      "review",
      "judging",
      "pm_reprioritization",
    ],
    branching: "off",
  },
  lean_handoff_loop: {
    id: "lean_handoff_loop",
    title: "Lean Handoff Loop",
    description:
      "Role-based cycle that keeps PM/TL intake and planning, but uses judge/review artifacts for deterministic reprioritization instead of a separate PM reprioritization turn.",
    phases: ["pm_intake", "planning", "execution", "review", "judging"],
    branching: "off",
  },
  repair_focus_loop: {
    id: "repair_focus_loop",
    title: "Repair Focus Loop",
    description:
      "Full PM/TL-guided first cycle, then direct repair passes that reuse the existing backlog and architecture guidance instead of replanning every cycle.",
    phases: [
      "pm_intake",
      "planning",
      "execution",
      "review",
      "judging",
      "pm_reprioritization",
    ],
    branching: "off",
  },
  branch_rank_revise: {
    id: "branch_rank_revise",
    title: "Branch Rank Revise",
    description: "Role-based cycle that branches once on a manifest-defined hinge, ranks candidates, then reprioritizes.",
    phases: [
      "pm_intake",
      "planning",
      "execution",
      "review",
      "judging",
      "pm_reprioritization",
    ],
    branching: "template_first_cycle",
  },
};

export function getPolicy(policyId: PolicyId): PolicyDefinition {
  return POLICIES[policyId];
}

export function shouldBranchThisCycle(
  policyId: PolicyId,
  spec: ResolvedBenchmarkSpec,
  cycleNumber: number,
  usedBranchTemplateIds: string[],
): boolean {
  const policy = getPolicy(policyId);
  if (policy.branching === "off") {
    return false;
  }
  if (cycleNumber !== 1) {
    return false;
  }
  return spec.branchTemplates.some((template) => !usedBranchTemplateIds.includes(template.id));
}

export function preExecutionPhasesForCycle(
  policyId: PolicyId,
  cycleNumber: number,
): Array<Extract<"pm_intake" | "planning", "pm_intake" | "planning">> {
  if (policyId === "single_pass") {
    return ["pm_intake", "planning"];
  }
  if (policyId === "repair_focus_loop") {
    return cycleNumber === 1 ? ["pm_intake", "planning"] : [];
  }
  return cycleNumber === 1 ? ["pm_intake", "planning"] : ["planning"];
}

function firstUnusedBranchTemplate(
  templates: BranchTemplate[],
  usedTemplateIds: string[],
): BranchTemplate | undefined {
  return templates.find((template) => !usedTemplateIds.includes(template.id));
}

export interface ResolvedBranchPlan {
  template: BranchTemplate;
  candidates: BranchCandidate[];
}

export function resolveBranchPlan(
  policyId: PolicyId,
  spec: ResolvedBenchmarkSpec,
  cycleNumber: number,
  usedBranchTemplateIds: string[],
  decision?: BranchDecision,
): ResolvedBranchPlan | undefined {
  if (decision?.shouldBranch !== true) {
    return undefined;
  }

  const canUseRuntimeBranch =
    (policyId === "branch_rank_revise" || policyId === "repair_focus_loop")
    && cycleNumber <= 3
    && usedBranchTemplateIds.length < 2;
  const canUseTemplateBranch = shouldBranchThisCycle(
    policyId,
    spec,
    cycleNumber,
    usedBranchTemplateIds,
  );

  if (!canUseRuntimeBranch && !canUseTemplateBranch) {
    return undefined;
  }

  if (decision.proposedCandidates && decision.proposedCandidates.length > 1 && canUseRuntimeBranch) {
    const selectedIdSet = new Set(decision.selectedCandidateIds ?? []);
    const filteredCandidates =
      selectedIdSet.size > 0
        ? decision.proposedCandidates.filter((candidate) => selectedIdSet.has(candidate.id))
        : decision.proposedCandidates;
    if (filteredCandidates.length < 2 && decision.proposedCandidates.length >= 2) {
      return undefined;
    }
    const hingeLabel = decision.proposedHinge?.trim() || "Runtime branch hinge";
    const templateId = `dynamic-${cycleNumber}-${slugifyBranchToken(hingeLabel || "runtime")}`;
    return {
      template: {
        id: templateId,
        label: hingeLabel,
        stage: "planning",
        ...(decision.maxKeep ? { maxKeep: decision.maxKeep } : { maxKeep: 2 }),
        candidates: decision.proposedCandidates,
      },
      candidates: filteredCandidates,
    };
  }

  if (!canUseTemplateBranch) {
    return undefined;
  }

  const template = decision.templateId
    ? spec.branchTemplates.find(
        (candidate) =>
          candidate.id === decision.templateId && !usedBranchTemplateIds.includes(candidate.id),
      )
    : firstUnusedBranchTemplate(spec.branchTemplates, usedBranchTemplateIds);

  if (!template) {
    return undefined;
  }

  const selectedIds = decision.selectedCandidateIds ?? [];
  if (selectedIds.length === 0) {
    return {
      template,
      candidates: template.candidates,
    };
  }

  const selectedIdSet = new Set(selectedIds);
  const candidates = template.candidates.filter((candidate) => selectedIdSet.has(candidate.id));
  if (candidates.length === 0) {
    return undefined;
  }

  return {
    template,
    candidates,
  };
}
