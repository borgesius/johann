import { spawn } from "node:child_process";
import path from "node:path";
import type {
  LoopClassification,
  PhaseTraceStep,
  RunnerAdapter,
  RunnerPhaseContext,
  RunnerPhaseProgress,
  RunnerPhaseResult,
  StructuredPhaseOutput,
  TokenUsageSummary,
  WorkerConfig,
} from "../types.js";
import { buildPhasePrompt, createFallbackPhaseOutput } from "../prompts.js";
import { extractJsonObject, listFiles, truncate } from "../utils.js";

type OpenCodeEvent = {
  type?: string;
  sessionID?: string;
  part?: Record<string, unknown>;
  timestamp?: number;
};

type OpenCodeInvocation = {
  binary: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  idleTimeoutMs?: number;
  onEvent?: (event: OpenCodeEvent) => void;
};

type OpenCodeInvocationResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  events: OpenCodeEvent[];
  sessionId?: string;
  timeoutReason?: "total" | "idle";
};

type OpenCodeInvoker = (options: OpenCodeInvocation) => Promise<OpenCodeInvocationResult>;

const DEFAULT_OPENCODE_PHASES: Array<RunnerPhaseContext["phase"]> = ["execution", "review"];
const FILE_REPAIR_THRESHOLD = 4;
const FILE_TRUE_THRASH_THRESHOLD = 6;
const COMMAND_VALIDATION_LOOP_THRESHOLD = 2;
const COMMAND_TRUE_THRASH_THRESHOLD = 4;
const EDIT_MISMATCH_REPAIR_THRESHOLD = 2;
const EDIT_MISMATCH_TRUE_THRASH_THRESHOLD = 4;
const WRITE_ACTIONS = new Set(["write", "edit", "multiedit"]);

function shouldUseOpenCodePhase(worker: WorkerConfig, phase: RunnerPhaseContext["phase"]): boolean {
  return (worker.opencodePhases ?? DEFAULT_OPENCODE_PHASES).includes(phase);
}

function toOpenCodeModel(model: string | undefined): string | undefined {
  if (!model) {
    return undefined;
  }
  return model.split("/").length >= 3 ? model : `openrouter/${model}`;
}

function resolveOpenCodeModel(
  worker: WorkerConfig,
  phase: RunnerPhaseContext["phase"],
): string | undefined {
  return toOpenCodeModel(worker.phaseModels?.[phase] ?? worker.model);
}

function phaseTimeoutMs(phase: RunnerPhaseContext["phase"]): number {
  switch (phase) {
    case "execution":
      return 12 * 60_000;
    case "review":
      return 8 * 60_000;
    default:
      return 5 * 60_000;
  }
}

function phaseIdleTimeoutMs(phase: RunnerPhaseContext["phase"]): number {
  switch (phase) {
    case "execution":
      return 4 * 60_000;
    case "review":
      return 3 * 60_000;
    default:
      return 2 * 60_000;
  }
}

function buildOpenCodePrompt(context: RunnerPhaseContext, repoTree: string[]): string {
  return [
    `You are operating inside OpenCode as the ${context.phase} worker for a benchmark harness.`,
    "Use OpenCode's built-in repo tools directly when useful.",
    "Do the work in the repo during execution. In review, stay read-only and do not modify files.",
    "Your final response must be exactly one JSON object matching the requested phase output fields.",
    "Do not wrap the final JSON in markdown fences.",
    "Do not narrate tool calls in the final response.",
    "Prefer compact, targeted edits and short validation commands over long-running foreground processes.",
    "When using the bash tool, omit timeout unless you really need it; if you do set timeout, pass a plain integer number of milliseconds, not a quoted or decimal value.",
    buildPhasePrompt(context, repoTree),
  ].join("\n\n");
}

