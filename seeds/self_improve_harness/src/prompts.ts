import type {
  BenchmarkSpec,
  BranchCandidate,
  HiddenCheck,
  InitiativeItem,
  OpportunityItem,
  PhaseId,
  PriorityItem,
  RunnerPhaseContext,
  StructuredPhaseOutput,
  WorkItem,
} from "./types.js";
import { truncate } from "./utils.js";

function renderPriorityQueue(items: PriorityItem[]): string {
  if (items.length === 0) {
    return "- none yet";
  }

  return items
    .map(
      (item, index) =>
        `${index + 1}. [${item.bucket}] ${item.title} (severity ${item.severity})\n   source: ${item.source}\n   rationale: ${item.rationale}`,
    )
    .join("\n");
}

function renderOpportunityQueue(items: OpportunityItem[] | undefined): string {
  if (!items || items.length === 0) {
    return "- none yet";
  }

  return items
    .slice(0, 8)
    .map(
      (item, index) =>
        `${index + 1}. [${item.track ?? "delivery"}] ${item.title} (severity ${item.severity})\n   source: ${item.source}\n   rationale: ${item.rationale}`,
    )
    .join("\n");
}

function renderInitiativeQueue(items: InitiativeItem[] | undefined): string {
  if (!items || items.length === 0) {
    return "- none yet";
  }

  return items
    .slice(0, 6)
    .map(
      (item, index) =>
        `${index + 1}. [${item.track ?? "delivery"}] ${item.title} (severity ${item.severity})\n   source: ${item.source}\n   rationale: ${item.rationale}${item.branchHingeHint ? `\n   branch hinge: ${item.branchHingeHint}` : ""}`,
    )
    .join("\n");
}

function renderQuotedList(items: string[]): string {
  return items.map((item) => `\`${item}\``).join(", ");
}

function renderGlobCountHint(pattern: string, count: number): string {
  if (pattern.endsWith(".*")) {
    const base = pattern.slice(0, -2);
    const leaf = base.split("/").pop() ?? "entry";
    if (leaf.length > 0 && !leaf.includes("*")) {
      return `Create ${count} shallow file(s) matching \`${pattern}\`, such as \`${base}.ts\` or \`${base}.js\`. Do not add another directory layer like \`${base}/${leaf}.ts\` unless the brief explicitly asks for it.`;
    }
  }

  if (pattern.endsWith("/**")) {
    const root = pattern.slice(0, -3);
    return `Create at least ${count} file(s) under \`${root}/\`.`;
  }

  return `Create ${count} file(s) matching \`${pattern}\`.`;
}

