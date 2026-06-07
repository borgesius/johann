#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createChainState,
  persistChainState,
  persistChainStateSync,
  resolveLatestChainPath,
  summarizeChainResults,
} from "./chain.js";
import { loadConfig } from "./config.js";
import {
  createCustomBriefBenchmark,
  listBenchmarks,
  loadBenchmarkSpec,
} from "./benchmark.js";
import { judgeRepo } from "./judge.js";
import { runLoopExperiment } from "./loop.js";
import { collectRunResults } from "./report.js";
import type {
  CellResult,
  ChainState,
  LoadedConfig,
  LoopState,
  PolicyId,
  PriorityItem,
} from "./types.js";
import { pathExists, readJson, slugify, writeJson } from "./utils.js";

type ParsedArgs = {
  command?: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
};

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token) {
      continue;
    }
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = rest[index + 1];
      if (!next || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        index += 1;
      }
    } else {
      positionals.push(token);
    }
  }

  const parsed: ParsedArgs = { positionals, flags };
  if (command !== undefined) {
    parsed.command = command;
  }
  return parsed;
}

function getStringFlag(parsed: ParsedArgs, key: string, fallback?: string): string | undefined {
  const value = parsed.flags[key];
  if (typeof value === "string") {
    return value;
  }
  return fallback;
}

function getNumberFlag(parsed: ParsedArgs, key: string, fallback: number): number {
  const value = getStringFlag(parsed, key);
  if (!value) {
    return fallback;
  }
  const parsedNumber = Number(value);
  if (Number.isNaN(parsedNumber)) {
    throw new Error(`Flag --${key} expects a number.`);
  }
  return parsedNumber;
}

function getOptionalNumberFlag(parsed: ParsedArgs, key: string): number | undefined {
  const value = getStringFlag(parsed, key);
  if (!value) {
    return undefined;
  }
  const parsedNumber = Number(value);
  if (Number.isNaN(parsedNumber)) {
    throw new Error(`Flag --${key} expects a number.`);
  }
  return parsedNumber;
}

function helpText(): string {
  return `Usage: bench <command> [options]

Commands:
  list
  run (--benchmark <id> | --brief-file <brief.md>) [--brief-id <id>] [--brief-kind <kind>] [--artifact-target <text>] [--worker <id>] [--policy <id>] [--budget <minutes>] [--seed <repo>] [--handoff-ledger <ledger.json>] [--success-threshold <score>] [--plateau-window <n>] [--plateau-threshold <score>] [--disable-plateau] [--continue-after-success]
  loop (--benchmark <id> | --brief-file <brief.md>) [--brief-id <id>] [--brief-kind <kind>] [--artifact-target <text>] [--worker <id>] [--policy <id>] [--budget <minutes>] [--max-cycles <n>] [--seed <repo>] [--handoff-ledger <ledger.json>] [--success-threshold <score>] [--plateau-window <n>] [--plateau-threshold <score>] [--disable-plateau] [--continue-after-success]
  matrix --benchmarks <a,b> --workers <x,y> --policies <p,q> [--budget <minutes>] [--max-cycles <n>] [--success-threshold <score>] [--plateau-window <n>] [--plateau-threshold <score>] [--disable-plateau] [--continue-after-success]
  judge (--benchmark <id> | --brief-file <brief.md>) [--brief-id <id>] [--brief-kind <kind>] [--artifact-target <text>] --repo <path>
  report
  chain --benchmarks <a,b,c> [--worker <id>] [--policy <id>] [--budget <minutes>] [--max-cycles <n>] [--chain-label <label>] [--success-threshold <score>] [--plateau-window <n>] [--plateau-threshold <score>] [--disable-plateau] [--continue-after-success]
  watch (--run <id> | --ledger <path> | --latest [--benchmark <id>] [--worker <id>] [--policy <id>] | --chain <id> | --chain-ledger <path> | --chain-latest [--label <label>]) [--interval <seconds>] [--once]
`;
}

function logJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function csvFlag(parsed: ParsedArgs, key: string, fallback: string[]): string[] {
  const value = getStringFlag(parsed, key);
  if (!value) {
    return fallback;
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function readStopRuleFlags(parsed: ParsedArgs) {
  const output: {
    successThreshold?: number;
    plateauWindow?: number;
    plateauThreshold?: number;
    disablePlateau?: boolean;
    continueAfterSuccess?: boolean;
  } = {};
  const successThreshold = getOptionalNumberFlag(parsed, "success-threshold");
  const plateauWindow = getOptionalNumberFlag(parsed, "plateau-window");
  const plateauThreshold = getOptionalNumberFlag(parsed, "plateau-threshold");

  if (successThreshold !== undefined) {
    output.successThreshold = successThreshold;
  }
  if (plateauWindow !== undefined) {
    output.plateauWindow = plateauWindow;
  }
  if (plateauThreshold !== undefined) {
    output.plateauThreshold = plateauThreshold;
  }
  if (parsed.flags["disable-plateau"]) {
    output.disablePlateau = true;
  }
  if (parsed.flags["continue-after-success"]) {
    output.continueAfterSuccess = true;
  }

  return output;
}

async function resolveBenchmarkInput(
  parsed: ParsedArgs,
  loaded: LoadedConfig,
  cwd: string,
): Promise<{ benchmarkId: string; fromBrief: boolean }> {
  const benchmarkId = getStringFlag(parsed, "benchmark");
  const briefFile = getStringFlag(parsed, "brief-file");

  if (benchmarkId && briefFile) {
    throw new Error("Use either --benchmark or --brief-file, not both.");
  }

  if (briefFile) {
    const briefId = getStringFlag(parsed, "brief-id");
    const briefKind = getStringFlag(parsed, "brief-kind");
    const artifactTarget = getStringFlag(parsed, "artifact-target");
    const benchmark = await createCustomBriefBenchmark(loaded, {
      briefPath: path.resolve(cwd, briefFile),
      ...(briefId ? { briefId } : {}),
      ...(briefKind ? { briefKind } : {}),
      ...(artifactTarget ? { artifactTarget } : {}),
    });
    return { benchmarkId: benchmark.id, fromBrief: true };
  }

  if (!benchmarkId) {
    throw new Error("Either --benchmark or --brief-file is required.");
  }

  return { benchmarkId, fromBrief: false };
}

function buildChainHandoffNotes(ledger: LoopState): string[] {
  const failedChecks = ledger.finalJudge?.failedChecks
    .slice(0, 4)
    .map((check) => `Carry over: ${check.check.title}`)
    ?? [];
  return dedupeStrings([
    `Continue from prior stage ${ledger.benchmarkId} (${ledger.runId}).`,
    ...(ledger.stopReason ? [`Previous stop reason: ${ledger.stopReason}`] : []),
    ...ledger.handoffNotes,
    ...failedChecks,
  ]).slice(0, 14);
}

function buildCarryoverPriorities(ledger: LoopState): PriorityItem[] {
  return ledger.priorityQueue.slice(0, 6);
}

type WatchSnapshot = {
  observedAt: string;
  runId: string;
  benchmarkId: string;
  workerId: string;
  policyId: PolicyId;
  status: LoopState["status"];
  currentCycleNumber: number | null;
  currentPhase: LoopState["currentPhase"] | null;
  lastPhaseSummary: string | null;
  scoreHistory: number[];
  latestScore: number | null;
  stopReason: string | null;
  priorityQueueSize: number;
  initiativeQueueSize: number;
  opportunityQueueSize: number;
  architectureDirectiveCount: number;
  priorityHead: string[];
  initiativeHead: string[];
  opportunityHead: string[];
  workHead: string[];
  architectureHead: string[];
  judge: {
    totalScore: number;
    hiddenCheckScore: number | null;
    productQualityScore: number | null;
    technicalQualityScore: number | null;
    validationScore: number | null;
    failedChecks: number;
    failedValidations: number;
    passedRequired: boolean;
    passedValidation: boolean | null;
  } | null;
  activity: {
    live: boolean;
    phase: string;
    summary: string;
    updatedAt: string;
    step: number | null;
    stepLimit: number | null;
    model: string | null;
    branchLabel: string | null;
    filesTouched: string[];
    commandsRun: string[];
    issues: string[];
    recentActions: Array<{
      step: number;
      actionType: string;
      summary: string;
    }>;
  } | null;
  successThreshold: number;
  plateauDisabled: boolean;
  plateauWindow: number | null;
  plateauThreshold: number | null;
  continueAfterSuccess: boolean;
  ledgerPath: string;
};

type ChainWatchSnapshot = {
  observedAt: string;
  chainRunId: string;
  label: string | null;
  status: ChainState["status"];
  currentStageIndex: number | null;
  totalStages: number;
  currentBenchmarkId: string | null;
  currentRunId: string | null;
  stopReason: string | null;
  chainPath: string;
  completedStages: Array<{
    benchmarkId: string;
    score: number | null;
    stopReason: string | null;
  }>;
  activeRun?: WatchSnapshot;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function registerChainInterruptHandler(chainState: ChainState): () => void {
  let handled = false;
  const handler = (signal: NodeJS.Signals) => {
    if (handled) {
      return;
    }
    handled = true;
    chainState.status = "failed";
    chainState.stopReason = `interrupted:${signal}`;
    if (chainState.currentStageIndex !== undefined) {
      const current = chainState.stages[chainState.currentStageIndex];
      chainState.stages[chainState.currentStageIndex] = {
        benchmarkId: current?.benchmarkId ?? chainState.currentBenchmarkId ?? "unknown",
        status: "failed",
        ...(current?.runId ? { runId: current.runId } : {}),
        ...(current?.ledgerPath ? { ledgerPath: current.ledgerPath } : {}),
        stopReason: chainState.stopReason,
      };
    }
    persistChainStateSync(chainState);
    setTimeout(() => {
      process.exit(130);
    }, 0);
  };

  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);

  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}

function buildWatchSnapshot(ledger: LoopState, ledgerPath: string): WatchSnapshot {
  const initiativeQueue = ledger.initiativeQueue ?? [];
  const latestScore =
    ledger.scoreHistory.length > 0
      ? ledger.scoreHistory[ledger.scoreHistory.length - 1]!
      : ledger.finalJudge?.totalScore ?? ledger.baselineScore ?? null;
  const latestJudge = ledger.finalJudge ?? ledger.baselineJudge;
  const latestCycle = ledger.cycles[ledger.cycles.length - 1];
  const latestWorkBreakdown =
    latestCycle?.phases
      .slice()
      .reverse()
      .find(
        (phase) =>
          phase.phase === "pm_reprioritization"
          || phase.phase === "planning"
          || phase.phase === "pm_intake",
      )
      ?.output.workBreakdown ?? [];
  const latestPhase = latestCycle?.phases[latestCycle.phases.length - 1];
  const metadataModel =
    latestPhase?.metadata && typeof latestPhase.metadata.model === "string"
      ? latestPhase.metadata.model
      : null;
  const activity = ledger.livePhase
    ? {
        live: true,
        phase: ledger.livePhase.phase,
        summary: ledger.livePhase.summary,
        updatedAt: ledger.livePhase.updatedAt,
        step: ledger.livePhase.step ?? null,
        stepLimit: ledger.livePhase.stepLimit ?? null,
        model: ledger.livePhase.model ?? ledger.livePhase.primaryModel ?? null,
        branchLabel: ledger.livePhase.branchLabel ?? null,
        filesTouched: ledger.livePhase.filesTouched.slice(0, 6),
        commandsRun: ledger.livePhase.commandsRun.slice(0, 4),
        issues: ledger.livePhase.issues.slice(0, 4),
        recentActions: ledger.livePhase.recentActions.slice(-5).map((trace) => ({
          step: trace.step,
          actionType: trace.actionType,
          summary: trace.observationSummary,
        })),
      }
    : latestPhase
      ? {
          live: false,
          phase: latestPhase.phase,
          summary: latestPhase.summary,
          updatedAt: latestPhase.completedAt,
          step: null,
          stepLimit: null,
          model: metadataModel,
          branchLabel: null,
          filesTouched: (latestPhase.output.filesTouched ?? []).slice(0, 6),
          commandsRun: (latestPhase.output.commandsRun ?? []).slice(0, 4),
          issues: [
            ...(latestPhase.output.unresolvedIssues ?? []),
            ...(latestPhase.output.risks ?? []),
          ].slice(0, 4),
          recentActions: (latestPhase.traces ?? []).slice(-5).map((trace) => ({
            step: trace.step,
            actionType: trace.actionType,
            summary: trace.observationSummary,
          })),
        }
      : null;

  return {
    observedAt: new Date().toISOString(),
    runId: ledger.runId,
    benchmarkId: ledger.benchmarkId,
    workerId: ledger.workerId,
    policyId: ledger.policyId,
    status: ledger.status,
    currentCycleNumber: ledger.currentCycleNumber ?? null,
    currentPhase: ledger.currentPhase ?? null,
    lastPhaseSummary: ledger.lastPhaseSummary ?? null,
    scoreHistory: ledger.scoreHistory,
    latestScore,
    stopReason: ledger.stopReason ?? null,
    priorityQueueSize: ledger.priorityQueue.length,
    initiativeQueueSize: initiativeQueue.length,
    opportunityQueueSize: ledger.opportunityQueue.length,
    architectureDirectiveCount: ledger.architectureDirectives.length,
    priorityHead: ledger.priorityQueue.slice(0, 4).map((item) => item.title),
    initiativeHead: initiativeQueue.slice(0, 4).map((item) => item.title),
    opportunityHead: ledger.opportunityQueue.slice(0, 4).map((item) => item.title),
    workHead: latestWorkBreakdown.slice(0, 4).map((item) => `[${item.size}] ${item.title}`),
    architectureHead: ledger.architectureDirectives.slice(0, 4),
    judge: latestJudge
      ? {
          totalScore: latestJudge.totalScore,
          hiddenCheckScore: latestJudge.hiddenCheckScore ?? null,
          productQualityScore: latestJudge.productQualityScore ?? null,
          technicalQualityScore: latestJudge.technicalQualityScore ?? null,
          validationScore: latestJudge.validationScore ?? null,
          failedChecks: latestJudge.failedChecks.length,
          failedValidations:
            latestJudge.validationResults?.filter((result) => !result.passed).length ?? 0,
          passedRequired: latestJudge.passedRequired,
          passedValidation: latestJudge.passedValidation ?? null,
        }
      : null,
    activity,
    successThreshold: ledger.stopRules.successThreshold,
    plateauDisabled: ledger.stopRules.disablePlateau,
    plateauWindow: ledger.stopRules.disablePlateau ? null : ledger.stopRules.plateauWindow,
    plateauThreshold: ledger.stopRules.disablePlateau ? null : ledger.stopRules.plateauThreshold,
    continueAfterSuccess: ledger.stopRules.continueAfterSuccess === true,
    ledgerPath,
  };
}

function renderWatchSnapshot(snapshot: WatchSnapshot, showLedgerPath = false): string {
  const lines = [
    `[${snapshot.observedAt}] ${snapshot.runId}`,
    `${snapshot.benchmarkId} | ${snapshot.workerId} | ${snapshot.policyId}`,
    `status: ${snapshot.status}${snapshot.currentCycleNumber ? ` | cycle ${snapshot.currentCycleNumber}` : ""}${snapshot.currentPhase ? ` | phase ${snapshot.currentPhase}` : ""}`,
    `latest score: ${snapshot.latestScore ?? "n/a"} | history: ${snapshot.scoreHistory.length > 0 ? snapshot.scoreHistory.join(", ") : "none"}`,
    `target score: ${snapshot.successThreshold} | plateau: ${snapshot.plateauDisabled ? "disabled" : `window ${snapshot.plateauWindow}, threshold ${snapshot.plateauThreshold}`}${snapshot.continueAfterSuccess ? " | continue-after-success: on" : ""}`,
    `priority queue: ${snapshot.priorityQueueSize} | initiatives: ${snapshot.initiativeQueueSize} | opportunities: ${snapshot.opportunityQueueSize} | architecture directives: ${snapshot.architectureDirectiveCount}`,
    `last update: ${snapshot.lastPhaseSummary ?? "n/a"}`,
  ];
  if (snapshot.judge) {
    lines.push(
      `judge: total ${snapshot.judge.totalScore.toFixed(1)} | hidden ${snapshot.judge.hiddenCheckScore ?? "n/a"} | product ${snapshot.judge.productQualityScore ?? "n/a"} | technical ${snapshot.judge.technicalQualityScore ?? "n/a"} | validation ${snapshot.judge.validationScore ?? "n/a"}`,
    );
    lines.push(
      `judge gates: required ${snapshot.judge.passedRequired ? "pass" : "fail"} | validation ${snapshot.judge.passedValidation === null ? "n/a" : snapshot.judge.passedValidation ? "pass" : "fail"} | failed checks ${snapshot.judge.failedChecks} | failed validations ${snapshot.judge.failedValidations}`,
    );
  }
  if (snapshot.priorityHead.length > 0) {
    lines.push(`priorities: ${snapshot.priorityHead.join(" | ")}`);
  }
  if (snapshot.workHead.length > 0) {
    lines.push(`current work: ${snapshot.workHead.join(" | ")}`);
  }
  if (snapshot.initiativeHead.length > 0) {
    lines.push(`initiatives: ${snapshot.initiativeHead.join(" | ")}`);
  }
  if (snapshot.opportunityHead.length > 0) {
    lines.push(`opportunities: ${snapshot.opportunityHead.join(" | ")}`);
  }
  if (snapshot.architectureHead.length > 0) {
    lines.push(`architecture: ${snapshot.architectureHead.join(" | ")}`);
  }
  if (snapshot.activity) {
    lines.push(
      `${snapshot.activity.live ? "live" : "recent"} activity: ${snapshot.activity.phase}${snapshot.activity.branchLabel ? ` (${snapshot.activity.branchLabel})` : ""}${snapshot.activity.step !== null ? ` | step ${snapshot.activity.step}/${snapshot.activity.stepLimit ?? "?"}` : ""}${snapshot.activity.model ? ` | model ${snapshot.activity.model}` : ""}`,
    );
    lines.push(`activity update: ${snapshot.activity.summary}`);
    if (snapshot.activity.filesTouched.length > 0) {
      lines.push(`files: ${snapshot.activity.filesTouched.join(", ")}`);
    }
    if (snapshot.activity.commandsRun.length > 0) {
      lines.push(`commands: ${snapshot.activity.commandsRun.join(" | ")}`);
    }
    if (snapshot.activity.issues.length > 0) {
      lines.push(`issues: ${snapshot.activity.issues.join(" | ")}`);
    }
    if (snapshot.activity.recentActions.length > 0) {
      lines.push("recent actions:");
      for (const action of snapshot.activity.recentActions) {
        lines.push(`  ${action.step}. ${action.actionType} -> ${action.summary}`);
      }
    }
  }
  if (snapshot.stopReason) {
    lines.push(`stop reason: ${snapshot.stopReason}`);
  }
  if (showLedgerPath) {
    lines.push(`ledger: ${snapshot.ledgerPath}`);
  }
  return `${lines.join("\n")}\n`;
}

async function buildChainWatchSnapshot(
  chain: ChainState,
  chainPath: string,
): Promise<ChainWatchSnapshot> {
  const currentStage =
    chain.currentStageIndex !== undefined ? chain.stages[chain.currentStageIndex] : undefined;
  let activeRun: WatchSnapshot | undefined;

  if (currentStage?.ledgerPath && (await pathExists(currentStage.ledgerPath))) {
    const ledger = await readJson<LoopState>(currentStage.ledgerPath);
    activeRun = buildWatchSnapshot(ledger, currentStage.ledgerPath);
  }

  return {
    observedAt: new Date().toISOString(),
    chainRunId: chain.chainRunId,
    label: chain.label ?? null,
    status: chain.status,
    currentStageIndex: chain.currentStageIndex ?? null,
    totalStages: chain.stages.length,
    currentBenchmarkId: chain.currentBenchmarkId ?? null,
    currentRunId: chain.currentRunId ?? null,
    stopReason: chain.stopReason ?? null,
    chainPath,
    completedStages: chain.stages
      .filter((stage) => stage.status === "completed")
      .map((stage) => ({
        benchmarkId: stage.benchmarkId,
        score: stage.score ?? null,
        stopReason: stage.stopReason ?? null,
      })),
    ...(activeRun ? { activeRun } : {}),
  };
}

function renderChainWatchSnapshot(snapshot: ChainWatchSnapshot, showChainPath = false): string {
  const lines = [
    `[${snapshot.observedAt}] chain ${snapshot.chainRunId}${snapshot.label ? ` (${snapshot.label})` : ""}`,
    `status: ${snapshot.status}${snapshot.currentStageIndex !== null ? ` | stage ${snapshot.currentStageIndex + 1}/${snapshot.totalStages}` : ""}${snapshot.currentBenchmarkId ? ` | benchmark ${snapshot.currentBenchmarkId}` : ""}`,
    `current run: ${snapshot.currentRunId ?? "n/a"}`,
    `completed stages: ${snapshot.completedStages.length}/${snapshot.totalStages}`,
  ];

  if (snapshot.completedStages.length > 0) {
    lines.push(
      `stage results: ${snapshot.completedStages
        .map(
          (stage) =>
            `${stage.benchmarkId}=${stage.score ?? "n/a"}${stage.stopReason ? ` (${stage.stopReason})` : ""}`,
        )
        .join(", ")}`,
    );
  }

  if (snapshot.activeRun) {
    lines.push("active run:");
    lines.push(
      ...renderWatchSnapshot(snapshot.activeRun)
        .trimEnd()
        .split("\n")
        .map((line) => `  ${line}`),
    );
  }

  if (snapshot.stopReason) {
    lines.push(`stop reason: ${snapshot.stopReason}`);
  }
  if (showChainPath) {
    lines.push(`chain ledger: ${snapshot.chainPath}`);
  }
  return `${lines.join("\n")}\n`;
}

async function resolveLatestLedgerPath(
  loaded: LoadedConfig,
  filters: { benchmarkId?: string; workerId?: string; policyId?: string },
): Promise<string | undefined> {
  const runsRoot = path.join(loaded.rootDir, loaded.config.runsDir);
  if (!(await pathExists(runsRoot))) {
    return undefined;
  }

  const tokens = [
    filters.benchmarkId ? slugify(filters.benchmarkId) : undefined,
    filters.workerId ? slugify(filters.workerId) : undefined,
    filters.policyId ? slugify(filters.policyId) : undefined,
  ].filter((value): value is string => Boolean(value));

  const entries = await fs.readdir(runsRoot, { withFileTypes: true });
  const candidates = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (!tokens.every((token) => entry.name.includes(token))) {
      continue;
    }
    const runDir = path.join(runsRoot, entry.name);
    const stat = await fs.stat(runDir);
    candidates.push({
      runDir,
      mtimeMs: stat.mtimeMs,
    });
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0] ? path.join(candidates[0].runDir, "ledger.json") : undefined;
}

async function watchRun(
  parsed: ParsedArgs,
  loaded: LoadedConfig,
  cwd: string,
): Promise<number> {
  const intervalSeconds = getNumberFlag(parsed, "interval", 2);
  const intervalMs = Math.max(250, Math.round(intervalSeconds * 1000));
  const once = Boolean(parsed.flags.once);

  let targetLedgerPath = getStringFlag(parsed, "ledger");
  if (targetLedgerPath) {
    targetLedgerPath = path.resolve(cwd, targetLedgerPath);
  }

  const runId = getStringFlag(parsed, "run");
  if (runId) {
    targetLedgerPath = path.join(loaded.rootDir, loaded.config.runsDir, runId, "ledger.json");
  }

  const wantsLatest =
    Boolean(parsed.flags.latest) ||
    (!targetLedgerPath &&
      (Boolean(getStringFlag(parsed, "benchmark")) ||
        Boolean(getStringFlag(parsed, "worker")) ||
        Boolean(getStringFlag(parsed, "policy"))));

  const latestFilters: { benchmarkId?: string; workerId?: string; policyId?: string } = {};
  const benchmarkFilter = getStringFlag(parsed, "benchmark");
  const workerFilter = getStringFlag(parsed, "worker");
  const policyFilter = getStringFlag(parsed, "policy") as PolicyId | undefined;
  if (benchmarkFilter) {
    latestFilters.benchmarkId = benchmarkFilter;
  }
  if (workerFilter) {
    latestFilters.workerId = workerFilter;
  }
  if (policyFilter) {
    latestFilters.policyId = policyFilter;
  }

  if (!targetLedgerPath && !wantsLatest) {
    throw new Error(
      "watch requires --run <id>, --ledger <path>, or --latest (optionally with --benchmark/--worker/--policy).",
    );
  }

  let waitingLogged = false;
  let lastFingerprint: string | undefined;

  while (true) {
    if (!targetLedgerPath && wantsLatest) {
      targetLedgerPath = await resolveLatestLedgerPath(loaded, latestFilters);
    }

    if (!targetLedgerPath || !(await pathExists(targetLedgerPath))) {
      if (!waitingLogged) {
        process.stdout.write("Waiting for a matching run ledger...\n");
        waitingLogged = true;
      }
      if (once) {
        return 1;
      }
      await sleep(intervalMs);
      continue;
    }

    waitingLogged = false;
    const ledger = await readJson<LoopState>(targetLedgerPath);
    const snapshot = buildWatchSnapshot(ledger, targetLedgerPath);
    const fingerprint = JSON.stringify({
      ...snapshot,
      observedAt: "",
    });

    if (fingerprint !== lastFingerprint) {
      process.stdout.write(renderWatchSnapshot(snapshot, lastFingerprint === undefined));
      lastFingerprint = fingerprint;
    }

    if (once || ledger.status !== "running") {
      return 0;
    }

  await sleep(intervalMs);
  }
}

async function watchChain(
  parsed: ParsedArgs,
  loaded: LoadedConfig,
  cwd: string,
): Promise<number> {
  const intervalSeconds = getNumberFlag(parsed, "interval", 2);
  const intervalMs = Math.max(250, Math.round(intervalSeconds * 1000));
  const once = Boolean(parsed.flags.once);

  let targetChainPath = getStringFlag(parsed, "chain-ledger");
  if (targetChainPath) {
    targetChainPath = path.resolve(cwd, targetChainPath);
  }

  const chainId = getStringFlag(parsed, "chain");
  if (chainId) {
    targetChainPath = path.join(loaded.rootDir, loaded.config.chainsDir!, `${chainId}.json`);
  }

  const wantsLatest = Boolean(parsed.flags["chain-latest"]);
  const label = getStringFlag(parsed, "label");

  if (!targetChainPath && !wantsLatest) {
    throw new Error(
      "watch requires --chain <id>, --chain-ledger <path>, or --chain-latest [--label <label>] for chain monitoring.",
    );
  }

  let waitingLogged = false;
  let lastFingerprint: string | undefined;

  while (true) {
    if (!targetChainPath && wantsLatest) {
      targetChainPath = await resolveLatestChainPath(loaded, label);
    }

    if (!targetChainPath || !(await pathExists(targetChainPath))) {
      if (!waitingLogged) {
        process.stdout.write("Waiting for a matching chain ledger...\n");
        waitingLogged = true;
      }
      if (once) {
        return 1;
      }
      await sleep(intervalMs);
      continue;
    }

    waitingLogged = false;
    const chain = await readJson<ChainState>(targetChainPath);
    const snapshot = await buildChainWatchSnapshot(chain, targetChainPath);
    const fingerprint = JSON.stringify({
      ...snapshot,
      observedAt: "",
      ...(snapshot.activeRun
        ? {
            activeRun: {
              ...snapshot.activeRun,
              observedAt: "",
            },
          }
        : {}),
    });

    if (fingerprint !== lastFingerprint) {
      process.stdout.write(renderChainWatchSnapshot(snapshot, lastFingerprint === undefined));
      lastFingerprint = fingerprint;
    }

    if (once || chain.status !== "running") {
      return 0;
    }

    await sleep(intervalMs);
  }
}

export async function runCli(argv = process.argv.slice(2), cwd = process.cwd()): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.command || parsed.command === "help" || parsed.flags.help) {
    process.stdout.write(helpText());
    return 0;
  }

  const loaded = await loadConfig(cwd);
  const defaultWorker = loaded.config.defaults.worker;
  const defaultPolicy = loaded.config.defaults.policy;
  const defaultBudget = loaded.config.defaults.budgetMinutes;

  switch (parsed.command) {
    case "list": {
      const benchmarks = await listBenchmarks(loaded);
      logJson({
        benchmarks,
        workers: Object.keys(loaded.config.workers).sort(),
      });
      return 0;
    }

    case "run":
    case "loop": {
      const benchmarkInput = await resolveBenchmarkInput(parsed, loaded, cwd);
      const benchmarkId = benchmarkInput.benchmarkId;
      const workerId = getStringFlag(parsed, "worker", defaultWorker)!;
      const policyId = getStringFlag(parsed, "policy", defaultPolicy) as PolicyId;
      const budgetMinutes = getNumberFlag(
        parsed,
        "budget",
        benchmarkInput.fromBrief ? Math.max(defaultBudget, 120) : defaultBudget,
      );
      const maxCycles =
        parsed.command === "run"
          ? 1
          : getNumberFlag(parsed, "max-cycles", benchmarkInput.fromBrief ? 12 : 3);
      let seedOverride = getStringFlag(parsed, "seed");
      let initialHandoffNotes: string[] | undefined;
      let initialArchitectureDirectives: string[] | undefined;
      let carryoverPriorities: PriorityItem[] | undefined;
      const stopRuleFlags = readStopRuleFlags(parsed);
      if (benchmarkInput.fromBrief && !("continue-after-success" in parsed.flags)) {
        stopRuleFlags.continueAfterSuccess = true;
      }
      if (benchmarkInput.fromBrief && !("plateau-window" in parsed.flags)) {
        stopRuleFlags.plateauWindow = 5;
      }
      if (benchmarkInput.fromBrief && !("plateau-threshold" in parsed.flags)) {
        stopRuleFlags.plateauThreshold = 0.5;
      }
      const handoffLedgerPath = getStringFlag(parsed, "handoff-ledger");
      if (handoffLedgerPath) {
        const handoffLedger = await readJson<LoopState>(path.resolve(cwd, handoffLedgerPath));
        seedOverride ??= handoffLedger.paths.repoDir;
        initialHandoffNotes = buildChainHandoffNotes(handoffLedger);
        initialArchitectureDirectives = handoffLedger.architectureDirectives;
        carryoverPriorities = buildCarryoverPriorities(handoffLedger);
      }

      const result = await runLoopExperiment({
        loaded,
        benchmarkId,
        workerId,
        policyId,
        budgetMinutes,
        maxCycles,
        ...stopRuleFlags,
        ...(seedOverride ? { seedOverride } : {}),
        ...(initialHandoffNotes ? { initialHandoffNotes } : {}),
        ...(initialArchitectureDirectives
          ? { initialArchitectureDirectives }
          : {}),
        ...(carryoverPriorities ? { carryoverPriorities } : {}),
      });
      logJson(result);
      return 0;
    }

    case "judge": {
      const benchmarkInput = await resolveBenchmarkInput(parsed, loaded, cwd);
      const benchmarkId = benchmarkInput.benchmarkId;
      const repo = getStringFlag(parsed, "repo");
      if (!repo) {
        throw new Error("--repo is required");
      }
      const benchmark = await loadBenchmarkSpec(loaded, benchmarkId);
      const judge = await judgeRepo(benchmark, path.resolve(cwd, repo));
      logJson(judge);
      return 0;
    }

    case "report": {
      const report = await collectRunResults(loaded);
      const reportPath = path.join(loaded.rootDir, loaded.config.reportsDir, "experiment-report.json");
      await writeJson(reportPath, report);
      logJson({
        ...report,
        reportPath,
      });
      return 0;
    }

    case "matrix": {
      const benchmarks = csvFlag(parsed, "benchmarks", []);
      const workers = csvFlag(parsed, "workers", [defaultWorker]);
      const policies = csvFlag(parsed, "policies", [defaultPolicy]);
      if (benchmarks.length === 0) {
        throw new Error("--benchmarks is required");
      }
      const budgetMinutes = getNumberFlag(parsed, "budget", defaultBudget);
      const loopCycles = getNumberFlag(parsed, "max-cycles", 2);
      const stopRuleFlags = readStopRuleFlags(parsed);
      const results = [];

      for (const benchmarkId of benchmarks) {
        for (const workerId of workers) {
          for (const policyId of policies as PolicyId[]) {
            const maxCycles = policyId === "single_pass" ? 1 : loopCycles;
            const result = await runLoopExperiment({
              loaded,
              benchmarkId,
              workerId,
              policyId,
              budgetMinutes,
              maxCycles,
              ...stopRuleFlags,
            });
            results.push(result);
          }
        }
      }

      const report = await collectRunResults(loaded);
      const reportPath = path.join(loaded.rootDir, loaded.config.reportsDir, "experiment-report.json");
      await writeJson(reportPath, report);
      logJson({
        results,
        reportPath,
      });
      return 0;
    }

    case "chain": {
      const benchmarksFlag = getStringFlag(parsed, "benchmarks");
      if (!benchmarksFlag) {
        throw new Error("--benchmarks is required");
      }
      const benchmarks = benchmarksFlag.split(",").map((value) => value.trim()).filter(Boolean);
      const workerId = getStringFlag(parsed, "worker", defaultWorker)!;
      const policyId = getStringFlag(parsed, "policy", defaultPolicy) as PolicyId;
      const budgetMinutes = getNumberFlag(parsed, "budget", defaultBudget);
      const maxCycles = getNumberFlag(parsed, "max-cycles", 2);
      const chainLabel = getStringFlag(parsed, "chain-label");
      const stopRuleFlags = readStopRuleFlags(parsed);
      const firstBenchmark = await loadBenchmarkSpec(loaded, benchmarks[0]!);
      const chainState = await createChainState(loaded, {
        ...(chainLabel ? { label: chainLabel } : {}),
        workerId,
        policyId,
        budgetMinutes,
        maxCycles,
        benchmarks,
        stopRules: {
          successThreshold:
            stopRuleFlags.successThreshold ?? firstBenchmark.successThreshold,
          plateauWindow: stopRuleFlags.plateauWindow ?? loaded.config.defaults.plateauWindow,
          plateauThreshold:
            stopRuleFlags.plateauThreshold ?? loaded.config.defaults.plateauThreshold,
          disablePlateau: stopRuleFlags.disablePlateau === true,
        },
      });
      const cleanupChainInterruptHandler = registerChainInterruptHandler(chainState);

      let seedOverride: string | undefined;
      let handoffNotes: string[] | undefined;
      let architectureDirectives: string[] | undefined;
      let carryoverPriorities: PriorityItem[] | undefined;
      const results: CellResult[] = [];

      try {
        for (const [index, benchmarkId] of benchmarks.entries()) {
          chainState.currentStageIndex = index;
          chainState.currentBenchmarkId = benchmarkId;
          delete chainState.currentRunId;
          chainState.stages[index] = {
            benchmarkId,
            status: "running",
          };
          await persistChainState(chainState);

          const result = await runLoopExperiment({
            loaded,
            benchmarkId,
            workerId,
            policyId,
            budgetMinutes,
            maxCycles,
            ...stopRuleFlags,
            ...(seedOverride ? { seedOverride } : {}),
            ...(handoffNotes ? { initialHandoffNotes: handoffNotes } : {}),
            ...(architectureDirectives
              ? { initialArchitectureDirectives: architectureDirectives }
              : {}),
            ...(carryoverPriorities ? { carryoverPriorities } : {}),
            onRunCreated: async (state) => {
              chainState.currentRunId = state.runId;
              chainState.stages[index] = {
                benchmarkId,
                status: "running",
                runId: state.runId,
                ledgerPath: state.paths.ledgerPath,
              };
              await persistChainState(chainState);
            },
          });
          results.push(result);
          const finalState = await readJson<{ ledgerPath: string }>(result.resultPath);
          const ledger = await readJson<LoopState>(finalState.ledgerPath);
          chainState.currentRunId = result.runId;
          chainState.stages[index] = {
            benchmarkId,
            status: "completed",
            runId: result.runId,
            ledgerPath: result.ledgerPath,
            score: result.score,
            ...(result.stopReason ? { stopReason: result.stopReason } : {}),
          };
          chainState.summary = summarizeChainResults(results);
          await persistChainState(chainState);
          seedOverride = ledger.paths.repoDir;
          handoffNotes = buildChainHandoffNotes(ledger);
          architectureDirectives = ledger.architectureDirectives;
          carryoverPriorities = buildCarryoverPriorities(ledger);
        }
        chainState.status = "completed";
        chainState.summary = summarizeChainResults(results);
        await persistChainState(chainState);
        cleanupChainInterruptHandler();
      } catch (error) {
        chainState.status = "failed";
        chainState.stopReason =
          error instanceof Error ? `failed:${error.message}` : `failed:${String(error)}`;
        if (chainState.currentStageIndex !== undefined) {
          const current = chainState.stages[chainState.currentStageIndex];
          chainState.stages[chainState.currentStageIndex] = {
            benchmarkId: current?.benchmarkId ?? chainState.currentBenchmarkId ?? "unknown",
            status: "failed",
            ...(current?.runId ? { runId: current.runId } : {}),
            ...(current?.ledgerPath ? { ledgerPath: current.ledgerPath } : {}),
            stopReason: chainState.stopReason,
          };
        }
        chainState.summary = summarizeChainResults(results);
        await persistChainState(chainState);
        cleanupChainInterruptHandler();
        throw error;
      }
      logJson({
        chainRunId: chainState.chainRunId,
        chainPath: chainState.chainPath,
        results,
        summary: summarizeChainResults(results),
      });
      return 0;
    }

    case "watch":
      if (
        parsed.flags["chain-latest"] ||
        getStringFlag(parsed, "chain") ||
        getStringFlag(parsed, "chain-ledger")
      ) {
        return watchChain(parsed, loaded, cwd);
      }
      return watchRun(parsed, loaded, cwd);

    default:
      throw new Error(`Unknown command '${parsed.command}'.`);
  }
}

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  runCli().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
