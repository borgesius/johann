import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenRouterRunner } from "../src/runners/openrouter.js";
import type {
  PriorityItem,
  ResolvedBenchmarkSpec,
  RunnerPhaseContext,
  WorkerConfig,
} from "../src/types.js";

const worker: WorkerConfig = {
  type: "openrouter",
  model: "qwen/test-model",
  apiKeyEnv: "OPENROUTER_API_KEY",
  baseUrl: "https://example.invalid/api/v1/chat/completions",
  maxTokens: 600,
};

const backlog: PriorityItem[] = [
  {
    id: "bootstrap-shell",
    bucket: "acceptance_gap",
    title: "Create a runnable Electron shell",
    rationale: "The repo needs a bootable desktop app before deeper simulation work.",
    source: "brief",
    severity: 5,
  },
  {
    id: "sim-core",
    bucket: "acceptance_gap",
    title: "Implement the first simulation loop",
    rationale: "The core progression should exist before polish.",
    source: "brief",
    severity: 4,
  },
  {
    id: "smoke-tests",
    bucket: "quality_improvement",
    title: "Add smoke validation and basic docs",
    rationale: "The repo should be testable and understandable early.",
    source: "brief",
    severity: 3,
  },
];

function makeBenchmark(): ResolvedBenchmarkSpec {
  return {
    id: "runner_limit_recovery",
    title: "Electron Bootstrap Recovery",
    summary: "A benchmark used to test OpenRouter limit recovery.",
    artifactTarget: "Electron simulation repo",
    publicBriefFile: "benchmarks/runner_limit_recovery/brief.md",
    workspaceSeed: "seeds/runner_limit_recovery",
    budgets: { minMinutes: 20, maxMinutes: 120, defaultMinutes: 45 },
    acceptanceCriteria: backlog.map((item) => item.title),
    branchTemplates: [],
    hiddenChecks: [
      {
        id: "shell-file",
        title: "Shell exists",
        category: "repo",
        weight: 1,
        required: true,
        type: "fileExists",
        path: "src/main.ts",
      },
    ],
    judgeWeights: {},
    expectedRoleOutputs: {},
    successThreshold: 80,
    benchmarkDir: "/tmp/benchmarks/runner_limit_recovery",
    publicBriefPath: "/tmp/benchmarks/runner_limit_recovery/brief.md",
    publicBrief:
      "# Brief\nBuild an Electron bootstrap with a strong simulation/domain split and fast smoke coverage.",
    workspaceSeedPath: "/tmp/seeds/runner_limit_recovery",
  };
}

function makeContext(
  repoDir: string,
  phase: RunnerPhaseContext["phase"],
  options?: { continueAfterSuccess?: boolean },
): RunnerPhaseContext {
  const now = new Date();
  return {
    workerId: "qwen-coder-next",
    benchmark: makeBenchmark(),
    phase,
    repoDir,
    runDir: path.join(repoDir, ".."),
    cycleNumber: 1,
    policyId: "gated_role_loop",
    budget: {
      totalMinutes: 45,
      startedAt: now.toISOString(),
      deadlineAt: new Date(now.getTime() + 45 * 60_000).toISOString(),
    },
    architectureDirectives: [],
    visibleBacklog: backlog,
    previousPhaseOutputs: {},
    handoffNotes: [],
    ...(options?.continueAfterSuccess ? { continueAfterSuccess: true } : {}),
  };
}

function mockCompletion(content: unknown) {
  return {
    ok: true,
    json: async () => ({
      model: "qwen/test-model",
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
      choices: [
        {
          message: {
            content: typeof content === "string" ? content : JSON.stringify(content),
          },
        },
      ],
    }),
    text: async () => JSON.stringify(content),
  };
}

