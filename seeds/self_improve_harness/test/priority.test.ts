import { describe, expect, it } from "vitest";
import { buildPriorityQueue } from "../src/priority.js";
import type { InitiativeItem, JudgeResult, OpportunityItem, PriorityItem } from "../src/types.js";

function makeJudge(): JudgeResult {
  return {
    scoredAt: new Date().toISOString(),
    totalScore: 74,
    hiddenCheckScore: 88,
    productQualityScore: 60,
    byCategory: {
      repo: 100,
      product_quality: 60,
    },
    passedRequired: true,
    confidence: 0.8,
    failedChecks: [],
    passedChecks: [],
    regressions: [],
    recommendations: [],
    productReview: {
      summary: "Functional but still too shallow.",
      overallScore: 60,
      axes: {
        product_depth: 55,
        architecture_coherence: 72,
      },
      findings: ["The repo needs more product depth."],
      recommendations: ["Promote a deeper workflow into active delivery."],
      opportunities: [],
    },
  };
}

describe("buildPriorityQueue", () => {
  it("keeps reprioritized backlog while still promoting opportunities and product recommendations", () => {
    const reprioritizedBacklog: PriorityItem[] = [
      {
        id: "reprio-1",
        bucket: "must_fix_regression",
        title: "Stabilize the run ledger",
        rationale: "The PM/TL wants this fixed first.",
        source: "pm",
        severity: 5,
      },
    ];
    const opportunities: OpportunityItem[] = [
      {
        id: "op-1",
        title: "Deepen the operator workflow",
        rationale: "A deeper end-to-end path will make the product feel more complete.",
        source: "exploration",
        severity: 4,
        track: "exploration",
        acceptanceHint: "Add a real drill-down flow from queue to release run detail.",
      },
    ];
    const initiatives: InitiativeItem[] = [
      {
        id: "init-1",
        title: "Own the main release-control journey",
        rationale: "A durable initiative should stay visible across multiple cycles.",
        source: "pm",
        severity: 5,
        track: "delivery",
        acceptanceHint: "Make the queue-to-run timeline feel complete.",
      },
    ];

    const queue = buildPriorityQueue(
      makeJudge(),
      undefined,
      reprioritizedBacklog,
      initiatives,
      opportunities,
      true,
    );

    expect(queue.map((item) => item.title)).toContain("Stabilize the run ledger");
    expect(queue.map((item) => item.title)).toContain("Own the main release-control journey");
    expect(queue.map((item) => item.title)).toContain("Promote a deeper workflow into active delivery.");
    expect(queue.map((item) => item.title)).toContain("Deepen the operator workflow");
  });
});