function usageFromStepFinish(part: Record<string, unknown>): TokenUsageSummary | undefined {
  const tokens = part.tokens;
  if (!tokens || typeof tokens !== "object") {
    return undefined;
  }
  const tokenRecord = tokens as Record<string, unknown>;
  const promptTokens = typeof tokenRecord.input === "number" ? tokenRecord.input : 0;
  const completionTokens = typeof tokenRecord.output === "number" ? tokenRecord.output : 0;
  const totalTokens = typeof tokenRecord.total === "number" ? tokenRecord.total : promptTokens + completionTokens;
  const costUsd = typeof part.cost === "number" ? part.cost : undefined;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

function appendUsage(
  totals: TokenUsageSummary | undefined,
  next: TokenUsageSummary | undefined,
): TokenUsageSummary | undefined {
  if (!next) {
    return totals;
  }
  if (!totals) {
    return next;
  }
  return {
    promptTokens: totals.promptTokens + next.promptTokens,
    completionTokens: totals.completionTokens + next.completionTokens,
    totalTokens: totals.totalTokens + next.totalTokens,
    ...(totals.costUsd !== undefined || next.costUsd !== undefined
      ? { costUsd: (totals.costUsd ?? 0) + (next.costUsd ?? 0) }
      : {}),
  };
}

function summarizeToolEvent(event: OpenCodeEvent, step: number): {
  trace?: PhaseTraceStep;
  touchedFiles?: string[];
  commands?: string[];
  issues?: string[];
} {
  if (event.type !== "tool_use" || !event.part || typeof event.part !== "object") {
    return {};
  }

  const part = event.part;
  const tool = typeof part.tool === "string" ? part.tool : "tool";
  const state = part.state && typeof part.state === "object"
    ? (part.state as Record<string, unknown>)
    : undefined;
  const input = state?.input && typeof state.input === "object"
    ? (state.input as Record<string, unknown>)
    : {};
  const metadata = state?.metadata && typeof state.metadata === "object"
    ? (state.metadata as Record<string, unknown>)
    : {};
  const status = typeof state?.status === "string" ? state.status : "completed";
  const title = typeof state?.title === "string" ? state.title : undefined;

  const touchedFiles = new Set<string>();
  const commands: string[] = [];
  const issues: string[] = [];

  const filePath = typeof input.filePath === "string"
    ? input.filePath
    : typeof metadata.filepath === "string"
      ? metadata.filepath
      : undefined;
  if (filePath) {
    touchedFiles.add(filePath);
  }
  if (typeof input.command === "string") {
    commands.push(input.command);
  }

  let summary = title ?? `${tool} executed`;
  if (tool === "write" && filePath) {
    summary = `Wrote ${filePath}`;
  } else if ((tool === "edit" || tool === "multiedit") && filePath) {
    summary = `Updated ${filePath}`;
  } else if (tool === "read" && filePath) {
    summary = `Read ${filePath}`;
  } else if (tool === "bash" && typeof input.command === "string") {
    const exitCode = typeof metadata.exit === "number" ? metadata.exit : undefined;
    summary = `Ran command '${input.command}'${exitCode !== undefined ? ` with exit code ${exitCode}` : ""}`;
  } else if (tool === "todowrite") {
    summary = "Updated OpenCode todo list";
  }

  const interrupted = metadata.interrupted === true;
  if (status !== "completed") {
    const error = typeof state?.error === "string" ? state.error : `${tool} ${status}`;
    if (!interrupted) {
      issues.push(error);
    }
    summary = `${summary} (${status})`;
  }

  return {
    trace: {
      step,
      actionType: tool,
      action: {
        ...input,
        ...(status !== "completed" ? { toolStatus: status } : {}),
        ...(typeof state?.error === "string" ? { toolError: state.error } : {}),
        ...(typeof metadata.exit === "number" ? { exitCode: metadata.exit } : {}),
      },
      observationSummary: truncate(summary, 220),
    },
    touchedFiles: [...touchedFiles],
    commands,
    issues,
  };
}

function extractTraceFilePath(trace: PhaseTraceStep): string | undefined {
  const filePath = typeof trace.action.filePath === "string"
    ? trace.action.filePath
    : typeof trace.action.path === "string"
      ? trace.action.path
      : undefined;
  return filePath;
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function normalizeIssueText(issue: string): string {
  return issue
    .replace(/\s+/g, " ")
    .replace(/["'`]/g, "")
    .trim()
    .toLowerCase();
}

function isExactMatchEditFailure(issue: string): boolean {
  const normalized = normalizeIssueText(issue);
  return (
    normalized.includes("could not find oldstring in the file")
    || normalized.includes("no changes to apply")
  );
}

function looksLikeRuntimeCommand(command: string): boolean {
  return /(?:npm|pnpm|yarn)\s+run\s+(?:dev|preview|start)\b|vite\b|curl\b|localhost|127\.0\.0\.1/i.test(
    command,
  );
}

type LoopAnalysis = {
  classification: LoopClassification;
  signals: string[];
};

function detectLoopState(
  traces: PhaseTraceStep[],
  rootDir?: string,
): LoopAnalysis {
  const fileWrites = new Map<string, number>();
  const failedEditFingerprints = new Map<string, { filePath: string; issue: string; count: number }>();
  const commandFingerprints = new Map<string, { command: string; count: number; exitCode?: number }>();
  const touchedFiles = new Set<string>();

  for (const trace of traces) {
    if (trace.actionType === "edit" || trace.actionType === "multiedit") {
      const filePath = extractTraceFilePath(trace);
      const toolError =
        typeof trace.action.toolError === "string" ? trace.action.toolError : undefined;
      if (filePath && toolError && isExactMatchEditFailure(toolError)) {
        const fingerprint = `${filePath}::${normalizeIssueText(toolError)}`;
        const current = failedEditFingerprints.get(fingerprint) ?? {
          filePath,
          issue: toolError,
          count: 0,
        };
        current.count += 1;
        failedEditFingerprints.set(fingerprint, current);
      }
    }

    if (!WRITE_ACTIONS.has(trace.actionType)) {
      if (trace.actionType === "bash" && typeof trace.action.command === "string") {
        const command = normalizeCommand(trace.action.command);
        const exitCode =
          typeof trace.action.exitCode === "number" ? trace.action.exitCode : undefined;
        if (command) {
          const fingerprint = `${command}::${exitCode ?? "unknown"}`;
          const current = commandFingerprints.get(fingerprint) ?? {
            command,
            count: 0,
            ...(exitCode !== undefined ? { exitCode } : {}),
          };
          current.count += 1;
          commandFingerprints.set(fingerprint, current);
        }
      }
      continue;
    }
    const filePath = extractTraceFilePath(trace);
    if (filePath) {
      touchedFiles.add(filePath);
      fileWrites.set(filePath, (fileWrites.get(filePath) ?? 0) + 1);
    }
  }

  const uniqueFiles = [...touchedFiles];
  const maxWrite = [...fileWrites.values()].sort((left, right) => right - left)[0] ?? 0;
  const repeatedEditMismatch = [...failedEditFingerprints.values()]
    .sort((left, right) => right.count - left.count)[0];
  const repeatedFailingCommand = [...commandFingerprints.values()]
    .filter((entry) => entry.exitCode !== undefined && entry.exitCode !== 0)
    .sort((left, right) => right.count - left.count)[0];
  const repeatedValidationishCommand = [...commandFingerprints.values()]
    .filter((entry) =>
      entry.count >= COMMAND_VALIDATION_LOOP_THRESHOLD
      && /\b(?:npm|pnpm|yarn)\s+run\s+(?:test|build|lint|typecheck|dev|preview|start)\b|curl\b/i.test(entry.command),
    )
    .sort((left, right) => right.count - left.count)[0];

  if (repeatedEditMismatch && repeatedEditMismatch.count >= EDIT_MISMATCH_TRUE_THRASH_THRESHOLD) {
    const displayPath =
      rootDir
      && path.isAbsolute(repeatedEditMismatch.filePath)
      && repeatedEditMismatch.filePath.startsWith(rootDir)
        ? path.relative(rootDir, repeatedEditMismatch.filePath)
        : repeatedEditMismatch.filePath;
    return {
      classification: "true_thrash",
      signals: [
        `True thrash detected: repeated exact-match edit failures on ${displayPath} (${repeatedEditMismatch.count} attempts). Switch away from fragile string patches and re-read or rewrite the surface cleanly.`,
      ],
    };
  }

  if (
    repeatedFailingCommand
    && repeatedFailingCommand.count >= COMMAND_TRUE_THRASH_THRESHOLD
    && uniqueFiles.length <= 2
  ) {
    const focusFiles = uniqueFiles
      .map((filePath) =>
        rootDir && path.isAbsolute(filePath) && filePath.startsWith(rootDir)
          ? path.relative(rootDir, filePath)
          : filePath,
      )
      .slice(0, 4);
    return {
      classification: "true_thrash",
      signals: [
        `True thrash detected: repeated failing fingerprint '${truncate(repeatedFailingCommand.command, 140)}' (exit ${repeatedFailingCommand.exitCode}) happened ${repeatedFailingCommand.count} times with edits concentrated in ${focusFiles.join(", ") || "the same surface"}.`,
      ],
    };
  }

  if (maxWrite >= FILE_TRUE_THRASH_THRESHOLD && uniqueFiles.length <= 2) {
    const focusFile = [...fileWrites.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
    const displayPath =
      focusFile && rootDir && path.isAbsolute(focusFile) && focusFile.startsWith(rootDir)
        ? path.relative(rootDir, focusFile)
        : focusFile;
    return {
      classification: "true_thrash",
      signals: [
        `True thrash detected: ${displayPath ?? "one file"} was rewritten ${maxWrite} times without enough evidence of state change.`,
      ],
    };
  }

  if (repeatedValidationishCommand && repeatedValidationishCommand.count >= COMMAND_VALIDATION_LOOP_THRESHOLD) {
    return {
      classification:
        repeatedValidationishCommand.exitCode !== undefined && repeatedValidationishCommand.exitCode !== 0
          ? "validation_loop"
          : "focused_build",
      signals: [],
    };
  }

  if (repeatedEditMismatch && repeatedEditMismatch.count >= EDIT_MISMATCH_REPAIR_THRESHOLD) {
    return {
      classification: "repair_loop",
      signals: [],
    };
  }

  if (maxWrite >= FILE_REPAIR_THRESHOLD && uniqueFiles.length <= 3) {
    return {
      classification: "repair_loop",
      signals: [],
    };
  }

  return {
    classification: "focused_build",
    signals: [],
  };
}

function mergeOutput(
  phase: RunnerPhaseContext["phase"],
  raw: unknown,
  fallback: StructuredPhaseOutput,
  actualFiles: string[],
  actualCommands: string[],
  issues: string[],
): StructuredPhaseOutput {
  const output: StructuredPhaseOutput =
    raw && typeof raw === "object"
      ? {
          ...fallback,
          ...(raw as Record<string, unknown>),
        } as StructuredPhaseOutput
      : fallback;

  if (actualFiles.length > 0) {
    output.filesTouched = actualFiles;
  }
  if (actualCommands.length > 0) {
    output.commandsRun = actualCommands;
  }

  if (phase === "execution") {
    if (issues.length > 0) {
      output.unresolvedIssues = [...new Set([...(output.unresolvedIssues ?? []), ...issues])];
    }
  } else if (phase === "review") {
    if (issues.length > 0) {
      output.unresolvedIssues = [...new Set([...(output.unresolvedIssues ?? []), ...issues])];
      output.risks = [...new Set([...(output.risks ?? []), ...issues])];
    }
  }

  return output;
}

async function invokeOpenCodeCli(options: OpenCodeInvocation): Promise<OpenCodeInvocationResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(options.binary, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";
    const events: OpenCodeEvent[] = [];
    let sessionId: string | undefined;
    let timeoutReason: "total" | "idle" | undefined;

    const timer = setTimeout(() => {
      timeoutReason = "total";
      child.kill("SIGTERM");
    }, options.timeoutMs);
    let idleTimer: NodeJS.Timeout | undefined;

    const resetIdleTimer = (): void => {
      if (!options.idleTimeoutMs) {
        return;
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => {
        timeoutReason = "idle";
        child.kill("SIGTERM");
      }, options.idleTimeoutMs);
    };

    resetIdleTimer();

    function flushLines(chunk: string): void {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const parsed = JSON.parse(trimmed) as OpenCodeEvent;
          events.push(parsed);
          if (parsed.sessionID) {
            sessionId = parsed.sessionID;
          }
          resetIdleTimer();
          options.onEvent?.(parsed);
        } catch {
          // Keep the raw line in stdout so callers can inspect unexpected output.
        }
      }
    }

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      resetIdleTimer();
      flushLines(text);
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      resetIdleTimer();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      if (stdoutBuffer.trim().length > 0) {
        try {
          const parsed = JSON.parse(stdoutBuffer.trim()) as OpenCodeEvent;
          events.push(parsed);
          if (parsed.sessionID) {
            sessionId = parsed.sessionID;
          }
          options.onEvent?.(parsed);
        } catch {
          // ignore trailing partial line
        }
      }
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        events,
        ...(sessionId ? { sessionId } : {}),
        ...(timeoutReason ? { timeoutReason } : {}),
      });
    });
  });
}

