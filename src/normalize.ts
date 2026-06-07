import type {
  BranchDecision,
  BranchCandidate,
  InitiativeItem,
  OpportunityItem,
  PhaseId,
  PriorityBucket,
  PriorityItem,
  StructuredPhaseOutput,
  WorkItem,
  WorkTrack,
  WorkSize,
} from "./types.js";

function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => asString(entry))
      .filter((entry): entry is string => Boolean(entry));
  }
  const single = asString(value);
  return single ? [single] : [];
}

function normalizePriorityBucket(value: unknown): PriorityBucket {
  const normalized = asString(value);
  switch (normalized) {
    case "must_fix_regression":
    case "acceptance_gap":
    case "quality_improvement":
    case "nice_to_have_polish":
      return normalized;
    default:
      return "quality_improvement";
  }
}

function normalizeBacklog(value: unknown): PriorityItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry, index) => {
    if (typeof entry === "string") {
      return [
        {
          id: `item-${index + 1}`,
          bucket: "quality_improvement" as const,
          title: entry,
          rationale: "Generated from a plain-string model backlog item.",
          source: "model",
          severity: 2,
        },
      ];
    }

    if (!entry || typeof entry !== "object") {
      return [];
    }

    const title = asString((entry as Record<string, unknown>).title) ?? `item-${index + 1}`;
    return [
      {
        id: asString((entry as Record<string, unknown>).id) ?? `item-${index + 1}`,
        bucket: normalizePriorityBucket((entry as Record<string, unknown>).bucket),
        title,
        rationale:
          asString((entry as Record<string, unknown>).rationale) ??
          "No rationale provided by the model.",
        source: asString((entry as Record<string, unknown>).source) ?? "model",
        severity: Math.max(1, Math.min(5, asNumber((entry as Record<string, unknown>).severity) ?? 2)),
      },
    ];
  });
}

function normalizeOpportunities(value: unknown): OpportunityItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry, index) => {
    if (typeof entry === "string") {
      return [
        {
          id: `opportunity-${index + 1}`,
          title: entry,
          rationale: "Generated from a plain-string opportunity item.",
          source: "model",
          severity: 2,
        },
      ];
    }

    if (!entry || typeof entry !== "object") {
      return [];
    }

    const record = entry as Record<string, unknown>;
    const title = asString(record.title) ?? `opportunity-${index + 1}`;
    const output: OpportunityItem = {
      id: asString(record.id) ?? `opportunity-${index + 1}`,
      title,
      rationale: asString(record.rationale) ?? "No rationale provided by the model.",
      source: asString(record.source) ?? "model",
      severity: Math.max(1, Math.min(5, asNumber(record.severity) ?? 2)),
    };
    const track = normalizeWorkTrack(record.track);
    if (track) {
      output.track = track;
    }
    const acceptanceHint = asString(record.acceptanceHint);
    if (acceptanceHint) {
      output.acceptanceHint = acceptanceHint;
    }
    return [output];
  });
}

function normalizeInitiatives(value: unknown): InitiativeItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry, index) => {
    if (typeof entry === "string") {
      return [
        {
          id: `initiative-${index + 1}`,
          title: entry,
          rationale: "Generated from a plain-string initiative item.",
          source: "model",
          severity: 3,
        },
      ];
    }

    if (!entry || typeof entry !== "object") {
      return [];
    }

    const record = entry as Record<string, unknown>;
    const output: InitiativeItem = {
      id: asString(record.id) ?? `initiative-${index + 1}`,
      title: asString(record.title) ?? `initiative-${index + 1}`,
      rationale: asString(record.rationale) ?? "No rationale provided by the model.",
      source: asString(record.source) ?? "model",
      severity: Math.max(1, Math.min(5, asNumber(record.severity) ?? 3)),
    };
    const track = normalizeWorkTrack(record.track);
    if (track) {
      output.track = track;
    }
    const acceptanceHint = asString(record.acceptanceHint);
    if (acceptanceHint) {
      output.acceptanceHint = acceptanceHint;
    }
    const branchHingeHint = asString(record.branchHingeHint);
    if (branchHingeHint) {
      output.branchHingeHint = branchHingeHint;
    }
    return [output];
  });
}

function normalizeWorkSize(value: unknown): WorkSize {
  const normalized = asString(value);
  switch (normalized) {
    case "tiny":
    case "small":
    case "medium":
    case "large":
    case "oversized":
      return normalized;
    default:
      return "medium";
  }
}

function normalizeWorkTrack(value: unknown): WorkTrack | undefined {
  const normalized = asString(value);
  switch (normalized) {
    case "delivery":
    case "exploration":
      return normalized;
    default:
      return undefined;
  }
}

