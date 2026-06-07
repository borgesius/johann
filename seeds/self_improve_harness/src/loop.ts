import path from "node:path";
import { createRunPaths, loadBenchmarkSpec, prepareRunWorkspace } from "./benchmark.js";
import { resolveWorkerConfig } from "./config.js";
import { judgeRepo, writeJudgeArtifact } from "./judge.js";
import { normalizePhaseOutput } from "./normalize.js";
import { getPolicy, preExecutionPhasesForCycle, resolveBranchPlan } from "./policies.js";
import { buildPhasePrompt, defaultBacklogFromBenchmark } from "./prompts.js";
import { buildPriorityQueue } from "./priority.js";
import { writeRunArtifacts } from "./report.js";
import { createRunner } from "./runners/index.js";
import {
  deriveProgramWorkItems,
  selectActiveWorkItems,
  selectCurrentProgramSlice,
  selectDeferredWorkItems,
} from "./sizing.js";
import type {
  BranchRecord,
  BranchCandidate,
  BranchTemplate,
  CellResult,
  CycleRecord,
  InitiativeItem,
  JudgeResult,
  LoadedConfig,
  LoopState,
  OpportunityItem,
  PhaseId,
  PhaseRecord,
  PolicyId,
  PriorityItem,
  RunBudget,
  RunnerAdapter,
  RunnerPhaseContext,
  RunnerPhaseProgress,
  RunnerPhaseResult,
  RunPaths,
  StopRules,
} from "./types.js";
import {
  copyDir,
  ensureDir,
  getGitSummary,
  listFiles,
  minutesFromNow,
  nowIso,
  readJson,
  writeJson,
  writeText,
  writeJsonSync,
  writeTextSync,
} from "./utils.js";

export interface RunLoopOptions {
  loaded: LoadedConfig;
  benchmarkId: string;
  workerId: string;
  policyId: PolicyId;
  budgetMinutes: number;
  maxCycles: number;
  successThreshold?: number;
  plateauWindow?: number;
  plateauThreshold?: number;
  disablePlateau?: boolean;
  continueAfterSuccess?: boolean;
  seedOverride?: string;
  initialHandoffNotes?: string[];
  initialArchitectureDirectives?: string[];
  carryoverPriorities?: PriorityItem[];
  onRunCreated?: (state: LoopState) => Promise<void> | void;
}

function createBudget(budgetMinutes: number): RunBudget {
  return {
    totalMinutes: budgetMinutes,
    startedAt: nowIso(),
    deadlineAt: minutesFromNow(budgetMinutes),
  };
}

function createStopRules(
  loaded: LoadedConfig,
  benchmark: Awaited<ReturnType<typeof loadBenchmarkSpec>>,
  options: Pick<
    RunLoopOptions,
    | "successThreshold"
    | "plateauWindow"
    | "plateauThreshold"
    | "disablePlateau"
    | "continueAfterSuccess"
  >,
): StopRules {
  const requestedWindow = options.plateauWindow ?? loaded.config.defaults.plateauWindow;
  const disablePlateau = options.disablePlateau === true || requestedWindow <= 0;

  return {
    successThreshold: options.successThreshold ?? benchmark.successThreshold,
    plateauWindow: Math.max(1, requestedWindow),
    plateauThreshold: options.plateauThreshold ?? loaded.config.defaults.plateauThreshold,
    disablePlateau,
    ...(options.continueAfterSuccess ? { continueAfterSuccess: true } : {}),
  };
}

function buildInitialState(
  benchmarkId: string,
  benchmarkTitle: string,
  workerId: string,
  workerType: LoopState["workerType"],
  policyId: PolicyId,
  paths: RunPaths,
  budget: RunBudget,
  stopRules: StopRules,
  handoffNotes: string[],
  baselineJudge: JudgeResult,
  initialArchitectureDirectives: string[] = [],
  carryoverPriorities: PriorityItem[] = [],
): LoopState {
  const createdAt = nowIso();
  const baselineOpportunities = baselineJudge.productReview?.opportunities ?? [];
  return {
    runId: path.basename(paths.runDir),
    benchmarkId,
    benchmarkTitle,
    workerId,
    workerType,
    policyId,
    createdAt,
    updatedAt: createdAt,
    status: "running",
    budget,
    stopRules,
    paths,
    baselineScore: baselineJudge.totalScore,
    baselineJudge,
    scoreHistory: [],
    usedBranchTemplateIds: [],
    cycles: [],
    priorityQueue: [],
    opportunityQueue: dedupeOpportunities(baselineOpportunities),
    initiativeQueue: dedupeInitiatives(
      promoteOpportunityInitiatives(baselineOpportunities),
    ),
    carryoverPriorities,
    architectureDirectives: [...new Set(initialArchitectureDirectives)],
    handoffNotes,
  };
}

