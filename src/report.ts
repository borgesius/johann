import path from "node:path";
import fs from "node:fs/promises";
import type {
  CellResult,
  ExperimentReport,
  ExperimentReportRow,
  LoadedConfig,
  LoopState,
  PhaseId,
  PhaseUsageSummary,
} from "./types.js";
import { summarizeActualWork, summarizeWorkBreakdown } from "./sizing.js";
import { formatScore, pathExists, readJson, writeJson, writeText } from "./utils.js";

function aggregateUsageByPhase(state: LoopState): Partial<Record<PhaseId, PhaseUsageSummary>> {
  const usageByPhase: Partial<Record<PhaseId, PhaseUsageSummary>> = {};
  const phaseGroups = [
    ...state.cycles.flatMap((cycle) => cycle.phases),
    ...state.cycles.flatMap((cycle) => cycle.branches.flatMap((branch) => branch.phases)),
  ];

  for (const phase of phaseGroups) {
    const usage = phase.metadata?.usage;
    if (!usage || typeof usage !== "object") {
      continue;
    }
    const record = usage as Record<string, unknown>;
    const phaseUsage = usageByPhase[phase.phase] ?? {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      calls: 0,
    };
    phaseUsage.promptTokens +=
      typeof record.prompt_tokens === "number" ? record.prompt_tokens : 0;
    phaseUsage.completionTokens +=
      typeof record.completion_tokens === "number" ? record.completion_tokens : 0;
    phaseUsage.totalTokens += typeof record.total_tokens === "number" ? record.total_tokens : 0;
    phaseUsage.costUsd = (phaseUsage.costUsd ?? 0) + (typeof record.cost === "number" ? record.cost : 0);
    phaseUsage.calls += 1;
    usageByPhase[phase.phase] = phaseUsage;
  }

  return usageByPhase;
}

function aggregateUsage(state: LoopState): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  executionTokens: number;
  coordinationTokens: number;
  executionCostUsd: number;
  coordinationCostUsd: number;
  phaseUsage: Partial<Record<PhaseId, PhaseUsageSummary>>;
} {
  const phaseUsage = aggregateUsageByPhase(state);
  const combined = Object.values(phaseUsage).reduce(
    (accumulator, current) => ({
      promptTokens: accumulator.promptTokens + current.promptTokens,
      completionTokens: accumulator.completionTokens + current.completionTokens,
      totalTokens: accumulator.totalTokens + current.totalTokens,
      costUsd: accumulator.costUsd + (current.costUsd ?? 0),
    }),
    { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 },
  );
  const executionTokens = phaseUsage.execution?.totalTokens ?? 0;
  const executionCostUsd = phaseUsage.execution?.costUsd ?? 0;
  return {
    ...combined,
    executionTokens,
    coordinationTokens: combined.totalTokens - executionTokens,
    executionCostUsd,
    coordinationCostUsd: combined.costUsd - executionCostUsd,
    phaseUsage,
  };
}

