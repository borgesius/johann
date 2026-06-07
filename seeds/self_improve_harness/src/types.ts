export type WorkerType = "stub" | "openrouter";
export type AppSmokeTarget = "browser" | "electron";

export type PolicyId =
  | "single_pass"
  | "gated_role_loop"
  | "lean_handoff_loop"
  | "repair_focus_loop"
  | "branch_rank_revise";

export type PhaseId =
  | "pm_intake"
  | "planning"
  | "execution"
  | "review"
  | "judging"
  | "pm_reprioritization";

export type PriorityBucket =
  | "must_fix_regression"
  | "acceptance_gap"
  | "quality_improvement"
  | "nice_to_have_polish";

export type WorkSize = "tiny" | "small" | "medium" | "large" | "oversized";
export type WorkTrack = "delivery" | "exploration";

export interface WorkerConfig {
  type: WorkerType;
  model?: string;
  fallbackModel?: string;
  phaseModels?: Partial<Record<Exclude<PhaseId, "judging">, string>>;
  apiKeyEnv?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  defaultHeaders?: Record<string, string>;
}

export interface HarnessDefaults {
  policy: PolicyId;
  worker: string;
  budgetMinutes: number;
  plateauWindow: number;
  plateauThreshold: number;
}

export interface HarnessConfig {
  version: number;
  runsDir: string;
  reportsDir: string;
  benchmarksDir: string;
  chainsDir?: string;
  workers: Record<string, WorkerConfig>;
  defaults: HarnessDefaults;
}

export interface BranchCandidate {
  id: string;
  label: string;
  promptHint: string;
}

export interface BranchTemplate {
  id: string;
  label: string;
  stage: Extract<PhaseId, "planning">;
  maxKeep?: number;
  candidates: BranchCandidate[];
}

export type HiddenCheckType =
  | "fileExists"
  | "globCount"
  | "globAnyCount"
  | "textIncludes"
  | "globTextIncludes"
  | "commandExitZero"
  | "appSmoke";

export interface HiddenCheck {
  id: string;
  title: string;
  category: string;
  weight: number;
  required?: boolean;
  type: HiddenCheckType;
  path?: string;
  pattern?: string;
  patterns?: string[];
  count?: number;
  includes?: string[];
  mode?: "all" | "any";
  command?: string;
  timeoutSeconds?: number;
  env?: Record<string, string>;
  appTarget?: AppSmokeTarget;
  startCommand?: string;
  url?: string;
  waitForText?: string[];
  waitForSelector?: string;
  electronEntry?: string;
  screenshotName?: string;
}

export interface OpportunityItem {
  id: string;
  title: string;
  rationale: string;
  source: string;
  severity: number;
  track?: WorkTrack;
  acceptanceHint?: string;
}

export interface InitiativeItem {
  id: string;
  title: string;
  rationale: string;
  source: string;
  severity: number;
  track?: WorkTrack;
  acceptanceHint?: string;
  branchHingeHint?: string;
}

export interface ProductJudgeConfig {
  enabled?: boolean;
  workerModel?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  hiddenCheckWeight?: number;
  productQualityWeight?: number;
  minimumProductQualityScore?: number;
  minimumTechnicalQualityScore?: number;
  maximumSpecQualityGap?: number;
  minimumValidationScore?: number;
  rubric?: string[];
}

export interface ProductQualityReview {
  summary: string;
  overallScore: number;
  axes: Record<string, number>;
  findings: string[];
  recommendations: string[];
  opportunities: OpportunityItem[];
  model?: string;
  usage?: TokenUsageSummary;
}

export interface ValidationResult {
  id: string;
  label: string;
  category: "test" | "build" | "lint" | "typecheck";
  command: string;
  passed: boolean;
  exitCode: number;
  summary: string;
  details?: string;
}

export interface BenchmarkBudget {
  minMinutes: number;
  maxMinutes: number;
  defaultMinutes: number;
}

export interface BenchmarkSpec {
  id: string;
  title: string;
  summary: string;
  artifactTarget: string;
  publicBriefFile: string;
  workspaceSeed: string;
  budgets: BenchmarkBudget;
  acceptanceCriteria: string[];
  branchTemplates: BranchTemplate[];
  hiddenChecks: HiddenCheck[];
  judgeWeights: Record<string, number>;
  expectedRoleOutputs: Record<string, string[]>;
  successThreshold: number;
  requireBaselineImprovement?: boolean;
  productJudge?: ProductJudgeConfig;
}

export interface ResolvedBenchmarkSpec extends BenchmarkSpec {
  benchmarkDir: string;
  publicBriefPath: string;
  publicBrief: string;
  workspaceSeedPath: string;
}

export interface StopRules {
  successThreshold: number;
  plateauWindow: number;
  plateauThreshold: number;
  disablePlateau: boolean;
  continueAfterSuccess?: boolean;
}

export interface RunBudget {
  totalMinutes: number;
  startedAt: string;
  deadlineAt: string;
}

