import type {
  InitiativeItem,
  JudgeResult,
  OpportunityItem,
  PriorityItem,
  StructuredPhaseOutput,
} from "./types.js";
import { truncate } from "./utils.js";

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