export class OpenCodeRunner implements RunnerAdapter {
  private readonly delegate: RunnerAdapter;

  private readonly invoke: OpenCodeInvoker;

  private readonly sessions = new Map<string, string>();

  constructor(
    private readonly worker: WorkerConfig,
    delegate: RunnerAdapter,
    invoke: OpenCodeInvoker = invokeOpenCodeCli,
  ) {
    this.delegate = delegate;
    this.invoke = invoke;
  }

  async runPhase(context: RunnerPhaseContext): Promise<RunnerPhaseResult> {
    if (!shouldUseOpenCodePhase(this.worker, context.phase)) {
      return this.delegate.runPhase(context);
    }

    const model = resolveOpenCodeModel(this.worker, context.phase);
    if (!model) {
      return this.delegate.runPhase(context);
    }

    const repoTree = await listFiles(context.repoDir, { maxDepth: 5, includeHidden: false });
    const prompt = buildOpenCodePrompt(context, repoTree);
    const existingSession = this.sessions.get(context.repoDir);
    const args = [
      "run",
      "--format",
      "json",
      "--pure",
      "--dir",
      context.repoDir,
      "--model",
      model,
      ...(this.worker.opencodeSkipPermissions ?? true ? ["--dangerously-skip-permissions"] : []),
      ...(existingSession ? ["--session", existingSession] : []),
      ...(this.worker.opencodeExtraArgs ?? []),
      prompt,
    ];

    const traces: PhaseTraceStep[] = [];
    const touchedFiles = new Set<string>();
    const commandsRun: string[] = [];
    const issues: string[] = [];
    const issueSet = new Set<string>();
    let textOutput = "";
    let usage: TokenUsageSummary | undefined;
    let step = 0;

    const reportProgress = (summary: string): void => {
      if (!context.onProgress) {
        return;
      }
      const loopState = detectLoopState(traces, context.repoDir);
      const progress: RunnerPhaseProgress = {
        cycleNumber: context.cycleNumber,
        phase: context.phase,
        summary,
        step,
        model,
        primaryModel: model,
        ...(usage ? { usage } : {}),
        filesTouched: [...touchedFiles].slice(-8),
        commandsRun: commandsRun.slice(-6),
        issues: issues.slice(-6),
        loopClassification: loopState.classification,
        recentActions: traces.slice(-6),
        ...(context.branchCandidate
          ? { branchCandidateId: context.branchCandidate.id, branchLabel: context.branchCandidate.label }
          : {}),
      };
      Promise.resolve(context.onProgress(progress)).catch(() => undefined);
    };

    reportProgress(`Starting OpenCode ${context.phase} run.`);

    const makeInvocation = (retryNote?: string): OpenCodeInvocation => ({
      binary: this.worker.opencodeBinary ?? "opencode",
      args: retryNote
        ? [
            ...args.slice(0, -1),
            `${prompt}\n\nRetry note:\n${retryNote}`,
          ]
        : args,
      cwd: context.repoDir,
      env: {
        ...process.env,
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_CLIENT: "bench-harness",
      },
      timeoutMs: phaseTimeoutMs(context.phase),
      idleTimeoutMs: phaseIdleTimeoutMs(context.phase),
      onEvent: (event) => {
          if (event.sessionID) {
            this.sessions.set(context.repoDir, event.sessionID);
          }

          if (event.type === "text" && event.part && typeof event.part === "object") {
            const text = typeof event.part.text === "string" ? event.part.text : "";
            if (text.length > 0) {
              textOutput += text;
            }
            reportProgress(
              text.length > 0
                ? `OpenCode produced ${context.phase} output text.`
                : `OpenCode is thinking through ${context.phase}.`,
            );
            return;
          }

          if (event.type === "tool_use") {
            step += 1;
            const { trace, touchedFiles: files, commands, issues: eventIssues } = summarizeToolEvent(event, step);
            if (trace) {
              trace.observationSummary = trace.observationSummary.replaceAll(`${context.repoDir}${path.sep}`, "");
              traces.push(trace);
            }
            for (const file of files ?? []) {
              touchedFiles.add(file.startsWith(context.repoDir) ? path.relative(context.repoDir, file) : file);
            }
            for (const command of commands ?? []) {
              commandsRun.push(command);
            }
            for (const issue of eventIssues ?? []) {
              if (!issueSet.has(issue)) {
                issues.push(issue);
                issueSet.add(issue);
              }
            }
            const loopState = detectLoopState(traces, context.repoDir);
            let newestThrashSignal: string | undefined;
            for (const signal of loopState.signals) {
              if (!issueSet.has(signal)) {
                issues.push(signal);
                issueSet.add(signal);
                newestThrashSignal = signal;
              }
            }
            reportProgress(
              newestThrashSignal
                ? newestThrashSignal
                : trace?.observationSummary ?? `OpenCode used ${trace?.actionType ?? "a tool"}.`,
            );
            return;
          }

          if (event.type === "step_finish" && event.part && typeof event.part === "object") {
            usage = appendUsage(usage, usageFromStepFinish(event.part));
            reportProgress(`OpenCode finished a ${context.phase} reasoning step.`);
          }
        },
    });

    let result: OpenCodeInvocationResult;
    try {
      result = await this.invoke(makeInvocation());
      if (result.timeoutReason === "idle" && !extractJsonObject(textOutput)) {
        const idleNote =
          `The previous OpenCode ${context.phase} attempt went idle after partial progress. ` +
          "If you are blocked after a validation or smoke failure, change tactic quickly or finish with a structured handoff instead of waiting.";
        reportProgress(`OpenCode ${context.phase} went idle; retrying once with a sharper recovery note.`);
        result = await this.invoke(makeInvocation(idleNote));
      }
    } catch (error) {
      return this.delegate.runPhase({
        ...context,
        handoffNotes: [
          ...context.handoffNotes,
          `OpenCode ${context.phase} failed before producing a stable result: ${error instanceof Error ? error.message : String(error)}`,
        ],
      });
    }

    if (result.sessionId) {
      this.sessions.set(context.repoDir, result.sessionId);
    }

    const jsonObject = extractJsonObject(textOutput);
    const parsed = jsonObject ? JSON.parse(jsonObject) : undefined;
    const loopState = detectLoopState(traces, context.repoDir);
    for (const signal of loopState.signals) {
      if (!issueSet.has(signal)) {
        issues.push(signal);
        issueSet.add(signal);
      }
    }
    const summary =
      parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).summary === "string"
        ? String((parsed as Record<string, unknown>).summary)
        : `OpenCode completed ${context.phase}${issues.length > 0 ? " with follow-up issues" : ""}.`;

    const fallback = createFallbackPhaseOutput(context.phase, summary);
    const output = mergeOutput(
      context.phase,
      parsed,
      fallback,
      [...touchedFiles],
      [...new Set(commandsRun)],
      [...new Set(issues)],
    );

    if (result.exitCode !== 0 && !jsonObject) {
      return this.delegate.runPhase({
        ...context,
        handoffNotes: [
          ...context.handoffNotes,
          `OpenCode ${context.phase} exited with code ${result.exitCode}${
            result.timeoutReason ? ` after a ${result.timeoutReason} timeout` : ""
          }: ${truncate(result.stderr || result.stdout, 600)}`,
        ],
      });
    }

    return {
      summary: output.summary,
      output,
      rawOutput: textOutput.length > 0 ? textOutput : truncate(result.stdout || result.stderr, 12_000),
      traces,
      metadata: {
        runner: "opencode",
        model,
        exitCode: result.exitCode,
        loopClassification: loopState.classification,
        ...(loopState.signals.length > 0 ? { thrashSignals: loopState.signals } : {}),
        ...(usage ? { usage } : {}),
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
      },
    };
  }
}