describe("OpenRouterRunner limit recovery", () => {
  const tempRoots: string[] = [];

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "test-key";
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await Promise.all(
      tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  it("forces a structured finish when planning exhausts its read-only tool budget", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openrouter-runner-limit-"));
    tempRoots.push(root);
    const repoDir = path.join(root, "repo");
    await fs.mkdir(path.join(repoDir, "src"), { recursive: true });
    await fs.writeFile(path.join(repoDir, "src", "existing.ts"), "export const ready = true;\n", "utf8");

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ content?: string }>;
      };
      const lastMessage = body.messages?.[body.messages.length - 1]?.content ?? "";
      if (lastMessage.includes("No more tool actions are available")) {
        return mockCompletion({
          type: "finish",
          reasoning: "Recovered planning handoff.",
          result: {
            summary: "Recovered planning handoff.",
          },
        });
      }

      return mockCompletion({
        type: "list_files",
        path: ".",
        depth: 2,
        reasoning: "Inspect the repo again.",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const runner = new OpenRouterRunner(worker);
    const result = await runner.runPhase(makeContext(repoDir, "planning"));

    expect(result.summary).toContain("Recovered planning");
    expect(result.output.workBreakdown?.length).toBeGreaterThan(0);
    expect(result.output.architectureDirectives?.length).toBeGreaterThan(0);
    expect(result.output.testStrategy?.length).toBeGreaterThan(0);
    expect(result.metadata?.forcedFinish).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("falls back to synthesized coordination output when forced-finish retries still fail", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openrouter-runner-bootstrap-"));
    tempRoots.push(root);
    const repoDir = path.join(root, "repo");
    await fs.mkdir(repoDir, { recursive: true });

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ content?: string }>;
      };
      const lastMessage = body.messages?.[body.messages.length - 1]?.content ?? "";
      if (lastMessage.includes("No more tool actions are available")) {
        return mockCompletion({
          type: "list_files",
          path: ".",
          depth: 1,
          reasoning: "Still trying to inspect.",
        });
      }

      return mockCompletion({
        type: "list_files",
        path: ".",
        depth: 1,
        reasoning: "Confirm the repo is empty.",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const runner = new OpenRouterRunner(worker);
    const result = await runner.runPhase(makeContext(repoDir, "pm_intake"));

    expect(result.summary).toContain("Recovered pm_intake");
    expect(result.output.backlog?.length).toBeGreaterThan(0);
    expect(result.output.workBreakdown?.length).toBeGreaterThan(0);
    expect(result.output.architectureDirectives?.length).toBeGreaterThan(0);
    expect(
      result.output.architectureDirectives?.some(
        (directive) =>
          directive.includes("src/main.ts") && directive.includes("src/preload.ts"),
      ),
    ).toBe(true);
    expect(result.metadata?.forcedFinishFallback).toBe(true);
  });

  it("rejects execution finishes that claim work without any actual repo changes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openrouter-runner-execution-"));
    tempRoots.push(root);
    const repoDir = path.join(root, "repo");
    await fs.mkdir(repoDir, { recursive: true });

    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        return mockCompletion({
          type: "list_files",
          path: ".",
          depth: 1,
          reasoning: "Confirm the repo is empty before scaffolding.",
        });
      }
      if (callCount === 2) {
        return mockCompletion({
          type: "finish",
          reasoning: "Everything is scaffolded.",
          result: {
            summary: "Everything is scaffolded.",
            filesTouched: ["package.json", "src/main.ts"],
            commandsRun: ["npm init -y"],
          },
        });
      }
      if (callCount === 3) {
        return mockCompletion({
          type: "write_file",
          path: "package.json",
          content: "{\n  \"name\": \"hft-foundation\"\n}\n",
          reasoning: "Create the actual package manifest.",
        });
      }
      return mockCompletion({
        type: "finish",
        reasoning: "Created the real scaffold.",
        result: {
          summary: "Created the real scaffold.",
          filesTouched: ["package.json", "src/main.ts"],
          commandsRun: ["npm init -y"],
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const runner = new OpenRouterRunner(worker);
    const result = await runner.runPhase(makeContext(repoDir, "execution"));

    expect(result.summary).toContain("Created the real scaffold");
    expect(result.output.filesTouched).toEqual(["package.json"]);
    expect(result.output.commandsRun).toBeUndefined();
    expect(result.traces?.some((trace) => trace.actionType === "write_file")).toBe(true);
    expect(callCount).toBeGreaterThanOrEqual(4);
  });

  it("uses a phase-specific model override for coordination phases", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openrouter-runner-phase-model-"));
    tempRoots.push(root);
    const repoDir = path.join(root, "repo");
    await fs.mkdir(path.join(repoDir, "docs"), { recursive: true });
    await fs.writeFile(path.join(repoDir, "README.md"), "# Seed\n", "utf8");

    const phaseWorker: WorkerConfig = {
      ...worker,
      model: "qwen/primary-model",
      phaseModels: {
        planning: "qwen/coordination-model",
      },
    };

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      expect(body.model).toBe("qwen/coordination-model");
      return mockCompletion({
        type: "finish",
        reasoning: "Coordination phase finished.",
        result: {
          summary: "Coordination phase finished.",
          architectureDirectives: ["Keep the server and web app loosely coupled."],
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const runner = new OpenRouterRunner(phaseWorker);
    const result = await runner.runPhase(makeContext(repoDir, "planning"));

    expect(result.summary).toContain("Coordination phase finished");
    expect(result.metadata?.primaryModel).toBe("qwen/coordination-model");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the configured model when the primary request fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openrouter-runner-fallback-model-"));
    tempRoots.push(root);
    const repoDir = path.join(root, "repo");
    await fs.mkdir(repoDir, { recursive: true });

    const fallbackWorker: WorkerConfig = {
      ...worker,
      model: "qwen/primary-model",
      fallbackModel: "qwen/fallback-model",
    };

    const requestedModels: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      const model = body.model ?? "unknown";
      requestedModels.push(model);
      if (model === "qwen/primary-model") {
        throw new Error("primary model timed out");
      }
      return mockCompletion({
        type: "finish",
        reasoning: "Recovered planning handoff with fallback model.",
        result: {
          summary: "Recovered planning handoff with fallback model.",
          architectureDirectives: ["Keep run state in a durable event ledger."],
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const runner = new OpenRouterRunner(fallbackWorker);
    const result = await runner.runPhase(makeContext(repoDir, "pm_intake"));

    expect(result.summary).toContain("Recovered planning handoff with fallback model");
    expect(requestedModels).toEqual(["qwen/primary-model", "qwen/fallback-model"]);
    expect(result.traces?.some((trace) => trace.actionType === "recovery")).toBe(true);
    expect(
      (result.metadata?.modelCalls as Array<Record<string, unknown>> | undefined)?.some(
        (call) => call.requestedModel === "qwen/fallback-model" && call.fallbackFrom === "qwen/primary-model",
      ),
    ).toBe(true);
  });

  it("emits live progress updates with touched files and recent actions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openrouter-runner-progress-"));
    tempRoots.push(root);
    const repoDir = path.join(root, "repo");
    await fs.mkdir(repoDir, { recursive: true });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        mockCompletion({
          type: "write_file",
          path: "src/main.ts",
          content: "export const ready = true;\n",
          reasoning: "Bootstrap the entrypoint.",
        }),
      )
      .mockResolvedValueOnce(
        mockCompletion({
          type: "finish",
          reasoning: "Execution scaffold is in place.",
          result: {
            summary: "Execution scaffold is in place.",
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const progressEvents: Array<NonNullable<RunnerPhaseContext["onProgress"]> extends (
      payload: infer T,
    ) => Promise<void> | void
      ? T
      : never> = [];
    const runner = new OpenRouterRunner(worker);
    const context = makeContext(repoDir, "execution");
    context.onProgress = (progress) => {
      progressEvents.push(progress);
    };

    const result = await runner.runPhase(context);

    expect(result.summary).toContain("Execution scaffold");
    expect(progressEvents.length).toBeGreaterThan(0);
    expect(progressEvents.some((event) => event.summary.includes("Awaiting model action"))).toBe(
      true,
    );
    expect(
      progressEvents.some((event) => event.filesTouched?.includes("src/main.ts") === true),
    ).toBe(true);
    expect(
      progressEvents.some((event) =>
        event.recentActions?.some((trace) => trace.observationSummary.includes("Wrote src/main.ts")),
      ),
    ).toBe(true);
  });

  it("normalizes common aliased execution actions instead of treating them as hard failures", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openrouter-runner-normalize-"));
    tempRoots.push(root);
    const repoDir = path.join(root, "repo");
    await fs.mkdir(repoDir, { recursive: true });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        mockCompletion({
          type: "create_file",
          filePath: "src/renderer/index.html",
          text: "<!doctype html><html><body>ok</body></html>\n",
          reasoning: "Create the first renderer asset.",
        }),
      )
      .mockResolvedValueOnce(
        mockCompletion({
          type: "finish",
          reasoning: "Execution scaffold is in place.",
          result: {
            summary: "Execution scaffold is in place.",
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const runner = new OpenRouterRunner(worker);
    const result = await runner.runPhase(makeContext(repoDir, "execution"));

    expect(result.summary).toContain("Execution scaffold");
    expect(await fs.readFile(path.join(repoDir, "src/renderer/index.html"), "utf8")).toContain("ok");
    expect(
      result.traces?.some(
        (trace) =>
          trace.actionType === "normalization"
          && trace.observationSummary.includes("Normalized action type 'create_file' to 'write_file'"),
      ),
    ).toBe(true);
  });

  it("records invalid JSON attempts in the trace before recovering", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openrouter-runner-invalid-json-"));
    tempRoots.push(root);
    const repoDir = path.join(root, "repo");
    await fs.mkdir(repoDir, { recursive: true });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: "qwen/test-model",
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
          choices: [
            {
              message: {
                content: "{\"type\":\"finish\",\"reasoning\":\"broken\"",
              },
            },
          ],
        }),
        text: async () => "{\"type\":\"finish\",\"reasoning\":\"broken\"",
      })
      .mockResolvedValueOnce(
        mockCompletion({
          type: "finish",
          reasoning: "Recovered planning handoff.",
          result: {
            summary: "Recovered planning handoff.",
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const runner = new OpenRouterRunner(worker);
    const result = await runner.runPhase(makeContext(repoDir, "planning"));

    expect(result.summary).toContain("Recovered planning handoff");
    expect(
      result.traces?.some(
        (trace) =>
          trace.actionType === "invalid_json"
          && trace.observationSummary.includes("Invalid model JSON"),
      ),
    ).toBe(true);
  });

  it("gives long-horizon bootstrap planning more read-only steps before forced finish", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openrouter-runner-long-horizon-"));
    tempRoots.push(root);
    const repoDir = path.join(root, "repo");
    await fs.mkdir(repoDir, { recursive: true });

    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount += 1;
      if (callCount <= 4) {
        return mockCompletion({
          type: "list_files",
          path: ".",
          depth: 1,
          reasoning: "Keep inspecting before committing to a long-horizon plan.",
        });
      }
      return mockCompletion({
        type: "finish",
        reasoning: "Enough context gathered for a long-horizon handoff.",
        result: {
          summary: "Enough context gathered for a long-horizon handoff.",
          workBreakdown: [
            {
              id: "program-core",
              title: "Define the primary product arc",
              size: "large",
              rationale: "A bigger run should keep a richer medium-horizon slice alive.",
            },
          ],
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const runner = new OpenRouterRunner(worker);
    const result = await runner.runPhase(
      makeContext(repoDir, "pm_intake", { continueAfterSuccess: true }),
    );

    expect(result.summary).toContain("long-horizon handoff");
    expect(callCount).toBeGreaterThanOrEqual(5);
    expect(result.metadata?.forcedFinish).not.toBe(true);
  });
});
