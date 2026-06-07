import { describe, expect, it } from "vitest";
import { normalizePhaseOutput } from "../src/normalize.js";
import {
  deriveProgramWorkItems,
  selectActiveWorkItems,
  selectCurrentProgramSlice,
  selectDeferredWorkItems,
  summarizeActualWork,
  summarizeWorkBreakdown,
} from "../src/sizing.js";
import type { CycleRecord, WorkItem } from "../src/types.js";

describe("work-breakdown normalization", () => {
  it("normalizes nested work items and size buckets", () => {
    const output = normalizePhaseOutput("planning", {
      summary: "Plan ready",
      workBreakdown: {
        id: "foundation",
        title: "Foundation",
        size: "large",
        track: "delivery",
        rationale: "Needs an Electron shell plus data model.",
        children: [
          {
            id: "shell",
            title: "Shell",
            size: "small",
            track: "exploration",
            rationale: "Create navigation and base layout.",
          },
        ],
      } as unknown as WorkItem[],
    });

    expect(output.workBreakdown).toHaveLength(1);
    expect(output.workBreakdown?.[0]?.size).toBe("large");
    expect(output.workBreakdown?.[0]?.track).toBe("delivery");
    expect(output.workBreakdown?.[0]?.children?.[0]?.size).toBe("small");
    expect(output.workBreakdown?.[0]?.children?.[0]?.track).toBe("exploration");
  });
});

describe("sizing summaries", () => {
  it("summarizes planned and actual work sizes", () => {
    const planned = summarizeWorkBreakdown([
      {
        id: "system",
        title: "System",
        size: "large",
        rationale: "Needs to be split.",
        children: [
          {
            id: "ui",
            title: "UI",
            size: "small",
            rationale: "One cycle of shell work.",
          },
          {
            id: "sim",
            title: "Simulation",
            size: "medium",
            rationale: "A few linked passes.",
          },
        ],
      },
    ]);

    expect(planned.leafCount).toBe(2);
    expect(planned.maxDepth).toBe(2);
    expect(planned.largestLeafSize).toBe("medium");

    const cycle: CycleRecord = {
      cycleNumber: 1,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      phases: [
        {
          phase: "execution",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 1,
          summary: "Did work",
          output: {
            summary: "Did work",
            filesTouched: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"],
            commandsRun: ["npm test", "npm run build"],
          },
        },
      ],
      branches: [],
      judge: {
        scoredAt: new Date().toISOString(),
        totalScore: 75,
        byCategory: {},
        passedRequired: false,
        confidence: 0.5,
        failedChecks: [],
        passedChecks: [],
        regressions: [],
        recommendations: [],
      },
      priorityQueue: [],
    };

    const actual = summarizeActualWork(cycle);
    expect(actual.size).toBe("small");
    expect(actual.uniqueFilesTouched).toBe(4);
    expect(actual.commandsRun).toBe(2);
  });

  it("derives active execution leaves and deferred work from a nested plan", () => {
    const work: WorkItem[] = [
      {
        id: "program",
        title: "Release platform",
        size: "oversized",
        rationale: "Needs staged delivery.",
        children: [
          {
            id: "planner",
            title: "Planner core",
            size: "small",
            rationale: "One cycle.",
          },
          {
            id: "runtime",
            title: "Runtime core",
            size: "medium",
            rationale: "A few passes.",
          },
          {
            id: "console",
            title: "Operator console",
            size: "large",
            rationale: "Should wait for later.",
          },
        ],
      },
    ];

    const active = selectActiveWorkItems(work);
    const deferred = selectDeferredWorkItems(work, active);

    expect(active.map((item) => item.id)).toEqual(["planner", "runtime"]);
    expect(deferred.map((item) => item.id)).toContain("console");
  });

  it("keeps execution focused inside the first major program slice", () => {
    const work: WorkItem[] = [
      {
        id: "program",
        title: "Big management sim",
        size: "oversized",
        rationale: "Needs multiple major slices.",
        children: [
          {
            id: "foundation",
            title: "Foundation and shell",
            size: "large",
            rationale: "The first major slice.",
            children: [
              {
                id: "shell",
                title: "Build shell",
                size: "small",
                rationale: "One cycle.",
              },
              {
                id: "state",
                title: "State model",
                size: "medium",
                rationale: "A few passes.",
              },
            ],
          },
          {
            id: "simulation",
            title: "Simulation systems",
            size: "large",
            rationale: "Later slice.",
            children: [
              {
                id: "economy",
                title: "Economy rules",
                size: "medium",
                rationale: "Later.",
              },
            ],
          },
        ],
      },
    ];

    const program = deriveProgramWorkItems(work);
    const active = selectActiveWorkItems(work);
    const currentSlice = selectCurrentProgramSlice(work, active);
    const deferred = selectDeferredWorkItems(work, active);

    expect(program.map((item) => item.id)).toEqual(["foundation", "simulation"]);
    expect(active.map((item) => item.id)).toEqual(["shell", "state"]);
    expect(currentSlice?.id).toBe("foundation");
    expect(deferred.map((item) => item.id)).toContain("economy");
  });
});
