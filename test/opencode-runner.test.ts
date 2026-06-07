import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeRunner } from "../src/runners/opencode.js";
import type {
  PriorityItem,
  ResolvedBenchmarkSpec,
  RunnerAdapter,
  RunnerPhaseContext,
  RunnerPhaseResult,
  WorkerConfig,
} from "../src/types.js";

const backlog: PriorityItem[] = [
  {
    id: "foundation",
    bucket: "acceptance_gap",
    title: "Create the first product slice",
    rationale: "The repo needs a real first slice before polish.",
    source: "brief",
    severity: 5,
  },
];

function makeBenchmark(): ResolvedBenchmarkSpec {
  return {
    id: "opencode_runner_probe",
    title: "OpenCode Runner Probe",
    summary: "A benchmark used to test the OpenCode-backed runner.",
    artifactTarget: "web app repo",
    publicBriefFile: "benchmarks/opencode_runner_probe/brief.md",
    workspaceSeed: "seeds/opencode_runner_probe",
    budgets: { minMinutes: 20, maxMinutes: 120, defaultMinutes: 45 },
    acceptanceCriteria: backlog.map((item) => item.title),
    branchTemplates: [],
    hiddenChecks: [],
    judgeWeights: {},
    expectedRoleOutputs: {},
    successThreshold: 80,
    benchmarkDir: "/tmp/benchmarks/opencode_runner_probe",
    publicBriefPath: "/tmp/benchmarks/opencode_runner_probe/brief.md",
    publicBrief: "# Brief\nCreate a thoughtful product surface.",
    workspaceSeedPath: "/tmp/seeds/opencode_runner_probe",
  };
}

function makeContext(
  repoDir: string,
  phase: RunnerPhaseContext["phase"],
): RunnerPhaseContext {
  const now = new Date();
  return {
    workerId: "qwen-coder-hybrid-opencode",
    benchmark: makeBenchmark(),
    phase,
    repoDir,
    runDir: path.join(repoDir, ".."),
    cycleNumber: 1,
    policyId: "repair_focus_loop",
    budget: {
      totalMinutes: 45,
      startedAt: now.toISOString(),
      deadlineAt: new Date(now.getTime() + 45 * 60_000).toISOString(),
    },
    architectureDirectives: [],
    visibleBacklog: backlog,
    previousPhaseOutputs: {},
    handoffNotes: [],
  };
}

const worker: WorkerConfig = {
  type: "opencode",
  model: "qwen/qwen3-coder-next",
  fallbackModel: "qwen/qwen3-coder-flash",
  phaseModels: {
    pm_intake: "qwen/qwen3-coder-flash",
    planning: "qwen/qwen3-coder-flash",
    review: "qwen/qwen3-coder-flash",
    pm_reprioritization: "qwen/qwen3-coder-flash",
  },
  apiKeyEnv: "OPENROUTER_API_KEY",
  baseUrl: "https://openrouter.ai/api/v1/chat/completions",
};