export interface PriorityItem {
  id: string;
  bucket: PriorityBucket;
  title: string;
  rationale: string;
  source: string;
  severity: number;
}

export interface BranchDecision {
  shouldBranch?: boolean;
  templateId?: string;
  selectedCandidateIds?: string[];
  rationale?: string;
  proposedHinge?: string;
  proposedCandidates?: BranchCandidate[];
  maxKeep?: number;
}

export interface WorkItem {
  id: string;
  title: string;
  size: WorkSize;
  rationale: string;
  track?: WorkTrack;
  acceptanceHint?: string;
  children?: WorkItem[];
}

export interface StructuredPhaseOutput {
  summary: string;
  confidence?: number;
  backlog?: PriorityItem[];
  workBreakdown?: WorkItem[];
  initiatives?: InitiativeItem[];
  opportunities?: OpportunityItem[];
  acceptanceChecklist?: string[];
  architectureDirectives?: string[];
  risks?: string[];
  branchDecision?: BranchDecision;
  testStrategy?: string[];
  unresolvedIssues?: string[];
  recommendations?: string[];
  commandsRun?: string[];
  filesTouched?: string[];
  notes?: string[];
}

export interface TokenUsageSummary {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd?: number;
}

export interface PhaseUsageSummary extends TokenUsageSummary {
  calls: number;
}

export interface PhaseTraceStep {
  step: number;
  actionType: string;
  action: Record<string, unknown>;
  observationSummary: string;
}

export interface RunnerPhaseProgress {
  cycleNumber: number;
  phase: Exclude<PhaseId, "judging">;
  summary: string;
  step?: number;
  stepLimit?: number;
  model?: string;
  primaryModel?: string;
  fallbackModel?: string;
  usage?: TokenUsageSummary;
  filesTouched?: string[];
  commandsRun?: string[];
  issues?: string[];
  recentActions?: PhaseTraceStep[];
  branchCandidateId?: string;
  branchLabel?: string;
}

export interface LivePhaseState {
  cycleNumber: number;
  phase: PhaseId;
  updatedAt: string;
  summary: string;
  step?: number;
  stepLimit?: number;
  model?: string;
  primaryModel?: string;
  fallbackModel?: string;
  usage?: TokenUsageSummary;
  filesTouched: string[];
  commandsRun: string[];
  issues: string[];
  recentActions: PhaseTraceStep[];
  branchCandidateId?: string;
  branchLabel?: string;
}

export interface PhaseRecord {
  phase: Exclude<PhaseId, "judging"> | "judging";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  summary: string;
  output: StructuredPhaseOutput;
  rawOutputPath?: string;
  promptPath?: string;
  traces?: PhaseTraceStep[];
  gitStatus?: string;
  gitDiffStat?: string;
  metadata?: Record<string, unknown>;
}

export interface JudgeCheckResult {
  check: HiddenCheck;
  passed: boolean;
  score: number;
  message: string;
  details?: string;
}

export interface JudgeResult {
  scoredAt: string;
  totalScore: number;
  hiddenCheckScore?: number;
  productQualityScore?: number;
  technicalQualityScore?: number;
  validationScore?: number;
  judgeUsage?: TokenUsageSummary;
  byCategory: Record<string, number>;
  passedRequired: boolean;
  passedValidation?: boolean;
  confidence: number;
  failedChecks: JudgeCheckResult[];
  passedChecks: JudgeCheckResult[];
  regressions: string[];
  recommendations: string[];
  productReview?: ProductQualityReview;
  validationResults?: ValidationResult[];
}

export interface BranchRecord {
  templateId: string;
  candidateId: string;
  label: string;
  repoDir: string;
  phases: PhaseRecord[];
  judge: JudgeResult;
  score: number;
  rank?: number;
  kept?: boolean;
}

export interface CycleRecord {
  cycleNumber: number;
  startedAt: string;
  completedAt?: string;
  phases: PhaseRecord[];
  branches: BranchRecord[];
  judge: JudgeResult;
  priorityQueue: PriorityItem[];
  winningBranchId?: string;
  stopReason?: string;
}

export interface RunPaths {
  runDir: string;
  repoDir: string;
  inputDir: string;
  phasesDir: string;
  branchesDir: string;
  reportsDir: string;
  artifactsDir: string;
  ledgerPath: string;
  resultPath: string;
}

export interface LoopState {
  runId: string;
  benchmarkId: string;
  benchmarkTitle: string;
  workerId: string;
  workerType: WorkerType;
  policyId: PolicyId;
  createdAt: string;
  updatedAt: string;
  status: "running" | "completed" | "failed";
  budget: RunBudget;
  stopRules: StopRules;
  paths: RunPaths;
  baselineScore: number;
  baselineJudge?: JudgeResult;
  scoreHistory: number[];
  usedBranchTemplateIds: string[];
  cycles: CycleRecord[];
  priorityQueue: PriorityItem[];
  opportunityQueue: OpportunityItem[];
  initiativeQueue: InitiativeItem[];
  carryoverPriorities: PriorityItem[];
  architectureDirectives: string[];
  handoffNotes: string[];
  currentCycleNumber?: number;
  currentPhase?: PhaseId;
  livePhase?: LivePhaseState;
  lastPhaseSummary?: string;
  stopReason?: string;
  finalJudge?: JudgeResult;
}

