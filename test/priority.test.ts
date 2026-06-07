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

  it("escalates live runtime closure when browser smoke fails on an otherwise rich product", () => {
    const judge = makeJudge();
    judge.hiddenCheckScore = 92;
    judge.productQualityScore = 78;
    judge.technicalQualityScore = 84;
    judge.validationScore = 72;
    judge.validationResults = [
      {
        id: "browser-smoke",
        label: "Browser smoke passes",
        category: "runtime",
        command: "npm run dev -- --host 127.0.0.1 --port 4173",
        passed: false,
        exitCode: 1,
        summary: "Browser smoke failed for http://127.0.0.1:4173",
        details: "Last browser error: connection refused",
      },
    ];

    const queue = buildPriorityQueue(judge);

    const runtimeItem = queue.find((item) => item.title === "Make the app come up cleanly in live browser smoke");
    expect(runtimeItem).toBeDefined();
    expect(runtimeItem?.severity).toBe(5);
    expect(runtimeItem?.rationale).toContain("Stop deepening content");
  });

  it("promotes shared-system and testing work when the product review flags feature islands and weak coverage", () => {
    const judge = makeJudge();
    judge.productReview = {
      ...judge.productReview!,
      findings: [
        "Static calibration: the repo looks like several adjacent feature islands, each with its own UI and helper module, without enough shared underlying system logic.",
        "Static calibration: the repo has meaningful implementation surface area but little or no automated behavior coverage.",
      ],
    };
    judge.validationResults = [
      {
        id: "build",
        label: "Build passes",
        category: "build",
        command: "npm run build",
        passed: true,
        exitCode: 0,
        summary: "Build passes: passed",
      },
    ];

    const queue = buildPriorityQueue(judge);

    expect(queue.map((item) => item.title)).toContain("Unify the product around a shared system spine");
    expect(queue.map((item) => item.title)).toContain("Add behavior tests around the core loop or shared system");
  });
});
