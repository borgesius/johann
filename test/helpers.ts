import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(here, "..");

export async function createTempHarness(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bench-harness-"));
  await fs.mkdir(path.join(root, "benchmarks"), { recursive: true });
  await fs.mkdir(path.join(root, "seeds"), { recursive: true });
  await fs.mkdir(path.join(root, ".bench"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".benchconfig.json"),
    JSON.stringify(
      {
        version: 1,
        runsDir: ".bench/runs",
        reportsDir: ".bench/reports",
        benchmarksDir: "benchmarks",
        workers: {
          stub: {
            type: "stub",
          },
        },
        defaults: {
          policy: "gated_role_loop",
          worker: "stub",
          budgetMinutes: 30,
          plateauWindow: 2,
          plateauThreshold: 0.5,
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  return root;
}

export async function copyBuiltInBenchmark(root: string, benchmarkId: string): Promise<void> {
  await fs.cp(
    path.join(projectRoot, "benchmarks", benchmarkId),
    path.join(root, "benchmarks", benchmarkId),
    { recursive: true },
  );
  await fs.cp(path.join(projectRoot, "seeds", benchmarkId), path.join(root, "seeds", benchmarkId), {
    recursive: true,
  });
}

export async function writeCustomBenchmark(
  root: string,
  benchmarkId: string,
  spec: Record<string, unknown>,
  brief: string,
): Promise<void> {
  const benchmarkDir = path.join(root, "benchmarks", benchmarkId);
  const seedDir = path.join(root, "seeds", benchmarkId);
  await fs.mkdir(benchmarkDir, { recursive: true });
  await fs.mkdir(seedDir, { recursive: true });
  await fs.writeFile(path.join(benchmarkDir, "spec.json"), `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(benchmarkDir, "brief.md"), brief, "utf8");
  await fs.writeFile(path.join(seedDir, ".gitkeep"), "", "utf8");
}