function renderHiddenCheckHint(check: HiddenCheck): string | undefined {
  switch (check.type) {
    case "fileExists":
      return check.path ? `Create the literal file \`${check.path}\`.` : undefined;
    case "globCount":
      return check.pattern ? renderGlobCountHint(check.pattern, check.count ?? 1) : undefined;
    case "globAnyCount":
      if (!check.patterns?.length) {
        return undefined;
      }
      return `Create at least ${check.count ?? 1} file(s) matching one of: ${renderQuotedList(check.patterns)}.`;
    case "textIncludes":
      if (!check.path || !check.includes?.length) {
        return undefined;
      }
      return `Ensure \`${check.path}\` includes ${check.mode === "any" ? "at least one of" : "all of"}: ${renderQuotedList(check.includes)}.`;
    case "globTextIncludes":
      if (!check.pattern || !check.includes?.length) {
        return undefined;
      }
      return `In files matching \`${check.pattern}\`, include ${check.mode === "any" ? "at least one of" : "all of"}: ${renderQuotedList(check.includes)}.`;
    case "commandExitZero":
      return check.command
        ? `Leave the repo in a state where \`${check.command}\` exits successfully.`
        : undefined;
    case "appSmoke":
      if (!check.url) {
        return undefined;
      }
      return `Leave the app in a state where a browser smoke check against \`${check.url}\`${check.startCommand ? ` using \`${check.startCommand}\`` : ""} passes${
        check.waitForSelector ? ` after finding selector \`${check.waitForSelector}\`` : ""
      }${check.waitForText?.length ? ` and text ${renderQuotedList(check.waitForText)}` : ""}.`;
  }
}

function renderArtifactTargetHints(benchmark: BenchmarkSpec): string {
  const prioritizedChecks = benchmark.hiddenChecks
    .slice()
    .sort((left, right) => Number(right.required ?? false) - Number(left.required ?? false));
  const hints = prioritizedChecks
    .map((check) => renderHiddenCheckHint(check))
    .filter((hint): hint is string => Boolean(hint))
    .slice(0, 10);

  return hints.length > 0 ? hints.map((hint) => `- ${hint}`).join("\n") : "- none";
}

function renderPhaseFields(phase: Exclude<PhaseId, "judging">): string[] {
  switch (phase) {
    case "pm_intake":
      return [
        "summary",
        "confidence",
        "backlog",
        "workBreakdown",
        "initiatives",
        "opportunities",
        "acceptanceChecklist",
        "architectureDirectives",
        "risks",
        "recommendations",
      ];
    case "planning":
      return [
        "summary",
        "confidence",
        "workBreakdown",
        "initiatives",
        "opportunities",
        "branchDecision",
        "architectureDirectives",
        "testStrategy",
        "risks",
        "recommendations",
      ];
    case "execution":
      return [
        "summary",
        "confidence",
        "commandsRun",
        "filesTouched",
        "initiatives",
        "opportunities",
        "unresolvedIssues",
        "recommendations",
      ];
    case "review":
      return [
        "summary",
        "confidence",
        "initiatives",
        "opportunities",
        "unresolvedIssues",
        "recommendations",
        "risks",
      ];
    case "pm_reprioritization":
      return [
        "summary",
        "confidence",
        "backlog",
        "workBreakdown",
        "initiatives",
        "opportunities",
        "architectureDirectives",
        "recommendations",
        "risks",
        "notes",
      ];
  }
}

function renderBranchContext(candidate?: BranchCandidate): string {
  if (!candidate) {
    return "No active branch candidate for this phase.";
  }

  return `Branch candidate: ${candidate.label} (${candidate.id})\nBranch hint: ${candidate.promptHint}`;
}

function renderPhaseHistory(
  previousPhaseOutputs: RunnerPhaseContext["previousPhaseOutputs"],
): string {
  const orderedPhases: Exclude<PhaseId, "judging">[] = [
    "pm_intake",
    "planning",
    "execution",
    "review",
    "pm_reprioritization",
  ];
  const sections = orderedPhases.flatMap((phase) => {
    const output = previousPhaseOutputs[phase];
    if (!output) {
      return [];
    }

    const lines: string[] = [`- summary: ${output.summary}`];
    if (output.backlog?.length) {
      lines.push(
        `- backlog: ${output.backlog
          .slice(0, 4)
          .map((item) => `[${item.bucket}] ${item.title}`)
          .join("; ")}`,
      );
    }
    if (output.workBreakdown?.length) {
      lines.push(`- work breakdown:\n${renderWorkBreakdown(output.workBreakdown)}`);
    }
    if (output.initiatives?.length) {
      lines.push(
        `- initiatives: ${output.initiatives
          .slice(0, 4)
          .map((item) => `[${item.track ?? "delivery"}] ${item.title}`)
          .join("; ")}`,
      );
    }
    if (output.opportunities?.length) {
      lines.push(
        `- opportunities: ${output.opportunities
          .slice(0, 4)
          .map((item) => `[${item.track ?? "delivery"}] ${item.title}`)
          .join("; ")}`,
      );
    }
    if (output.acceptanceChecklist?.length) {
      lines.push(`- acceptance: ${output.acceptanceChecklist.slice(0, 4).join("; ")}`);
    }
    if (output.architectureDirectives?.length) {
      lines.push(`- architecture: ${output.architectureDirectives.slice(0, 4).join("; ")}`);
    }
    if (output.branchDecision) {
      const selected = output.branchDecision.selectedCandidateIds?.join(", ");
      lines.push(
        `- branch decision: shouldBranch=${output.branchDecision.shouldBranch ?? "n/a"}${
          output.branchDecision.templateId ? ` template=${output.branchDecision.templateId}` : ""
        }${output.branchDecision.proposedHinge ? ` hinge=${output.branchDecision.proposedHinge}` : ""}${selected ? ` candidates=${selected}` : ""}`,
      );
    }
    if (output.testStrategy?.length) {
      lines.push(`- test strategy: ${output.testStrategy.slice(0, 3).join("; ")}`);
    }
    if (output.commandsRun?.length) {
      lines.push(`- commands: ${output.commandsRun.slice(0, 4).join("; ")}`);
    }
    if (output.filesTouched?.length) {
      lines.push(`- files touched: ${output.filesTouched.slice(0, 6).join("; ")}`);
    }
    if (output.unresolvedIssues?.length) {
      lines.push(`- unresolved: ${output.unresolvedIssues.slice(0, 4).join("; ")}`);
    }
    if (output.recommendations?.length) {
      lines.push(`- recommendations: ${output.recommendations.slice(0, 4).join("; ")}`);
    }
    if (output.risks?.length) {
      lines.push(`- risks: ${output.risks.slice(0, 4).join("; ")}`);
    }
    if (output.notes?.length) {
      lines.push(`- notes: ${output.notes.slice(0, 4).join("; ")}`);
    }
    return [`### ${phase}\n${lines.join("\n")}`];
  });

  return sections.length > 0 ? sections.join("\n\n") : "- none yet";
}

