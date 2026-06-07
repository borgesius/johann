import { describe, expect, it } from "vitest";
import { buildOpenRouterSystemPrompt, buildPhasePrompt } from "../src/prompts.js";
import type { ResolvedBenchmarkSpec, RunnerPhaseContext } from "../src/types.js";

function makeBenchmark(): ResolvedBenchmarkSpec {
  return {
    id: "prompt_artifact_hints",
    title: "Prompt Artifact Hints",
    summary: "A benchmark used to verify prompt artifact target hints.",
    artifactTarget: "Electron repo scaffold",
    publicBriefFile: "benchmarks/prompt_artifact_hints/brief.md",
    workspaceSeed: "seeds/prompt_artifact_hints",
    budgets: { minMinutes: 20, maxMinutes: 90, defaultMinutes: 45 },
    acceptanceCriteria: [
      "Ship an Electron shell with clear entrypoints.",
      "Provide core docs and a smoke path.",
    ],
    branchTemplates: [],
    hiddenChecks: [
      {
        id: "package-json",
        title: "package.json exists",
        category: "repo",
        weight: 1,
        required: true,
        type: "fileExists",
        path: "package.json",
      },
      {
        id: "main-entry",
        title: "Main entry exists",
        category: "desktop",
        weight: 1,
        required: true,
        type: "globCount",
        pattern: "src/main.*",
        count: 1,
      },
      {
        id: "preload-entry",
        title: "Preload entry exists",
        category: "desktop",
        weight: 1,
        required: true,
        type: "globCount",
        pattern: "src/preload.*",
        count: 1,
      },
      {
        id: "renderer-files",
        title: "Renderer files exist",
        category: "ux",
        weight: 1,
        required: true,
        type: "globCount",
        pattern: "src/renderer/**",
        count: 1,
      },
      {
        id: "renderer-copy",
        title: "Renderer mentions markets",
        category: "ux",
        weight: 1,
        required: true,
        type: "globTextIncludes",
        pattern: "src/renderer/**",
        includes: ["market", "latency"],
        mode: "any",
      },
      {
        id: "readme-headings",
        title: "README headings exist",
        category: "docs",
        weight: 1,
        required: true,
        type: "textIncludes",
        path: "README.md",
        includes: ["## Development", "## Core Systems"],
        mode: "all",
      },
    ],
    judgeWeights: {},
    expectedRoleOutputs: {},
    successThreshold: 80,
    benchmarkDir: "/tmp/benchmarks/prompt_artifact_hints",
    publicBriefPath: "/tmp/benchmarks/prompt_artifact_hints/brief.md",
    publicBrief: "# Prompt Artifact Hints\nShip a small Electron shell.\n",
    workspaceSeedPath: "/tmp/seeds/prompt_artifact_hints",
  };
}

function makeContext(): RunnerPhaseContext {
  const now = new Date();
  return {
    workerId: "qwen-coder-next",
    benchmark: makeBenchmark(),
    phase: "execution",
    repoDir: "/tmp/prompt-artifact-hints/repo",
    runDir: "/tmp/prompt-artifact-hints/run",
    cycleNumber: 1,
    policyId: "repair_focus_loop",
    budget: {
      totalMinutes: 45,
      startedAt: now.toISOString(),
      deadlineAt: new Date(now.getTime() + 45 * 60_000).toISOString(),
    },
    architectureDirectives: [],
    visibleBacklog: [],
    previousPhaseOutputs: {},
    handoffNotes: [],
  };
}

describe("prompt artifact hints", () => {
  it("renders concrete target hints from hidden checks", () => {
    const prompt = buildPhasePrompt(makeContext(), []);

    expect(prompt).toContain("Artifact target hints:");
    expect(prompt).toContain("Create the literal file `package.json`.");
    expect(prompt).toContain("`src/main.ts` or `src/main.js`");
    expect(prompt).toContain("`src/main/main.ts`");
    expect(prompt).toContain("`src/preload.ts` or `src/preload.js`");
    expect(prompt).toContain("Create at least 1 file(s) under `src/renderer/`.");
    expect(prompt).toContain("Ensure `README.md` includes all of: `## Development`, `## Core Systems`.");
    expect(prompt).toContain("In files matching `src/renderer/**`, include at least one of: `market`, `latency`.");
  });

  it("tells the worker to treat shallow globs as concrete layout requirements", () => {
    const systemPrompt = buildOpenRouterSystemPrompt();

    expect(systemPrompt).toContain("Treat artifact target hints with literal paths or shallow globs as concrete layout requirements.");
    expect(systemPrompt).toContain("`src/main/main.ts`");
  });
});