export interface CellResult {
  runId: string;
  benchmarkId: string;
  workerId: string;
  policyId: PolicyId;
  baselineScore: number;
  scoreDelta: number;
  score: number;
  successThreshold?: number;
  plateauWindow?: number;
  plateauThreshold?: number;
  disablePlateau?: boolean;
  continueAfterSuccess?: boolean;
  hiddenCheckScore?: number;
  productQualityScore?: number;
  technicalQualityScore?: number;
  validationScore?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  executionTokens?: number;
  coordinationTokens?: number;
  executionCostUsd?: number;
  coordinationCostUsd?: number;
  phaseUsage?: Partial<Record<PhaseId, PhaseUsageSummary>>;
  tokensPerScoreDelta?: number;
  stopReason?: string;
  finalJudge: JudgeResult;
  resultPath: string;
  ledgerPath: string;
  reportPath?: string;
}

export interface ExperimentReportRow {
  runId: string;
  benchmarkId: string;
  workerId: string;
  policyId: PolicyId;
  baselineScore: number;
  scoreDelta: number;
  score: number;
  successThreshold?: number;
  plateauWindow?: number;
  plateauThreshold?: number;
  disablePlateau?: boolean;
  continueAfterSuccess?: boolean;
  hiddenCheckScore?: number;
  productQualityScore?: number;
  technicalQualityScore?: number;
  validationScore?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  executionTokens?: number;
  coordinationTokens?: number;
  executionCostUsd?: number;
  coordinationCostUsd?: number;
  tokensPerScoreDelta?: number;
  stopReason?: string;
  cycles: number;
}

export interface ExperimentReport {
  generatedAt: string;
  rows: ExperimentReportRow[];
  latestByCombo: ExperimentReportRow[];
}

export interface ChainStageState {
  benchmarkId: string;
  status: "pending" | "running" | "completed" | "failed";
  runId?: string;
  ledgerPath?: string;
  score?: number;
  stopReason?: string;
}

export interface ChainSummary {
  totalTokens: number;
  executionTokens: number;
  coordinationTokens: number;
  costUsd: number;
  executionCostUsd: number;
  coordinationCostUsd: number;
  finalScore: number | null;
  minStageScore: number | null;
  averageScore: number | null;
}

export interface ChainState {
  chainRunId: string;
  label?: string;
  createdAt: string;
  updatedAt: string;
  status: "running" | "completed" | "failed";
  workerId: string;
  policyId: PolicyId;
  budgetMinutes: number;
  maxCycles: number;
  benchmarks: string[];
  stopRules: StopRules;
  chainPath: string;
  stages: ChainStageState[];
  currentStageIndex?: number;
  currentBenchmarkId?: string;
  currentRunId?: string;
  stopReason?: string;
  summary?: ChainSummary;
}

export interface RunnerPhaseContext {
  workerId: string;
  benchmark: ResolvedBenchmarkSpec;
  phase: Exclude<PhaseId, "judging">;
  repoDir: string;
  runDir: string;
  cycleNumber: number;
  policyId: PolicyId;
  budget: RunBudget;
  architectureDirectives: string[];
  branchCandidate?: BranchCandidate;
  branchTemplate?: BranchTemplate;
  visibleBacklog: PriorityItem[];
  visibleInitiatives?: InitiativeItem[];
  visibleOpportunities?: OpportunityItem[];
  programWorkItems?: WorkItem[];
  currentProgramSlice?: WorkItem;
  activeWorkItems?: WorkItem[];
  deferredWorkItems?: WorkItem[];
  previousJudge?: JudgeResult;
  previousPhaseOutputs: Partial<Record<Exclude<PhaseId, "judging">, StructuredPhaseOutput>>;
  handoffNotes: string[];
  continueAfterSuccess?: boolean;
  onProgress?: (progress: RunnerPhaseProgress) => Promise<void> | void;
}

export interface RunnerPhaseResult {
  summary: string;
  output: StructuredPhaseOutput;
  rawOutput?: string;
  traces?: PhaseTraceStep[];
  metadata?: Record<string, unknown>;
}

export interface RunnerAdapter {
  runPhase(context: RunnerPhaseContext): Promise<RunnerPhaseResult>;
}

export interface LoadedConfig {
  rootDir: string;
  configPath: string;
  config: HarnessConfig;
}

export interface PolicyDefinition {
  id: PolicyId;
  title: string;
  description: string;
  phases: PhaseId[];
  branching: "off" | "template_first_cycle";
}