function renderWorkBreakdown(items: WorkItem[], depth = 0): string {
  const prefix = "  ".repeat(depth);
  return items
    .slice(0, depth === 0 ? 6 : 4)
    .map((item) => {
      const trackPrefix = item.track ? `${item.track}|` : "";
      const lines = [`${prefix}- [${trackPrefix}${item.size}] ${item.title}: ${item.rationale}`];
      if (item.acceptanceHint) {
        lines.push(`${prefix}  acceptance: ${item.acceptanceHint}`);
      }
      if (item.children?.length) {
        lines.push(renderWorkBreakdown(item.children, depth + 1));
      }
      return lines.join("\n");
    })
    .join("\n");
}

function renderWorkItemList(items: WorkItem[] | undefined, emptyMessage: string): string {
  if (!items || items.length === 0) {
    return `- ${emptyMessage}`;
  }

  return items
    .slice(0, 6)
    .map((item) => `- [${item.track ? `${item.track}|` : ""}${item.size}] ${item.title}${item.acceptanceHint ? ` (${item.acceptanceHint})` : ""}`)
    .join("\n");
}

function renderCurrentProgramSlice(item: WorkItem | undefined): string {
  if (!item) {
    return "- No focused program slice selected yet.";
  }

  const lines = [`- [${item.track ? `${item.track}|` : ""}${item.size}] ${item.title}: ${item.rationale}`];
  if (item.acceptanceHint) {
    lines.push(`  acceptance: ${item.acceptanceHint}`);
  }
  if (item.children?.length) {
    lines.push(renderWorkBreakdown(item.children, 1));
  }
  return lines.join("\n");
}

function renderJudgeFailures(context: RunnerPhaseContext): string {
  const failedChecks = context.previousJudge?.failedChecks ?? [];
  if (failedChecks.length === 0) {
    return "- none";
  }

  return failedChecks
    .slice(0, 4)
    .map((entry) => {
      const details = entry.details ? `\n  details: ${truncate(entry.details, 320)}` : "";
      return `- ${entry.check.title}: ${entry.message}${details}`;
    })
    .join("\n");
}