function dedupeOpportunities(items: OpportunityItem[]): OpportunityItem[] {
  const seen = new Set<string>();
  const output: OpportunityItem[] = [];
  for (const item of items) {
    const key = item.title.trim().toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(item);
  }
  return output;
}

function dedupeInitiatives(items: InitiativeItem[]): InitiativeItem[] {
  const seen = new Set<string>();
  const output: InitiativeItem[] = [];
  for (const item of items) {
    const key = item.title.trim().toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(item);
  }
  return output;
}

function deriveInitiativesFromWorkBreakdown(
  workBreakdown: RunnerPhaseResult["output"]["workBreakdown"] | undefined,
  source: string,
): InitiativeItem[] {
  if (!workBreakdown || workBreakdown.length === 0) {
    return [];
  }

  return workBreakdown.slice(0, 6).flatMap((item, index) => {
    const severity =
      item.size === "oversized"
        ? 5
        : item.size === "large"
          ? 4
          : item.children && item.children.length > 0
            ? 3
            : 0;
    if (severity === 0) {
      return [];
    }
    return [
      {
        id: `initiative-${source}-${item.id || index + 1}`,
        title: item.title,
        rationale: item.rationale,
        source,
        severity,
        ...(item.track ? { track: item.track } : {}),
        ...(item.acceptanceHint ? { acceptanceHint: item.acceptanceHint } : {}),
      },
    ];
  });
}

function promoteOpportunityInitiatives(items: OpportunityItem[]): InitiativeItem[] {
  return items.flatMap((item) => {
    if (item.severity < 4) {
      return [];
    }
    return [
      {
        id: `promoted-${item.id}`,
        title: item.title,
        rationale: item.rationale,
        source: item.source,
        severity: item.severity,
        ...(item.track ? { track: item.track } : {}),
        ...(item.acceptanceHint ? { acceptanceHint: item.acceptanceHint } : {}),
      },
    ];
  });
}

function mergeStateInitiatives(
  state: LoopState,
  explicit: InitiativeItem[] | undefined,
  workBreakdown: RunnerPhaseResult["output"]["workBreakdown"] | undefined,
  source: string,
  extraOpportunities?: OpportunityItem[],
): void {
  state.initiativeQueue = dedupeInitiatives(
    [
      ...state.initiativeQueue,
      ...(explicit ?? []),
      ...deriveInitiativesFromWorkBreakdown(workBreakdown, source),
      ...promoteOpportunityInitiatives(extraOpportunities ?? []),
    ].sort((left, right) => right.severity - left.severity),
  ).slice(0, 16);
}

function mergeStateOpportunities(
  state: LoopState,
  extra: OpportunityItem[] | undefined,
): void {
  if (!extra || extra.length === 0) {
    return;
  }
  state.opportunityQueue = dedupeOpportunities(
    [...state.opportunityQueue, ...extra].sort((left, right) => right.severity - left.severity),
  ).slice(0, 20);
}

function buildVisibleBacklog(
  state: LoopState,
  benchmark: Awaited<ReturnType<typeof loadBenchmarkSpec>>,
): PriorityItem[] {
  if (state.priorityQueue.length > 0) {
    return state.priorityQueue;
  }

  const base = defaultBacklogFromBenchmark(benchmark);
  if (state.carryoverPriorities.length === 0) {
    return base;
  }

  const merged = [...base];
  const existingTitles = new Set(merged.map((item) => item.title.trim().toLowerCase()));
  for (const item of state.carryoverPriorities
    .slice()
    .sort((left, right) => right.severity - left.severity)
    .slice(0, 6)) {
    const key = item.title.trim().toLowerCase();
    if (existingTitles.has(key)) {
      continue;
    }
    merged.push({
      ...item,
      id: `carryover-${item.id}`,
      source: `carryover:${item.source}`,
    });
    existingTitles.add(key);
  }

  if (state.initiativeQueue.length > 0) {
    for (const item of state.initiativeQueue.slice(0, state.stopRules.continueAfterSuccess ? 4 : 2)) {
      const key = item.title.trim().toLowerCase();
      if (existingTitles.has(key)) {
        continue;
      }
      merged.push({
        id: `initiative-${item.id}`,
        bucket: "quality_improvement",
        title: item.title,
        rationale: item.acceptanceHint
          ? `${item.rationale} Next step: ${item.acceptanceHint}`
          : item.rationale,
        source: `initiative:${item.source}`,
        severity: Math.max(2, Math.min(5, item.severity)),
      });
      existingTitles.add(key);
    }
  }

  if (state.opportunityQueue.length > 0) {
    for (const item of state.opportunityQueue.slice(0, state.stopRules.continueAfterSuccess ? 4 : 2)) {
      const key = item.title.trim().toLowerCase();
      if (existingTitles.has(key)) {
        continue;
      }
      merged.push({
        id: `opportunity-${item.id}`,
        bucket: item.track === "exploration" ? "nice_to_have_polish" : "quality_improvement",
        title: item.title,
        rationale: item.rationale,
        source: `opportunity:${item.source}`,
        severity: Math.max(1, Math.min(5, item.severity)),
      });
      existingTitles.add(key);
    }
  }

  return merged
    .sort((left, right) => right.severity - left.severity)
    .slice(0, 12);
}

