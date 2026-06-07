import fs from "node:fs/promises";
import path from "node:path";
import type {
  CellResult,
  ChainState,
  ChainSummary,
  LoadedConfig,
  PolicyId,
  StopRules,
} from "./types.js";
import {
  ensureDir,
  makeRunId,
  nowIso,
  pathExists,
  slugify,
  writeJson,
  writeJsonSync,
} from "./utils.js";

export function resolveChainsDir(loaded: LoadedConfig): string {
  return path.join(loaded.rootDir, loaded.config.chainsDir ?? ".bench/chains");
}

export interface CreateChainStateOptions {
  label?: string;
  workerId: string;
  policyId: PolicyId;
  budgetMinutes: number;
  maxCycles: number;
  benchmarks: string[];
  stopRules: StopRules;
}

export async function createChainState(
  loaded: LoadedConfig,
  options: CreateChainStateOptions,
): Promise<ChainState> {
  const chainRunId = makeRunId([options.label ?? "chain", options.workerId, options.policyId]);
  const chainPath = path.join(resolveChainsDir(loaded), `${chainRunId}.json`);
  await ensureDir(path.dirname(chainPath));

  const createdAt = nowIso();
  const state: ChainState = {
    chainRunId,
    ...(options.label ? { label: options.label } : {}),
    createdAt,
    updatedAt: createdAt,
    status: "running",
    workerId: options.workerId,
    policyId: options.policyId,
    budgetMinutes: options.budgetMinutes,
    maxCycles: options.maxCycles,
    benchmarks: options.benchmarks,
    stopRules: options.stopRules,
    chainPath,
    stages: options.benchmarks.map((benchmarkId) => ({
      benchmarkId,
      status: "pending",
    })),
  };

  await writeJson(chainPath, state);
  return state;
}

export async function persistChainState(state: ChainState): Promise<void> {
  state.updatedAt = nowIso();
  await writeJson(state.chainPath, state);
}

export function persistChainStateSync(state: ChainState): void {
  state.updatedAt = nowIso();
  writeJsonSync(state.chainPath, state);
}

export function summarizeChainResults(results: CellResult[]): ChainSummary {
  const totalTokens = results.reduce((sum, result) => sum + (result.totalTokens ?? 0), 0);
  const executionTokens = results.reduce(
    (sum, result) => sum + (result.executionTokens ?? 0),
    0,
  );
  const coordinationTokens = results.reduce(
    (sum, result) => sum + (result.coordinationTokens ?? 0),
    0,
  );
  const costUsd = results.reduce((sum, result) => sum + (result.costUsd ?? 0), 0);
  const executionCostUsd = results.reduce(
    (sum, result) => sum + (result.executionCostUsd ?? 0),
    0,
  );
  const coordinationCostUsd = results.reduce(
    (sum, result) => sum + (result.coordinationCostUsd ?? 0),
    0,
  );

  return {
    totalTokens,
    executionTokens,
    coordinationTokens,
    costUsd,
    executionCostUsd,
    coordinationCostUsd,
    finalScore: results[results.length - 1]?.score ?? null,
    minStageScore:
      results.length > 0 ? Math.min(...results.map((result) => result.score)) : null,
    averageScore:
      results.length > 0
        ? Number(
            (
              results.reduce((sum, result) => sum + result.score, 0) / results.length
            ).toFixed(1),
          )
        : null,
  };
}

export async function resolveLatestChainPath(
  loaded: LoadedConfig,
  label?: string,
): Promise<string | undefined> {
  const chainsRoot = resolveChainsDir(loaded);
  if (!(await pathExists(chainsRoot))) {
    return undefined;
  }

  const labelToken = label ? slugify(label) : undefined;
  const entries = await fs.readdir(chainsRoot, { withFileTypes: true });
  const candidates = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    if (labelToken && !entry.name.includes(labelToken)) {
      continue;
    }
    const chainPath = path.join(chainsRoot, entry.name);
    const stat = await fs.stat(chainPath);
    candidates.push({
      chainPath,
      mtimeMs: stat.mtimeMs,
    });
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.chainPath;
}
