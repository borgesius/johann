import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { runLoopExperiment } from "../src/loop.js";
import { collectRunResults } from "../src/report.js";
import { copyBuiltInBenchmark, createTempHarness } from "./helpers.js";

describe("collectRunResults", () => {
  it("aggregates completed run results", async () => {
    const root = await createTempHarness();
    await copyBuiltInBenchmark(root, "eval_loop");
    const loaded = await loadConfig(root);

    await runLoopExperiment({
      loaded,
      benchmarkId: "eval_loop",
      workerId: "stub",
      policyId: "gated_role_loop",
      budgetMinutes: 30,
      maxCycles: 1,
    });

    const report = await collectRunResults(loaded);
    expect(report.rows.length).toBe(1);
    expect(report.rows[0]?.benchmarkId).toBe("eval_loop");
    expect(report.rows[0]?.score).toBeGreaterThan(0);
  });
});