function remainingMinutes(state: LoopState): number {
  return Math.max(
    0,
    Math.round((new Date(state.budget.deadlineAt).getTime() - Date.now()) / 60_000),
  );
}

function stopForPlateau(history: number[], window: number, threshold: number): boolean {
  if (history.length < window + 1) {
    return false;
  }
  const recent = history.slice(-(window + 1));
  return recent[recent.length - 1]! - recent[0]! <= threshold;
}

function holisticCompletionGaps(
  benchmark: Awaited<ReturnType<typeof loadBenchmarkSpec>>,
  latestJudge: JudgeResult,
): string[] {
  const config = benchmark.productJudge;
  if (!config || config.enabled === false) {
    return [];
  }

  const reasons: string[] = [];
  if (
    config.minimumProductQualityScore !== undefined &&
    latestJudge.productQualityScore !== undefined &&
    latestJudge.productQualityScore < config.minimumProductQualityScore
  ) {
    reasons.push(
      `product quality ${latestJudge.productQualityScore.toFixed(1)} < ${config.minimumProductQualityScore.toFixed(1)}`,
    );
  }

  if (
    config.minimumTechnicalQualityScore !== undefined &&
    latestJudge.technicalQualityScore !== undefined &&
    latestJudge.technicalQualityScore < config.minimumTechnicalQualityScore
  ) {
    reasons.push(
      `technical quality ${latestJudge.technicalQualityScore.toFixed(1)} < ${config.minimumTechnicalQualityScore.toFixed(1)}`,
    );
  }

  if (
    config.maximumSpecQualityGap !== undefined &&
    latestJudge.hiddenCheckScore !== undefined &&
    latestJudge.productQualityScore !== undefined &&
    latestJudge.hiddenCheckScore - latestJudge.productQualityScore > config.maximumSpecQualityGap
  ) {
    reasons.push(
      `spec/product gap ${(latestJudge.hiddenCheckScore - latestJudge.productQualityScore).toFixed(1)} > ${config.maximumSpecQualityGap.toFixed(1)}`,
    );
  }

  if (
    config.minimumValidationScore !== undefined &&
    latestJudge.validationScore !== undefined &&
    latestJudge.validationScore < config.minimumValidationScore
  ) {
    reasons.push(
      `validation score ${latestJudge.validationScore.toFixed(1)} < ${config.minimumValidationScore.toFixed(1)}`,
    );
  }

  if (latestJudge.passedValidation === false) {
    reasons.push("automatic validations are still failing");
  }

  return reasons;
}

function determineStopReason(
  benchmark: Awaited<ReturnType<typeof loadBenchmarkSpec>>,
  state: LoopState,
  latestJudge: JudgeResult,
  maxCycles: number,
  prospectiveScoreHistory = state.scoreHistory,
): string | undefined {
  const holisticGaps = holisticCompletionGaps(benchmark, latestJudge);
  if (
    !state.stopRules.continueAfterSuccess &&
    latestJudge.passedRequired &&
    latestJudge.totalScore >= state.stopRules.successThreshold &&
    latestJudge.regressions.length === 0 &&
    holisticGaps.length === 0 &&
    (!benchmark.requireBaselineImprovement ||
      latestJudge.totalScore > state.baselineScore)
  ) {
    return "success_gate_met";
  }
  if (state.policyId === "single_pass") {
    return "single_pass_complete";
  }
  if (state.cycles.length >= maxCycles) {
    return "max_cycles_reached";
  }
  if (remainingMinutes(state) <= 0) {
    return "budget_exhausted";
  }
  if (
    !state.stopRules.disablePlateau &&
    stopForPlateau(
      prospectiveScoreHistory,
      state.stopRules.plateauWindow,
      state.stopRules.plateauThreshold,
    )
  ) {
    if (holisticGaps.length > 0) {
      return undefined;
    }
    return "score_plateau";
  }
  return undefined;
}

async function persistState(state: LoopState): Promise<void> {
  state.updatedAt = nowIso();
  await writeJson(state.paths.ledgerPath, state);
}

function persistStateSync(state: LoopState): void {
  state.updatedAt = nowIso();
  writeJsonSync(state.paths.ledgerPath, state);
}

async function setLivePhase(
  state: LoopState,
  cycleNumber: number,
  phase: PhaseId,
  summary?: string,
): Promise<void> {
  state.currentCycleNumber = cycleNumber;
  state.currentPhase = phase;
  const phaseSummary = summary ?? `Running ${phase}`;
  state.lastPhaseSummary = phaseSummary;
  state.livePhase = {
    cycleNumber,
    phase,
    updatedAt: nowIso(),
    summary: phaseSummary,
    filesTouched: [],
    commandsRun: [],
    issues: [],
    recentActions: [],
  };
  await persistState(state);
}