function renderProductReview(context: RunnerPhaseContext): string {
  const review = context.previousJudge?.productReview;
  if (!review) {
    return "- none";
  }

  const axes = Object.entries(review.axes)
    .map(([label, score]) => `${label}=${score.toFixed(1)}`)
    .join(", ");
  return [
    `- score: ${review.overallScore.toFixed(1)}`,
    `- summary: ${review.summary}`,
    axes ? `- axes: ${axes}` : undefined,
    review.findings.length > 0 ? `- findings: ${review.findings.slice(0, 4).join("; ")}` : undefined,
    review.recommendations.length > 0
      ? `- recommendations: ${review.recommendations.slice(0, 4).join("; ")}`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function renderValidationSummary(context: RunnerPhaseContext): string {
  const validationResults = context.previousJudge?.validationResults ?? [];
  if (validationResults.length === 0) {
    return "- none";
  }

  return validationResults
    .slice(0, 4)
    .map((result) => {
      const details = result.details ? `\n  details: ${truncate(result.details, 240)}` : "";
      return `- [${result.category}] ${result.label}: ${result.passed ? "passed" : "failed"} via \`${result.command}\`${details}`;
    })
    .join("\n");
}

function renderCompletionPressure(context: RunnerPhaseContext): string {
  const judge = context.previousJudge;
  if (!judge) {
    return "- none yet";
  }

  const notes: string[] = [];
  if (
    judge.hiddenCheckScore !== undefined &&
    judge.productQualityScore !== undefined &&
    judge.hiddenCheckScore - judge.productQualityScore >= 12
  ) {
    notes.push(
      `Spec/checklist progress is ahead of product quality (${judge.hiddenCheckScore.toFixed(1)} vs ${judge.productQualityScore.toFixed(1)}). Do not treat this as nearly done.`,
    );
  }
  if (judge.technicalQualityScore !== undefined && judge.technicalQualityScore < 55) {
    notes.push(
      `Technical quality is still weak at ${judge.technicalQualityScore.toFixed(1)}. Prefer stronger structure, validation, and integration over more brittle feature surface.`,
    );
  }
  if (judge.passedValidation === false) {
    notes.push("Automatic validations are still failing, so the next cycle must include real technical repair work.");
  }
  return notes.length > 0 ? notes.map((item) => `- ${item}`).join("\n") : "- none";
}

function renderAvailableBranchTemplates(context: RunnerPhaseContext): string {
  if (context.phase !== "planning") {
    return "- not applicable in this phase";
  }
  if (context.benchmark.branchTemplates.length === 0) {
    return "- no branch templates available";
  }

  return context.benchmark.branchTemplates
    .map((template) => {
      const keepCount = template.maxKeep ?? 2;
      const candidates = template.candidates
        .map((candidate) => `${candidate.id}=${candidate.label}`)
        .join("; ");
      return `- ${template.id}: ${template.label} (keep up to ${keepCount})\n  candidates: ${candidates}`;
    })
    .join("\n");
}

function renderPhaseConstraints(phase: Exclude<PhaseId, "judging">): string {
  switch (phase) {
    case "pm_intake":
      return `- mode: read_only\n- allowed actions: list_files, read_file, finish\n- guidance: inspect briefly, set backlog and architecture direction, estimate the work in LLM-loop terms, split anything large into smaller leaves, and if this is a multi-hour program, create 3 to 7 major slices. Major slices may be \`delivery\` or \`exploration\` tracks. Open only the first concrete slice into current-cycle leaves, but keep the broader exploration visible. Finish with the best structured handoff even if some details remain uncertain`;
    case "planning":
      return `- mode: read_only\n- allowed actions: list_files, read_file, finish\n- guidance: use the available branch templates if branching is worth the budget; if no template fits, you may propose a runtime branch hinge and 2 to 3 concrete candidates. Prefer leaves that are tiny, small, or medium for the current cycle, keep splitting any large or oversized items, and keep the next cycle focused inside one major program slice unless a tiny cross-cutting task is strictly required. Use \`exploration\` tracks when the product needs freeform design or discovery work that should remain open-ended for later passes. Finish with a practical plan instead of waiting for perfect certainty`;
    case "execution":
      return `- mode: repo_editing\n- allowed actions: list_files, read_file, write_file, replace_in_file, run_command, run_app_smoke, finish\n- guidance: do the minimum coherent implementation that clears the active execution leaves before polishing. If a web surface exists, prefer a short browser smoke over guesswork.`;
    case "review":
      return `- mode: read_only\n- allowed actions: list_files, read_file, run_command, run_app_smoke, finish\n- guidance: do not edit the repo in review; inspect what changed, call out spec drift, and recommend the next fixes. If the repo exposes a UI or server shell, use a browser smoke pass when it materially improves confidence. Prefer at least one meaningful validation command when the repo appears runnable so review can judge the product holistically instead of by files alone.`;
    case "pm_reprioritization":
      return `- mode: read_only\n- allowed actions: list_files, read_file, finish\n- guidance: convert judge and review output into the next backlog, preserve architecture directives, split any remaining oversized work instead of pretending it fits in one more pass, and explicitly decide which exploration opportunities should now be promoted into delivery work`;
  }
}

function buildPhaseInstructions(phase: Exclude<PhaseId, "judging">): string {
  switch (phase) {
    case "pm_intake":
      return "Act as a PM/TL. Turn the brief and current repo state into a practical backlog, set early architecture directives, and produce a hierarchical work breakdown. Size the work in benchmark-loop terms, not human-engineer project terms: tiny means one focused execution pass, small means one cycle, medium means a few coordinated passes, large means it should be split before execution, and oversized means it should become multiple benchmark stages. For big briefs, first create a top-level program map with both delivery slices and exploration tracks, then open only the first concrete slice into current-cycle leaves. Exploration tracks are real work: they should generate hypotheses, design options, and future delivery slices instead of sitting idle. Also surface 2 to 5 durable initiatives that represent the strongest medium-horizon bets for making the product excellent.";
    case "planning":
      return "Choose an implementation plan, refine the architecture directives, call out the test strategy, and decide whether branching is justified at the available hinge. If no existing hinge fits but comparing two approaches would materially improve decision quality, propose a runtime branch hinge with 2 to 3 concrete candidates. Maintain a hierarchical work breakdown and keep splitting large or oversized items until the next active leaves look executable in this run. Treat the top-level breakdown as a program map, allow exploration tracks where discovery is needed, and keep the current cycle focused inside one major slice when possible. If the initiative or opportunity queue already contains strong exploration ideas, decide whether any of them should be promoted into delivery in this cycle. Plan toward a fuller final product, not a thin pass on the visible spec.";
    case "execution":
      return "Do the real work in the repo. Edit files, run commands when useful, and leave the tree in a better state than you found it. Stay inside the active execution leaves unless a small enabling change is required to unblock them. For service repos, prefer a test-friendly shape: keep implementation under src when the brief calls for modularity, export the app or server from the entrypoint, and guard automatic listening so tests can import the server without port conflicts. If you add or change tests, run them and repair obvious failures before finishing; passing tests are worth more than extra polish. When a repo already has a test runner or framework, prefer repairing the existing setup instead of swapping to a different harness. When the checklist is ahead of the product, spend the cycle making the result feel more whole, coherent, and technically sound rather than merely more complete on paper.";
    case "review":
      return "Inspect the repo critically as if you were deciding whether this is becoming a strong final product. Look for spec drift, code quality issues, missing tests, operational gaps, shallow or disconnected product surfaces, and places where execution drifted outside the active work scope. Prefer a short validation or smoke command over setup churn. Do not spend review turns on dependency installation or long-lived foreground servers unless a previous validation clearly failed because dependencies were missing or a smoke action explicitly needs a start command.";
    case "pm_reprioritization":
      return "Act as a PM/TL again. Take the latest judge feedback and convert it into the next priority queue while maintaining long-term architecture directives and updating the hierarchical work breakdown. If the remaining work is still too big, split it again rather than pretending it fits in one more pass. Explicitly promote the best exploration ideas into delivery when the product needs depth more than another round of checklist cleanup. Maintain a durable initiative queue so the run can pursue medium-horizon product arcs instead of only reacting to the latest failed checks. Balance desired spec coverage with technical quality and overall product feel when choosing what happens next.";
  }
}

export function buildPhasePrompt(context: RunnerPhaseContext, repoTree: string[]): string {
  return buildPhasePromptWithPreviews(context, repoTree);
}

export function buildPhasePromptWithPreviews(
  context: RunnerPhaseContext,
  repoTree: string[],
  previews?: Record<string, string>,
): string {
  const repoIsEffectivelyEmpty = repoTree.length === 0;
  const previousJudge = context.previousJudge;
  const previousJudgeSummary = previousJudge
    ? `Previous judge score: ${previousJudge.totalScore.toFixed(1)}${
        previousJudge.hiddenCheckScore !== undefined
          ? `\nHidden-check score: ${previousJudge.hiddenCheckScore.toFixed(1)}`
          : ""
      }${
        previousJudge.productQualityScore !== undefined
          ? `\nProduct-quality score: ${previousJudge.productQualityScore.toFixed(1)}`
          : ""
      }\nPassed required checks: ${previousJudge.passedRequired}\nRegressions: ${
        previousJudge.regressions.length > 0 ? previousJudge.regressions.join(", ") : "none"
      }\nFailed checks:\n${renderJudgeFailures(context)}\nRecommendations: ${
        previousJudge.recommendations.length > 0 ? previousJudge.recommendations.join("; ") : "none"
      }\nProduct review:\n${renderProductReview(context)}`
    : "Previous judge: none";
  const longRunModeNote = context.continueAfterSuccess
    ? "This run is in long-horizon product mode. Clearing the current judge is only a floor, not the finish line. Keep surfacing deeper opportunities, stronger implementations, and richer product decisions instead of treating minimum acceptance as enough."
    : "This run uses normal benchmark stop rules. Clear the active requirements efficiently, but still leave the repo in a thoughtful state.";

  const roleFields = renderPhaseFields(context.phase)
    .map((field) => `- ${field}`)
    .join("\n");

  return `You are acting as the ${context.phase} role inside a local benchmark harness for medium-running coding tasks.

Goal for this phase:
${buildPhaseInstructions(context.phase)}

Benchmark:
- id: ${context.benchmark.id}
- title: ${context.benchmark.title}
- summary: ${context.benchmark.summary}
- artifact target: ${context.benchmark.artifactTarget}
- cycle: ${context.cycleNumber}
- policy: ${context.policyId}

Visible acceptance criteria:
${context.benchmark.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}

Artifact target hints:
${renderArtifactTargetHints(context.benchmark)}

If a hint names a literal path or a shallow glob like \`src/main.*\`, match that shape exactly unless the brief explicitly asks for a different layout.

Current priority queue:
${renderPriorityQueue(context.visibleBacklog)}

Current initiative queue:
${renderInitiativeQueue(context.visibleInitiatives)}

Current opportunity queue:
${renderOpportunityQueue(
  context.visibleOpportunities
    ?? context.previousPhaseOutputs.pm_reprioritization?.opportunities
    ?? context.previousPhaseOutputs.review?.opportunities
    ?? context.previousPhaseOutputs.planning?.opportunities
    ?? context.previousPhaseOutputs.pm_intake?.opportunities,
)}

Program slices:
${renderWorkItemList(context.programWorkItems, "No program slices derived yet. If the brief is broad, define 3 to 7 major slices before you choose active leaves.")}

Current focus slice:
${renderCurrentProgramSlice(context.currentProgramSlice)}

Active execution leaves:
${renderWorkItemList(context.activeWorkItems, "No explicit active leaves were derived yet. If you are in planning, define them. If you are in execution, do the smallest coherent slice that unblocks the highest-priority backlog item.")}

Deferred or oversized work:
${renderWorkItemList(context.deferredWorkItems, "No deferred work captured yet.")}

${previousJudgeSummary}

Holistic completion pressure:
${renderCompletionPressure(context)}

Automatic validation summary:
${renderValidationSummary(context)}

Run mode:
${longRunModeNote}

Previous role handoffs:
${renderPhaseHistory(context.previousPhaseOutputs)}

Available branch hinges:
${renderAvailableBranchTemplates(context)}

${renderBranchContext(context.branchCandidate)}

Current architecture directives:
${context.architectureDirectives.length > 0
  ? context.architectureDirectives
      .map((note) => `- ${note}`)
      .join("\n")
  : "- none yet"}

Handoff notes:
${context.handoffNotes.length > 0 ? context.handoffNotes.map((note) => `- ${note}`).join("\n") : "- none"}

Current repo tree snapshot:
${repoTree.length > 0 ? repoTree.map((line) => `- ${line}`).join("\n") : "- repo is empty"}

Repo bootstrap note:
${repoIsEffectivelyEmpty
  ? [
      "- The repo is effectively empty or unbootstrapped.",
      "- Do not spend repeated tool calls proving that it is empty.",
      "- After one or two quick inspection actions at most, switch to a structured finish or direct scaffold work.",
      "- In PM/TL and planning phases, derive the first backlog, work breakdown, and architecture directives directly from the brief and current priority queue.",
      "- In execution, start creating the scaffold immediately instead of waiting for another coordination pass.",
    ].join("\n")
  : "- The repo already contains enough structure that targeted inspection is useful."}

Repo file previews:
${previews && Object.keys(previews).length > 0
  ? Object.entries(previews)
      .map(([file, content]) => `### ${file}\n\`\`\`\n${content}\n\`\`\``)
      .join("\n\n")
  : "- none provided"}

Public brief:
${context.benchmark.publicBrief}

Phase operating constraints:
${renderPhaseConstraints(context.phase)}

When you are done, finish with a result object that includes these fields when relevant:
${roleFields}

${["pm_intake", "planning", "pm_reprioritization"].includes(context.phase)
  ? "If you include architectureDirectives, restate the 1-5 directives that should remain true even if they are unchanged from the previous handoff."
  : ""}

When useful, include opportunities:
- surface product, architecture, UX, or simulation ideas that are not urgent acceptance gaps yet
- prefer concrete opportunities that could plausibly be promoted into delivery work in a later cycle
- use the shape:
{
  "id": "stable-id",
  "title": "short title",
  "rationale": "why this would improve the product",
  "source": "brief | review | judge | exploration | repo",
  "severity": 1-5,
  "track": "delivery | exploration",
  "acceptanceHint": "optional concrete next step"
}

When useful, include initiatives:
- initiatives are medium-horizon product bets or architectural arcs that should survive across multiple cycles
- prefer initiatives when a stronger product requires more than one local fix
- use the shape:
{
  "id": "stable-id",
  "title": "short title",
  "rationale": "why this arc matters",
  "source": "brief | review | judge | exploration | repo",
  "severity": 1-5,
  "track": "delivery | exploration",
  "acceptanceHint": "optional concrete next step",
  "branchHingeHint": "optional hinge worth comparing via branching"
}

When you provide workBreakdown:
- each item must include: id, title, size, rationale
- optional: track, acceptanceHint, children
- track can be:
  - delivery: concrete building work that should eventually clear acceptance criteria
  - exploration: open-ended discovery, design, or investigation work that may spawn later delivery slices
- valid sizes:
  - tiny: should fit in one focused execution pass
  - small: should fit in one cycle
  - medium: should fit in 2 to 3 coordinated passes
  - large: should be split before execution
  - oversized: should be split into benchmark stages or major sub-stages
- if the brief is big, use the top level of the tree as a program map of major slices, and keep the active leaves inside one slice at a time
- prefer a tree depth of 1 to 3
- if a parent is large or oversized, add children instead of leaving it as a leaf

Backlog items should use this shape:
{
  "id": "stable-id",
  "bucket": "must_fix_regression | acceptance_gap | quality_improvement | nice_to_have_polish",
  "title": "short title",
  "rationale": "why this matters now",
  "source": "brief | judge | review | branch | repo",
  "severity": 1-5
}

For planning, branchDecision should use:
{
  "shouldBranch": true|false,
  "templateId": "branch-template-id",
  "selectedCandidateIds": ["candidate-a", "candidate-b"],
  "proposedHinge": "optional runtime hinge if no existing template fits",
  "proposedCandidates": [
    {"id": "candidate-a", "label": "candidate label", "promptHint": "what makes this path distinct"}
  ],
  "maxKeep": 1|2|3,
  "rationale": "why branching or not"
}`;
}

export function buildOpenRouterSystemPrompt(): string {
  return `You are a local coding worker controlled by a benchmark harness. You must respond with exactly one JSON object and nothing else.

Allowed actions:
1. {"type":"list_files","path":".","depth":3,"reasoning":"why"}
2. {"type":"read_file","path":"relative/path.txt","reasoning":"why"}
3. {"type":"write_file","path":"relative/path.txt","content":"full file content","reasoning":"why"}
4. {"type":"replace_in_file","path":"relative/path.txt","find":"old text","replace":"new text","all":true,"reasoning":"why"}
5. {"type":"run_command","command":"npm test","timeoutSeconds":90,"reasoning":"why"}
6. {"type":"run_app_smoke","url":"http://127.0.0.1:4173","startCommand":"PORT=4173 npm run start","waitForText":["Release Queue"],"waitForSelector":"#app","timeoutSeconds":45,"reasoning":"why"}
7. {"type":"finish","reasoning":"why you are done","result":{...}}

Rules:
- Paths must be relative to the repo root.
- Return the action object itself, not a wrapper like {"action": {...}} or {"tool": "..."}.
- Return exactly one action, not an array or batch of actions.
- If you need to create a directory, either write the nested file directly or use run_command with mkdir -p. Do not invent a separate mkdir action.
- If you are writing a large file, prefer multiple smaller actions over one giant JSON string. Create a minimal file first, then extend it with replace_in_file or another small write. Avoid multi-kilobyte write_file payloads when a split implementation would work.
- Prefer inspecting the repo before making large edits.
- If the repo previews already answer the question, finish instead of spending tool calls.
- Prefer direct file edits for small changes and shell commands for installs, tests, and build checks.
- Avoid adding new dependencies unless a visible requirement or a failing test clearly requires them.
- For Node or web services, prefer exporting the app/server and guarding listen(...) behind an environment check such as NODE_ENV !== "test".
- When writing tests, prefer built-in tooling or dependencies already present in package.json. If you introduce a helper library, add it explicitly before relying on it.
- If package.json already defines a working test runner or the repo already uses a test framework like Jest, repair the existing test setup before replacing it with a different runner.
- Prefer test and short smoke commands over long-running foreground servers like npm start when validating changes.
- In review, prefer at most one focused validation command unless a prior result clearly identifies the next necessary check. Avoid npm install in review unless a failed validation explicitly shows missing dependencies.
- In PM/TL and planning phases, preserve prior architecture directives unless you are intentionally replacing them, and restate the important ones in the finish result.
- Use initiatives for medium-horizon product arcs that should stay alive across multiple cycles, not just one-off chores.
- Keep command output in mind when deciding whether to continue.
- Keep every response concise and action-oriented. One short JSON object is enough.
- Respect the phase operating constraints in the user prompt.
- In read-only phases, never emit write_file or replace_in_file. Inspect briefly, then finish.
- If previous role handoffs already contain the needed context, skip extra tool calls and finish.
- If the repo is empty or nearly empty, spend at most one inspection step confirming that, then switch to a structured finish or direct scaffold work.
- If the harness says you are out of tool actions or nearing the budget, immediately return a finish action with the best structured handoff you can produce from the current context.
- If the harness explicitly says "No more tool actions are available", your very next response must be a finish action and must not request any further tools.
- Treat artifact target hints with literal paths or shallow globs as concrete layout requirements. Example: \`src/main.*\` means \`src/main.ts\` or \`src/main.js\`, not \`src/main/main.ts\`.
- If program slices are provided, treat them as the high-level roadmap and keep the current cycle inside the current focus slice unless a tiny enabling change is strictly required.
- When planning large products, it is valid to create both delivery slices and exploration tracks in the work breakdown. Exploration tracks should still point toward a next concrete step instead of staying purely abstract.
- If no benchmark branch template fits but comparing two concrete approaches would improve the decision, you may propose a runtime branch hinge and concrete candidates in the planning finish result.
- Stay inside the active execution leaves when they are provided. Large or oversized work belongs in planning and PM/TL decomposition, not in an execution sprawl.
- Use \`run_app_smoke\` when a real browser check is the shortest way to validate a web surface or operator console.
- Do not wrap JSON in markdown fences.
- The finish action must include a "result" object matching the requested phase output.
- Do not claim files or commands in the finish result unless you actually wrote or ran them.
- If a previous tool result reports an error, adapt and recover instead of repeating the same failing action.`;
}

export function defaultBacklogFromBenchmark(benchmark: BenchmarkSpec): PriorityItem[] {
  return benchmark.acceptanceCriteria.map((criterion, index) => ({
    id: `acceptance-${index + 1}`,
    bucket: "acceptance_gap",
    title: criterion,
    rationale: "Visible acceptance criteria from the benchmark brief.",
    source: "brief",
    severity: 3,
  }));
}

export function createFallbackPhaseOutput(
  phase: Exclude<PhaseId, "judging">,
  summary: string,
): StructuredPhaseOutput {
  if (phase === "pm_intake" || phase === "pm_reprioritization") {
    return { summary, backlog: [], recommendations: [] };
  }
  return { summary, recommendations: [] };
}