export function renderRunReport(state: LoopState): string {
  const usage = aggregateUsage(state);
  const scoreDelta = (state.finalJudge?.totalScore ?? 0) - state.baselineScore;
  const tokensPerScoreDelta =
    scoreDelta > 0 ? Number((usage.totalTokens / scoreDelta).toFixed(1)) : undefined;
  const finalReview = state.finalJudge?.metaReview ?? state.finalJudge?.productReview;
  const cycleLines = state.cycles
    .map((cycle) => {
      const planningBreakdown =
        cycle.phases.find((phase) => phase.phase === "planning")?.output.workBreakdown
        ?? cycle.phases.find((phase) => phase.phase === "pm_intake")?.output.workBreakdown
        ?? [];
      const breakdownSummary = summarizeWorkBreakdown(planningBreakdown);
      const actualWork = summarizeActualWork(cycle);
      const branches = cycle.branches.length
        ? `Branches: ${cycle.branches
            .map(
              (branch) =>
                `${branch.candidateId}=${formatScore(branch.score)}${branch.kept ? " (kept)" : ""}`,
            )
            .join(", ")}`
        : "Branches: none";
      return `## Cycle ${cycle.cycleNumber}

- Judge score: ${formatScore(cycle.judge.totalScore)}
- Passed required checks: ${cycle.judge.passedRequired}
- Stop reason: ${cycle.stopReason ?? "continue"}
- Priority queue size: ${cycle.priorityQueue.length}
- Planned breakdown: ${breakdownSummary.itemCount > 0
  ? `${breakdownSummary.leafCount} leaves, max depth ${breakdownSummary.maxDepth}, largest leaf ${breakdownSummary.largestLeafSize ?? "n/a"}, ${breakdownSummary.estimatedPoints} points`
  : "none"}
- Actual work: ${actualWork.size} (${actualWork.uniqueFilesTouched} files, ${actualWork.commandsRun} commands, ${actualWork.branchCandidates} branches)
- ${branches}
`;
    })
    .join("\n");

  return `# ${state.benchmarkTitle}

- Run ID: ${state.runId}
- Worker: ${state.workerId}
- Policy: ${state.policyId}
- Status: ${state.status}
- Stop reason: ${state.stopReason ?? "n/a"}
- Baseline score: ${formatScore(state.baselineScore)}
- Final score: ${formatScore(state.finalJudge?.totalScore ?? 0)}
- Hidden-check score: ${state.finalJudge?.hiddenCheckScore !== undefined ? formatScore(state.finalJudge.hiddenCheckScore) : "n/a"}
- Product-quality score: ${state.finalJudge?.productQualityScore !== undefined ? formatScore(state.finalJudge.productQualityScore) : "n/a"}
- Technical-quality score: ${state.finalJudge?.technicalQualityScore !== undefined ? formatScore(state.finalJudge.technicalQualityScore) : "n/a"}
- Validation score: ${state.finalJudge?.validationScore !== undefined ? formatScore(state.finalJudge.validationScore) : "n/a"}
- Score delta: ${formatScore(scoreDelta)}
- Cycles: ${state.cycles.length}

## Usage

- Success threshold: ${state.stopRules.successThreshold.toFixed(1)}
- Plateau stop: ${state.stopRules.disablePlateau ? "disabled" : `window=${state.stopRules.plateauWindow}, threshold=${state.stopRules.plateauThreshold.toFixed(1)}`}
- Continue after success: ${state.stopRules.continueAfterSuccess ? "enabled" : "disabled"}
- Prompt tokens: ${usage.promptTokens}
- Completion tokens: ${usage.completionTokens}
- Total tokens: ${usage.totalTokens}
- Estimated cost (USD): ${usage.costUsd.toFixed(6)}
- Execution tokens: ${usage.executionTokens}
- Coordination tokens: ${usage.coordinationTokens}
- Execution cost (USD): ${usage.executionCostUsd.toFixed(6)}
- Coordination cost (USD): ${usage.coordinationCostUsd.toFixed(6)}
- Tokens per score-delta point: ${tokensPerScoreDelta ?? "n/a"}

## Phase Usage

${Object.entries(usage.phaseUsage).length > 0
  ? Object.entries(usage.phaseUsage)
      .map(
        ([phase, phaseUsage]) =>
          `- ${phase}: ${phaseUsage.totalTokens} total (${phaseUsage.promptTokens} prompt / ${phaseUsage.completionTokens} completion), $${(phaseUsage.costUsd ?? 0).toFixed(6)} across ${phaseUsage.calls} phase runs`,
      )
      .join("\n")
  : "- none"}

## Score History

${state.scoreHistory.length > 0 ? state.scoreHistory.map((score) => `- ${formatScore(score)}`).join("\n") : "- none"}

${state.finalJudge?.validationResults && state.finalJudge.validationResults.length > 0
  ? `## Automatic Validation

${state.finalJudge.validationResults
  .map(
    (result) =>
      `- [${result.category}] ${result.label}: ${result.passed ? "passed" : "failed"} via \`${result.command}\`${result.details ? `\n  details: ${result.details}` : ""}`,
  )
  .join("\n")}

`
  : ""}${finalReview
  ? `## Final Product Review

- Summary: ${finalReview.summary}
- Trajectory: ${finalReview.trajectory ?? "n/a"}
- Satisfaction: ${finalReview.satisfaction ?? "n/a"}
- Next step thesis: ${finalReview.nextStepThesis ?? "n/a"}
- Evaluation plan: ${finalReview.evaluationPlan && finalReview.evaluationPlan.length > 0 ? finalReview.evaluationPlan.join("; ") : "none"}
- Long-horizon plan: ${finalReview.longHorizonPlan && finalReview.longHorizonPlan.length > 0 ? finalReview.longHorizonPlan.join("; ") : "none"}
- Improvement hypotheses: ${finalReview.improvementHypotheses && finalReview.improvementHypotheses.length > 0 ? finalReview.improvementHypotheses.join("; ") : "none"}
- Findings: ${finalReview.findings.length > 0 ? finalReview.findings.join("; ") : "none"}
- Recommendations: ${finalReview.recommendations.length > 0 ? finalReview.recommendations.join("; ") : "none"}
- Opportunities: ${finalReview.opportunities.length > 0 ? finalReview.opportunities.map((item) => item.title).join("; ") : "none"}

`
  : ""}${cycleLines}
`;
}

