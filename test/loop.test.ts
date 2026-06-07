import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { runLoopExperiment } from "../src/loop.js";
import type { LoopState } from "../src/types.js";
import { readJson } from "../src/utils.js";
import { copyBuiltInBenchmark, createTempHarness, writeCustomBenchmark } from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENROUTER_API_KEY;
});

describe("runLoopExperiment", () => {
  it("records branch candidates and architecture directives for built-in eval runs", async () => {
    const root = await createTempHarness();
    await copyBuiltInBenchmark(root, "eval_loop");
    const loaded = await loadConfig(root);

    const result = await runLoopExperiment({
      loaded,
      benchmarkId: "eval_loop",
      workerId: "stub",
      policyId: "branch_rank_revise",
      budgetMinutes: 30,
      maxCycles: 1,
    });

    const ledger = await readJson<LoopState>(result.ledgerPath);
    expect(ledger.cycles).toHaveLength(1);
    expect(ledger.cycles[0]?.branches).toHaveLength(2);
    expect(ledger.cycles[0]?.winningBranchId).toBeDefined();
    expect(ledger.baselineScore).toBeGreaterThanOrEqual(0);
    expect(result.scoreDelta).toBeGreaterThan(0);
    expect(ledger.architectureDirectives.length).toBeGreaterThan(0);
    const directives = await fs.readFile(
      path.join(ledger.paths.artifactsDir, "ARCHITECTURE_DIRECTIVES.md"),
      "utf8",
    );
    expect(directives).toContain("Architecture Directives");
  }, 30_000);

  it("stops on plateau when scores stop improving", async () => {
    const root = await createTempHarness();
    await writeCustomBenchmark(
      root,
      "plateau_blank",
      {
        id: "plateau_blank",
        title: "Plateau Blank",
        summary: "A benchmark the stub worker cannot improve.",
        artifactTarget: "No-op repo",
        publicBriefFile: "benchmarks/plateau_blank/brief.md",
        workspaceSeed: "seeds/plateau_blank",
        budgets: { minMinutes: 20, maxMinutes: 60, defaultMinutes: 30 },
        acceptanceCriteria: ["Create a file that the stub worker will never create."],
        branchTemplates: [],
        hiddenChecks: [
          {
            id: "impossible-file",
            title: "Impossible file exists",
            category: "repo",
            weight: 1,
            required: true,
            type: "fileExists",
            path: "missing.txt",
          },
        ],
        judgeWeights: {},
        expectedRoleOutputs: {},
        successThreshold: 80,
      },
      "# Plateau Blank\n",
    );
    const loaded = await loadConfig(root);

    const result = await runLoopExperiment({
      loaded,
      benchmarkId: "plateau_blank",
      workerId: "stub",
      policyId: "gated_role_loop",
      budgetMinutes: 30,
      maxCycles: 4,
    });

    const ledger = await readJson<LoopState>(result.ledgerPath);
    expect(result.stopReason).toBe("score_plateau");
    expect(ledger.cycles.length).toBe(3);
    expect(ledger.scoreHistory[0]).toBeGreaterThanOrEqual(0);
    expect(ledger.scoreHistory).toHaveLength(3);
    expect(new Set(ledger.scoreHistory).size).toBe(1);
    expect(ledger.cycles[1]?.phases.some((phase) => phase.phase === "pm_intake")).toBe(false);
  });

  it("skips pm reprioritization on terminal success cycles", async () => {
    const root = await createTempHarness();
    await copyBuiltInBenchmark(root, "eval_loop");
    const loaded = await loadConfig(root);

    const result = await runLoopExperiment({
      loaded,
      benchmarkId: "eval_loop",
      workerId: "stub",
      policyId: "gated_role_loop",
      budgetMinutes: 30,
      maxCycles: 2,
    });

    const ledger = await readJson<LoopState>(result.ledgerPath);
    expect(result.stopReason).toBe("success_gate_met");
    expect(ledger.cycles).toHaveLength(1);
    expect(ledger.cycles[0]?.phases.some((phase) => phase.phase === "pm_reprioritization")).toBe(
      false,
    );
  }, 25_000);

  it("reuses the existing plan on later repair-focus cycles", async () => {
    const root = await createTempHarness();
    await writeCustomBenchmark(
      root,
      "repair_focus_blank",
      {
        id: "repair_focus_blank",
        title: "Repair Focus Blank",
        summary: "A benchmark the stub worker cannot improve in one cycle.",
        artifactTarget: "No-op repo",
        publicBriefFile: "benchmarks/repair_focus_blank/brief.md",
        workspaceSeed: "seeds/repair_focus_blank",
        budgets: { minMinutes: 20, maxMinutes: 60, defaultMinutes: 30 },
        acceptanceCriteria: ["Create two files the stub worker will never create."],
        branchTemplates: [],
        hiddenChecks: [
          {
            id: "file-a",
            title: "File A exists",
            category: "repo",
            weight: 1,
            required: true,
            type: "fileExists",
            path: "a.txt",
          },
          {
            id: "file-b",
            title: "File B exists",
            category: "repo",
            weight: 1,
            required: true,
            type: "fileExists",
            path: "b.txt",
          },
        ],
        judgeWeights: {},
        expectedRoleOutputs: {},
        successThreshold: 80,
      },
      "# Repair Focus Blank\n",
    );
    const loaded = await loadConfig(root);

    const result = await runLoopExperiment({
      loaded,
      benchmarkId: "repair_focus_blank",
      workerId: "stub",
      policyId: "repair_focus_loop",
      budgetMinutes: 30,
      maxCycles: 2,
    });

    const ledger = await readJson<LoopState>(result.ledgerPath);
    expect(ledger.cycles).toHaveLength(2);
    expect(ledger.cycles[1]?.phases.some((phase) => phase.phase === "pm_intake")).toBe(false);
    expect(ledger.cycles[1]?.phases.some((phase) => phase.phase === "planning")).toBe(false);
  });

  it("threads continuity state into the first cycle prompt of a chained-style run", async () => {
    const root = await createTempHarness();
    await copyBuiltInBenchmark(root, "eval_loop");
    const loaded = await loadConfig(root);

    const result = await runLoopExperiment({
      loaded,
      benchmarkId: "eval_loop",
      workerId: "stub",
      policyId: "gated_role_loop",
      budgetMinutes: 30,
      maxCycles: 1,
      initialHandoffNotes: ["Continue from prior stage stateful-notes-stage1."],
      initialArchitectureDirectives: ["Preserve modular server/storage split."],
      carryoverPriorities: [
        {
          id: "carryover-health",
          bucket: "must_fix_regression",
          title: "Keep health endpoint green",
          rationale: "The previous stage depended on /health for smoke checks.",
          source: "carryover",
          severity: 5,
        },
      ],
    });

    const ledger = await readJson<LoopState>(result.ledgerPath);
    const pmPromptPath = ledger.cycles[0]?.phases.find((phase) => phase.phase === "pm_intake")
      ?.promptPath;
    expect(pmPromptPath).toBeDefined();
    const prompt = await fs.readFile(pmPromptPath!, "utf8");
    expect(prompt).toContain("Continue from prior stage stateful-notes-stage1.");
    expect(prompt).toContain("Preserve modular server/storage split.");
    expect(prompt).toContain("Keep health endpoint green");
  });

  it("can disable plateau stopping for longer exploratory runs", async () => {
    const root = await createTempHarness();
    await writeCustomBenchmark(
      root,
      "plateau_disabled_blank",
      {
        id: "plateau_disabled_blank",
        title: "Plateau Disabled Blank",
        summary: "A benchmark the stub worker cannot improve, used to test plateau overrides.",
        artifactTarget: "No-op repo",
        publicBriefFile: "benchmarks/plateau_disabled_blank/brief.md",
        workspaceSeed: "seeds/plateau_disabled_blank",
        budgets: { minMinutes: 20, maxMinutes: 60, defaultMinutes: 30 },
        acceptanceCriteria: ["Create a file that the stub worker will never create."],
        branchTemplates: [],
        hiddenChecks: [
          {
            id: "missing-file",
            title: "Missing file exists",
            category: "repo",
            weight: 1,
            required: true,
            type: "fileExists",
            path: "never-there.txt",
          },
        ],
        judgeWeights: {},
        expectedRoleOutputs: {},
        successThreshold: 80,
      },
      "# Plateau Disabled Blank\n",
    );
    const loaded = await loadConfig(root);

    const result = await runLoopExperiment({
      loaded,
      benchmarkId: "plateau_disabled_blank",
      workerId: "stub",
      policyId: "gated_role_loop",
      budgetMinutes: 30,
      maxCycles: 4,
      disablePlateau: true,
    });

    const ledger = await readJson<LoopState>(result.ledgerPath);
    expect(result.stopReason).toBe("max_cycles_reached");
    expect(ledger.cycles).toHaveLength(4);
    expect(ledger.stopRules.disablePlateau).toBe(true);
  });

  it("respects stricter success-threshold overrides", async () => {
    const root = await createTempHarness();
    await copyBuiltInBenchmark(root, "eval_loop");
    const loaded = await loadConfig(root);

    const result = await runLoopExperiment({
      loaded,
      benchmarkId: "eval_loop",
      workerId: "stub",
      policyId: "gated_role_loop",
      budgetMinutes: 30,
      maxCycles: 1,
      successThreshold: 101,
    });

    const ledger = await readJson<LoopState>(result.ledgerPath);
    expect(result.stopReason).toBe("max_cycles_reached");
    expect(ledger.stopRules.successThreshold).toBe(101);
  }, 25_000);

  it("can keep iterating after clearing the current success gate", async () => {
    const root = await createTempHarness();
    await copyBuiltInBenchmark(root, "eval_loop");
    const loaded = await loadConfig(root);

    const result = await runLoopExperiment({
      loaded,
      benchmarkId: "eval_loop",
      workerId: "stub",
      policyId: "gated_role_loop",
      budgetMinutes: 30,
      maxCycles: 2,
      disablePlateau: true,
      continueAfterSuccess: true,
    });

    const ledger = await readJson<LoopState>(result.ledgerPath);
    expect(result.stopReason).toBe("max_cycles_reached");
    expect(ledger.cycles).toHaveLength(2);
    expect(ledger.stopRules.continueAfterSuccess).toBe(true);
  }, 25_000);

  it("does not plateau-stop while holistic quality thresholds remain unmet", async () => {
    const root = await createTempHarness();
    await writeCustomBenchmark(
      root,
      "holistic_gap_blank",
      {
        id: "holistic_gap_blank",
        title: "Holistic Gap Blank",
        summary: "A benchmark that should keep iterating despite flat total score.",
        artifactTarget: "No-op repo",
        publicBriefFile: "benchmarks/holistic_gap_blank/brief.md",
        workspaceSeed: "seeds/holistic_gap_blank",
        budgets: { minMinutes: 20, maxMinutes: 60, defaultMinutes: 30 },
        acceptanceCriteria: ["Create a meaningful product."],
        branchTemplates: [],
        hiddenChecks: [
          {
            id: "missing-file",
            title: "Missing file exists",
            category: "repo",
            weight: 1,
            required: true,
            type: "fileExists",
            path: "never-there.txt",
          },
        ],
        judgeWeights: {},
        expectedRoleOutputs: {},
        successThreshold: 80,
        productJudge: {
          enabled: true,
          workerModel: "qwen/qwen3-coder-flash",
          hiddenCheckWeight: 0.3,
          productQualityWeight: 0.7,
          minimumProductQualityScore: 60,
          minimumTechnicalQualityScore: 55,
          maximumSpecQualityGap: 18,
        },
      },
      "# Holistic Gap Blank\n",
    );
    process.env.OPENROUTER_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          model: "qwen/qwen3-coder-flash",
          usage: {
            prompt_tokens: 100,
            completion_tokens: 40,
            total_tokens: 140,
            cost: 0.001,
          },
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: "Still a weak product attempt.",
                  overallScore: 20,
                  axes: {
                    spec_realization: 10,
                    technical_quality: 20,
                    product_depth: 15,
                    experience_quality: 10,
                    architecture_coherence: 25,
                    forward_readiness: 10,
                  },
                  findings: ["Still weak."],
                  recommendations: ["Keep iterating."],
                  opportunities: [],
                }),
              },
            },
          ],
        }),
      })),
    );
    const loaded = await loadConfig(root);

    const result = await runLoopExperiment({
      loaded,
      benchmarkId: "holistic_gap_blank",
      workerId: "stub",
      policyId: "gated_role_loop",
      budgetMinutes: 30,
      maxCycles: 4,
    });

    const ledger = await readJson<LoopState>(result.ledgerPath);
    expect(result.stopReason).toBe("max_cycles_reached");
    expect(ledger.cycles).toHaveLength(4);
  }, 25_000);

  it("seeds cycle one with baseline product-judge opportunities for custom briefs", async () => {
    const root = await createTempHarness();
    await writeCustomBenchmark(
      root,
      "baseline_product_opportunities",
      {
        id: "baseline_product_opportunities",
        title: "Baseline Product Opportunities",
        summary: "Ensures product-judge opportunities are visible from cycle one.",
        artifactTarget: "Product-like repo",
        publicBriefFile: "benchmarks/baseline_product_opportunities/brief.md",
        workspaceSeed: "seeds/baseline_product_opportunities",
        budgets: { minMinutes: 20, maxMinutes: 60, defaultMinutes: 30 },
        acceptanceCriteria: ["Create a serious product attempt."],
        branchTemplates: [],
        hiddenChecks: [
          {
            id: "package-file",
            title: "package.json exists",
            category: "repo",
            weight: 1,
            required: true,
            type: "fileExists",
            path: "package.json",
          },
        ],
        judgeWeights: {},
        expectedRoleOutputs: {},
        successThreshold: 80,
        productJudge: {
          enabled: true,
          workerModel: "qwen/qwen3-coder-flash",
          hiddenCheckWeight: 0.3,
          productQualityWeight: 0.7,
        },
      },
      "# Baseline Product Opportunities\n\nBuild something deeper than a shell.\n",
    );
    process.env.OPENROUTER_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          model: "qwen/qwen3-coder-flash",
          usage: {
            prompt_tokens: 100,
            completion_tokens: 40,
            total_tokens: 140,
            cost: 0.001,
          },
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: "Empty repo with obvious deeper work available.",
                  overallScore: 20,
                  axes: {
                    product_depth: 10,
                  },
                  findings: ["Repo is empty."],
                  recommendations: ["Start building the core product loop."],
                  opportunities: [
                    {
                      id: "core-loop",
                      title: "Design the core product loop",
                      rationale: "A concrete product loop should shape the first implementation pass.",
                      source: "product-judge",
                      severity: 5,
                      track: "exploration",
                      acceptanceHint: "Define the first meaningful interactive flow.",
                    },
                  ],
                }),
              },
            },
          ],
        }),
      })),
    );

    const loaded = await loadConfig(root);
    const result = await runLoopExperiment({
      loaded,
      benchmarkId: "baseline_product_opportunities",
      workerId: "stub",
      policyId: "repair_focus_loop",
      budgetMinutes: 30,
      maxCycles: 1,
      continueAfterSuccess: true,
    });

    const ledger = await readJson<LoopState>(result.ledgerPath);
    expect(ledger.opportunityQueue.map((item) => item.title)).toContain("Design the core product loop");
    expect(ledger.initiativeQueue.map((item) => item.title)).toContain("Design the core product loop");
    const pmPromptPath = ledger.cycles[0]?.phases.find((phase) => phase.phase === "pm_intake")?.promptPath;
    expect(pmPromptPath).toBeDefined();
    const prompt = await fs.readFile(pmPromptPath!, "utf8");
    expect(prompt).toContain("Design the core product loop");
    expect(prompt).toContain("Current initiative queue:");
    expect(prompt).toContain("Current opportunity queue:");
    expect(prompt).toContain("Identify the likely shared system spine early");
  }, 25_000);
});