async function clearLivePhase(state: LoopState, summary?: string): Promise<void> {
  delete state.currentCycleNumber;
  delete state.currentPhase;
  delete state.livePhase;
  if (summary) {
    state.lastPhaseSummary = summary;
  }
  await persistState(state);
}

async function updateLivePhaseProgress(
  state: LoopState,
  progress: RunnerPhaseProgress,
): Promise<void> {
  state.currentCycleNumber = progress.cycleNumber;
  state.currentPhase = progress.phase;
  state.lastPhaseSummary = progress.summary;
  state.livePhase = {
    cycleNumber: progress.cycleNumber,
    phase: progress.phase,
    updatedAt: nowIso(),
    summary: progress.summary,
    filesTouched: progress.filesTouched ?? [],
    commandsRun: progress.commandsRun ?? [],
    issues: progress.issues ?? [],
    recentActions: progress.recentActions ?? [],
    ...(progress.step !== undefined ? { step: progress.step } : {}),
    ...(progress.stepLimit !== undefined ? { stepLimit: progress.stepLimit } : {}),
    ...(progress.model ? { model: progress.model } : {}),
    ...(progress.primaryModel ? { primaryModel: progress.primaryModel } : {}),
    ...(progress.fallbackModel ? { fallbackModel: progress.fallbackModel } : {}),
    ...(progress.usage ? { usage: progress.usage } : {}),
    ...(progress.branchCandidateId ? { branchCandidateId: progress.branchCandidateId } : {}),
    ...(progress.branchLabel ? { branchLabel: progress.branchLabel } : {}),
  };
  await persistState(state);
}

async function persistArchitectureDirectives(state: LoopState): Promise<void> {
  const directivesPath = path.join(state.paths.artifactsDir, "ARCHITECTURE_DIRECTIVES.md");
  const body = state.architectureDirectives.length
    ? `# Architecture Directives

${state.architectureDirectives.map((directive) => `- ${directive}`).join("\n")}
`
    : `# Architecture Directives

- none yet
`;
  await writeText(directivesPath, body);
}

function persistArchitectureDirectivesSync(state: LoopState): void {
  const directivesPath = path.join(state.paths.artifactsDir, "ARCHITECTURE_DIRECTIVES.md");
  const body = state.architectureDirectives.length
    ? `# Architecture Directives

${state.architectureDirectives.map((directive) => `- ${directive}`).join("\n")}
`
    : `# Architecture Directives

- none yet
`;
  writeTextSync(directivesPath, body);
}