export async function writeRunArtifacts(state: LoopState): Promise<string> {
  const usage = aggregateUsage(state);
  const reportPath = path.join(state.paths.reportsDir, "run-report.md");
  await writeText(reportPath, renderRunReport(state));

  const cell: CellResult = {
    runId: state.runId,
    benchmarkId: state.benchmarkId,
    workerId: state.workerId,
    policyId: state.policyId,
    baselineScore: state.baselineScore,
    scoreDelta: (state.finalJudge?.totalScore ?? 0) - state.baselineScore,
    score: state.finalJudge?.totalScore ?? 0,
    ...(state.finalJudge?.hiddenCheckScore !== undefined
      ? { hiddenCheckScore: state.finalJudge.hiddenCheckScore }
      : {}),
    ...(state.finalJudge?.productQualityScore !== undefined
      ? { productQualityScore: state.finalJudge.productQualityScore }
      : {}),
    ...(state.finalJudge?.technicalQualityScore !== undefined
      ? { technicalQualityScore: state.finalJudge.technicalQualityScore }
      : {}),
    ...(state.finalJudge?.validationScore !== undefined
      ? { validationScore: state.finalJudge.validationScore }
      : {}),
    successThreshold: state.stopRules.successThreshold,
    plateauWindow: state.stopRules.plateauWindow,
    plateauThreshold: state.stopRules.plateauThreshold,
    disablePlateau: state.stopRules.disablePlateau,
    continueAfterSuccess: state.stopRules.continueAfterSuccess === true,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    costUsd: usage.costUsd,
    executionTokens: usage.executionTokens,
    coordinationTokens: usage.coordinationTokens,
    executionCostUsd: usage.executionCostUsd,
    coordinationCostUsd: usage.coordinationCostUsd,
    phaseUsage: usage.phaseUsage,
    ...(state.finalJudge && state.finalJudge.totalScore > state.baselineScore
      ? {
          tokensPerScoreDelta: Number(
            (usage.totalTokens / (state.finalJudge.totalScore - state.baselineScore)).toFixed(1),
          ),
        }
      : {}),
    finalJudge: state.finalJudge ?? {
      scoredAt: state.createdAt,
      totalScore: 0,
      byCategory: {},
      passedRequired: false,
      confidence: 0,
      failedChecks: [],
      passedChecks: [],
      regressions: [],
      recommendations: [],
    },
    resultPath: state.paths.resultPath,
    ledgerPath: state.paths.ledgerPath,
    reportPath,
  };
  if (state.stopReason) {
    cell.stopReason = state.stopReason;
  }
  await writeJson(state.paths.resultPath, cell);
  return reportPath;
}

