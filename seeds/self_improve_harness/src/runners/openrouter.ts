import path from "node:path";
import type {
  PhaseTraceStep,
  PriorityItem,
  RunnerAdapter,
  RunnerPhaseContext,
  RunnerPhaseResult,
  StructuredPhaseOutput,
  TokenUsageSummary,
  WorkItem,
  WorkerConfig,
} from "../types.js";
import { runBrowserSmoke } from "../app-smoke.js";
import {
  extractJsonObject,
  listFiles,
  pathExists,
  readFilesPreview,
  readText,
  runShellCommand,
  safeResolveWithin,
  truncate,
  writeText,
} from "../utils.js";
import {
  buildOpenRouterSystemPrompt,
  buildPhasePromptWithPreviews,
  createFallbackPhaseOutput,
} from "../prompts.js";

type OpenRouterMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type UsageTotals = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost?: number;
};

type AgentAction =
  | { type: "list_files"; path?: string; depth?: number; reasoning?: string }
  | { type: "read_file"; path: string; reasoning?: string }
  | { type: "write_file"; path: string; content: string; reasoning?: string }
  | {
      type: "replace_in_file";
      path: string;
      find: string;
      replace: string;
      all?: boolean;
      reasoning?: string;
    }
  | { type: "run_command"; command: string; timeoutSeconds?: number; reasoning?: string }
  | {
      type: "run_app_smoke";
      url: string;
      startCommand?: string;
      waitForText?: string[];
      waitForSelector?: string;
      timeoutSeconds?: number;
      reasoning?: string;
    }
  | {
      type: "finish";
      reasoning?: string;
      result?: Record<string, unknown>;
    };

type ParsedAgentAction = {
  action: AgentAction;
  note?: string;
};

function normalizeContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object" && "text" in item && typeof item.text === "string") {
          return item.text;
        }
        return JSON.stringify(item);
      })
      .join("\n");
  }
  return JSON.stringify(content);
}