function normalizeWorkBreakdown(value: unknown, depth = 0): WorkItem[] {
  if (depth > 3) {
    return [];
  }
  const entries = Array.isArray(value) ? value : (value && typeof value === "object" ? [value] : []);
  if (entries.length === 0) {
    return [];
  }

  return entries.flatMap((entry, index) => {
    if (typeof entry === "string") {
      return [
        {
          id: `work-${depth + 1}-${index + 1}`,
          title: entry,
          size: "medium" as const,
          rationale: "Generated from a plain-string model work item.",
        },
      ];
    }

    if (!entry || typeof entry !== "object") {
      return [];
    }

    const record = entry as Record<string, unknown>;
    const title = asString(record.title) ?? `work-${depth + 1}-${index + 1}`;
    const children = normalizeWorkBreakdown(record.children, depth + 1);
    const output: WorkItem = {
      id: asString(record.id) ?? `work-${depth + 1}-${index + 1}`,
      title,
      size: normalizeWorkSize(record.size),
      rationale:
        asString(record.rationale) ?? "No rationale provided by the model.",
    };
    const track = normalizeWorkTrack(record.track);
    if (track) {
      output.track = track;
    }
    const acceptanceHint = asString(record.acceptanceHint);
    if (acceptanceHint) {
      output.acceptanceHint = acceptanceHint;
    }
    if (children.length > 0) {
      output.children = children;
    }
    return [output];
  });
}

function normalizeBranchDecision(value: unknown): BranchDecision | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const output: BranchDecision = {};
  if (typeof record.shouldBranch === "boolean") {
    output.shouldBranch = record.shouldBranch;
  }
  const templateId = asString(record.templateId);
  if (templateId) {
    output.templateId = templateId;
  }
  const selectedCandidateIds = toStringArray(record.selectedCandidateIds);
  if (selectedCandidateIds.length > 0) {
    output.selectedCandidateIds = selectedCandidateIds;
  }
  const rationale = asString(record.rationale);
  if (rationale) {
    output.rationale = rationale;
  }
  const proposedHinge = asString(record.proposedHinge);
  if (proposedHinge) {
    output.proposedHinge = proposedHinge;
  }
  const maxKeep = asNumber(record.maxKeep);
  if (maxKeep !== undefined) {
    output.maxKeep = Math.max(1, Math.min(3, Math.round(maxKeep)));
  }
  if (Array.isArray(record.proposedCandidates)) {
    const proposedCandidates = record.proposedCandidates.flatMap((entry, index) => {
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const candidate = entry as Record<string, unknown>;
      const id = asString(candidate.id) ?? `proposed-candidate-${index + 1}`;
      const label = asString(candidate.label) ?? id;
      const promptHint =
        asString(candidate.promptHint) ?? "No additional branch hint provided.";
      const outputCandidate: BranchCandidate = {
        id,
        label,
        promptHint,
      };
      return [outputCandidate];
    });
    if (proposedCandidates.length > 0) {
      output.proposedCandidates = proposedCandidates;
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

export function normalizePhaseOutput(
  phase: Exclude<PhaseId, "judging">,
  raw: StructuredPhaseOutput,
): StructuredPhaseOutput {
  const output: StructuredPhaseOutput = {
    summary: asString(raw.summary) ?? `Completed ${phase}`,
  };

  const confidence = asNumber(raw.confidence);
  if (confidence !== undefined) {
    output.confidence = Number(confidence.toFixed(2));
  }

  const acceptanceChecklist = toStringArray(raw.acceptanceChecklist);
  if (acceptanceChecklist.length > 0) {
    output.acceptanceChecklist = acceptanceChecklist;
  }

  const architectureDirectives = toStringArray(raw.architectureDirectives);
  if (architectureDirectives.length > 0) {
    output.architectureDirectives = architectureDirectives;
  }

  const backlog = normalizeBacklog(raw.backlog);
  if (backlog.length > 0) {
    output.backlog = backlog;
  }

  const opportunities = normalizeOpportunities(raw.opportunities);
  if (opportunities.length > 0) {
    output.opportunities = opportunities;
  }

  const workBreakdown = normalizeWorkBreakdown(raw.workBreakdown);
  if (workBreakdown.length > 0) {
    output.workBreakdown = workBreakdown;
  }

  const initiatives = normalizeInitiatives(raw.initiatives);
  if (initiatives.length > 0) {
    output.initiatives = initiatives;
  }

  const branchDecision = normalizeBranchDecision(raw.branchDecision);
  if (branchDecision) {
    output.branchDecision = branchDecision;
  }

  const risks = toStringArray(raw.risks);
  if (risks.length > 0) {
    output.risks = risks;
  }

  const testStrategy = toStringArray(raw.testStrategy);
  if (testStrategy.length > 0) {
    output.testStrategy = testStrategy;
  }

  const unresolvedIssues = toStringArray(raw.unresolvedIssues);
  if (unresolvedIssues.length > 0) {
    output.unresolvedIssues = unresolvedIssues;
  }

  const recommendations = toStringArray(raw.recommendations);
  if (recommendations.length > 0) {
    output.recommendations = recommendations;
  }

  const commandsRun = toStringArray(raw.commandsRun);
  if (commandsRun.length > 0) {
    output.commandsRun = commandsRun;
  }

  const filesTouched = toStringArray(raw.filesTouched);
  if (filesTouched.length > 0) {
    output.filesTouched = filesTouched;
  }

  const notes = toStringArray(raw.notes);
  if (notes.length > 0) {
    output.notes = notes;
  }

  return output;
}