export async function collectRunResults(loaded: LoadedConfig): Promise<ExperimentReport> {
  const runsRoot = path.join(loaded.rootDir, loaded.config.runsDir);
  const rows: ExperimentReportRow[] = [];

  if (!(await pathExists(runsRoot))) {
    return {
      generatedAt: new Date().toISOString(),
      rows,
      latestByCombo: rows,
    };
  }

  const runDirs = await fs.readdir(runsRoot, { withFileTypes: true });
  for (const dir of runDirs) {
    if (!dir.isDirectory()) {
      continue;
    }
    const resultPath = path.join(runsRoot, dir.name, "result.json");
    if (!(await pathExists(resultPath))) {
      continue;
    }
    const result = await readJson<CellResult>(resultPath);
    const ledger = await readJson<LoopState>(result.ledgerPath);
    const baselineScore =
      typeof result.baselineScore === "number" ? result.baselineScore : ledger.baselineScore ?? 0;
    const row: ExperimentReportRow = {
      runId: result.runId,
      benchmarkId: result.benchmarkId,
      workerId: result.workerId,
      policyId: result.policyId,
      baselineScore,
      scoreDelta:
        typeof result.scoreDelta === "number" ? result.scoreDelta : result.score - baselineScore,
      score: result.score,
      ...(typeof result.successThreshold === "number"
        ? { successThreshold: result.successThreshold }
        : {}),
      ...(typeof result.plateauWindow === "number"
        ? { plateauWindow: result.plateauWindow }
        : {}),
      ...(typeof result.plateauThreshold === "number"
        ? { plateauThreshold: result.plateauThreshold }
        : {}),
      ...(typeof result.disablePlateau === "boolean"
        ? { disablePlateau: result.disablePlateau }
        : {}),
      ...(typeof result.continueAfterSuccess === "boolean"
        ? { continueAfterSuccess: result.continueAfterSuccess }
        : {}),
      ...(typeof result.hiddenCheckScore === "number"
        ? { hiddenCheckScore: result.hiddenCheckScore }
        : {}),
      ...(typeof result.productQualityScore === "number"
        ? { productQualityScore: result.productQualityScore }
        : {}),
      ...(typeof result.technicalQualityScore === "number"
        ? { technicalQualityScore: result.technicalQualityScore }
        : {}),
      ...(typeof result.validationScore === "number"
        ? { validationScore: result.validationScore }
        : {}),
      ...(typeof result.promptTokens === "number" ? { promptTokens: result.promptTokens } : {}),
      ...(typeof result.completionTokens === "number"
        ? { completionTokens: result.completionTokens }
        : {}),
      ...(typeof result.totalTokens === "number" ? { totalTokens: result.totalTokens } : {}),
      ...(typeof result.costUsd === "number" ? { costUsd: result.costUsd } : {}),
      ...(typeof result.executionTokens === "number"
        ? { executionTokens: result.executionTokens }
        : {}),
      ...(typeof result.coordinationTokens === "number"
        ? { coordinationTokens: result.coordinationTokens }
        : {}),
      ...(typeof result.executionCostUsd === "number"
        ? { executionCostUsd: result.executionCostUsd }
        : {}),
      ...(typeof result.coordinationCostUsd === "number"
        ? { coordinationCostUsd: result.coordinationCostUsd }
        : {}),
      ...(typeof result.tokensPerScoreDelta === "number"
        ? { tokensPerScoreDelta: result.tokensPerScoreDelta }
        : {}),
      cycles: ledger.cycles.length,
    };
    if (result.stopReason) {
      row.stopReason = result.stopReason;
    }
    rows.push(row);
  }

  rows.sort((left, right) => right.score - left.score);
  const latestByComboMap = new Map<string, ExperimentReportRow>();
  for (const row of rows) {
    const key = `${row.benchmarkId}|${row.workerId}|${row.policyId}`;
    const current = latestByComboMap.get(key);
    if (!current || row.runId > current.runId) {
      latestByComboMap.set(key, row);
    }
  }
  const latestByCombo = [...latestByComboMap.values()].sort((left, right) =>
    [left.benchmarkId, left.workerId, left.policyId].join("|").localeCompare(
      [right.benchmarkId, right.workerId, right.policyId].join("|"),
    ),
  );
  return {
    generatedAt: new Date().toISOString(),
    rows,
    latestByCombo,
  };
}
