import path from "node:path";
import { readJson } from "./utils.js";
import type { HarnessConfig, LoadedConfig } from "./types.js";

export async function loadConfig(rootDir = process.cwd()): Promise<LoadedConfig> {
  const configPath = path.join(rootDir, ".benchconfig.json");
  const rawConfig = await readJson<HarnessConfig>(configPath);
  const config: HarnessConfig = {
    ...rawConfig,
    chainsDir: rawConfig.chainsDir ?? ".bench/chains",
  };
  return {
    rootDir,
    configPath,
    config,
  };
}

export function resolveWorkerConfig(loaded: LoadedConfig, workerId: string) {
  const worker = loaded.config.workers[workerId];
  if (!worker) {
    const known = Object.keys(loaded.config.workers).sort().join(", ");
    throw new Error(`Unknown worker '${workerId}'. Known workers: ${known}`);
  }
  return worker;
}
