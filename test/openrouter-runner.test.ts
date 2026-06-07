import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/app-smoke.js", () => ({
  runBrowserSmoke: vi.fn(async () => ({
    passed: true,
    summary: "Browser smoke passed for http://127.0.0.1:4173",
    details: "Page title: mocked",
  })),
}));

import { runBrowserSmoke } from "../src/app-smoke.js";
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

function makeWebBenchmark(): ResolvedBenchmarkSpec {
  return {
    ...makeBenchmark(),
    id: "web_surface_integrity",
    title: "Philosophy Site",
    summary: "A webapp benchmark used to test that execution does not gut core surfaces into placeholders.",
    artifactTarget: "Elaborate philosophy website repo",
    publicBrief:
      "# Brief\nBuild a philosophy website with a manifesto, concept map, exploratory mode, and interactive surface. Do not replace core screens with trivial placeholders just to make the build pass.",
  };
}

function makeContext(
  repoDir: string,
  phase: RunnerPhaseContext["phase"],
  options?: Partial<RunnerPhaseContext> & { continueAfterSuccess?: boolean; benchmark?: ResolvedBenchmarkSpec },
): RunnerPhaseContext {
  const now = new Date();
  return {
    workerId: "qwen-coder-next",
    benchmark: options?.benchmark ?? makeBenchmark(),
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
    ...(options?.activeWorkItems ? { activeWorkItems: options.activeWorkItems } : {}),
    ...(options?.programWorkItems ? { programWorkItems: options.programWorkItems } : {}),
    ...(options?.currentProgramSlice ? { currentProgramSlice: options.currentProgramSlice } : {}),
    ...(options?.deferredWorkItems ? { deferredWorkItems: options.deferredWorkItems } : {}),
    ...(options?.visibleInitiatives ? { visibleInitiatives: options.visibleInitiatives } : {}),
    ...(options?.visibleOpportunities ? { visibleOpportunities: options.visibleOpportunities } : {}),
    ...(options?.previousPhaseOutputs ? { previousPhaseOutputs: options.previousPhaseOutputs } : {}),
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

  it("steers coordination write attempts into a structured handoff", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openrouter-runner-coordination-guidance-"));
    tempRoots.push(root);
    const repoDir = path.join(root, "repo");
    await fs.mkdir(repoDir, { recursive: true });

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ content?: string }>;
      };
      const lastMessage = body.messages?.[body.messages.length - 1]?.content ?? "";
      if (lastMessage.includes("strictly read-only")) {
        expect(lastMessage).toContain("structured handoff");
        expect(lastMessage).toContain("name them in the plan/current work");
        return mockCompletion({
          type: "finish",
          reasoning: "Converted the intended scaffold into a planning handoff.",
          result: {
            summary: "Converted the intended scaffold into a planning handoff.",
            workBreakdown: [
              {
                id: "electron-foundation",
                title: "Bootstrap Electron foundation",
                size: "small",
                rationale: "Execution should start with package.json and the main/preload/renderer shell.",
              },
            ],
            architectureDirectives: [
              "Keep the first scaffold split across src/main.ts, src/preload.ts, and src/renderer/.",
            ],
          },
        });
      }

      return mockCompletion({
        type: "write_file",
        path: "package.json",
        content: "{\n  \"name\": \"hft-firm-game\"\n}\n",
        reasoning: "Jump straight to the obvious scaffold.",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const runner = new OpenRouterRunner(worker);
    const result = await runner.runPhase(makeContext(repoDir, "planning"));

    expect(result.summary).toContain("planning handoff");
    expect(
      result.traces?.some(
        (trace) =>
          trace.actionType === "write_file"
          && trace.observationSummary.includes("not allowed during planning"),
      ),
    ).toBe(true);
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

  it("forces a structured coordination finish after repeated implementation attempts in read-only phases", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openrouter-runner-coordination-drift-"));
    tempRoots.push(root);
    const repoDir = path.join(root, "repo");
    await fs.mkdir(repoDir, { recursive: true });

    const fetchMock = vi.fn(async () =>
      mockCompletion({
        type: "write_file",
        path: "package.json",
        content: "{\n  \"name\": \"hft-firm-game\"\n}\n",
        reasoning: "Jump straight to the obvious scaffold.",
      }));
    vi.stubGlobal("fetch", fetchMock);

    const runner = new OpenRouterRunner(worker);
    const result = await runner.runPhase(makeContext(repoDir, "pm_intake"));

    expect(result.summary).toContain("read-only phase");
    expect(result.metadata?.forcedFinish).toBe(true);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(4);
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

  it("requires a passing validation before execution can finish once the repo is runnable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openrouter-runner-validation-"));
    tempRoots.push(root);
    const repoDir = path.join(root, "repo");
    await fs.mkdir(repoDir, { recursive: true });

    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        return mockCompletion({
          type: "write_file",
          path: "package.json",
          content: JSON.stringify({
            name: "hft-foundation",
            private: true,
            scripts: {
              test: "node -e \"process.exit(0)\"",
            },
          }, null, 2) + "\n",
          reasoning: "Create the package manifest with a smokeable test script.",
        });
      }
      if (callCount === 2) {
        return mockCompletion({
          type: "write_file",
          path: "src/main.ts",
          content: "export const mainReady = true;\n",
          reasoning: "Add the Electron main process entry.",
        });
      }
      if (callCount === 3) {
        return mockCompletion({
          type: "write_file",
          path: "src/preload.ts",
          content: "export const preloadReady = true;\n",
          reasoning: "Add the preload bridge.",
        });
      }
      if (callCount === 4) {
        return mockCompletion({
          type: "write_file",
          path: "src/renderer/index.html",
          content: "<!doctype html><html><body>ready</body></html>\n",
          reasoning: "Add the renderer shell.",
        });
      }
      if (callCount === 5) {
        return mockCompletion({
          type: "finish",
          reasoning: "The scaffold is complete.",
          result: {
            summary: "The scaffold is complete.",
          },
        });
      }
      if (callCount === 6) {
        return mockCompletion({
          type: "run_command",
          command: "npm test",
          reasoning: "Run the lightweight validation path.",
        });
      }
      return mockCompletion({
        type: "finish",
        reasoning: "The scaffold is validated.",
        result: {
          summary: "The scaffold is validated.",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const runner = new OpenRouterRunner(worker);
    const result = await runner.runPhase(makeContext(repoDir, "execution"));

    expect(result.summary).toContain("validated");
    expect(
      result.traces?.some(
        (trace) => trace.actionType === "run_command" && trace.action.command === "npm test",
      ),
    ).toBe(true);
    expect(callCount).toBeGreaterThanOrEqual(7);
  });

  it("requires real domain progress before a long-horizon execution can finish", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openrouter-runner-domain-depth-"));
    tempRoots.push(root);
    const repoDir = path.join(root, "repo");
    await fs.mkdir(repoDir, { recursive: true });

    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        return mockCompletion({
          type: "write_file",
          path: "package.json",
          content: JSON.stringify({
            name: "hft-foundation",
            private: true,
            scripts: {
              test: "node -e \"process.exit(0)\"",
            },
          }, null, 2) + "\n",
          reasoning: "Create the package manifest.",
        });
      }
      if (callCount === 2) {
        return mockCompletion({
          type: "write_file",
          path: "src/main.ts",
          content: "export const mainReady = true;\n",
          reasoning: "Add the Electron main process entry.",
        });
      }
      if (callCount === 3) {
        return mockCompletion({
          type: "write_file",
          path: "src/preload.ts",
          content: "export const preloadReady = true;\n",
          reasoning: "Add the preload bridge.",
        });
      }
      if (callCount === 4) {
        return mockCompletion({
          type: "write_file",
          path: "src/renderer/index.html",
          content: "<!doctype html><html><body>ready</body></html>\n",
          reasoning: "Add the renderer shell.",
        });
      }
      if (callCount === 5) {
        return mockCompletion({
          type: "run_command",
          command: "npm test",
          reasoning: "Secure a passing validation path.",
        });
      }
      if (callCount === 6) {
        return mockCompletion({
          type: "finish",
          reasoning: "The foundation is validated.",
          result: {
            summary: "The foundation is validated.",
          },
        });
      }
      if (callCount === 7) {
        return mockCompletion({
          type: "write_file",
          path: "src/game/GameEngine.ts",
          content: "export class GameEngine { tick() { return 'market-open'; } }\n",
          reasoning: "Implement one real domain module before handing off.",
        });
      }
      return mockCompletion({
        type: "finish",
        reasoning: "The foundation now includes real game logic.",
        result: {
          summary: "The foundation now includes real game logic.",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const runner = new OpenRouterRunner(worker);
    const result = await runner.runPhase(
      makeContext(repoDir, "execution", {
        continueAfterSuccess: true,
        activeWorkItems: [
          {
            id: "bootstrap-electron-app",
            title: "Bootstrap Electron Application Structure",
            size: "small",
            rationale: "Create package.json and the main/preload/renderer shell.",
            track: "delivery",
            acceptanceHint: "package.json, src/main.ts, src/preload.ts, and src/renderer/ exist",
          },
          {
            id: "implement-core-simulation-systems",
            title: "Implement Core Simulation Systems",
            size: "medium",
            rationale: "Build the people, engine, and market systems that make the game real.",
            track: "delivery",
            acceptanceHint: "One real simulation module exists under src/ and changes product state",
          },
        ],
      }),
    );

    expect(result.summary).toContain("real game logic");
    expect(
      result.traces?.some(
        (trace) =>
          trace.actionType === "write_file"
          && trace.action.path === "src/game/GameEngine.ts",
      ),
    ).toBe(true);
    expect(callCount).toBeGreaterThanOrEqual(8);
  });

  it("does not treat a failing validation command as enough to leave execution", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openrouter-runner-validation-fail-"));
    tempRoots.push(root);
    const repoDir = path.join(root, "repo");
    await fs.mkdir(repoDir, { recursive: true });

    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        return mockCompletion({
          type: "write_file",
          path: "package.json",
          content: JSON.stringify({
            name: "hft-foundation",
            private: true,
            scripts: {
              test: "node -e \"process.exit(1)\"",
            },
          }, null, 2) + "\n",
          reasoning: "Create the package manifest with a failing test script.",
        });
      }
      if (callCount === 2) {
        return mockCompletion({
          type: "write_file",
          path: "src/main.ts",
          content: "export const mainReady = true;\n",
          reasoning: "Add the Electron main process entry.",
        });
      }
      if (callCount === 3) {
        return mockCompletion({
          type: "write_file",
          path: "src/preload.ts",
          content: "export const preloadReady = true;\n",
          reasoning: "Add the preload bridge.",
        });
      }
      if (callCount === 4) {
        return mockCompletion({
          type: "write_file",
          path: "src/renderer/index.html",
          content: "<!doctype html><html><body>ready</body></html>\n",
          reasoning: "Add the renderer shell.",
        });
      }
      if (callCount === 5) {
        return mockCompletion({
          type: "run_command",
          command: "npm test",
          reasoning: "Try the validation path.",
        });
      }
      if (callCount === 6) {
        return mockCompletion({
          type: "finish",
          reasoning: "The scaffold is ready for review.",
          result: {
            summary: "The scaffold is ready for review.",
          },
        });
      }
      if (callCount === 7) {
        return mockCompletion({
          type: "replace_in_file",
          path: "package.json",
          find: "process.exit(1)",
          replace: "process.exit(0)",
          reasoning: "Repair the failing validation path.",
        });
      }
      if (callCount === 8) {
        return mockCompletion({
          type: "run_command",
          command: "npm test",
          reasoning: "Confirm the repaired validation path passes.",
        });
      }
      return mockCompletion({
        type: "finish",
        reasoning: "The scaffold is now validated.",
        result: {
          summary: "The scaffold is now validated.",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const runner = new OpenRouterRunner(worker);
    const result = await runner.runPhase(makeContext(repoDir, "execution"));

    expect(result.summary).toContain("now validated");
    expect(
      result.traces?.filter(
        (trace) => trace.actionType === "run_command" && trace.action.command === "npm test",
      ).length,
    ).toBe(2);
    expect(callCount).toBeGreaterThanOrEqual(9);
  });

  it("blocks execution finish when core web surfaces were gutted into trivial placeholders", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openrouter-runner-surface-gutting-"));
    tempRoots.push(root);
    const repoDir = path.join(root, "repo");
    await fs.mkdir(repoDir, { recursive: true });

    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        return mockCompletion({
          type: "write_file",
          path: "package.json",
          content: JSON.stringify({
            name: "philosophy-site",
            private: true,
            scripts: {
              build: "node -e \"process.exit(0)\"",
            },
            dependencies: {
              next: "^15.0.0",
              react: "^19.0.0",
              "react-dom": "^19.0.0",
            },
          }, null, 2) + "\n",
          reasoning: "Create a minimal package manifest.",
        });
      }
      if (callCount === 2) {
        return mockCompletion({
          type: "write_file",
          path: "src/app/page.tsx",
          content: "export default function HomePage() { return <div>Home</div>; }\n",
          reasoning: "Drop in a trivial page stub.",
        });
      }
      if (callCount === 3) {
        return mockCompletion({
          type: "write_file",
          path: "src/components/Manifesto.tsx",
          content: "export default function Manifesto() { return <div>Manifesto</div>; }\n",
          reasoning: "Drop in a trivial manifesto stub.",
        });
      }
      if (callCount === 4) {
        return mockCompletion({
          type: "run_command",
          command: "npm run build",
          reasoning: "Make sure the build passes.",
        });
      }
      if (callCount === 5) {
        return mockCompletion({
          type: "finish",
          reasoning: "The site now builds.",
          result: {
            summary: "The site now builds.",
          },
        });
      }
      if (callCount === 6) {
        return mockCompletion({
          type: "replace_in_file",
          path: "src/components/Manifesto.tsx",
          find: "export default function Manifesto() { return <div>Manifesto</div>; }",
          replace: "export default function Manifesto() { return <section><h1>Becoming</h1><p>Being is shorthand for a stabilization inside becoming.</p></section>; }",
          reasoning: "Restore real manifesto content.",
        });
      }
      if (callCount === 7) {
        return mockCompletion({
          type: "replace_in_file",
          path: "src/app/page.tsx",
          find: "export default function HomePage() { return <div>Home</div>; }",
          replace: "import Manifesto from '../components/Manifesto'; export default function HomePage() { return <main><Manifesto /></main>; }",
          reasoning: "Restore a real page surface.",
        });
      }
      return mockCompletion({
        type: "finish",
        reasoning: "The site now builds without hollowing out the core surfaces.",
        result: {
          summary: "The site now builds without hollowing out the core surfaces.",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const runner = new OpenRouterRunner(worker);
    const result = await runner.runPhase(
      makeContext(repoDir, "execution", {
        benchmark: makeWebBenchmark(),
      }),
    );

    expect(result.summary).toContain("without hollowing out");
    expect(callCount).toBeGreaterThanOrEqual(8);
  });

  it("requires revalidation after repo edits make earlier passing validation stale", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openrouter-runner-validation-stale-"));
    tempRoots.push(root);
    const repoDir = path.join(root, "repo");
    await fs.mkdir(repoDir, { recursive: true });

    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        return mockCompletion({
          type: "write_file",
          path: "package.json",
          content: JSON.stringify({
            name: "hft-foundation",
            private: true,
            scripts: {
              test: "node -e \"process.exit(0)\"",
            },
          }, null, 2) + "\n",
          reasoning: "Create the package manifest with a passing validation path.",
        });
      }
      if (callCount === 2) {
        return mockCompletion({
          type: "write_file",
          path: "src/main.ts",
          content: "export const mainReady = true;\n",
          reasoning: "Add the Electron main process entry.",
        });
      }
      if (callCount === 3) {
        return mockCompletion({
          type: "write_file",
          path: "src/preload.ts",
          content: "export const preloadReady = true;\n",
          reasoning: "Add the preload bridge.",
        });
      }
      if (callCount === 4) {
        return mockCompletion({
          type: "write_file",
          path: "src/renderer/index.html",
          content: "<!doctype html><html><body>ready</body></html>\n",
          reasoning: "Add the renderer shell.",
        });
      }
      if (callCount === 5) {
        return mockCompletion({
          type: "run_command",
          command: "npm test",
          reasoning: "Secure an initial passing validation path.",
        });
      }
      if (callCount === 6) {
        return mockCompletion({
          type: "write_file",
          path: "src/game/core.ts",
          content: "export const broken = ;\n",
          reasoning: "Add gameplay logic after validation, but this edit should make the old validation stale.",
        });
      }
      if (callCount === 7) {
        return mockCompletion({
          type: "finish",
          reasoning: "The repo was validated earlier and now has game logic.",
          result: {
            summary: "The repo was validated earlier and now has game logic.",
          },
        });
      }
      if (callCount === 8) {
        return mockCompletion({
          type: "replace_in_file",
          path: "src/game/core.ts",
          find: "export const broken = ;",
          replace: "export const broken = false;",
          reasoning: "Repair the stale-broken gameplay module.",
        });
      }
      if (callCount === 9) {
        return mockCompletion({
          type: "run_command",
          command: "npm test",
          reasoning: "Revalidate after the gameplay edit.",
        });
      }
      return mockCompletion({
        type: "finish",
        reasoning: "The scaffold and gameplay module are validated again.",
        result: {
          summary: "The scaffold and gameplay module are validated again.",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const runner = new OpenRouterRunner(worker);
    const result = await runner.runPhase(makeContext(repoDir, "execution"));

    expect(result.summary).toContain("validated again");
    expect(
      result.traces?.filter(
        (trace) => trace.actionType === "run_command" && trace.action.command === "npm test",
      ).length,
    ).toBe(2);
    expect(callCount).toBeGreaterThanOrEqual(10);
  });

  it("blocks execution finish when Electron runtime wiring still points at src TypeScript", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openrouter-runner-runtime-shape-"));
    tempRoots.push(root);
    const repoDir = path.join(root, "repo");
    await fs.mkdir(repoDir, { recursive: true });

    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        return mockCompletion({
          type: "write_file",
          path: "package.json",
          content: JSON.stringify({
            name: "hft-foundation",
            main: "src/main.ts",
            scripts: {
              test: "node -e \"process.exit(0)\"",
            },
            devDependencies: {
              electron: "^27.0.0",
            },
          }, null, 2) + "\n",
          reasoning: "Create the initial Electron package manifest.",
        });
      }
      if (callCount === 2) {
        return mockCompletion({
          type: "write_file",
          path: "tsconfig.json",
          content: JSON.stringify({
            compilerOptions: {
              outDir: "dist",
            },
          }, null, 2) + "\n",
          reasoning: "Set the TypeScript outDir.",
        });
      }
      if (callCount === 3) {
        return mockCompletion({
          type: "write_file",
          path: "src/main.ts",
          content: "export const mainReady = true;\n",
          reasoning: "Add the Electron main source entry.",
        });
      }
      if (callCount === 4) {
        return mockCompletion({
          type: "write_file",
          path: "src/preload.ts",
          content: "export const preloadReady = true;\n",
          reasoning: "Add the preload source entry.",
        });
      }
      if (callCount === 5) {
        return mockCompletion({
          type: "write_file",
          path: "src/renderer/index.html",
          content: "<!doctype html><html><body>ready</body></html>\n",
          reasoning: "Add the renderer shell.",
        });
      }
      if (callCount === 6) {
        return mockCompletion({
          type: "write_file",
          path: "dist/main.js",
          content: "exports.mainReady = true;\n",
          reasoning: "Simulate the built Electron runtime entry.",
        });
      }
      if (callCount === 7) {
        return mockCompletion({
          type: "run_command",
          command: "npm test",
          reasoning: "Run the lightweight validation path.",
        });
      }
      if (callCount === 8) {
        return mockCompletion({
          type: "finish",
          reasoning: "The scaffold is validated.",
          result: {
            summary: "The scaffold is validated.",
          },
        });
      }
      if (callCount === 9) {
        return mockCompletion({
          type: "replace_in_file",
          path: "package.json",
          find: "\"src/main.ts\"",
          replace: "\"dist/main.js\"",
          reasoning: "Align package main with the built runtime output.",
        });
      }
      return mockCompletion({
        type: "finish",
        reasoning: "The scaffold is validated and runtime-coherent.",
        result: {
          summary: "The scaffold is validated and runtime-coherent.",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const runner = new OpenRouterRunner(worker);
    const result = await runner.runPhase(makeContext(repoDir, "execution"));

    expect(result.summary).toContain("runtime-coherent");
    expect(
      result.traces?.some(
        (trace) =>
          trace.actionType === "replace_in_file"
          && trace.action.path === "package.json",
      ),
    ).toBe(true);
    expect(callCount).toBeGreaterThanOrEqual(10);
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

  it("nudges execution into runtime closure after repeated smoke failures on a substantive web app", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openrouter-runner-runtime-closure-"));
    tempRoots.push(root);
    const repoDir = path.join(root, "repo");
    await fs.mkdir(path.join(repoDir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, "package.json"),
      JSON.stringify({
        name: "becoming-site",
        scripts: {
          dev: "vite",
          build: "vite build",
        },
        dependencies: {
          react: "^18.0.0",
        },
        devDependencies: {
          vite: "^5.0.0",
        },
      }, null, 2) + "\n",
      "utf8",
    );
    await fs.writeFile(path.join(repoDir, "src/main.tsx"), "console.log('boot');\n", "utf8");
    await fs.writeFile(
      path.join(repoDir, "src/App.tsx"),
      "export default function App() { return <main>rich philosophy surface</main>; }\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(repoDir, "src/ConceptAtlas.tsx"),
      "export default function ConceptAtlas() { return <section><h2>Concept Atlas</h2><p>dense content</p></section>; }\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(repoDir, "src/ExploratoryMode.tsx"),
      "export default function ExploratoryMode() { return <section><h2>Exploratory Mode</h2><p>fragments</p></section>; }\n",
      "utf8",
    );

    vi.mocked(runBrowserSmoke)
      .mockResolvedValueOnce({
        passed: false,
        summary: "Browser smoke failed for http://127.0.0.1:4173",
        details: "Last browser error: connection refused",
      })
      .mockResolvedValueOnce({
        passed: false,
        summary: "Browser smoke failed for http://127.0.0.1:4173",
        details: "Last browser error: blank page",
      })
      .mockResolvedValueOnce({
        passed: true,
        summary: "Browser smoke passed for http://127.0.0.1:4173",
        details: "Page title: becoming",
      });
    const initialSmokeCalls = vi.mocked(runBrowserSmoke).mock.calls.length;

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ content?: string }>;
      };
      const lastMessage = body.messages?.[body.messages.length - 1]?.content ?? "";

      if (lastMessage.includes("Browser smoke has already failed 2 times")) {
        return mockCompletion({
          type: "run_app_smoke",
          url: "http://127.0.0.1:4173",
          startCommand: "npm run dev -- --host 127.0.0.1 --port 4173",
          waitForSelector: "#root, #app, main",
          reasoning: "Verify the runtime after focusing on closure work.",
        });
      }

      if (lastMessage.includes("Browser smoke passed")) {
        return mockCompletion({
          type: "finish",
          reasoning: "Closed the live runtime issue.",
          result: {
            summary: "Closed the live runtime issue.",
            filesTouched: ["src/App.tsx"],
            commandsRun: ["npm run build"],
          },
        });
      }

      return mockCompletion({
        type: "run_app_smoke",
        url: "http://127.0.0.1:4173",
        startCommand: "npm run dev -- --host 127.0.0.1 --port 4173",
        waitForSelector: "#root, #app, main",
        reasoning: "Check whether the live app comes up cleanly.",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const runner = new OpenRouterRunner(worker);
    const result = await runner.runPhase(
      makeContext(repoDir, "execution", { benchmark: makeWebBenchmark(), continueAfterSuccess: true }),
    );

    expect(
      fetchMock.mock.calls.some((call) => {
        const init = call[1] as RequestInit | undefined;
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          messages?: Array<{ content?: string }>;
        };
        const lastMessage = body.messages?.[body.messages.length - 1]?.content ?? "";
        return lastMessage.includes("Browser smoke has already failed 2 times");
      }),
    ).toBe(true);
    expect(vi.mocked(runBrowserSmoke).mock.calls.length - initialSmokeCalls).toBeGreaterThanOrEqual(3);
    expect(
      result.summary.includes("Closed the live runtime issue")
      || result.summary.includes("Recovered execution after hitting the phase step limit."),
    ).toBe(true);
  });
});