describe("OpenCodeRunner", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  it("delegates non-OpenCode phases to the fallback runner", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-runner-delegate-"));
    tempRoots.push(root);
    const repoDir = path.join(root, "repo");
    await fs.mkdir(repoDir, { recursive: true });

    const delegateResult: RunnerPhaseResult = {
      summary: "Delegated planning result.",
      output: {
        summary: "Delegated planning result.",
        recommendations: ["Keep the scaffold modular."],
      },
    };
    const delegate: RunnerAdapter = {
      runPhase: vi.fn(async () => delegateResult),
    };

    const runner = new OpenCodeRunner(worker, delegate, vi.fn());
    const result = await runner.runPhase(makeContext(repoDir, "planning"));

    expect(result.summary).toBe("Delegated planning result.");
    expect(delegate.runPhase).toHaveBeenCalledTimes(1);
  });

  it("uses OpenCode for execution phases and captures traces plus structured output", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-runner-execution-"));
    tempRoots.push(root);
    const repoDir = path.join(root, "repo");
    await fs.mkdir(repoDir, { recursive: true });
    await fs.writeFile(path.join(repoDir, "package.json"), "{\n  \"name\": \"probe\"\n}\n", "utf8");

    const delegate: RunnerAdapter = {
      runPhase: vi.fn(async () => ({
        summary: "delegate",
        output: { summary: "delegate" },
      })),
    };

    const invoke = vi.fn(async ({ onEvent }: { onEvent?: (event: Record<string, unknown>) => void }) => {
      const events = [
        { type: "step_start", sessionID: "ses_probe" },
        {
          type: "tool_use",
          sessionID: "ses_probe",
          part: {
            tool: "write",
            state: {
              status: "completed",
              input: { filePath: path.join(repoDir, "src", "app.ts"), content: "export const ready = true;\n" },
              metadata: { filepath: path.join(repoDir, "src", "app.ts") },
              title: "src/app.ts",
            },
          },
        },
        {
          type: "tool_use",
          sessionID: "ses_probe",
          part: {
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "npm run build" },
              metadata: { exit: 0 },
              title: "Build app",
            },
          },
        },
        {
          type: "step_finish",
          sessionID: "ses_probe",
          part: {
            tokens: { input: 500, output: 120, total: 620 },
            cost: 0.123,
          },
        },
        {
          type: "text",
          sessionID: "ses_probe",
          part: {
            text: JSON.stringify({
              summary: "OpenCode landed the first product slice.",
              recommendations: ["Keep pushing into product depth next cycle."],
            }),
          },
        },
      ];
      for (const event of events) {
        onEvent?.(event);
      }
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        events,
        sessionId: "ses_probe",
      };
    });

    const runner = new OpenCodeRunner(worker, delegate, invoke as never);
    const result = await runner.runPhase(makeContext(repoDir, "execution"));

    expect(delegate.runPhase).not.toHaveBeenCalled();
    expect(result.output.summary).toBe("OpenCode landed the first product slice.");
    expect(result.output.filesTouched).toContain("src/app.ts");
    expect(result.output.commandsRun).toContain("npm run build");
    expect(result.metadata).toMatchObject({
      runner: "opencode",
      model: "openrouter/qwen/qwen3-coder-next",
      exitCode: 0,
      sessionId: "ses_probe",
    });
    expect(result.traces?.map((trace) => trace.actionType)).toEqual(["write", "bash"]);
  });

  it("falls back to the delegate when OpenCode fails before producing structured output", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-runner-fallback-"));
    tempRoots.push(root);
    const repoDir = path.join(root, "repo");
    await fs.mkdir(repoDir, { recursive: true });

    const delegate: RunnerAdapter = {
      runPhase: vi.fn(async () => ({
        summary: "OpenRouter rescue path.",
        output: {
          summary: "OpenRouter rescue path.",
          recommendations: ["Repair the app shell."],
        },
      })),
    };

    const invoke = vi.fn(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "fatal opencode failure",
      events: [],
    }));

    const runner = new OpenCodeRunner(worker, delegate, invoke as never);
    const result = await runner.runPhase(makeContext(repoDir, "execution"));

    expect(result.summary).toBe("OpenRouter rescue path.");
    expect(delegate.runPhase).toHaveBeenCalledTimes(1);
  });

  it("retries once after an idle timeout before falling back", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-runner-idle-retry-"));
    tempRoots.push(root);
    const repoDir = path.join(root, "repo");
    await fs.mkdir(repoDir, { recursive: true });

    const delegate: RunnerAdapter = {
      runPhase: vi.fn(async () => ({
        summary: "delegate",
        output: { summary: "delegate" },
      })),
    };

    let callCount = 0;
    const invoke = vi.fn(async ({ onEvent }: { onEvent?: (event: Record<string, unknown>) => void }) => {
      callCount += 1;
      if (callCount === 1) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "idle timeout",
          events: [],
          timeoutReason: "idle" as const,
        };
      }

      const events = [
        {
          type: "text",
          sessionID: "ses_retry",
          part: {
            text: JSON.stringify({
              summary: "Recovered after one idle retry.",
              recommendations: ["Keep runtime closure decisive."],
            }),
          },
        },
      ];
      for (const event of events) {
        onEvent?.(event);
      }
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        events,
        sessionId: "ses_retry",
      };
    });

    const runner = new OpenCodeRunner(worker, delegate, invoke as never);
    const result = await runner.runPhase(makeContext(repoDir, "execution"));

    expect(result.summary).toBe("Recovered after one idle retry.");
    expect(delegate.runPhase).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("surfaces thrash signals when the same file and command repeat too many times", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-runner-thrash-"));
    tempRoots.push(root);
    const repoDir = path.join(root, "repo");
    await fs.mkdir(repoDir, { recursive: true });

    const delegate: RunnerAdapter = {
      runPhase: vi.fn(async () => ({
        summary: "delegate",
        output: { summary: "delegate" },
      })),
    };

    const invoke = vi.fn(async ({ onEvent }: { onEvent?: (event: Record<string, unknown>) => void }) => {
      const events = [
        { type: "step_start", sessionID: "ses_thrash" },
        ...Array.from({ length: 4 }).flatMap(() => [
          {
            type: "tool_use",
            sessionID: "ses_thrash",
            part: {
              tool: "write",
              state: {
                status: "completed",
                input: { filePath: path.join(repoDir, "src", "App.tsx"), content: "export const x = 1;\n" },
                metadata: { filepath: path.join(repoDir, "src", "App.tsx") },
                title: "src/App.tsx",
              },
            },
          },
          {
            type: "tool_use",
            sessionID: "ses_thrash",
            part: {
              tool: "bash",
              state: {
                status: "completed",
                input: { command: "npm run build" },
                metadata: { exit: 1 },
                title: "Build app",
              },
            },
          },
        ]),
        {
          type: "text",
          sessionID: "ses_thrash",
          part: {
            text: JSON.stringify({
              summary: "Execution ended with repeated attempts on the same surface.",
            }),
          },
        },
      ];
      for (const event of events) {
        onEvent?.(event);
      }
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        events,
        sessionId: "ses_thrash",
      };
    });

    const runner = new OpenCodeRunner(worker, delegate, invoke as never);
    const result = await runner.runPhase(makeContext(repoDir, "execution"));

    expect(
      result.output.unresolvedIssues?.some((issue) =>
        issue.includes("True thrash detected: repeated failing fingerprint 'npm run build'"),
      ),
    ).toBe(true);
    expect((result.metadata as Record<string, unknown>).loopClassification).toBe("true_thrash");
    expect((result.metadata as Record<string, unknown>).thrashSignals).toBeDefined();
  });

  it("escalates repeated exact-match edit failures on the same file into a repair-loop thrash signal", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-runner-edit-mismatch-"));
    tempRoots.push(root);
    const repoDir = path.join(root, "repo");
    await fs.mkdir(repoDir, { recursive: true });

    const delegate: RunnerAdapter = {
      runPhase: vi.fn(async () => ({
        summary: "delegate",
        output: { summary: "delegate" },
      })),
    };

    const invoke = vi.fn(async ({ onEvent }: { onEvent?: (event: Record<string, unknown>) => void }) => {
      const targetFile = path.join(repoDir, "src", "shared", "model.ts");
      const events = [
        { type: "step_start", sessionID: "ses_edit_mismatch" },
        ...Array.from({ length: 4 }).map(() => ({
          type: "tool_use",
          sessionID: "ses_edit_mismatch",
          part: {
            tool: "edit",
            state: {
              status: "error",
              error:
                "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.",
              input: {
                filePath: targetFile,
                oldString: "old fragment text",
                newString: "new fragment text",
              },
              metadata: { filepath: targetFile },
              title: "src/shared/model.ts",
            },
          },
        })),
        {
          type: "text",
          sessionID: "ses_edit_mismatch",
          part: {
            text: JSON.stringify({
              summary: "Execution kept attempting brittle exact-match edits.",
            }),
          },
        },
      ];
      for (const event of events) {
        onEvent?.(event);
      }
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        events,
        sessionId: "ses_edit_mismatch",
      };
    });

    const runner = new OpenCodeRunner(worker, delegate, invoke as never);
    const result = await runner.runPhase(makeContext(repoDir, "execution"));

    expect(
      result.output.unresolvedIssues?.some((issue) =>
        issue.includes("True thrash detected: repeated exact-match edit failures on src/shared/model.ts"),
      ),
    ).toBe(true);
    expect((result.metadata as Record<string, unknown>).loopClassification).toBe("true_thrash");
  });
});
