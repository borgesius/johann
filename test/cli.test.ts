import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/index.js";
import type { ChainState, LoopState } from "../src/types.js";
import { readJson } from "../src/utils.js";
import { copyBuiltInBenchmark, createTempHarness } from "./helpers.js";

describe("runCli chain flow", () => {
  it("writes a chain ledger that can be watched later", async () => {
    const root = await createTempHarness();
    await copyBuiltInBenchmark(root, "tiny_smoke");
    await copyBuiltInBenchmark(root, "eval_loop");

    const exitCode = await runCli(
      [
        "chain",
        "--benchmarks",
        "tiny_smoke,eval_loop",
        "--worker",
        "stub",
        "--policy",
        "repair_focus_loop",
        "--budget",
        "15",
        "--max-cycles",
        "2",
        "--chain-label",
        "cli-chain-test",
        "--plateau-window",
        "3",
        "--plateau-threshold",
        "0.5",
      ],
      root,
    );

    expect(exitCode).toBe(0);
    const chainsDir = path.join(root, ".bench", "chains");
    const entries = await fs.readdir(chainsDir);
    expect(entries.length).toBeGreaterThan(0);
    const chainPath = path.join(chainsDir, entries[0]!);
    const chain = await readJson<ChainState>(chainPath);
    expect(chain.label).toBe("cli-chain-test");
    expect(chain.status).toBe("completed");
    expect(chain.stages).toHaveLength(2);
    expect(chain.stages.every((stage) => stage.status === "completed")).toBe(true);

    const watchExit = await runCli(
      ["watch", "--chain-latest", "--label", "cli-chain-test", "--once"],
      root,
    );
    expect(watchExit).toBe(0);
  }, 30_000);

  it("can run directly from a custom brief file", async () => {
    const root = await createTempHarness();
    const briefPath = path.join(root, "custom-brief.md");
    await fs.writeFile(
      briefPath,
      "# Terminal Fleet Console\n\nBuild a small operator console for a fictional fleet.\n",
      "utf8",
    );

    const exitCode = await runCli(
      [
        "loop",
        "--brief-file",
        "custom-brief.md",
        "--worker",
        "stub",
        "--policy",
        "repair_focus_loop",
        "--budget",
        "15",
        "--max-cycles",
        "2",
      ],
      root,
    );

    expect(exitCode).toBe(0);
    const generatedSpecPath = path.join(
      root,
      ".bench",
      "generated",
      "briefs",
      "brief-custom-brief",
      "benchmark",
      "spec.json",
    );
    await expect(fs.access(generatedSpecPath)).resolves.toBeUndefined();

    const runsDir = path.join(root, ".bench", "runs");
    const entries = await fs.readdir(runsDir);
    expect(entries.length).toBeGreaterThan(0);
    const result = await readJson<{ benchmarkId: string; continueAfterSuccess?: boolean }>(
      path.join(runsDir, entries[0]!, "result.json"),
    );
    expect(result.benchmarkId).toBe("brief-custom-brief");
    expect(result.continueAfterSuccess).toBe(true);
  }, 30_000);

  it("renders richer watcher output for live run state", async () => {
    const root = await createTempHarness();
    await copyBuiltInBenchmark(root, "tiny_smoke");

    const exitCode = await runCli(
      [
        "loop",
        "--benchmark",
        "tiny_smoke",
        "--worker",
        "stub",
        "--policy",
        "gated_role_loop",
        "--budget",
        "15",
        "--max-cycles",
        "1",
      ],
      root,
    );
    expect(exitCode).toBe(0);

    const runsDir = path.join(root, ".bench", "runs");
    const entries = await fs.readdir(runsDir);
    const runDir = path.join(runsDir, entries[0]!);
    const ledgerPath = path.join(runDir, "ledger.json");
    const ledger = await readJson<LoopState>(ledgerPath);
    ledger.currentCycleNumber = 1;
    ledger.currentPhase = "execution";
    ledger.lastPhaseSummary = "Streaming progress from execution.";
    ledger.livePhase = {
      cycleNumber: 1,
      phase: "execution",
      updatedAt: new Date().toISOString(),
      summary: "Streaming progress from execution.",
      step: 2,
      stepLimit: 8,
      model: "qwen/test-model",
      filesTouched: ["src/main.ts", "src/renderer/App.tsx"],
      commandsRun: ["npm run build"],
      issues: ["Smoke test still pending."],
      recentActions: [
        {
          step: 1,
          actionType: "write_file",
          action: { path: "src/main.ts" },
          observationSummary: "Wrote src/main.ts",
        },
        {
          step: 2,
          actionType: "run_command",
          action: { command: "npm run build" },
          observationSummary: "Ran command 'npm run build' with exit code 0",
        },
      ],
    };
    await fs.writeFile(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");

    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((chunk: string | Uint8Array) => {
        writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return true;
      }) as typeof process.stdout.write);

    const watchExit = await runCli(["watch", "--ledger", ledgerPath, "--once"], root);
    writeSpy.mockRestore();

    expect(watchExit).toBe(0);
    const output = writes.join("");
    expect(output).toContain("priorities:");
    expect(output).toContain("judge:");
    expect(output).toContain("live activity:");
    expect(output).toContain("recent actions:");
    expect(output).toContain("files:");
    expect(output).toContain("commands:");
  }, 30_000);
});
