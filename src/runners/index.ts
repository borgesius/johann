import type { LoadedConfig, RunnerAdapter } from "../types.js";
import { resolveWorkerConfig } from "../config.js";
import { OpenCodeRunner } from "./opencode.js";
import { OpenRouterRunner } from "./openrouter.js";
import { StubRunner } from "./stub.js";

export function createRunner(loaded: LoadedConfig, workerId: string): RunnerAdapter {
  const worker = resolveWorkerConfig(loaded, workerId);
  switch (worker.type) {
    case "stub":
      return new StubRunner();
    case "openrouter":
      return new OpenRouterRunner(worker);
    case "opencode":
      return new OpenCodeRunner(worker, new OpenRouterRunner({ ...worker, type: "openrouter" }));
  }
}
