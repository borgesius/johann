import type {
  InitiativeItem,
  JudgeResult,
  OpportunityItem,
  PriorityItem,
  StructuredPhaseOutput,
} from "./types.js";
import { truncate } from "./utils.js";

function findingMatches(judge: JudgeResult, pattern: RegExp): boolean {
  return (judge.productReview?.findings ?? []).some((finding) => pattern.test(finding));
}

function failedBrowserSmokeSummary(
  judge: JudgeResult,
  reviewOutput?: StructuredPhaseOutput,
): string | undefined {
  const validationFailure = (judge.validationResults ?? []).find(
    (result) =>
      !result.passed
      && (result.id === "browser-smoke" || /browser smoke/i.test(result.label) || /browser smoke/i.test(result.summary)),
  );
  if (validationFailure) {
    return validationFailure.details
      ? `${validationFailure.summary}. Details: ${truncate(validationFailure.details, 260)}`
      : validationFailure.summary;
  }

  const reviewSignal = [...(reviewOutput?.unresolvedIssues ?? []), ...(reviewOutput?.risks ?? [])].find((item) =>
    /browser smoke failed|live smoke failed|smoke failed/i.test(item),
  );
  return reviewSignal ? truncate(reviewSignal, 260) : undefined;
}

export function buildPriorityQueue(
  judge: JudgeResult,
  reviewOutput?: StructuredPhaseOutput,
  reprioritizedBacklog?: PriorityItem[],
  initiativeQueue?: InitiativeItem[],
  opportunityQueue?: OpportunityItem[],
  preferOpportunities = false,
): PriorityItem[] {
  const queue: PriorityItem[] = [...(reprioritizedBacklog ?? [])];

  for (const regression of judge.regressions) {
    queue.push({
      id: `regression-${queue.length + 1}`,
      bucket: "must_fix_regression",
      title: regression,
      rationale: "Previously passing behavior regressed in the latest cycle.",
      source: "judge",
      severity: 5,
    });
  }

  for (const check of judge.failedChecks.filter((entry) => entry.check.required)) {
    queue.push({
      id: `required-${check.check.id}`,
      bucket: "acceptance_gap",
      title: check.check.title,
      rationale: check.details
        ? `${check.message} Details: ${truncate(check.details, 260)}`
        : check.message,
      source: "judge",
      severity: 4,
    });
  }

  for (const check of judge.failedChecks.filter((entry) => !entry.check.required)) {
    queue.push({
      id: `quality-${check.check.id}`,
      bucket: "quality_improvement",
      title: check.check.title,
      rationale: check.details
        ? `${check.message} Details: ${truncate(check.details, 220)}`
        : check.message,
      source: "judge",
      severity: 2,
    });
  }

  for (const recommendation of judge.productReview?.recommendations ?? []) {
    queue.push({
      id: `product-review-${queue.length + 1}`,
      bucket: "quality_improvement",
      title: recommendation,
      rationale: "Product-quality judge recommendation for a stronger, less checklist-shaped result.",
      source: "product-judge",
      severity: preferOpportunities ? 3 : 2,
    });
  }

  if (
    judge.hiddenCheckScore !== undefined &&
    judge.productQualityScore !== undefined &&
    judge.hiddenCheckScore - judge.productQualityScore >= 12
  ) {
    queue.push({
      id: `product-gap-${queue.length + 1}`,
      bucket: "quality_improvement",
      title: "Turn the scaffold into a fuller, more integrated product",
      rationale:
        `The repo is satisfying more of the visible/spec floor than the holistic product bar. Hidden/spec score ${judge.hiddenCheckScore.toFixed(1)} vs product-quality score ${judge.productQualityScore.toFixed(1)} suggests the next cycle should deepen the product instead of chasing more checkboxes.`,
      source: "product-gap",
      severity: 5,
    });
  }

  if (
    judge.productReview?.axes?.product_depth !== undefined &&
    judge.productReview.axes.product_depth < 55
  ) {
    queue.push({
      id: `product-depth-${queue.length + 1}`,
      bucket: "quality_improvement",
      title: "Implement one real core mechanic with visible consequences",
      rationale:
        `Product depth is still only ${judge.productReview.axes.product_depth.toFixed(1)}. The next cycle should add a concrete end-to-end mechanic where player input changes state and produces visible downstream behavior, instead of spending most of the budget on shell, docs, or generic infrastructure.`,
      source: "product-depth",
      severity: 5,
    });
  }

  if (
    findingMatches(judge, /feature islands|presentation surfaces relative to the amount of deeper system|cluster of demos/i)
    || (
      (judge.productReview?.axes?.architecture_coherence ?? 100) < 82
      && (judge.productReview?.axes?.product_depth ?? 100) < 82
    )
  ) {
    queue.push({
      id: `system-spine-${queue.length + 1}`,
      bucket: "quality_improvement",
      title: "Unify the product around a shared system spine",
      rationale:
        "The current repo shape suggests adjacent surfaces without enough shared underlying state, model, or engine logic. The next cycle should deepen one shared system that multiple screens or workflows depend on, rather than adding another isolated feature.",
      source: "architecture-coherence",
      severity: 5,
    });
  }

  if (
    findingMatches(judge, /little or no automated behavior coverage|tests look shallow/i)
    || (
      (judge.productReview?.axes?.technical_quality ?? 100) < 70
      && (judge.validationResults ?? []).every((result) => result.category !== "test")
    )
  ) {
    queue.push({
      id: `test-core-loop-${queue.length + 1}`,
      bucket: "quality_improvement",
      title: "Add behavior tests around the core loop or shared system",
      rationale:
        "The product has enough implementation surface that continued iteration without meaningful behavior coverage will mostly produce guesswork. Add tests around the central system, not just structural smoke checks.",
      source: "testing-depth",
      severity: 4,
    });
  }

  if (judge.technicalQualityScore !== undefined && judge.technicalQualityScore < 55) {
    queue.push({
      id: `technical-quality-${queue.length + 1}`,
      bucket: "quality_improvement",
      title: "Raise technical quality before expanding scope",
      rationale:
        `The latest technical-quality read is ${judge.technicalQualityScore.toFixed(1)}. Prefer stronger structure, validation, integration, and cleanup over piling on more brittle features.`,
      source: "technical-quality",
      severity: 4,
    });
  }

  const browserSmokeFailure = failedBrowserSmokeSummary(judge, reviewOutput);
  if (browserSmokeFailure) {
    const alreadyRich =
      (judge.productQualityScore ?? 0) >= 70
      || (judge.hiddenCheckScore ?? 0) >= 85
      || (judge.validationScore ?? 0) >= 80;
    queue.push({
      id: `browser-smoke-${queue.length + 1}`,
      bucket: "quality_improvement",
      title: alreadyRich
        ? "Make the app come up cleanly in live browser smoke"
        : "Fix the live browser smoke failure",
      rationale: alreadyRich
        ? `The product is already materially built, but it still does not come up cleanly in a live browser check. Stop deepening content until runtime closure is handled. ${browserSmokeFailure}`
        : `The app still fails a live browser smoke check. ${browserSmokeFailure}`,
      source: "runtime-closure",
      severity: alreadyRich ? 5 : 4,
    });
  }

  for (const validation of judge.validationResults ?? []) {
    if (validation.passed) {
      continue;
    }
    queue.push({
      id: `validation-${validation.id}`,
      bucket: "quality_improvement",
      title: validation.label,
      rationale: validation.details
        ? `${validation.summary}. Details: ${truncate(validation.details, 260)}`
        : validation.summary,
      source: `validation:${validation.category}`,
      severity: 4,
    });
  }

  for (const recommendation of reviewOutput?.recommendations ?? []) {
    queue.push({
      id: `review-${queue.length + 1}`,
      bucket: "nice_to_have_polish",
      title: recommendation,
      rationale: "Review-phase recommendation for cleanup or polish.",
      source: "review",
      severity: 1,
    });
  }

  for (const initiative of initiativeQueue ?? []) {
    queue.push({
      id: `initiative-${initiative.id}`,
      bucket: initiative.track === "exploration" ? "quality_improvement" : "quality_improvement",
      title: initiative.title,
      rationale: initiative.acceptanceHint
        ? `${initiative.rationale} Next step: ${initiative.acceptanceHint}`
        : initiative.rationale,
      source: `initiative:${initiative.source}`,
      severity: Math.max(
        2,
        Math.min(
          5,
          preferOpportunities || judge.productQualityScore === undefined
            ? initiative.severity + 1
            : judge.hiddenCheckScore !== undefined &&
                judge.productQualityScore < judge.hiddenCheckScore - 8
              ? initiative.severity + 1
              : initiative.severity,
        ),
      ),
    });
  }

  for (const opportunity of opportunityQueue ?? []) {
    queue.push({
      id: `opportunity-${opportunity.id}`,
      bucket: opportunity.track === "exploration" ? "nice_to_have_polish" : "quality_improvement",
      title: opportunity.title,
      rationale: opportunity.acceptanceHint
        ? `${opportunity.rationale} Next step: ${opportunity.acceptanceHint}`
        : opportunity.rationale,
      source: `opportunity:${opportunity.source}`,
      severity: Math.max(
        1,
        Math.min(
          5,
          preferOpportunities || judge.productQualityScore === undefined
            ? opportunity.severity + 1
            : judge.hiddenCheckScore !== undefined &&
                judge.productQualityScore < judge.hiddenCheckScore - 8
              ? opportunity.severity + 1
              : opportunity.severity,
        ),
      ),
    });
  }

  const deduped: PriorityItem[] = [];
  const seen = new Set<string>();
  for (const item of queue.sort((left, right) => right.severity - left.severity)) {
    const key = item.title.trim().toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
    if (deduped.length >= 12) {
      break;
    }
  }

  return deduped;
}