async function callOpenRouter(
  worker: WorkerConfig,
  messages: OpenRouterMessage[],
  options?: {
    maxTokens?: number;
    timeoutMs?: number;
    model?: string;
  },
): Promise<{ text: string; model?: string; usage?: unknown; requestedModel: string }> {
  const apiKeyEnv = worker.apiKeyEnv ?? "OPENROUTER_API_KEY";
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Missing ${apiKeyEnv} for OpenRouter worker.`);
  }
  const requestedModel = options?.model ?? worker.model;
  if (!requestedModel) {
    throw new Error("OpenRouter worker is missing a model.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options?.timeoutMs ?? 60_000);
  const response = await fetch(worker.baseUrl ?? "https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(worker.defaultHeaders ?? {}),
    },
    body: JSON.stringify({
      model: requestedModel,
      messages,
      temperature: worker.temperature ?? 0.2,
      max_tokens: options?.maxTokens ?? worker.maxTokens ?? 2200,
    }),
    signal: controller.signal,
  }).finally(() => {
    clearTimeout(timeout);
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter request failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    model?: string;
    usage?: unknown;
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  const output: { text: string; model?: string; usage?: unknown; requestedModel: string } = {
    text: normalizeContent(content),
    requestedModel,
  };
  if (data.model) {
    output.model = data.model;
  }
  if (data.usage !== undefined) {
    output.usage = data.usage;
  }
  return output;
}

function primaryModelForPhase(
  worker: WorkerConfig,
  phase: Exclude<RunnerPhaseContext["phase"], "judging">,
): string | undefined {
  return worker.phaseModels?.[phase] ?? worker.model;
}

function fallbackModelForPhase(
  worker: WorkerConfig,
  phase: Exclude<RunnerPhaseContext["phase"], "judging">,
): string | undefined {
  const primary = primaryModelForPhase(worker, phase);
  if (!worker.fallbackModel || worker.fallbackModel === primary) {
    return undefined;
  }
  return worker.fallbackModel;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function normalizeActionTypeAlias(rawType: string): string {
  const normalized = rawType.toLowerCase().replace(/[\s-]+/g, "_");
  switch (normalized) {
    case "ls":
    case "list":
    case "list_dir":
    case "list_directory":
    case "list_folder":
      return "list_files";
    case "cat":
    case "view_file":
    case "open_file":
    case "show_file":
      return "read_file";
    case "create_file":
    case "create_text_file":
    case "save_file":
    case "overwrite_file":
    case "write":
      return "write_file";
    case "edit_file":
    case "update_file":
    case "replace_text":
    case "string_replace":
      return "replace_in_file";
    case "shell":
    case "bash":
    case "sh":
    case "run_shell":
    case "shell_command":
    case "execute_command":
    case "exec":
      return "run_command";
    case "browser_smoke":
    case "app_smoke":
    case "smoke_test":
      return "run_app_smoke";
    case "done":
    case "complete":
    case "completed":
    case "final":
    case "final_answer":
      return "finish";
    default:
      return normalized;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildResultObjectFromRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const result = toRecord(record.result) ?? toRecord(record.output);
  if (result) {
    return result;
  }

  const phaseResultKeys = new Set([
    "summary",
    "confidence",
    "backlog",
    "workBreakdown",
    "initiatives",
    "opportunities",
    "acceptanceChecklist",
    "architectureDirectives",
    "risks",
    "branchDecision",
    "testStrategy",
    "unresolvedIssues",
    "recommendations",
    "commandsRun",
    "filesTouched",
    "notes",
  ]);
  const extracted = Object.fromEntries(
    Object.entries(record).filter(([key]) => phaseResultKeys.has(key)),
  );
  return Object.keys(extracted).length > 0 ? extracted : undefined;
}

function normalizeAgentAction(raw: string): ParsedAgentAction {
  const json = extractJsonObject(raw) ?? raw;
  const parsed = JSON.parse(json) as unknown;
  let record = toRecord(parsed);
  if (!record) {
    throw new Error("Model response must be a JSON object.");
  }

  const notes: string[] = [];
  if (Array.isArray(record.actions) && record.actions.length > 0) {
    const first = toRecord(record.actions[0]);
    if (first) {
      notes.push("Model returned multiple actions; only the first action was used.");
      const merged: Record<string, unknown> = { ...record, ...first };
      delete merged.actions;
      record = merged;
    }
  }

  const nestedAction = toRecord(record.action) ?? toRecord(record.tool_input);
  if (nestedAction) {
    notes.push("Model wrapped the action in an outer object; the inner action was used.");
    const merged: Record<string, unknown> = {
      ...record,
      ...nestedAction,
      ...(record.reasoning !== undefined && nestedAction.reasoning === undefined
        ? { reasoning: record.reasoning }
        : {}),
      ...(record.result !== undefined && nestedAction.result === undefined
        ? { result: record.result }
        : {}),
    };
    delete merged.action;
    delete merged.tool_input;
    record = merged;
  }

  let actionType = firstString(record, ["type", "actionType", "tool", "toolName", "name"]);
  if (!actionType) {
    if (firstString(record, ["command", "cmd", "shellCommand"])) {
      actionType = "run_command";
    } else if (
      firstString(record, ["path", "file", "filePath"]) &&
      firstString(record, ["content", "text", "body", "contents", "fileContent"])
    ) {
      actionType = "write_file";
    } else if (
      firstString(record, ["path", "file", "filePath"]) &&
      firstString(record, ["find", "search", "oldText"]) !== undefined &&
      firstString(record, ["replace", "replacement", "newText"]) !== undefined
    ) {
      actionType = "replace_in_file";
    } else if (firstString(record, ["path", "file", "filePath"])) {
      actionType = "read_file";
    } else if (record.result !== undefined || record.output !== undefined || record.summary !== undefined) {
      actionType = "finish";
    }
    if (actionType) {
      notes.push(`Model omitted an explicit action type; inferred '${actionType}'.`);
    }
  }

  if (!actionType) {
    throw new Error("Model response is missing an action type.");
  }

  const normalizedType = normalizeActionTypeAlias(actionType);
  if (normalizedType !== actionType) {
    notes.push(`Normalized action type '${actionType}' to '${normalizedType}'.`);
  }

  const reasoning = firstString(record, ["reasoning", "why", "note", "notes"]);
  const pathValue = firstString(record, ["path", "file", "filePath", "target"]);
  const contentValue = firstString(record, ["content", "text", "body", "contents", "fileContent"]);
  const findValue = firstString(record, ["find", "search", "oldText"]);
  const replaceValue = firstString(record, ["replace", "replacement", "newText"]);
  const commandValue = firstString(record, ["command", "cmd", "shellCommand"]);
  const urlValue = firstString(record, ["url", "address"]);
  const smokeStartCommand = firstString(record, ["startCommand", "start", "serverCommand"]);
  const finishResult = buildResultObjectFromRecord(record);

  if (normalizedType === "mkdir" || normalizedType === "create_directory" || normalizedType === "make_directory") {
    const directory = pathValue ?? firstString(record, ["dir", "directory"]);
    if (!directory) {
      throw new Error(`${normalizedType} is missing a path.`);
    }
    notes.push(`Normalized '${normalizedType}' into a run_command mkdir call.`);
    return {
      action: {
        type: "run_command",
        command: `mkdir -p ${shellQuote(directory)}`,
        ...(reasoning ? { reasoning } : {}),
      },
      ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
    };
  }

  let action: AgentAction;
  switch (normalizedType) {
    case "list_files":
      action = {
        type: "list_files",
        ...(pathValue ? { path: pathValue } : {}),
        ...(typeof record.depth === "number" ? { depth: record.depth } : {}),
        ...(reasoning ? { reasoning } : {}),
      };
      break;
    case "read_file":
      action = {
        type: "read_file",
        path: pathValue ?? "",
        ...(reasoning ? { reasoning } : {}),
      };
      break;
    case "write_file":
      if (Array.isArray(record.files) && record.files.length > 0) {
        const firstFile = toRecord(record.files[0]);
        if (firstFile) {
          notes.push("Model returned a batch file write; only the first file was used.");
          action = {
            type: "write_file",
            path: firstString(firstFile, ["path", "file", "filePath", "target"]) ?? "",
            content: firstString(firstFile, ["content", "text", "body", "contents", "fileContent"]) ?? "",
            ...(reasoning ? { reasoning } : {}),
          };
          break;
        }
      }
      action = {
        type: "write_file",
        path: pathValue ?? "",
        content: contentValue ?? "",
        ...(reasoning ? { reasoning } : {}),
      };
      break;
    case "replace_in_file":
      action = {
        type: "replace_in_file",
        path: pathValue ?? "",
        find: findValue ?? "",
        replace: replaceValue ?? "",
        ...(typeof record.all === "boolean" ? { all: record.all } : {}),
        ...(reasoning ? { reasoning } : {}),
      };
      break;
    case "run_command":
      action = {
        type: "run_command",
        command: commandValue ?? "",
        ...(typeof record.timeoutSeconds === "number" ? { timeoutSeconds: record.timeoutSeconds } : {}),
        ...(reasoning ? { reasoning } : {}),
      };
      break;
    case "run_app_smoke":
      action = {
        type: "run_app_smoke",
        url: urlValue ?? "",
        ...(smokeStartCommand ? { startCommand: smokeStartCommand } : {}),
        ...(Array.isArray(record.waitForText) ? { waitForText: record.waitForText as string[] } : {}),
        ...(typeof record.waitForSelector === "string" ? { waitForSelector: record.waitForSelector } : {}),
        ...(typeof record.timeoutSeconds === "number" ? { timeoutSeconds: record.timeoutSeconds } : {}),
        ...(reasoning ? { reasoning } : {}),
      };
      break;
    case "finish":
      action = {
        type: "finish",
        ...(reasoning ? { reasoning } : {}),
        ...(finishResult ? { result: finishResult } : {}),
      };
      break;
    default:
      throw new Error(`Unsupported action type '${normalizedType}'.`);
  }

  return {
    action,
    ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
  };
}

function normalizeUsage(usage: unknown): UsageTotals | undefined {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  const record = usage as Record<string, unknown>;
  const promptTokens =
    typeof record.prompt_tokens === "number" ? record.prompt_tokens : undefined;
  const completionTokens =
    typeof record.completion_tokens === "number" ? record.completion_tokens : undefined;
  const totalTokens = typeof record.total_tokens === "number" ? record.total_tokens : undefined;
  const cost = typeof record.cost === "number" ? record.cost : undefined;

  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined &&
    cost === undefined
  ) {
    return undefined;
  }

  return {
    prompt_tokens: promptTokens ?? 0,
    completion_tokens: completionTokens ?? 0,
    total_tokens: totalTokens ?? (promptTokens ?? 0) + (completionTokens ?? 0),
    ...(cost !== undefined ? { cost } : {}),
  };
}

function addUsage(left: UsageTotals | undefined, right: unknown): UsageTotals | undefined {
  const normalized = normalizeUsage(right);
  if (!normalized) {
    return left;
  }
  if (!left) {
    return normalized;
  }
  return {
    prompt_tokens: left.prompt_tokens + normalized.prompt_tokens,
    completion_tokens: left.completion_tokens + normalized.completion_tokens,
    total_tokens: left.total_tokens + normalized.total_tokens,
    ...(left.cost !== undefined || normalized.cost !== undefined
      ? { cost: (left.cost ?? 0) + (normalized.cost ?? 0) }
      : {}),
  };
}

function toTokenUsageSummary(usage: UsageTotals | undefined): TokenUsageSummary | undefined {
  if (!usage) {
    return undefined;
  }
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    ...(usage.cost !== undefined ? { costUsd: usage.cost } : {}),
  };
}

function validateAgentAction(action: AgentAction): string | null {
  switch (action.type) {
    case "list_files":
      return null;
    case "read_file":
      return typeof action.path === "string" && action.path.length > 0
        ? null
        : "read_file requires a non-empty string path";
    case "write_file":
      if (typeof action.path !== "string" || action.path.length === 0) {
        return "write_file requires a non-empty string path";
      }
      if (typeof action.content !== "string") {
        return "write_file requires string content";
      }
      return null;
    case "replace_in_file":
      if (typeof action.path !== "string" || action.path.length === 0) {
        return "replace_in_file requires a non-empty string path";
      }
      if (typeof action.find !== "string") {
        return "replace_in_file requires string find text";
      }
      if (typeof action.replace !== "string") {
        return "replace_in_file requires string replace text";
      }
      return null;
    case "run_command":
      return typeof action.command === "string" && action.command.length > 0
        ? null
        : "run_command requires a non-empty string command";
    case "run_app_smoke":
      return typeof action.url === "string" && action.url.length > 0
        ? null
        : "run_app_smoke requires a non-empty string url";
    case "finish":
      return null;
  }
}

function benchmarkComplexity(context: RunnerPhaseContext): number {
  return (
    context.benchmark.acceptanceCriteria.length +
    Math.ceil(context.benchmark.hiddenChecks.length / 4) +
    context.benchmark.branchTemplates.length
  );
}

const SCAFFOLD_ONLY_FILES = new Set([
  "README.md",
  "LICENSE",
  "LICENSE.md",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "tsconfig.json",
  "vitest.config.ts",
  "vite.config.ts",
]);

function isCoordinationPhase(phase: RunnerPhaseContext["phase"]): boolean {
  return phase === "pm_intake" || phase === "planning" || phase === "pm_reprioritization";
}

function isScaffoldOnlyFile(file: string): boolean {
  const name = file.split("/").pop() ?? file;
  return SCAFFOLD_ONLY_FILES.has(name);
}

function isBootstrapRepo(repoTree: string[]): boolean {
  const files = repoTree.filter((entry) => !entry.endsWith("/"));
  if (files.length === 0) {
    return true;
  }
  return files.every(isScaffoldOnlyFile);
}

function isLongHorizonContext(context: RunnerPhaseContext): boolean {
  return context.continueAfterSuccess === true;
}

function recoverableErrorLimit(context: RunnerPhaseContext): number {
  return isLongHorizonContext(context) ? 5 : 3;
}

function bootstrapInspectionLimit(context: RunnerPhaseContext): number {
  return isLongHorizonContext(context) ? 5 : 2;
}

function stepLimitForPhase(
  context: RunnerPhaseContext,
  options?: { repoIsBootstrap?: boolean },
): number {
  const complexity = benchmarkComplexity(context);
  const repoIsBootstrap = options?.repoIsBootstrap === true;
  const longHorizon = isLongHorizonContext(context);

  switch (context.phase) {
    case "execution":
      if (longHorizon) {
        if (complexity >= 9) {
          return repoIsBootstrap ? 24 : 22;
        }
        return repoIsBootstrap ? 20 : 18;
      }
      if (complexity >= 9) {
        return repoIsBootstrap ? 14 : 12;
      }
      return repoIsBootstrap ? 12 : 10;
    case "review":
      if (longHorizon) {
        return complexity >= 9 ? 12 : 10;
      }
      return complexity >= 9 ? 8 : 6;
    case "pm_reprioritization":
      if (longHorizon) {
        if (complexity <= 4) {
          return repoIsBootstrap ? 12 : 10;
        }
        return complexity >= 9 ? (repoIsBootstrap ? 18 : 16) : (repoIsBootstrap ? 14 : 12);
      }
      if (complexity <= 4) {
        return repoIsBootstrap ? 6 : 5;
      }
      return complexity >= 9 ? (repoIsBootstrap ? 10 : 9) : (repoIsBootstrap ? 8 : 7);
    case "planning":
    case "pm_intake":
      if (longHorizon) {
        if (complexity <= 4) {
          return repoIsBootstrap ? 18 : 16;
        }
        if (complexity >= 9) {
          return repoIsBootstrap ? 28 : 24;
        }
        return repoIsBootstrap ? 22 : 18;
      }
      if (complexity <= 4) {
        return repoIsBootstrap ? 7 : 6;
      }
      if (complexity >= 9) {
        return repoIsBootstrap ? 14 : 12;
      }
      return repoIsBootstrap ? 10 : 8;
  }
}

function phaseTimeBudgetMs(
  context: RunnerPhaseContext,
  options?: { repoIsBootstrap?: boolean },
): number {
  const complexity = benchmarkComplexity(context);
  const repoIsBootstrap = options?.repoIsBootstrap === true;
  const longHorizon = isLongHorizonContext(context);

  switch (context.phase) {
    case "execution":
      if (longHorizon) {
        if (complexity >= 9) {
          return repoIsBootstrap ? 480_000 : 420_000;
        }
        return repoIsBootstrap ? 420_000 : 360_000;
      }
      if (complexity >= 9) {
        return repoIsBootstrap ? 240_000 : 210_000;
      }
      return repoIsBootstrap ? 210_000 : 180_000;
    case "review":
      if (longHorizon) {
        return complexity >= 9 ? 210_000 : 180_000;
      }
      return complexity >= 9 ? 150_000 : 120_000;
    case "pm_reprioritization":
      if (longHorizon) {
        if (complexity <= 4) {
          return repoIsBootstrap ? 180_000 : 150_000;
        }
        return complexity >= 9 ? (repoIsBootstrap ? 300_000 : 240_000) : (repoIsBootstrap ? 240_000 : 180_000);
      }
      if (complexity <= 4) {
        return repoIsBootstrap ? 120_000 : 90_000;
      }
      return complexity >= 9 ? (repoIsBootstrap ? 180_000 : 150_000) : (repoIsBootstrap ? 150_000 : 120_000);
    case "planning":
    case "pm_intake":
      if (longHorizon) {
        if (complexity <= 4) {
          return repoIsBootstrap ? 240_000 : 180_000;
        }
        return complexity >= 9 ? (repoIsBootstrap ? 480_000 : 420_000) : (repoIsBootstrap ? 360_000 : 300_000);
      }
      if (complexity <= 4) {
        return repoIsBootstrap ? 150_000 : 120_000;
      }
      return complexity >= 9 ? (repoIsBootstrap ? 270_000 : 240_000) : (repoIsBootstrap ? 210_000 : 180_000);
  }
}

function requestTimeoutMsForPhase(
  context: RunnerPhaseContext,
  worker: WorkerConfig,
  options?: { repoIsBootstrap?: boolean; forcedFinish?: boolean },
): number {
  const phaseBudget = phaseTimeBudgetMs(context, options);
  const configured = worker.maxTokens ?? 0;
  const longHorizon = isLongHorizonContext(context);
  const executionHeavy =
    context.phase === "execution" && longHorizon && (options?.repoIsBootstrap === true || benchmarkComplexity(context) >= 9);
  const floor = options?.forcedFinish
    ? (longHorizon ? 60_000 : 45_000)
    : (longHorizon ? 50_000 : 40_000);
  const tokenAllowance = executionHeavy
    ? 120_000
    : configured >= 1_500
      ? (longHorizon ? 90_000 : 65_000)
      : (longHorizon ? 75_000 : 55_000);
  const maxTimeout = options?.forcedFinish
    ? (executionHeavy ? 135_000 : (longHorizon ? 110_000 : 75_000))
    : (executionHeavy ? 125_000 : (longHorizon ? 95_000 : 70_000));
  return Math.min(maxTimeout, Math.max(floor, Math.min(tokenAllowance, phaseBudget)));
}

function maxTokensForPhase(
  context: RunnerPhaseContext,
  worker: WorkerConfig,
  options?: { repoIsBootstrap?: boolean; forcedFinish?: boolean },
): number {
  const configured = worker.maxTokens ?? 2_200;
  const repoIsBootstrap = options?.repoIsBootstrap === true;
  const complexity = benchmarkComplexity(context);
  const longHorizon = isLongHorizonContext(context);
  let target = configured;

  if (isCoordinationPhase(context.phase)) {
    target = Math.max(
      configured,
      longHorizon
        ? (repoIsBootstrap || complexity >= 9 ? 2_600 : 2_200)
        : (repoIsBootstrap || complexity >= 9 ? 1_800 : 1_400),
    );
  } else if (context.phase === "execution") {
    target = Math.max(
      configured,
      longHorizon
        ? (repoIsBootstrap || complexity >= 9 ? 4_200 : 3_000)
        : (complexity >= 9 ? 2_100 : 1_700),
    );
  } else {
    target = Math.max(configured, longHorizon ? 1_700 : 1_300);
  }

  if (options?.forcedFinish) {
    target = Math.max(
      target,
      isCoordinationPhase(context.phase)
        ? (longHorizon ? 2_800 : 2_000)
        : (longHorizon ? 2_000 : 1_600),
    );
  }

  return target;
}

function allowedActionsForPhase(phase: RunnerPhaseContext["phase"]): Set<AgentAction["type"]> {
  switch (phase) {
    case "pm_intake":
    case "planning":
    case "pm_reprioritization":
      return new Set(["list_files", "read_file", "finish"]);
    case "review":
      return new Set(["list_files", "read_file", "run_command", "run_app_smoke", "finish"]);
    case "execution":
      return new Set([
        "list_files",
        "read_file",
        "write_file",
        "replace_in_file",
        "run_command",
        "run_app_smoke",
        "finish",
      ]);
  }
}

function previewBudgetForPhase(
  context: RunnerPhaseContext,
): { maxFiles: number; maxCharsPerFile: number } {
  const complexity = benchmarkComplexity(context);
  switch (context.phase) {
    case "execution":
      return complexity >= 9
        ? { maxFiles: 7, maxCharsPerFile: 1_700 }
        : { maxFiles: 6, maxCharsPerFile: 1_600 };
    case "review":
      return complexity >= 9
        ? { maxFiles: 5, maxCharsPerFile: 1_200 }
        : { maxFiles: 4, maxCharsPerFile: 1_100 };
    case "planning":
    case "pm_intake":
    case "pm_reprioritization":
      if (complexity <= 4) {
        return { maxFiles: 3, maxCharsPerFile: 650 };
      }
      return complexity >= 9
        ? { maxFiles: 5, maxCharsPerFile: 1_000 }
        : { maxFiles: 4, maxCharsPerFile: 850 };
  }
}

function scorePreviewCandidate(
  file: string,
  touchedFiles: Set<string>,
  phase: RunnerPhaseContext["phase"],
): number {
  let score =
    Number(file === "README.md") * 10 +
    Number(file === "package.json") * 9 +
    Number(file.startsWith("src/")) * 5 +
    Number(file.startsWith("test/")) * 4 +
    Number(file.startsWith("docs/")) * 3;

  if (touchedFiles.has(file)) {
    score += 20;
  }

  if (phase === "review") {
    score += Number(file.startsWith("test/")) * 6;
    score += Number(file.startsWith("src/")) * 4;
  }

  if (phase === "pm_reprioritization") {
    score += Number(file.startsWith("test/")) * 5;
  }

  return score;
}

function previewCandidatesForContext(
  context: RunnerPhaseContext,
  repoTree: string[],
): string[] {
  const touchedFiles = new Set(
    [
      ...(context.previousPhaseOutputs.execution?.filesTouched ?? []),
      ...(context.previousPhaseOutputs.review?.filesTouched ?? []),
      ...(context.previousPhaseOutputs.pm_reprioritization?.filesTouched ?? []),
    ].filter((file): file is string => typeof file === "string" && file.length > 0),
  );
  const { maxFiles } = previewBudgetForPhase(context);

  return repoTree
    .filter((item) => !item.endsWith("/"))
    .sort((left, right) => {
      const leftScore = scorePreviewCandidate(left, touchedFiles, context.phase);
      const rightScore = scorePreviewCandidate(right, touchedFiles, context.phase);
      return rightScore - leftScore;
    })
    .slice(0, maxFiles);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function dedupeStrings(values: Array<string | undefined>, limit = 6): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!isNonEmptyString(value)) {
      continue;
    }
    const normalized = value.trim();
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
    if (output.length >= limit) {
      break;
    }
  }
  return output;
}

function benchmarkText(context: RunnerPhaseContext): string {
  return [
    context.benchmark.title,
    context.benchmark.summary,
    context.benchmark.artifactTarget,
    context.benchmark.publicBrief,
  ]
    .join(" ")
    .toLowerCase();
}

function isElectronBenchmark(context: RunnerPhaseContext): boolean {
  return benchmarkText(context).includes("electron");
}

function isSimulationBenchmark(context: RunnerPhaseContext): boolean {
  const text = benchmarkText(context);
  return text.includes("simulation") || text.includes("game");
}

function isServiceBenchmark(context: RunnerPhaseContext): boolean {
  const text = benchmarkText(context);
  return text.includes("api") || text.includes("service") || text.includes("saas");
}

function chooseBacklogItems(context: RunnerPhaseContext, limit = 6): PriorityItem[] {
  const source = context.visibleBacklog.length > 0
    ? context.visibleBacklog
    : context.previousPhaseOutputs.pm_reprioritization?.backlog
      ?? context.previousPhaseOutputs.pm_intake?.backlog
      ?? [];
  return source
    .slice()
    .sort((left, right) => right.severity - left.severity)
    .slice(0, limit);
}

function leafSizeForBacklogItem(item: PriorityItem, index: number): WorkItem["size"] {
  if (index === 0) {
    return item.severity >= 4 ? "small" : "medium";
  }
  return item.severity >= 5 ? "small" : "medium";
}

function synthesizeWorkBreakdown(
  context: RunnerPhaseContext,
  options?: { repoIsBootstrap?: boolean },
): WorkItem[] {
  const inherited =
    context.previousPhaseOutputs.pm_reprioritization?.workBreakdown
    ?? context.previousPhaseOutputs.planning?.workBreakdown
    ?? context.previousPhaseOutputs.pm_intake?.workBreakdown
    ?? [];
  if (inherited.length > 0) {
    return inherited;
  }

  const repoIsBootstrap = options?.repoIsBootstrap === true;
  const backlog = chooseBacklogItems(context, 5);
  const leaves = backlog.map((item, index) => ({
    id: `fallback-${context.phase}-${item.id}`,
    title: item.title,
    size: leafSizeForBacklogItem(item, index),
    rationale: item.rationale,
    acceptanceHint: item.title,
  })) satisfies WorkItem[];

  if (leaves.length === 0) {
    return [];
  }

  const core = leaves.slice(0, 3);
  const followUp = leaves.slice(3);
  const output: WorkItem[] = [
    {
      id: `fallback-${context.phase}-core`,
      title: repoIsBootstrap ? "Bootstrap the runnable foundation" : "Clear the highest-priority product gaps",
      size: core.length > 1 ? "large" : core[0]?.size ?? "medium",
      rationale: repoIsBootstrap
        ? "The next pass needs a bootable scaffold before the project can absorb deeper work."
        : "The next pass should stay focused on the highest-impact executable leaves.",
      children: core,
    },
  ];

  if (followUp.length > 0) {
    output.push({
      id: `fallback-${context.phase}-followup`,
      title: "Queue the next hardening pass",
      size: "medium",
      rationale: "Keep follow-up work visible without pretending it all fits in the same pass.",
      children: followUp,
    });
  }

  return output;
}

function synthesizeArchitectureDirectives(
  context: RunnerPhaseContext,
  options?: { repoIsBootstrap?: boolean },
): string[] {
  if (context.architectureDirectives.length > 0) {
    return dedupeStrings(context.architectureDirectives, 5);
  }

  const repoIsBootstrap = options?.repoIsBootstrap === true;
  const directives = [
    repoIsBootstrap
      ? "Ship a runnable vertical slice before broadening scope."
      : "Preserve the current working surface before widening scope.",
    "Keep domain logic separate from UI and integration glue.",
    "Favor small, testable modules with clear entry points and smoke coverage.",
  ];

  if (isElectronBenchmark(context)) {
    directives.push(
      repoIsBootstrap
        ? "For Electron foundations, keep shallow root entrypoints like `src/main.ts` and `src/preload.ts`, and keep renderer assets under `src/renderer/`."
        : "Keep Electron main, preload, and renderer responsibilities explicitly separated.",
    );
  }
  if (isSimulationBenchmark(context)) {
    directives.push("Keep simulation state and economic rules in plain modules that can be exercised outside the UI.");
  }
  if (isServiceBenchmark(context)) {
    directives.push("Guard automatic startup so tests and smoke checks can import the app without port conflicts.");
  }

  return dedupeStrings(directives, 5);
}

function synthesizeTestStrategy(
  context: RunnerPhaseContext,
  options?: { repoIsBootstrap?: boolean },
): string[] {
  const repoIsBootstrap = options?.repoIsBootstrap === true;
  return dedupeStrings(
    [
      repoIsBootstrap
        ? "Create the runnable scaffold first, then prove it with the fastest smoke path available."
        : "Validate the highest-priority path before polishing secondary features.",
      "Run the fastest available smoke/build/test command before handing off the phase.",
      isElectronBenchmark(context)
        ? "Keep core simulation and progression logic importable outside Electron for fast tests."
        : undefined,
      isServiceBenchmark(context)
        ? "Export the app or server and guard startup so tests avoid port conflicts."
        : undefined,
    ],
    4,
  );
}

function judgeIssues(context: RunnerPhaseContext): string[] {
  return dedupeStrings(
    (context.previousJudge?.failedChecks ?? []).map(
      (entry) => `${entry.check.title}: ${entry.message}`,
    ),
    5,
  );
}

function traceIssues(traces: PhaseTraceStep[]): string[] {
  return dedupeStrings(
    traces
      .map((trace) => trace.observationSummary)
      .filter((summary) =>
        summary.includes("Tool error")
        || summary.includes("not allowed")
        || summary.includes("invalid")
        || summary.includes("Forced finish"),
      ),
    5,
  );
}

function commandsFromTraces(traces: PhaseTraceStep[]): string[] {
  return dedupeStrings(
    traces.flatMap((trace) => {
      if (trace.actionType !== "run_command") {
        return [];
      }
      const command = trace.action.command;
      return typeof command === "string" ? [command] : [];
    }),
    6,
  );
}

function buildBranchDecisionFallback(
  context: RunnerPhaseContext,
  options?: { repoIsBootstrap?: boolean },
): StructuredPhaseOutput["branchDecision"] {
  const existing = context.previousPhaseOutputs.planning?.branchDecision;
  if (existing) {
    return existing;
  }
  const repoIsBootstrap = options?.repoIsBootstrap === true;
  return {
    shouldBranch: false,
    ...(context.benchmark.branchTemplates[0]
      ? { templateId: context.benchmark.branchTemplates[0].id }
      : {}),
    rationale: repoIsBootstrap
      ? "Keep a single mainline until the bootstrap scaffold is stable enough to compare branches."
      : "Use the mainline path unless a branch is clearly worth the budget.",
  };
}

function buildContextualFallbackPhaseOutput(
  context: RunnerPhaseContext,
  summary: string,
  repoTree: string[],
  touchedFiles: Iterable<string>,
  traces: PhaseTraceStep[],
): StructuredPhaseOutput {
  const repoIsBootstrap = isBootstrapRepo(repoTree);
  const backlog = chooseBacklogItems(context, 6);
  const workBreakdown = synthesizeWorkBreakdown(context, { repoIsBootstrap });
  const initiatives = dedupeStrings(
    [
      ...workBreakdown
        .filter((item) => item.size === "large" || item.size === "oversized" || Boolean(item.children?.length))
        .map((item) => item.title),
      ...backlog
        .filter((item) => item.severity >= 4)
        .map((item) => item.title),
    ],
    4,
  ).map((title, index) => ({
    id: `fallback-initiative-${context.phase}-${index + 1}`,
    title,
    rationale: "Recovered initiative synthesized from the current backlog and program map.",
    source: "fallback",
    severity: 4,
  }));
  const architectureDirectives = synthesizeArchitectureDirectives(context, { repoIsBootstrap });
  const issues = dedupeStrings(
    [...judgeIssues(context), ...traceIssues(traces)],
    6,
  );
  const recommendations = dedupeStrings(
    [
      repoIsBootstrap && isCoordinationPhase(context.phase)
        ? "Turn the brief into a concrete scaffold plan instead of spending more read-only actions inspecting emptiness."
        : undefined,
      repoIsBootstrap && context.phase === "execution"
        ? "Bootstrap the package, entrypoints, and first smoke path before deeper feature work."
        : undefined,
      context.previousJudge?.recommendations[0],
      context.previousJudge?.recommendations[1],
      backlog[0]?.title ? `Start with: ${backlog[0].title}` : undefined,
    ],
    5,
  );

  switch (context.phase) {
    case "pm_intake":
      return {
        summary,
        confidence: 0.48,
        backlog,
        workBreakdown,
        ...(initiatives.length > 0 ? { initiatives } : {}),
        acceptanceChecklist: context.benchmark.acceptanceCriteria.slice(0, 8),
        architectureDirectives,
        risks: issues,
        recommendations,
      };
    case "planning":
      {
        const branchDecision = buildBranchDecisionFallback(context, { repoIsBootstrap });
        return {
        summary,
        confidence: 0.46,
        workBreakdown,
        ...(initiatives.length > 0 ? { initiatives } : {}),
        ...(branchDecision ? { branchDecision } : {}),
        architectureDirectives,
        testStrategy: synthesizeTestStrategy(context, { repoIsBootstrap }),
        risks: issues,
        recommendations,
        };
      }
    case "execution":
      return {
        summary,
        confidence: 0.42,
        commandsRun: commandsFromTraces(traces),
        filesTouched: [...touchedFiles],
        ...(initiatives.length > 0 ? { initiatives } : {}),
        unresolvedIssues: issues,
        recommendations,
      };
    case "review":
      return {
        summary,
        confidence: 0.44,
        ...(initiatives.length > 0 ? { initiatives } : {}),
        unresolvedIssues: issues,
        recommendations,
        risks: issues,
      };
    case "pm_reprioritization":
      return {
        summary,
        confidence: 0.45,
        backlog,
        workBreakdown,
        ...(initiatives.length > 0 ? { initiatives } : {}),
        architectureDirectives,
        recommendations,
        risks: issues,
        notes: ["Recovered under phase limit pressure and preserved the best available next backlog."],
      };
  }
}

function mergePhaseOutputWithFallback(
  fallback: StructuredPhaseOutput,
  raw: unknown,
): StructuredPhaseOutput {
  if (!raw || typeof raw !== "object") {
    return fallback;
  }

  const record = raw as Record<string, unknown>;
  const output: StructuredPhaseOutput = {
    ...fallback,
    summary: isNonEmptyString(record.summary) ? record.summary : fallback.summary,
  };

  if (typeof record.confidence === "number") {
    output.confidence = record.confidence;
  }
  if (Array.isArray(record.backlog) && record.backlog.length > 0) {
    output.backlog = record.backlog as PriorityItem[];
  }
  if (Array.isArray(record.workBreakdown) && record.workBreakdown.length > 0) {
    output.workBreakdown = record.workBreakdown as WorkItem[];
  }
  if (Array.isArray(record.initiatives) && record.initiatives.length > 0) {
    output.initiatives = record.initiatives as NonNullable<StructuredPhaseOutput["initiatives"]>;
  }
  if (Array.isArray(record.acceptanceChecklist) && record.acceptanceChecklist.length > 0) {
    output.acceptanceChecklist = record.acceptanceChecklist as string[];
  }
  if (Array.isArray(record.architectureDirectives) && record.architectureDirectives.length > 0) {
    output.architectureDirectives = record.architectureDirectives as string[];
  }
  if (Array.isArray(record.risks) && record.risks.length > 0) {
    output.risks = record.risks as string[];
  }
  if (record.branchDecision && typeof record.branchDecision === "object") {
    output.branchDecision = record.branchDecision as NonNullable<StructuredPhaseOutput["branchDecision"]>;
  }
  if (Array.isArray(record.testStrategy) && record.testStrategy.length > 0) {
    output.testStrategy = record.testStrategy as string[];
  }
  if (Array.isArray(record.unresolvedIssues) && record.unresolvedIssues.length > 0) {
    output.unresolvedIssues = record.unresolvedIssues as string[];
  }
  if (Array.isArray(record.recommendations) && record.recommendations.length > 0) {
    output.recommendations = record.recommendations as string[];
  }
  if (Array.isArray(record.commandsRun) && record.commandsRun.length > 0) {
    output.commandsRun = record.commandsRun as string[];
  }
  if (Array.isArray(record.filesTouched) && record.filesTouched.length > 0) {
    output.filesTouched = record.filesTouched as string[];
  }
  if (Array.isArray(record.notes) && record.notes.length > 0) {
    output.notes = record.notes as string[];
  }

  return output;
}

function limitNotice(
  step: number,
  stepLimit: number,
  startedAt: number,
  phaseBudgetMs: number,
): string | undefined {
  const remainingSteps = stepLimit - step;
  const remainingMs = phaseBudgetMs - (Date.now() - startedAt);
  if (remainingSteps > 2 && remainingMs > 35_000) {
    return undefined;
  }
  return `Harness note: ${Math.max(0, remainingSteps)} tool actions remain and about ${Math.max(
    0,
    Math.ceil(remainingMs / 1_000),
  )}s are left in this phase. If you already have enough context, return a finish action now with the best structured handoff you can produce.`;
}

function visibleRepoFiles(repoTree: string[]): string[] {
  return repoTree.filter((entry) => !entry.endsWith("/"));
}

function hasMaterialRepoProgress(
  initialRepoTree: string[],
  currentRepoTree: string[],
  touchedFiles: Set<string>,
  traces: PhaseTraceStep[],
): boolean {
  const before = new Set(visibleRepoFiles(initialRepoTree));
  const after = visibleRepoFiles(currentRepoTree);
  return (
    touchedFiles.size > 0
    || commandsFromTraces(traces).length > 0
    || after.some((file) => !before.has(file))
  );
}

function applyActualPhaseArtifacts(
  phase: RunnerPhaseContext["phase"],
  output: StructuredPhaseOutput,
  touchedFiles: Set<string>,
  traces: PhaseTraceStep[],
): StructuredPhaseOutput {
  if (phase !== "execution" && phase !== "review") {
    return output;
  }

  const actualCommands = commandsFromTraces(traces);
  const actualFiles = [...touchedFiles];
  if (actualCommands.length > 0) {
    output.commandsRun = actualCommands;
  } else {
    delete output.commandsRun;
  }
  if (actualFiles.length > 0) {
    output.filesTouched = actualFiles;
  } else {
    delete output.filesTouched;
  }
  return output;
}

async function applyAction(
  context: RunnerPhaseContext,
  action: AgentAction,
): Promise<{ summary: string; observation: Record<string, unknown>; touchedFile?: string }> {
  const repoDir = context.repoDir;
  switch (action.type) {
    case "list_files": {
      const root = action.path ? safeResolveWithin(repoDir, action.path) : repoDir;
      const files = await listFiles(root, { maxDepth: Math.min(action.depth ?? 3, 6), includeHidden: false });
      return {
        summary: `Listed ${files.length} files under ${action.path ?? "."}`,
        observation: {
          path: action.path ?? ".",
          files,
        },
      };
    }
    case "read_file": {
      const target = safeResolveWithin(repoDir, action.path);
      if (!(await pathExists(target))) {
        return {
          summary: `${action.path} is missing`,
          observation: {
            path: action.path,
            missing: true,
          },
        };
      }
      const raw = await readText(target);
      return {
        summary: `Read ${action.path}`,
        observation: {
          path: action.path,
          content: truncate(raw, 8_000),
        },
      };
    }
    case "write_file": {
      const target = safeResolveWithin(repoDir, action.path);
      await writeText(target, action.content);
      return {
        summary: `Wrote ${action.path}`,
        observation: {
          path: action.path,
          bytes: action.content.length,
        },
        touchedFile: action.path,
      };
    }
    case "replace_in_file": {
      const target = safeResolveWithin(repoDir, action.path);
      const raw = await readText(target);
      const updated = action.all
        ? raw.split(action.find).join(action.replace)
        : raw.replace(action.find, action.replace);
      await writeText(target, updated);
      return {
        summary: `Updated ${action.path}`,
        observation: {
          path: action.path,
          replaced: raw !== updated,
        },
        touchedFile: action.path,
      };
    }
    case "run_command": {
      const result = await runShellCommand(
        action.command,
        repoDir,
        (action.timeoutSeconds ?? 45) * 1_000,
      );
      return {
        summary: `Ran command '${action.command}' with exit code ${result.exitCode}`,
        observation: {
          command: action.command,
          exitCode: result.exitCode,
          stdout: truncate(result.stdout, 6_000),
          stderr: truncate(result.stderr, 4_000),
        },
      };
    }
    case "run_app_smoke": {
      const screenshotPath = path.join(
        context.runDir,
        "artifacts",
        "smoke",
        `cycle-${context.cycleNumber}-${context.phase}-${Date.now()}.png`,
      );
      const result = await runBrowserSmoke({
        repoDir,
        url: action.url,
        timeoutMs: (action.timeoutSeconds ?? 45) * 1_000,
        screenshotPath,
        ...(action.startCommand ? { startCommand: action.startCommand } : {}),
        ...(action.waitForText ? { waitForText: action.waitForText } : {}),
        ...(action.waitForSelector ? { waitForSelector: action.waitForSelector } : {}),
      });
      return {
        summary: result.summary,
        observation: {
          url: action.url,
          passed: result.passed,
          details: truncate(result.details, 6_000),
          ...(result.title ? { title: result.title } : {}),
          ...(result.screenshotPath ? { screenshotPath: result.screenshotPath } : {}),
        },
      };
    }
    case "finish":
      return {
        summary: "Finished phase execution",
        observation: action.result ?? {},
      };
  }
}

export class OpenRouterRunner implements RunnerAdapter {
  constructor(private readonly worker: WorkerConfig) {}

  async runPhase(context: RunnerPhaseContext): Promise<RunnerPhaseResult> {
    const startedAt = Date.now();
    const repoTree = (await listFiles(context.repoDir, { maxDepth: 4, includeHidden: false })).slice(0, 120);
    const repoIsBootstrap = isBootstrapRepo(repoTree);
    const previewCandidates = previewCandidatesForContext(context, repoTree);
    const previews = await readFilesPreview(
      context.repoDir,
      previewCandidates,
      previewBudgetForPhase(context).maxCharsPerFile,
    );
    const prompt = buildPhasePromptWithPreviews(context, repoTree, previews);
    const messages: OpenRouterMessage[] = [
      {
        role: "system",
        content: buildOpenRouterSystemPrompt(),
      },
      {
        role: "user",
        content: prompt,
      },
    ];
    const traces: PhaseTraceStep[] = [];
    const touchedFiles = new Set<string>();
    let aggregatedUsage: UsageTotals | undefined;
    let latestModel: string | undefined;
    const modelCalls: Array<Record<string, unknown>> = [];
    const allowedActions = allowedActionsForPhase(context.phase);
    const phaseStepLimit = stepLimitForPhase(context, { repoIsBootstrap });
    const phaseBudgetMs = phaseTimeBudgetMs(context, { repoIsBootstrap });
    const phaseRequestTimeoutMs = requestTimeoutMsForPhase(context, this.worker, { repoIsBootstrap });
    const phaseMaxTokens = maxTokensForPhase(context, this.worker, { repoIsBootstrap });
    let recoverableErrorCount = 0;
    let bootstrapInspectionCount = 0;
    const phasePrimaryModel = primaryModelForPhase(this.worker, context.phase);
    if (!phasePrimaryModel) {
      throw new Error(
        `Worker '${context.workerId}' is missing a primary model for phase '${context.phase}'.`,
      );
    }
    const phaseFallbackModel = fallbackModelForPhase(this.worker, context.phase);

    const buildMetadata = (extra?: Record<string, unknown>): Record<string, unknown> => ({
      prompt,
      model: latestModel,
      primaryModel: phasePrimaryModel,
      fallbackModel: phaseFallbackModel,
      modelCalls,
      usage: aggregatedUsage,
      filesTouched: [...touchedFiles],
      ...(extra ?? {}),
    });

    const buildFallbackOutput = async (summary: string): Promise<StructuredPhaseOutput> => {
      const currentRepoTree = (
        await listFiles(context.repoDir, { maxDepth: 4, includeHidden: false })
      ).slice(0, 120);
      return buildContextualFallbackPhaseOutput(
        context,
        summary,
        currentRepoTree,
        touchedFiles,
        traces,
      );
    };

    const reportProgress = async (
      summary: string,
      options?: {
        step?: number;
        recentActions?: PhaseTraceStep[];
      },
    ): Promise<void> => {
      if (!context.onProgress) {
        return;
      }
      try {
        const usage = toTokenUsageSummary(aggregatedUsage);
        await context.onProgress({
          cycleNumber: context.cycleNumber,
          phase: context.phase,
          summary,
          ...(options?.step !== undefined ? { step: options.step } : {}),
          stepLimit: phaseStepLimit,
          ...(latestModel ? { model: latestModel } : {}),
          primaryModel: phasePrimaryModel,
          ...(phaseFallbackModel ? { fallbackModel: phaseFallbackModel } : {}),
          ...(usage ? { usage } : {}),
          filesTouched: [...touchedFiles],
          commandsRun: commandsFromTraces(traces),
          issues: traceIssues(traces),
          recentActions: options?.recentActions ?? traces.slice(-6),
        });
      } catch {
        // Live watcher updates should never break the run itself.
      }
    };

    const pushTrace = async (
      step: number,
      actionType: string,
      action: Record<string, unknown>,
      observationSummary: string,
    ): Promise<void> => {
      const trace: PhaseTraceStep = {
        step,
        actionType,
        action,
        observationSummary,
      };
      traces.push(trace);
      await reportProgress(observationSummary, {
        step,
        recentActions: traces.slice(-6),
      });
    };

    const forceStructuredFinish = async (
      reasonTag: string,
      summary: string,
    ): Promise<RunnerPhaseResult> => {
      await pushTrace(
        Math.max(1, Math.min(phaseStepLimit, traces.length + 1)),
        "recovery",
        {
          reasonTag,
          phase: context.phase,
        },
        `Forced finish requested: ${summary}`,
      );

      const fallback = await buildFallbackOutput(summary);
      const finishMessages: OpenRouterMessage[] = [
        ...messages,
        {
          role: "user",
          content: `No more tool actions are available for the ${context.phase} phase. Return exactly one JSON action object with type "finish" now. Do not request or imply any further tools. Use the brief, repo snapshot, previous handoffs, and tool results already in the conversation to synthesize the best possible structured result. If some details remain uncertain, make a reasonable best effort instead of leaving key fields empty.`,
        },
      ];

      for (let attempt = 1; attempt <= 2; attempt += 1) {
        let completion;
        try {
          completion = await requestCompletion(phaseStepLimit + attempt, finishMessages, {
            maxTokens: maxTokensForPhase(context, this.worker, {
              repoIsBootstrap,
              forcedFinish: true,
            }),
            timeoutMs: requestTimeoutMsForPhase(context, this.worker, {
              repoIsBootstrap,
              forcedFinish: true,
            }),
            forcedFinish: true,
          });
        } catch (error) {
          await pushTrace(
            phaseStepLimit + attempt,
            "recovery",
            {
              reasonTag,
              attempt,
            },
            `Forced finish call failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          break;
        }

        aggregatedUsage = addUsage(aggregatedUsage, completion.usage);
        latestModel = completion.model ?? completion.requestedModel ?? latestModel;

        let parsedAction: ParsedAgentAction;
        try {
          parsedAction = normalizeAgentAction(completion.text);
        } catch (error) {
          await pushTrace(
            phaseStepLimit + attempt,
            "invalid_json",
            {
              raw: truncate(completion.text, 800),
            },
            `Forced-finish recovery received invalid JSON: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          finishMessages.push({ role: "assistant", content: completion.text });
          finishMessages.push({
            role: "user",
            content: `You must return exactly one JSON finish action now. Your previous response was not valid JSON. Error: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
          continue;
        }

        const action = parsedAction.action;
        if (parsedAction.note) {
          await pushTrace(
            phaseStepLimit + attempt,
            "normalization",
            {
              normalizedTo: action.type,
            },
            parsedAction.note,
          );
        }

        if (action.type !== "finish") {
          await pushTrace(
            phaseStepLimit + attempt,
            action.type,
            action as unknown as Record<string, unknown>,
            `Forced-finish recovery rejected non-finish action '${action.type}'.`,
          );
          finishMessages.push({ role: "assistant", content: completion.text });
          finishMessages.push({
            role: "user",
            content: "No more tool actions are available. Return a single finish action now.",
          });
          continue;
        }

        const output = applyActualPhaseArtifacts(
          context.phase,
          mergePhaseOutputWithFallback(fallback, action.result),
          touchedFiles,
          traces,
        );
        return {
          summary: output.summary ?? action.reasoning ?? summary,
          output,
          rawOutput: completion.text,
          traces,
          metadata: buildMetadata({
            recoveryMode: reasonTag,
            forcedFinish: true,
          }),
        };
      }

      return {
        summary: fallback.summary,
        output: applyActualPhaseArtifacts(
          context.phase,
          mergePhaseOutputWithFallback(
            fallback,
            createFallbackPhaseOutput(context.phase, summary),
          ),
          touchedFiles,
          traces,
        ),
        traces,
        metadata: buildMetadata({
          recoveryMode: reasonTag,
          forcedFinish: true,
          forcedFinishFallback: true,
        }),
      };
    };

    const requestCompletion = async (
      step: number,
      requestMessages: OpenRouterMessage[],
      options: {
        maxTokens: number;
        timeoutMs: number;
        forcedFinish?: boolean;
      },
    ) => {
      try {
        const completion = await callOpenRouter(this.worker, requestMessages, {
          maxTokens: options.maxTokens,
          timeoutMs: options.timeoutMs,
          model: phasePrimaryModel,
        });
        modelCalls.push({
          requestedModel: phasePrimaryModel,
          responseModel: completion.model ?? completion.requestedModel,
          forcedFinish: options.forcedFinish === true,
        });
        return completion;
      } catch (primaryError) {
        modelCalls.push({
          requestedModel: phasePrimaryModel,
          error: primaryError instanceof Error ? primaryError.message : String(primaryError),
          forcedFinish: options.forcedFinish === true,
        });
        if (!phaseFallbackModel) {
          throw primaryError;
        }
        await pushTrace(
          Math.max(1, step),
          "recovery",
          {
            phase: context.phase,
            primaryModel: phasePrimaryModel,
            fallbackModel: phaseFallbackModel,
            forcedFinish: options.forcedFinish === true,
          },
          `Primary model ${phasePrimaryModel} failed. Retrying with ${phaseFallbackModel}.`,
        );
        try {
          const completion = await callOpenRouter(this.worker, requestMessages, {
            maxTokens: options.maxTokens,
            timeoutMs: options.timeoutMs,
            model: phaseFallbackModel,
          });
          modelCalls.push({
            requestedModel: phaseFallbackModel,
            responseModel: completion.model ?? completion.requestedModel,
            forcedFinish: options.forcedFinish === true,
            fallbackFrom: phasePrimaryModel,
          });
          return completion;
        } catch (fallbackError) {
          modelCalls.push({
            requestedModel: phaseFallbackModel,
            error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
            forcedFinish: options.forcedFinish === true,
            fallbackFrom: phasePrimaryModel,
          });
          throw new Error(
            `Primary model ${phasePrimaryModel} failed: ${
              primaryError instanceof Error ? primaryError.message : String(primaryError)
            }. Fallback model ${phaseFallbackModel} failed: ${
              fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
            }`,
          );
        }
      }
    };

    for (let step = 1; step <= phaseStepLimit; step += 1) {
      await reportProgress(`Awaiting model action for ${context.phase} (step ${step}/${phaseStepLimit})`, {
        step,
      });

      if (Date.now() - startedAt > phaseBudgetMs) {
        return forceStructuredFinish(
          "time_budget",
          `Recovered ${context.phase} after hitting the phase time budget.`,
        );
      }

      let completion;
      try {
        completion = await requestCompletion(step, messages, {
          maxTokens: phaseMaxTokens,
          timeoutMs: phaseRequestTimeoutMs,
        });
      } catch (error) {
        return forceStructuredFinish(
          "completion_error",
          `Recovered ${context.phase} after an OpenRouter call failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      aggregatedUsage = addUsage(aggregatedUsage, completion.usage);
      latestModel = completion.model ?? completion.requestedModel ?? latestModel;

      let parsedAction: ParsedAgentAction;
      try {
        parsedAction = normalizeAgentAction(completion.text);
      } catch (error) {
        await pushTrace(
          step,
          "invalid_json",
          {
            raw: truncate(completion.text, 800),
          },
          `Invalid model JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
        messages.push({ role: "assistant", content: completion.text });
        messages.push({
          role: "user",
          content: `Your previous response was not valid JSON. Return exactly one JSON action object. Error: ${
            error instanceof Error ? error.message : String(error)
          }${limitNotice(step, phaseStepLimit, startedAt, phaseBudgetMs)
            ? `\n\n${limitNotice(step, phaseStepLimit, startedAt, phaseBudgetMs)}`
            : ""}`,
        });
        recoverableErrorCount += 1;
        if (recoverableErrorCount >= recoverableErrorLimit(context)) {
          return forceStructuredFinish(
            "recoverable_error_limit",
            `Recovered ${context.phase} after repeated invalid model actions.`,
          );
        }
        continue;
      }

      const action = parsedAction.action;
      if (parsedAction.note) {
        await pushTrace(
          step,
          "normalization",
          {
            normalizedTo: action.type,
          },
          parsedAction.note,
        );
      }

      if (!allowedActions.has(action.type)) {
        await pushTrace(
          step,
          action.type,
          {
            ...(action as unknown as Record<string, unknown>),
            raw: truncate(completion.text, 800),
          },
          `Action ${action.type} is not allowed during ${context.phase}`,
        );
        messages.push({ role: "assistant", content: completion.text });
        messages.push({
          role: "user",
          content: `Action '${action.type}' is not allowed during the ${context.phase} phase. Use only these actions: ${[
            ...allowedActions,
          ].join(", ")}.${limitNotice(step, phaseStepLimit, startedAt, phaseBudgetMs)
            ? `\n\n${limitNotice(step, phaseStepLimit, startedAt, phaseBudgetMs)}`
            : ""}`,
        });
        recoverableErrorCount += 1;
        if (recoverableErrorCount >= recoverableErrorLimit(context)) {
          return forceStructuredFinish(
            "recoverable_error_limit",
            `Recovered ${context.phase} after repeated invalid model actions.`,
          );
        }
        continue;
      }

      const validationError = validateAgentAction(action);
      if (validationError) {
        await pushTrace(
          step,
          action.type,
          {
            ...(action as unknown as Record<string, unknown>),
            raw: truncate(completion.text, 800),
          },
          `Invalid action: ${validationError}`,
        );
        messages.push({ role: "assistant", content: completion.text });
        messages.push({
          role: "user",
          content: `Your previous action was invalid: ${validationError}. Return a corrected JSON action.${limitNotice(
            step,
            phaseStepLimit,
            startedAt,
            phaseBudgetMs,
          )
            ? `\n\n${limitNotice(step, phaseStepLimit, startedAt, phaseBudgetMs)}`
            : ""}`,
        });
        recoverableErrorCount += 1;
        if (recoverableErrorCount >= recoverableErrorLimit(context)) {
          return forceStructuredFinish(
            "recoverable_error_limit",
            `Recovered ${context.phase} after repeated invalid model actions.`,
          );
        }
        continue;
      }

      if (action.type === "finish") {
        const currentRepoTree = (
          await listFiles(context.repoDir, { maxDepth: 4, includeHidden: false })
        ).slice(0, 120);
        if (
          context.phase === "execution"
          && !hasMaterialRepoProgress(repoTree, currentRepoTree, touchedFiles, traces)
        ) {
          messages.push({ role: "assistant", content: completion.text });
          messages.push({
            role: "user",
            content: `You cannot finish the execution phase yet because no actual repo progress has been observed. Use write_file, replace_in_file, or run_command to create the scaffold before finishing.${limitNotice(
              step,
              phaseStepLimit,
              startedAt,
              phaseBudgetMs,
            )
              ? `\n\n${limitNotice(step, phaseStepLimit, startedAt, phaseBudgetMs)}`
              : ""}`,
          });
          recoverableErrorCount += 1;
          if (recoverableErrorCount >= recoverableErrorLimit(context)) {
            return forceStructuredFinish(
              "execution_noop",
              `Recovered ${context.phase} after repeated finish attempts without actual repo changes.`,
            );
          }
          continue;
        }

        const fallback = buildContextualFallbackPhaseOutput(
          context,
          action.reasoning ?? `Completed ${context.phase}`,
          currentRepoTree,
          touchedFiles,
          traces,
        );
        const result = applyActualPhaseArtifacts(
          context.phase,
          mergePhaseOutputWithFallback(
            fallback,
            action.result,
          ),
          touchedFiles,
          traces,
        );
        return {
          summary: result.summary ?? action.reasoning ?? `Completed ${context.phase}`,
          output: result,
          rawOutput: completion.text,
          traces,
          metadata: buildMetadata(),
        };
      }

      let applied;
      try {
        applied = await applyAction(context, action);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await pushTrace(
          step,
          action.type,
          action as unknown as Record<string, unknown>,
          `Tool error: ${message}`,
        );
        messages.push({ role: "assistant", content: completion.text });
        messages.push({
          role: "user",
          content: `Tool error for action '${action.type}': ${message}. Recover and try again with a corrected action.${limitNotice(
            step,
            phaseStepLimit,
            startedAt,
            phaseBudgetMs,
          )
            ? `\n\n${limitNotice(step, phaseStepLimit, startedAt, phaseBudgetMs)}`
            : ""}`,
        });
        recoverableErrorCount += 1;
        if (recoverableErrorCount >= recoverableErrorLimit(context)) {
          return forceStructuredFinish(
            "recoverable_error_limit",
            `Recovered ${context.phase} after repeated tool-level failures.`,
          );
        }
        continue;
      }

      recoverableErrorCount = 0;
      if (applied.touchedFile) {
        touchedFiles.add(applied.touchedFile);
      }
      await pushTrace(
        step,
        action.type,
        action as unknown as Record<string, unknown>,
        applied.summary,
      );
      messages.push({ role: "assistant", content: completion.text });
      messages.push({
        role: "user",
        content: `Tool result:\n${JSON.stringify(applied.observation, null, 2)}${
          limitNotice(step, phaseStepLimit, startedAt, phaseBudgetMs)
            ? `\n\n${limitNotice(step, phaseStepLimit, startedAt, phaseBudgetMs)}`
            : ""
        }`,
      });

      if (
        repoIsBootstrap &&
        isCoordinationPhase(context.phase) &&
        (action.type === "list_files" || action.type === "read_file")
      ) {
        bootstrapInspectionCount += 1;
        if (bootstrapInspectionCount >= bootstrapInspectionLimit(context)) {
          return forceStructuredFinish(
            "bootstrap_repo_confirmed",
            `Recovered ${context.phase} after confirming the bootstrap repo state and preserving a structured handoff.`,
          );
        }
      }
    }

    return forceStructuredFinish(
      "step_limit",
      `Recovered ${context.phase} after hitting the phase step limit.`,
    );
  }
}