function registerRunInterruptHandlers(state: LoopState): () => void {
  let handled = false;
  const handler = (signal: NodeJS.Signals) => {
    if (handled) {
      return;
    }
    handled = true;
    state.status = "failed";
    state.stopReason = `interrupted:${signal}`;
    state.lastPhaseSummary = `Interrupted by ${signal}`;
    persistArchitectureDirectivesSync(state);
    persistStateSync(state);
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

function mergeArchitectureDirectives(
  state: LoopState,
  record: PhaseRecord | undefined,
): void {
  const directives = record?.output.architectureDirectives ?? [];
  for (const directive of directives) {
    if (!state.architectureDirectives.includes(directive)) {
      state.architectureDirectives.push(directive);
    }
  }
}

async function writePhaseArtifacts(
  directory: string,
  phase: string,
  prompt: string | undefined,
  rawOutput: string | undefined,
): Promise<{ promptPath?: string; rawOutputPath?: string }> {
  await ensureDir(directory);
  let promptPath: string | undefined;
  let rawOutputPath: string | undefined;

  if (prompt) {
    promptPath = path.join(directory, `${phase}.prompt.md`);
    await writeText(promptPath, prompt);
  }
  if (rawOutput) {
    rawOutputPath = path.join(directory, `${phase}.output.md`);
    await writeText(rawOutputPath, rawOutput);
  }

  const output: { promptPath?: string; rawOutputPath?: string } = {};
  if (promptPath) {
    output.promptPath = promptPath;
  }
  if (rawOutputPath) {
    output.rawOutputPath = rawOutputPath;
  }
  return output;
}

async function runRolePhase(
  runner: RunnerAdapter,
  context: RunnerPhaseContext,
  outputDir: string,
  state?: LoopState,
): Promise<PhaseRecord> {
  const startedAt = nowIso();
  const existingOnProgress = context.onProgress;
  const result = await runner.runPhase({
    ...context,
    ...(existingOnProgress || state
      ? {
          onProgress: async (progress) => {
            if (existingOnProgress) {
              await existingOnProgress(progress);
            }
            if (state) {
              await updateLivePhaseProgress(state, {
                ...progress,
                ...(context.branchCandidate
                  ? {
                      branchCandidateId: context.branchCandidate.id,
                      branchLabel: context.branchCandidate.label,
                    }
                  : {}),
              });
            }
          },
        }
      : {}),
  });
  const completedAt = nowIso();
  const git = await getGitSummary(context.repoDir);
  const prompt =
    typeof result.metadata?.prompt === "string"
      ? result.metadata.prompt
      : buildPhasePrompt(context, await listFiles(context.repoDir, { maxDepth: 4 }));
  const artifacts = await writePhaseArtifacts(outputDir, context.phase, prompt, result.rawOutput);

  const record: PhaseRecord = {
    phase: context.phase,
    startedAt,
    completedAt,
    durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
    summary: result.summary,
    output: normalizePhaseOutput(context.phase, result.output),
    gitStatus: git.status,
    gitDiffStat: git.diffStat,
  };
  if (artifacts.promptPath) {
    record.promptPath = artifacts.promptPath;
  }
  if (artifacts.rawOutputPath) {
    record.rawOutputPath = artifacts.rawOutputPath;
  }
  if (result.traces) {
    record.traces = result.traces;
  }
  if (result.metadata) {
    record.metadata = result.metadata;
  }
  return record;
}

function deriveWorkScope(
  previousPhaseOutputs: RunnerPhaseContext["previousPhaseOutputs"],
): Pick<
  RunnerPhaseContext,
  "programWorkItems" | "currentProgramSlice" | "activeWorkItems" | "deferredWorkItems"
> {
  const workBreakdown =
    previousPhaseOutputs.pm_reprioritization?.workBreakdown
    ?? previousPhaseOutputs.planning?.workBreakdown
    ?? previousPhaseOutputs.pm_intake?.workBreakdown
    ?? [];
  const programWorkItems = deriveProgramWorkItems(workBreakdown);
  const activeWorkItems = selectActiveWorkItems(workBreakdown);
  const currentProgramSlice = selectCurrentProgramSlice(workBreakdown, activeWorkItems);
  const deferredWorkItems = selectDeferredWorkItems(workBreakdown, activeWorkItems);

  return {
    ...(programWorkItems.length > 0 ? { programWorkItems } : {}),
    ...(currentProgramSlice ? { currentProgramSlice } : {}),
    ...(activeWorkItems.length > 0 ? { activeWorkItems } : {}),
    ...(deferredWorkItems.length > 0 ? { deferredWorkItems } : {}),
  };
}

function buildJudgingPhaseRecord(
  judge: JudgeResult,
  outputDir: string,
  previousJudge?: JudgeResult,
): PhaseRecord {
  const startedAt = nowIso();
  const completedAt = nowIso();
  const scoreParts = [judge.totalScore.toFixed(1)];
  if (judge.hiddenCheckScore !== undefined) {
    scoreParts.push(`hidden ${judge.hiddenCheckScore.toFixed(1)}`);
  }
  if (judge.productQualityScore !== undefined) {
    scoreParts.push(`product ${judge.productQualityScore.toFixed(1)}`);
  }
  return {
    phase: "judging",
    startedAt,
    completedAt,
    durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
    summary: `Judge scored ${scoreParts.join(" | ")} with ${
      judge.failedChecks.length
    } failing checks.`,
    output: {
      summary: `Judge scored ${scoreParts.join(" | ")} with ${
        judge.failedChecks.length
      } failing checks.`,
      recommendations: judge.recommendations,
      notes: previousJudge
        ? [
            `Previous score was ${previousJudge.totalScore.toFixed(1)}`,
            ...(judge.productReview ? [`Product review: ${judge.productReview.summary}`] : []),
          ]
        : judge.productReview
          ? [`Product review: ${judge.productReview.summary}`]
          : [],
    },
    rawOutputPath: path.join(outputDir, "judging.json"),
    metadata: {
      judge,
      ...(judge.judgeUsage
        ? {
            usage: {
              prompt_tokens: judge.judgeUsage.promptTokens,
              completion_tokens: judge.judgeUsage.completionTokens,
              total_tokens: judge.judgeUsage.totalTokens,
              ...(judge.judgeUsage.costUsd !== undefined ? { cost: judge.judgeUsage.costUsd } : {}),
            },
          }
        : {}),
    },
  };
}

async function runBranchCandidates(
  loaded: LoadedConfig,
  runner: RunnerAdapter,
  state: LoopState,
  cycleNumber: number,
  branchTemplate: BranchTemplate,
  branchCandidates: BranchCandidate[],
  baseContext: Omit<RunnerPhaseContext, "branchCandidate" | "phase" | "repoDir">,
): Promise<BranchRecord[]> {
  const cycleBranchDir = path.join(state.paths.branchesDir, `cycle-${cycleNumber}`);
  await ensureDir(cycleBranchDir);

  const records: BranchRecord[] = [];

  for (const candidate of branchCandidates) {
    const branchDir = path.join(cycleBranchDir, candidate.id);
    const repoDir = path.join(branchDir, "repo");
    await copyDir(state.paths.repoDir, repoDir);

    await setLivePhase(
      state,
      cycleNumber,
      "execution",
      `Branch candidate ${candidate.id}: execution`,
    );
    const execution = await runRolePhase(
      runner,
      {
        ...baseContext,
        repoDir,
        phase: "execution",
        branchCandidate: candidate,
        branchTemplate,
        ...deriveWorkScope(baseContext.previousPhaseOutputs),
      },
      branchDir,
      state,
    );
    await persistArchitectureDirectives(state);
    await persistState(state);
    await setLivePhase(
      state,
      cycleNumber,
      "review",
      `Branch candidate ${candidate.id}: review`,
    );
    const review = await runRolePhase(
      runner,
      {
        ...baseContext,
        repoDir,
        phase: "review",
        branchCandidate: candidate,
        branchTemplate,
        previousPhaseOutputs: {
          ...baseContext.previousPhaseOutputs,
          execution: execution.output,
        },
        ...deriveWorkScope({
          ...baseContext.previousPhaseOutputs,
          execution: execution.output,
        }),
      },
      branchDir,
      state,
    );
    const judge = await judgeRepo(baseContext.benchmark, repoDir, baseContext.previousJudge, {
      artifactsDir: branchDir,
    });
    await writeJudgeArtifact(path.join(branchDir, "judging.json"), judge);

    records.push({
      templateId: branchTemplate.id,
      candidateId: candidate.id,
      label: candidate.label,
      repoDir,
      phases: [execution, review],
      judge,
      score: judge.totalScore,
    });
  }

  records.sort((left, right) => right.score - left.score);
  const keepCount = branchTemplate.maxKeep ?? 2;
  records.forEach((record, index) => {
    record.rank = index + 1;
    record.kept = index < keepCount;
  });

  return records;
}

async function runCycle(
  loaded: LoadedConfig,
  state: LoopState,
  runner: RunnerAdapter,
  maxCycles: number,
): Promise<CycleRecord> {
  const benchmark = await loadBenchmarkSpec(loaded, state.benchmarkId);
  const cycleNumber = state.cycles.length + 1;
  const cycleDir = path.join(state.paths.phasesDir, `cycle-${cycleNumber}`);
  await ensureDir(cycleDir);

  const cycle: CycleRecord = {
    cycleNumber,
    startedAt: nowIso(),
    phases: [],
    branches: [],
    judge: {
      scoredAt: nowIso(),
      totalScore: 0,
      byCategory: {},
      passedRequired: false,
      confidence: 0,
      failedChecks: [],
      passedChecks: [],
      regressions: [],
      recommendations: [],
    },
    priorityQueue: [],
  };
  state.cycles.push(cycle);
  await persistState(state);

  const phaseOutputs: RunnerPhaseContext["previousPhaseOutputs"] = {};
  const visibleBacklog = buildVisibleBacklog(state, benchmark);
  const baseContext = {
    workerId: state.workerId,
    benchmark,
    repoDir: state.paths.repoDir,
    runDir: state.paths.runDir,
    cycleNumber,
    policyId: state.policyId,
    budget: state.budget,
    architectureDirectives: state.architectureDirectives,
    visibleBacklog,
    visibleInitiatives: state.initiativeQueue,
    visibleOpportunities: state.opportunityQueue,
    previousPhaseOutputs: phaseOutputs,
    handoffNotes: state.handoffNotes,
    ...(state.stopRules.continueAfterSuccess ? { continueAfterSuccess: true } : {}),
    ...(state.finalJudge
      ? { previousJudge: state.finalJudge }
      : state.baselineJudge
        ? { previousJudge: state.baselineJudge }
        : {}),
  } satisfies Omit<RunnerPhaseContext, "phase">;

  for (const phase of preExecutionPhasesForCycle(state.policyId, cycleNumber)) {
    await setLivePhase(state, cycleNumber, phase, `Running ${phase}`);
    const record = await runRolePhase(
      runner,
      {
        ...baseContext,
        phase,
        ...deriveWorkScope(phaseOutputs),
      },
      cycleDir,
      state,
    );
    cycle.phases.push(record);
    phaseOutputs[phase] = record.output;
    mergeArchitectureDirectives(state, record);
    mergeStateInitiatives(
      state,
      record.output.initiatives,
      record.output.workBreakdown,
      `${record.phase}:phase`,
      record.output.opportunities,
    );
    mergeStateOpportunities(state, record.output.opportunities);
    await persistArchitectureDirectives(state);
    await persistState(state);
  }

  let judge: JudgeResult;
  const branchPlan = resolveBranchPlan(
    state.policyId,
    benchmark,
    cycleNumber,
    state.usedBranchTemplateIds,
    phaseOutputs.planning?.branchDecision,
  );

  if (branchPlan) {
    const branches = await runBranchCandidates(
      loaded,
      runner,
      state,
      cycleNumber,
      branchPlan.template,
      branchPlan.candidates,
      baseContext,
    );
    cycle.branches = branches;
    state.usedBranchTemplateIds.push(branchPlan.template.id);
    await persistState(state);
    const winner = branches[0];
    if (!winner) {
      throw new Error(`Branch template ${branchPlan.template.id} produced no branches.`);
    }
    cycle.winningBranchId = winner.candidateId;
    await copyDir(winner.repoDir, state.paths.repoDir);
    const branchExecution = winner.phases.find((phase) => phase.phase === "execution");
    if (branchExecution) {
      phaseOutputs.execution = branchExecution.output;
      mergeStateInitiatives(
        state,
        branchExecution.output.initiatives,
        branchExecution.output.workBreakdown,
        "branch:execution",
        branchExecution.output.opportunities,
      );
      mergeStateOpportunities(state, branchExecution.output.opportunities);
    }
    const branchReview = winner.phases.find((phase) => phase.phase === "review");
    if (branchReview) {
      phaseOutputs.review = branchReview.output;
      mergeStateInitiatives(
        state,
        branchReview.output.initiatives,
        branchReview.output.workBreakdown,
        "branch:review",
        branchReview.output.opportunities,
      );
      mergeStateOpportunities(state, branchReview.output.opportunities);
    }
    judge = winner.judge;
  } else {
    for (const phase of ["execution", "review"] satisfies Exclude<PhaseId, "judging">[]) {
      await setLivePhase(state, cycleNumber, phase, `Running ${phase}`);
      const record = await runRolePhase(
        runner,
        {
          ...baseContext,
          phase,
          ...deriveWorkScope(phaseOutputs),
        },
        cycleDir,
        state,
      );
      cycle.phases.push(record);
      phaseOutputs[phase] = record.output;
      mergeStateInitiatives(
        state,
        record.output.initiatives,
        record.output.workBreakdown,
        `${record.phase}:phase`,
        record.output.opportunities,
      );
      mergeStateOpportunities(state, record.output.opportunities);
      await persistState(state);
    }
    judge = await judgeRepo(benchmark, state.paths.repoDir, state.finalJudge, {
      artifactsDir: cycleDir,
    });
    await writeJudgeArtifact(path.join(cycleDir, "judging.json"), judge);
  }

  const reviewOutput = phaseOutputs.review;
  cycle.judge = judge;
  mergeStateInitiatives(
    state,
    undefined,
    reviewOutput?.workBreakdown,
    "judge:carryover",
    judge.productReview?.opportunities,
  );
  mergeStateOpportunities(state, judge.productReview?.opportunities);
  cycle.phases.push(buildJudgingPhaseRecord(judge, cycleDir, state.finalJudge));
  await setLivePhase(
    state,
    cycleNumber,
    "judging",
    `Judge score ${judge.totalScore.toFixed(1)}`,
  );
  await persistState(state);
  const projectedScoreHistory = [...state.scoreHistory, judge.totalScore];
  const terminalStopReason = determineStopReason(
    benchmark,
    state,
    judge,
    maxCycles,
    projectedScoreHistory,
  );

  if (
    getPolicy(state.policyId).phases.includes("pm_reprioritization") &&
    !terminalStopReason
  ) {
    const generatedQueue = buildPriorityQueue(
      judge,
      reviewOutput,
      undefined,
      state.initiativeQueue,
      state.opportunityQueue,
      state.stopRules.continueAfterSuccess === true,
    );
    await setLivePhase(
      state,
      cycleNumber,
      "pm_reprioritization",
      "Running pm_reprioritization",
    );
    const reprioritized = await runRolePhase(
      runner,
      {
        ...baseContext,
        phase: "pm_reprioritization",
        previousJudge: judge,
        visibleBacklog: generatedQueue,
        previousPhaseOutputs: phaseOutputs,
        ...deriveWorkScope(phaseOutputs),
      },
      cycleDir,
      state,
    );
    cycle.phases.push(reprioritized);
    phaseOutputs.pm_reprioritization = reprioritized.output;
    mergeArchitectureDirectives(state, reprioritized);
    mergeStateInitiatives(
      state,
      reprioritized.output.initiatives,
      reprioritized.output.workBreakdown,
      "pm_reprioritization:phase",
      reprioritized.output.opportunities,
    );
    mergeStateOpportunities(state, reprioritized.output.opportunities);
    cycle.priorityQueue = buildPriorityQueue(
      judge,
      reviewOutput,
      reprioritized.output.backlog,
      state.initiativeQueue,
      state.opportunityQueue,
      state.stopRules.continueAfterSuccess === true,
    );
    await persistArchitectureDirectives(state);
    await persistState(state);
  } else {
    cycle.priorityQueue = buildPriorityQueue(
      judge,
      reviewOutput,
      undefined,
      state.initiativeQueue,
      state.opportunityQueue,
      state.stopRules.continueAfterSuccess === true,
    );
  }

  cycle.completedAt = nowIso();
  state.scoreHistory.push(judge.totalScore);
  const stopReason = terminalStopReason;
  if (stopReason) {
    cycle.stopReason = stopReason;
  }
  await clearLivePhase(state, `Completed cycle ${cycleNumber}`);
  return cycle;
}

export async function runLoopExperiment(options: RunLoopOptions): Promise<CellResult> {
  const benchmark = await loadBenchmarkSpec(options.loaded, options.benchmarkId);
  const worker = resolveWorkerConfig(options.loaded, options.workerId);
  const paths = await createRunPaths(
    options.loaded,
    options.benchmarkId,
    options.workerId,
    options.policyId,
  );
  await prepareRunWorkspace(benchmark, paths, options.seedOverride);
  const baselineJudge = await judgeRepo(benchmark, paths.repoDir, undefined, {
    artifactsDir: paths.artifactsDir,
  });
  await writeJudgeArtifact(path.join(paths.artifactsDir, "baseline-judge.json"), baselineJudge);
  const stopRules = createStopRules(options.loaded, benchmark, options);

  const state = buildInitialState(
    benchmark.id,
    benchmark.title,
    options.workerId,
    worker.type,
    options.policyId,
    paths,
    createBudget(options.budgetMinutes),
    stopRules,
    options.initialHandoffNotes ?? [],
    baselineJudge,
    options.initialArchitectureDirectives,
    options.carryoverPriorities,
  );
  await persistState(state);
  if (options.onRunCreated) {
    await options.onRunCreated(state);
  }

  const runner = createRunner(options.loaded, options.workerId);
  const cleanupInterruptHandlers = registerRunInterruptHandlers(state);
  await persistArchitectureDirectives(state);

  try {
    while (!state.stopReason) {
      const cycle = await runCycle(options.loaded, state, runner, options.maxCycles);
      state.priorityQueue = cycle.priorityQueue;
      state.finalJudge = cycle.judge;
      const cycleWorkBreakdown =
        cycle.phases.find((phase) => phase.phase === "pm_reprioritization")?.output.workBreakdown
        ?? cycle.phases.find((phase) => phase.phase === "planning")?.output.workBreakdown
        ?? cycle.phases.find((phase) => phase.phase === "pm_intake")?.output.workBreakdown
        ?? [];
      state.handoffNotes = [
        `Baseline score: ${state.baselineScore.toFixed(1)}`,
        `Latest score: ${cycle.judge.totalScore.toFixed(1)}`,
        ...(cycle.judge.hiddenCheckScore !== undefined
          ? [`Latest hidden-check score: ${cycle.judge.hiddenCheckScore.toFixed(1)}`]
          : []),
        ...(cycle.judge.productQualityScore !== undefined
          ? [`Latest product-quality score: ${cycle.judge.productQualityScore.toFixed(1)}`]
          : []),
        ...(cycle.judge.technicalQualityScore !== undefined
          ? [`Latest technical-quality score: ${cycle.judge.technicalQualityScore.toFixed(1)}`]
          : []),
        ...(cycle.judge.validationScore !== undefined
          ? [`Latest validation score: ${cycle.judge.validationScore.toFixed(1)}`]
          : []),
        `Delta from baseline: ${(cycle.judge.totalScore - state.baselineScore).toFixed(1)}`,
        ...(cycle.winningBranchId ? [`Winning branch: ${cycle.winningBranchId}`] : []),
        ...state.architectureDirectives.map((directive) => `ARCH: ${directive}`),
        ...cycleWorkBreakdown
          .slice(0, 4)
          .map((item) => `WORK: [${item.size}] ${item.title}`),
        ...(state.initiativeQueue.slice(0, 3).map((item) => `INITIATIVE: ${item.title}`)),
        ...(state.opportunityQueue.slice(0, 3).map((item) => `OPPORTUNITY: ${item.title}`)),
        ...(cycle.priorityQueue.slice(0, 5).map((item) => item.title)),
      ];
      if (cycle.stopReason) {
        state.stopReason = cycle.stopReason;
      }
      await persistArchitectureDirectives(state);
      await persistState(state);
      if (state.stopReason) {
        break;
      }
    }
  } catch (error) {
    state.status = "failed";
    state.stopReason =
      error instanceof Error ? `failed:${error.message}` : `failed:${String(error)}`;
    await clearLivePhase(state, "Run failed");
    cleanupInterruptHandlers();
    throw error;
  }

  state.status = "completed";
  await clearLivePhase(state, `Completed run with ${state.cycles.length} cycles`);
  const reportPath = await writeRunArtifacts(state);
  cleanupInterruptHandlers();

  const result = await readJson<CellResult>(state.paths.resultPath);
  if (reportPath) {
    result.reportPath = reportPath;
  }
  await writeJson(state.paths.resultPath, result);
  return result;
}
