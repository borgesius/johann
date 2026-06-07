import type {
  JudgeCheckResult,
  JudgeResult,
  OpportunityItem,
  ProductJudgeConfig,
  ProductQualityReview,
  ResolvedBenchmarkSpec,
  TokenUsageSummary,
  ValidationResult,
} from "./types.js";
import {
  extractJsonObject,
  listFiles,
  pathExists,
  readFilesPreview,
  truncate,
} from "./utils.js";

type EffectiveProductJudgeConfig = {
  workerModel: string;
  apiKeyEnv: string;
  baseUrl: string;
  temperature: number;
  maxTokens: number;
  hiddenCheckWeight: number;
  productQualityWeight: number;
  minimumProductQualityScore?: number;
  minimumTechnicalQualityScore?: number;
  maximumSpecQualityGap?: number;
  minimumValidationScore?: number;
  rubric: string[];
};

type OpenRouterMessage = {
  role: "system" | "user";
  content: string;
};

type OpenRouterUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
};

type RepoSignals = {
  srcFiles: number;
  configFiles: number;
  docsFiles: number;
  testFiles: number;
  shellFiles: number;
  coreImplementationFiles: number;
  surfaceModuleFiles: number;
  logicModuleFiles: number;
  sharedSystemFiles: number;
  featureIslandPairs: number;
  entrypointFile?: string;
  entrypointLineCount: number;
  entrypointUseStateCount: number;
  entrypointLocalImportCount: number;
  trivialTestSignals: string[];
  placeholderSignals: string[];
  trivialSurfaceSignals: string[];
  scaffoldHeavy: boolean;
  runtimeValidationFailed: boolean;
};

const DEFAULT_PRODUCT_JUDGE: EffectiveProductJudgeConfig = {
  workerModel: "qwen/qwen3-coder-flash",
  apiKeyEnv: "OPENROUTER_API_KEY",
  baseUrl: "https://openrouter.ai/api/v1/chat/completions",
  temperature: 0.15,
  maxTokens: 1800,
  hiddenCheckWeight: 0.6,
  productQualityWeight: 0.4,
  rubric: [
    "Judge product quality, not simple file existence. Hidden checks already cover the checklist floor.",
    "Reward depth of the core loop, architecture coherence, UX or operator-flow clarity, and evidence of meaningful iteration.",
    "Penalize generic templates, shallow shells, disconnected features, overgrown orchestration files, and products that technically exist but feel empty.",
    "Prefer fewer deeper systems over a pile of loosely connected tools, panels, or demos.",
  ],
};

export function resolveProductJudgeConfig(
  benchmark: ResolvedBenchmarkSpec,
): EffectiveProductJudgeConfig | undefined {
  const configured = benchmark.productJudge;
  if (configured?.enabled === false) {
    return undefined;
  }

  return {
    workerModel: configured?.workerModel ?? DEFAULT_PRODUCT_JUDGE.workerModel,
    apiKeyEnv: configured?.apiKeyEnv ?? DEFAULT_PRODUCT_JUDGE.apiKeyEnv,
    baseUrl: configured?.baseUrl ?? DEFAULT_PRODUCT_JUDGE.baseUrl,
    temperature: configured?.temperature ?? DEFAULT_PRODUCT_JUDGE.temperature,
    maxTokens: configured?.maxTokens ?? DEFAULT_PRODUCT_JUDGE.maxTokens,
    hiddenCheckWeight:
      configured?.hiddenCheckWeight ?? DEFAULT_PRODUCT_JUDGE.hiddenCheckWeight,
    productQualityWeight:
      configured?.productQualityWeight ?? DEFAULT_PRODUCT_JUDGE.productQualityWeight,
    ...(configured?.minimumProductQualityScore !== undefined
      ? { minimumProductQualityScore: configured.minimumProductQualityScore }
      : {}),
    ...(configured?.minimumTechnicalQualityScore !== undefined
      ? { minimumTechnicalQualityScore: configured.minimumTechnicalQualityScore }
      : {}),
    ...(configured?.maximumSpecQualityGap !== undefined
      ? { maximumSpecQualityGap: configured.maximumSpecQualityGap }
      : {}),
    ...(configured?.minimumValidationScore !== undefined
      ? { minimumValidationScore: configured.minimumValidationScore }
      : {}),
    rubric: configured?.rubric?.length
      ? configured.rubric
      : DEFAULT_PRODUCT_JUDGE.rubric,
  };
}

function normalizeUsage(usage: OpenRouterUsage | undefined): TokenUsageSummary | undefined {
  if (!usage) {
    return undefined;
  }
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? promptTokens + completionTokens;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(typeof usage.cost === "number" ? { costUsd: usage.cost } : {}),
  };
}

function clampScore(value: unknown, fallback: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(100, Number(value.toFixed(1))));
}

function clampSeverity(value: unknown, fallback = 2): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(5, Math.round(value)));
}

function normalizeStringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const output = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  return output.length > 0 ? output.slice(0, 8) : fallback;
}

function normalizeAxes(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, score]) => typeof score === "number" && Number.isFinite(score))
      .map(([label, score]) => [label, clampScore(score, 0)]),
  );
}

function normalizeOpportunity(
  raw: unknown,
  index: number,
): OpportunityItem | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  if (!title) {
    return undefined;
  }
  const source =
    typeof record.source === "string" && record.source.trim().length > 0
      ? record.source.trim()
      : "product-judge";
  const track =
    record.track === "exploration" || record.track === "delivery"
      ? record.track
      : "delivery";
  const rationale =
    typeof record.rationale === "string" && record.rationale.trim().length > 0
      ? record.rationale.trim()
      : "Generated from the product-quality judge.";
  const acceptanceHint =
    typeof record.acceptanceHint === "string" && record.acceptanceHint.trim().length > 0
      ? record.acceptanceHint.trim()
      : undefined;

  return {
    id:
      typeof record.id === "string" && record.id.trim().length > 0
        ? record.id.trim()
        : `product-opportunity-${index + 1}`,
    title,
    rationale,
    source,
    severity: clampSeverity(record.severity),
    track,
    ...(acceptanceHint ? { acceptanceHint } : {}),
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

function prioritizePreviewFiles(repoTree: string[]): string[] {
  const scoreFile = (file: string): number => {
    let score = 0;
    const lower = file.toLowerCase();
    if (lower === "package.json") {
      score += 200;
    }
    if (lower === "readme.md") {
      score += 190;
    }
    if (lower === "tsconfig.json" || lower === "vite.config.ts" || lower === "vitest.config.ts") {
      score += 120;
    }
    if (lower.startsWith("src/")) {
      score += 110;
    }
    if (
      /src\/(main|preload|renderer|app|index|server|routes|pages|components|features|systems|lib)\b/.test(
        lower,
      )
    ) {
      score += 120;
    }
    if (/test|spec/.test(lower)) {
      score += 90;
    }
    if (lower.startsWith("docs/")) {
      score += 70;
    }
    if (lower.endsWith(".md")) {
      score += 35;
    }
    if (lower.includes("generated") || lower.includes("snapshot")) {
      score -= 60;
    }
    return score - file.length / 120;
  };

  return repoTree
    .filter((entry) => !entry.endsWith("/"))
    .sort((left, right) => scoreFile(right) - scoreFile(left))
    .slice(0, 14);
}

function summarizeFailedChecks(failedChecks: JudgeCheckResult[]): string {
  if (failedChecks.length === 0) {
    return "- none";
  }
  return failedChecks
    .slice(0, 6)
    .map((entry) => `- ${entry.check.title}: ${entry.message}`)
    .join("\n");
}

function summarizePreviousProduct(previousJudge?: JudgeResult): string {
  if (!previousJudge?.productReview) {
    return "- none";
  }
  const review = previousJudge.productReview;
  return [
    `- score: ${review.overallScore.toFixed(1)}`,
    `- summary: ${review.summary}`,
    review.findings.length > 0 ? `- findings: ${review.findings.slice(0, 4).join("; ")}` : undefined,
    review.recommendations.length > 0
      ? `- recommendations: ${review.recommendations.slice(0, 4).join("; ")}`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function summarizeValidationResults(validationResults: ValidationResult[]): string {
  if (validationResults.length === 0) {
    return "- none";
  }
  return validationResults
    .map((result) => {
      const details = result.details ? `\n  details: ${result.details}` : "";
      return `- [${result.category}] ${result.label}: ${result.passed ? "passed" : "failed"} via \`${result.command}\`${details}`;
    })
    .join("\n");
}

function collectRepoSignals(
  repoTree: string[],
  previews: Record<string, string>,
  validationResults: ValidationResult[],
): RepoSignals {
  const files = repoTree.filter((entry) => !entry.endsWith("/"));
  const srcFiles = files.filter((file) => file.startsWith("src/"));
  const docsFiles = files.filter((file) => file === "README.md" || file.startsWith("docs/"));
  const testFiles = files.filter((file) => /(^|\/)(__tests__|test|tests)\//.test(file) || /\.(test|spec)\./.test(file));
  const configFiles = files.filter((file) =>
    /(^|\/)(package\.json|tsconfig\.json|vite\.config|vitest\.config|jest\.config|eslint|\.gitignore|pnpm-lock|package-lock|yarn\.lock)/i.test(file),
  );
  const shellFiles = files.filter((file) =>
    /^src\/(main|preload)\.[^/]+$/.test(file)
    || /^src\/renderer\/(index\.(html|tsx?|jsx?)|renderer\.(ts|js|tsx|jsx)|styles?\.(css|scss))$/.test(file),
  );
  const coreImplementationFiles = srcFiles.filter((file) => {
    if (shellFiles.includes(file)) {
      return false;
    }
    if (/(^|\/)(__tests__|test|tests)\//.test(file) || /\.(test|spec)\./.test(file)) {
      return false;
    }
    return /\.(ts|tsx|js|jsx|json)$/.test(file);
  });
  const surfaceModuleFiles = srcFiles.filter((file) =>
    /\.(tsx|jsx)$/.test(file)
    && !/(^|\/)(__tests__|test|tests)\//.test(file)
    && (
      /(^|\/)(components|pages|screens|views|routes|app)\//.test(file)
      || /(^|\/)(App|.*UI)\.(tsx|jsx)$/.test(file)
    ),
  );
  const logicModuleFiles = coreImplementationFiles.filter((file) =>
    /\.(ts|js)$/.test(file)
    || /(^|\/)(lib|domain|store|state|data|engine|sim|system|model|models|services|hooks)\//.test(file),
  );
  const sharedSystemFiles = logicModuleFiles.filter((file) =>
    /(^|\/)(lib|domain|store|state|data|engine|sim|system|model|models|services|hooks)\//.test(file),
  );
  const normalizedFeatureBase = (file: string): string => {
    const base = file.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
    return base.replace(/UI$/, "").toLowerCase();
  };
  const ignoredFeatureBases = new Set([
    "app",
    "main",
    "index",
    "renderer",
    "page",
    "layout",
    "navigation",
  ]);
  const surfaceBases = new Set(
    surfaceModuleFiles
      .map(normalizedFeatureBase)
      .filter((base) => base.length > 0 && !ignoredFeatureBases.has(base)),
  );
  const logicBases = new Set(
    logicModuleFiles
      .map(normalizedFeatureBase)
      .filter((base) => base.length > 0 && !ignoredFeatureBases.has(base)),
  );
  const featureIslandPairs = [...surfaceBases].filter((base) => logicBases.has(base)).length;
  const entrypointFile = [
    "src/App.tsx",
    "src/App.jsx",
    "src/main.tsx",
    "src/main.jsx",
    "src/index.tsx",
    "src/index.jsx",
    "app/page.tsx",
    "app/page.jsx",
    "src/app/page.tsx",
    "src/app/page.jsx",
  ].find((candidate) => typeof previews[candidate] === "string");
  const entrypointPreview = entrypointFile ? previews[entrypointFile] ?? "" : "";
  const entrypointLineCount = entrypointPreview ? entrypointPreview.split("\n").length : 0;
  const entrypointUseStateCount = entrypointPreview
    ? [...entrypointPreview.matchAll(/\buseState\s*\(/g)].length
    : 0;
  const entrypointLocalImportCount = entrypointPreview
    ? entrypointPreview
      .split("\n")
      .filter((line) => /^\s*import\b/.test(line) && /from\s+['"]\.\.?\//.test(line)).length
    : 0;

  const placeholderSignals: string[] = [];
  const trivialSurfaceSignals: string[] = [];
  const trivialTestSignals: string[] = [];
  for (const [file, content] of Object.entries(previews)) {
    if (
      /(^|\/)(app\/(page|layout)|components\/[^/]+)\.(ts|tsx|js|jsx)$/i.test(file)
      && (
        content.trim().length === 0
        || /return\s*\(\s*<div>\s*([A-Z][A-Za-z0-9]*|Home|Page|Layout|Manifesto|ConceptMap|ExploratoryMode|InteractiveSurface)\s*<\/div>\s*\)/s.test(content)
        || /return\s*<div>\s*([A-Z][A-Za-z0-9]*|Home|Page|Layout|Manifesto|ConceptMap|ExploratoryMode|InteractiveSurface)\s*<\/div>/s.test(content)
      )
    ) {
      trivialSurfaceSignals.push(`${file}: core surface looks reduced to a trivial placeholder`);
    }
    if (/No [^.\n]+ yet/i.test(content)) {
      placeholderSignals.push(`${file}: contains placeholder empty-state copy`);
    }
    if (/not yet built|not yet implemented|todo|placeholder/i.test(content)) {
      placeholderSignals.push(`${file}: contains unfinished placeholder language`);
    }
    if (/staff:\s*\[\s*\]|projects:\s*\[\s*\]|market(access|s)?:\s*\[\s*\]|engine(Grid|):\s*\[\s*\]/i.test(content)) {
      placeholderSignals.push(`${file}: uses static empty game state defaults`);
    }
    if (/(^|\/)(__tests__|test|tests)\//.test(file) || /\.(test|spec)\./.test(file)) {
      if (/expect\s*\(\s*true\s*\)\.toBe\s*\(\s*true\s*\)/.test(content)) {
        trivialTestSignals.push(`${file}: contains a tautological test`);
      }
      if (/basic assertion|project structure/i.test(content)) {
        trivialTestSignals.push(`${file}: contains low-value placeholder assertions`);
      }
    }
  }

  const runtimeValidationFailed = validationResults.some(
    (result) => result.category === "runtime" && result.passed === false,
  );
  const scaffoldHeavy =
    coreImplementationFiles.length === 0
    && srcFiles.length > 0
    && (docsFiles.length + testFiles.length + configFiles.length) >= shellFiles.length;

  return {
    srcFiles: srcFiles.length,
    configFiles: configFiles.length,
    docsFiles: docsFiles.length,
    testFiles: testFiles.length,
    shellFiles: shellFiles.length,
    coreImplementationFiles: coreImplementationFiles.length,
    surfaceModuleFiles: surfaceModuleFiles.length,
    logicModuleFiles: logicModuleFiles.length,
    sharedSystemFiles: sharedSystemFiles.length,
    featureIslandPairs,
    ...(entrypointFile ? { entrypointFile } : {}),
    entrypointLineCount,
    entrypointUseStateCount,
    entrypointLocalImportCount,
    trivialTestSignals: trivialTestSignals.slice(0, 6),
    placeholderSignals: placeholderSignals.slice(0, 8),
    trivialSurfaceSignals: trivialSurfaceSignals.slice(0, 8),
    scaffoldHeavy,
    runtimeValidationFailed,
  };
}

function summarizeRepoSignals(signals: RepoSignals): string {
  const lines = [
    `- src files: ${signals.srcFiles}`,
    `- shell files: ${signals.shellFiles}`,
    `- core implementation files: ${signals.coreImplementationFiles}`,
    `- docs files: ${signals.docsFiles}`,
    `- test files: ${signals.testFiles}`,
    `- config files: ${signals.configFiles}`,
    `- surface modules: ${signals.surfaceModuleFiles}`,
    `- logic modules: ${signals.logicModuleFiles}`,
    `- shared system files: ${signals.sharedSystemFiles}`,
    `- feature-island pairs: ${signals.featureIslandPairs}`,
    `- entrypoint file: ${signals.entrypointFile ?? "n/a"}`,
    `- entrypoint lines: ${signals.entrypointLineCount}`,
    `- entrypoint local imports: ${signals.entrypointLocalImportCount}`,
    `- entrypoint useState count: ${signals.entrypointUseStateCount}`,
    `- scaffold heavy: ${signals.scaffoldHeavy ? "yes" : "no"}`,
    `- runtime validation failed: ${signals.runtimeValidationFailed ? "yes" : "no"}`,
  ];
  if (signals.placeholderSignals.length > 0) {
    lines.push(`- placeholder signals: ${signals.placeholderSignals.join("; ")}`);
  }
  if (signals.trivialSurfaceSignals.length > 0) {
    lines.push(`- trivial surface signals: ${signals.trivialSurfaceSignals.join("; ")}`);
  }
  if (signals.trivialTestSignals.length > 0) {
    lines.push(`- trivial test signals: ${signals.trivialTestSignals.join("; ")}`);
  }
  return lines.join("\n");
}

function applyRepoSignalCalibration(
  review: ProductQualityReview,
  signals: RepoSignals,
): ProductQualityReview {
  const findings = [...review.findings];
  const recommendations = [...review.recommendations];
  let overall = review.overallScore;
  const axes = { ...review.axes };

  if (signals.scaffoldHeavy) {
    overall = Math.min(overall, 58);
    axes.product_depth = Math.min(axes.product_depth ?? 100, 35);
    findings.unshift("Static calibration: repo is still scaffold-heavy relative to actual product logic.");
    recommendations.unshift("Use the next cycle on one real domain slice with visible state change and consequences, not more shell/docs polish.");
  }

  if (signals.coreImplementationFiles <= 1 && signals.srcFiles >= Math.max(4, signals.shellFiles)) {
    overall = Math.min(overall, 62);
    axes.product_depth = Math.min(axes.product_depth ?? 100, 42);
    findings.unshift("Static calibration: there is little evidence of core domain/system code beyond the application shell.");
  }

  if (signals.placeholderSignals.length >= 2) {
    overall = Math.min(overall, 60);
    axes.experience_quality = Math.min(axes.experience_quality ?? 100, 48);
    findings.unshift("Static calibration: repo previews still show placeholder states and unfinished product copy.");
  }

  if (signals.trivialSurfaceSignals.length > 0) {
    overall = Math.min(overall, 44);
    axes.product_depth = Math.min(axes.product_depth ?? 100, 20);
    axes.experience_quality = Math.min(axes.experience_quality ?? 100, 24);
    findings.unshift("Static calibration: one or more core product surfaces were reduced to trivial placeholder components.");
    recommendations.unshift("Restore substantive core screens/components instead of using placeholder stubs to rescue build or lint status.");
  }

  if (signals.trivialTestSignals.length > 0) {
    overall = Math.min(overall, 64);
    axes.technical_quality = Math.min(axes.technical_quality ?? 100, 70);
    findings.unshift("Static calibration: current tests look shallow and do not strongly prove product behavior.");
    recommendations.unshift("Replace tautological smoke assertions with tests that exercise a real domain or interaction path.");
  }

  if (signals.runtimeValidationFailed) {
    overall = Math.min(overall, 55);
    axes.technical_quality = Math.min(axes.technical_quality ?? 100, 55);
    findings.unshift("Static calibration: runtime validation indicates the app may not launch coherently despite passing build/test checks.");
    recommendations.unshift("Repair runtime wiring before treating this as a trustworthy vertical slice.");
  }

  const fragmentedSurfaceHeavy =
    signals.surfaceModuleFiles >= 6
    && signals.logicModuleFiles <= Math.max(3, Math.floor(signals.surfaceModuleFiles / 2));
  if (fragmentedSurfaceHeavy) {
    overall = Math.min(overall, 84);
    axes.product_depth = Math.min(axes.product_depth ?? 100, 76);
    axes.architecture_coherence = Math.min(axes.architecture_coherence ?? 100, 82);
    findings.unshift("Static calibration: effort appears spread across many presentation surfaces relative to the amount of deeper system or domain logic.");
    recommendations.unshift("Consolidate the product around one or two central interaction loops instead of adding more loosely connected surfaces.");
  }

  const featureIslandHeavy =
    signals.featureIslandPairs >= 3 && signals.sharedSystemFiles <= 1;
  if (featureIslandHeavy) {
    overall = Math.min(overall, 86);
    axes.product_depth = Math.min(axes.product_depth ?? 100, 78);
    axes.architecture_coherence = Math.min(axes.architecture_coherence ?? 100, 80);
    axes.forward_readiness = Math.min(axes.forward_readiness ?? 100, 80);
    findings.unshift("Static calibration: the repo looks like several adjacent feature islands, each with its own UI and helper module, without enough shared underlying system logic.");
    recommendations.unshift("Unify multiple surfaces through a shared state, model, or engine so the product feels like one system instead of a cluster of demos.");
  }

  if (signals.coreImplementationFiles >= 5 && signals.testFiles === 0) {
    overall = Math.min(overall, 88);
    axes.technical_quality = Math.min(axes.technical_quality ?? 100, 82);
    axes.forward_readiness = Math.min(axes.forward_readiness ?? 100, 80);
    findings.unshift("Static calibration: the repo has meaningful implementation surface area but little or no automated behavior coverage.");
    recommendations.unshift("Add tests around the core loop or shared system behavior so the product can evolve without guesswork.");
  }

  const overgrownEntrypointShell =
    signals.entrypointLineCount >= 220
    && signals.entrypointUseStateCount >= 5
    && signals.entrypointLocalImportCount >= 4;
  if (overgrownEntrypointShell) {
    overall = Math.min(overall, 82);
    axes.architecture_coherence = Math.min(axes.architecture_coherence ?? 100, 78);
    axes.forward_readiness = Math.min(axes.forward_readiness ?? 100, 76);
    findings.unshift("Static calibration: too much orchestration appears concentrated in a single entrypoint shell, which is a common demo-ware pattern.");
    recommendations.unshift("Move state, routing, and interaction logic out of the main shell into deeper product systems so the repo scales beyond a demo.");
  }

  return {
    ...review,
    overallScore: clampScore(overall, review.overallScore),
    axes,
    findings: normalizeStringList(findings, review.findings),
    recommendations: normalizeStringList(recommendations, review.recommendations),
  };
}

function weightedAverage(pairs: Array<[number, number]>): number {
  const totalWeight = pairs.reduce((sum, [, weight]) => sum + weight, 0);
  if (totalWeight <= 0) {
    return 0;
  }
  const total = pairs.reduce((sum, [score, weight]) => sum + score * weight, 0);
  return total / totalWeight;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function buildHeuristicFallbackReview(
  hiddenCheckScore: number,
  failedChecks: JudgeCheckResult[],
  validationResults: ValidationResult[],
  validationScore: number | undefined,
  signals: RepoSignals,
  reason: string,
): ProductQualityReview {
  const failedValidationCount = validationResults.filter((result) => !result.passed).length;
  const placeholderPenalty = signals.placeholderSignals.length * 6;
  const trivialSurfacePenalty = signals.trivialSurfaceSignals.length * 16;
  const trivialTestPenalty = signals.trivialTestSignals.length * 5;
  const runtimePenalty = signals.runtimeValidationFailed ? 18 : 0;
  const scaffoldPenalty = signals.scaffoldHeavy ? 18 : 0;
  const featureSprawlPenalty = signals.surfaceModuleFiles >= 6 && signals.logicModuleFiles <= 3 ? 12 : 0;
  const entrypointPenalty =
    signals.entrypointLineCount >= 220 && signals.entrypointUseStateCount >= 5 ? 12 : 0;

  const specRealization = clampScore(
    hiddenCheckScore
      - failedChecks.filter((check) => check.check.required).length * 6
      - failedValidationCount * 3,
    hiddenCheckScore,
  );
  const technicalQuality = clampScore(
    (validationScore ?? hiddenCheckScore * 0.85)
      - runtimePenalty
      - trivialTestPenalty
      - entrypointPenalty * 0.35,
    validationScore ?? hiddenCheckScore * 0.85,
  );
  const productDepth = clampScore(
    32
      + Math.min(signals.coreImplementationFiles * 5, 26)
      + Math.min(signals.logicModuleFiles * 4, 20)
      - placeholderPenalty
      - trivialSurfacePenalty
      - scaffoldPenalty
      - featureSprawlPenalty,
    45,
  );
  const experienceQuality = clampScore(
    42
      + Math.min(signals.surfaceModuleFiles * 3, 16)
      + Math.min(signals.docsFiles * 2, 8)
      - placeholderPenalty
      - trivialSurfacePenalty
      - runtimePenalty * 0.6,
    46,
  );
  const architectureCoherence = clampScore(
    44
      + Math.min(signals.logicModuleFiles * 4, 18)
      + Math.min(signals.coreImplementationFiles * 2, 12)
      - featureSprawlPenalty
      - entrypointPenalty
      - scaffoldPenalty * 0.5,
    48,
  );
  const forwardReadiness = clampScore(
    weightedAverage([
      [technicalQuality, 0.42],
      [architectureCoherence, 0.28],
      [productDepth, 0.3],
    ]) - (failedValidationCount > 0 ? 6 : 0),
    45,
  );

  const overallScore = clampScore(
    weightedAverage([
      [specRealization, 0.2],
      [technicalQuality, 0.22],
      [productDepth, 0.24],
      [experienceQuality, 0.12],
      [architectureCoherence, 0.14],
      [forwardReadiness, 0.08],
    ]),
    hiddenCheckScore * 0.8,
  );

  const findings = dedupeStrings([
    `Model-based product judge unavailable (${reason}); using heuristic repo analysis instead.`,
    ...(signals.scaffoldHeavy
      ? ["Repo still appears scaffold-heavy relative to its deeper implementation."]
      : []),
    ...(signals.runtimeValidationFailed
      ? ["Runtime validation is failing, which means the product is not yet trustworthy as a live build."]
      : []),
    ...(signals.trivialSurfaceSignals.length > 0
      ? ["One or more core surfaces appear reduced to placeholders or trivial stubs."]
      : []),
    ...(signals.placeholderSignals.length >= 2
      ? ["Previewed files still contain unfinished or placeholder product language."]
      : []),
    ...(signals.surfaceModuleFiles >= 6 && signals.logicModuleFiles <= 3
      ? ["The repo is surface-heavy: many UI/presentation modules, not enough deeper system or domain logic."]
      : []),
    ...(signals.entrypointLineCount >= 220 && signals.entrypointUseStateCount >= 5
      ? ["Too much coordination appears concentrated in a single entrypoint shell, which is a common demo-ware pattern."]
      : []),
    ...(failedValidationCount > 0
      ? [`There are still ${failedValidationCount} failing validation path(s), so the build is not holistically closed out.`]
      : []),
  ]);

  const recommendations = dedupeStrings([
    ...(productDepth < 80
      ? ["Deepen one central product loop so the repo feels like a real system rather than a coherent prototype shell."]
      : []),
    ...(signals.runtimeValidationFailed || failedValidationCount > 0
      ? ["Close all failing validation and live runtime issues before expanding the feature surface further."]
      : []),
    ...(signals.surfaceModuleFiles >= 6 && signals.logicModuleFiles <= 3
      ? ["Collapse effort into one or two meaty interaction loops instead of continuing to add loosely connected surfaces."]
      : []),
    ...(signals.entrypointLineCount >= 220 && signals.entrypointUseStateCount >= 5
      ? ["Move product state and orchestration out of the main shell into deeper product systems that can scale cleanly."]
      : []),
    ...(signals.scaffoldHeavy
      ? ["Spend the next cycle on a real domain/system slice with state, consequences, and tests rather than more shell polish."]
      : []),
    ...(signals.trivialTestSignals.length > 0
      ? ["Replace shallow or tautological tests with assertions that exercise real domain behavior."]
      : []),
    ...(signals.placeholderSignals.length > 0
      ? ["Replace placeholder language and static empty states with substantive behavior or authored content."]
      : []),
    ...(recommendationsFromFailedChecks(failedChecks)),
  ]).slice(0, 8);

  const opportunities: OpportunityItem[] = [];
  if (signals.surfaceModuleFiles >= 6 && signals.logicModuleFiles <= 3) {
    opportunities.push({
      id: "deepen-core-loop",
      title: "Deepen one central interaction loop",
      rationale: "The repo has enough surface area to demonstrate breadth; the limiting factor is depth and system consequence.",
      source: "heuristic-product-judge",
      severity: 5,
      track: "delivery",
      acceptanceHint: "Choose one loop and route multiple screens/modules through that same stateful system.",
    });
  }
  if (signals.entrypointLineCount >= 220 && signals.entrypointUseStateCount >= 5) {
    opportunities.push({
      id: "split-entrypoint-orchestration",
      title: "Split orchestration out of the entry shell",
      rationale: "A large shell coordinating many features is a common sign of a prototype that will get harder to extend coherently.",
      source: "heuristic-product-judge",
      severity: 4,
      track: "delivery",
      acceptanceHint: "Move state and coordination into domain modules or feature-level controllers.",
    });
  }
  if (signals.runtimeValidationFailed || failedValidationCount > 0) {
    opportunities.push({
      id: "close-runtime-validations",
      title: "Close runtime and validation gaps",
      rationale: "A rich product surface still does not count as a strong result if the live app or validation paths are unreliable.",
      source: "heuristic-product-judge",
      severity: 5,
      track: "delivery",
      acceptanceHint: "Get all build, lint, test, and live runtime validations green before adding new scope.",
    });
  }
  if (opportunities.length === 0 && (productDepth < 80 || architectureCoherence < 78)) {
    opportunities.push({
      id: "strengthen-core-system",
      title: "Strengthen the core system",
      rationale: "The repo is coherent enough to run, but it still needs a deeper center of gravity to feel like a substantial product.",
      source: "heuristic-product-judge",
      severity: 4,
      track: "delivery",
      acceptanceHint: "Pick the central user journey and make more of the app depend on the same underlying state and logic.",
    });
  }

  return {
    summary: "Heuristic product review completed without the model judge. This score is directionally useful, but it should be treated as lower-confidence than a full model-backed review.",
    overallScore,
    axes: {
      spec_realization: specRealization,
      technical_quality: technicalQuality,
      product_depth: productDepth,
      experience_quality: experienceQuality,
      architecture_coherence: architectureCoherence,
      forward_readiness: forwardReadiness,
    },
    findings,
    recommendations:
      recommendations.length > 0
        ? recommendations
        : ["Deepen the core system and interaction loop before treating this as a finished product."],
    opportunities,
    calibration: {
      evidenceScore: clampScore(weightedAverage([
        [hiddenCheckScore, 0.35],
        [validationScore ?? hiddenCheckScore * 0.85, 0.35],
        [Math.min(100, signals.coreImplementationFiles * 12), 0.15],
        [Math.min(100, signals.logicModuleFiles * 16), 0.15],
      ]), hiddenCheckScore),
      adjustedFrom: hiddenCheckScore,
      reasons: [reason],
    },
    model: "heuristic-fallback",
  };
}

function recommendationsFromFailedChecks(failedChecks: JudgeCheckResult[]): string[] {
  return failedChecks
    .slice(0, 4)
    .map((check) => `Fix the failing requirement '${check.check.title}' before claiming the product is complete.`);
}

async function callOpenRouter(
  config: EffectiveProductJudgeConfig,
  messages: OpenRouterMessage[],
): Promise<{ content: string; model?: string; usage?: TokenUsageSummary }> {
  const apiKey = process.env[config.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Missing ${config.apiKeyEnv}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  const response = await fetch(config.baseUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-OpenRouter-Title": "Medium Run Loop Product Judge",
    },
    body: JSON.stringify({
      model: config.workerModel,
      messages,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
    }),
    signal: controller.signal,
  }).finally(() => {
    clearTimeout(timeout);
  });

  if (!response.ok) {
    throw new Error(`OpenRouter request failed (${response.status}): ${await response.text()}`);
  }

  const payload = (await response.json()) as {
    model?: string;
    usage?: OpenRouterUsage;
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((item) => {
              if (typeof item === "string") {
                return item;
              }
              if (item && typeof item === "object" && "text" in item && typeof item.text === "string") {
                return item.text;
              }
              return JSON.stringify(item);
            })
            .join("\n")
        : JSON.stringify(content);
  const usage = normalizeUsage(payload.usage);

  return {
    content: text,
    ...(payload.model ? { model: payload.model } : {}),
    ...(usage ? { usage } : {}),
  };
}

function buildPrompt(
  benchmark: ResolvedBenchmarkSpec,
  repoTree: string[],
  previews: Record<string, string>,
  signals: RepoSignals,
  hiddenCheckScore: number,
  failedChecks: JudgeCheckResult[],
  validationResults: ValidationResult[],
  validationScore: number | undefined,
  previousJudge?: JudgeResult,
  config?: EffectiveProductJudgeConfig,
): OpenRouterMessage[] {
  const previewBlock = Object.entries(previews)
    .map(([file, content]) => `### ${file}\n\`\`\`\n${content}\n\`\`\``)
    .join("\n\n");

  return [
    {
      role: "system",
      content: `You are a product-quality judge for long-running coding tasks. Respond with exactly one JSON object and no markdown.

Focus on whether the repo is becoming a genuinely strong, well-engineered final product, not whether it merely created the right files.

Rubric:
${(config?.rubric ?? DEFAULT_PRODUCT_JUDGE.rubric).map((item) => `- ${item}`).join("\n")}

Return JSON with this shape:
{
  "summary": "one paragraph",
  "overallScore": 0-100,
  "axes": {
    "spec_realization": 0-100,
    "technical_quality": 0-100,
    "product_depth": 0-100,
    "experience_quality": 0-100,
    "architecture_coherence": 0-100,
    "forward_readiness": 0-100
  },
  "findings": ["..."],
  "recommendations": ["..."],
  "opportunities": [
    {
      "id": "short-stable-id",
      "title": "short title",
      "rationale": "why this materially improves the product",
      "source": "product-judge",
      "severity": 1-5,
      "track": "delivery|exploration",
      "acceptanceHint": "optional next step"
    }
  ]
}

Rules:
- Balance brief fidelity with technical quality. A repo that technically covers the brief but is brittle, shallow, or poorly validated should still score low.
- Do not restate checklist failures unless they materially affect the final product.
- If the repo is mostly scaffold, score it low even if the structure is neat.
- Do not confuse many panels, tools, modes, or feature islands with a deep product. A handful of loosely connected subsurfaces should score lower than one or two genuinely meaty loops.
- Penalize overgrown orchestration shells where a single entrypoint coordinates many features without enough deeper systems behind them.
- Use validation results, repo previews, and architectural coherence to judge whether this could become a strong final product without rework.
- Prefer opportunities that would deepen the product, improve technical integrity, or make the result feel more complete and intentional.
- Keep findings and recommendations concrete, blunt, and useful.`,
    },
    {
      role: "user",
      content: `Benchmark:
- id: ${benchmark.id}
- title: ${benchmark.title}
- summary: ${benchmark.summary}
- artifact target: ${benchmark.artifactTarget}

Public brief:
${benchmark.publicBrief}

Visible acceptance criteria:
${benchmark.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}

Current hidden-check score:
- ${hiddenCheckScore.toFixed(1)}

Current hidden-check failures:
${summarizeFailedChecks(failedChecks)}

Automatic validation results:
${summarizeValidationResults(validationResults)}

Automatic validation score:
- ${validationScore !== undefined ? validationScore.toFixed(1) : "n/a"}

Static repo-shape signals:
${summarizeRepoSignals(signals)}

Previous product review:
${summarizePreviousProduct(previousJudge)}

Repo tree snapshot (${repoTree.length} entries):
${repoTree.length > 0 ? repoTree.slice(0, 180).map((item) => `- ${item}`).join("\n") : "- repo is empty"}

Selected file previews:
${previewBlock || "- none"}

Judge the repo as a serious final-product candidate. The hidden checks already cover file existence and literal requirements, so spend your attention on whether this feels like a convincing, coherent, technically sound build that should keep iterating until it feels whole.`
    },
  ];
}

export async function evaluateProductQuality(
  benchmark: ResolvedBenchmarkSpec,
  repoDir: string,
  hiddenCheckScore: number,
  failedChecks: JudgeCheckResult[],
  validationResults: ValidationResult[],
  validationScore: number | undefined,
  previousJudge?: JudgeResult,
): Promise<ProductQualityReview | undefined> {
  const config = resolveProductJudgeConfig(benchmark);
  if (!config) {
    return undefined;
  }
  if (!(await pathExists(repoDir))) {
    return undefined;
  }

  const repoTree = await listFiles(repoDir, { maxDepth: 6 });
  const previews = await readFilesPreview(repoDir, prioritizePreviewFiles(repoTree), 2200);
  const signals = collectRepoSignals(repoTree, previews, validationResults);

  let response: { content: string; model?: string; usage?: TokenUsageSummary };
  try {
    response = await callOpenRouter(
      config,
      buildPrompt(
        benchmark,
        repoTree,
        previews,
        signals,
        hiddenCheckScore,
        failedChecks,
        validationResults,
        validationScore,
        previousJudge,
        config,
      ),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown model-judge error";
    return applyRepoSignalCalibration(
      buildHeuristicFallbackReview(
        hiddenCheckScore,
        failedChecks,
        validationResults,
        validationScore,
        signals,
        reason,
      ),
      signals,
    );
  }

  const rawJson = extractJsonObject(response.content);
  if (!rawJson) {
    return {
      summary: "Product judge returned an unstructured response.",
      overallScore: Math.max(0, Math.min(100, hiddenCheckScore * 0.85)),
      axes: {},
      findings: ["The product-quality judge response could not be parsed cleanly."],
      recommendations: [
        "Keep iterating on product depth and architecture coherence rather than trusting the current score.",
      ],
      opportunities: [],
      ...(response.model ? { model: response.model } : {}),
      ...(response.usage ? { usage: response.usage } : {}),
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawJson) as Record<string, unknown>;
  } catch {
    return {
      summary: "Product judge returned invalid JSON.",
      overallScore: Math.max(0, Math.min(100, hiddenCheckScore * 0.85)),
      axes: {},
      findings: ["The product-quality judge response was not valid JSON."],
      recommendations: [
        "Keep iterating on product depth and architecture coherence rather than trusting the current score.",
      ],
      opportunities: [],
      ...(response.model ? { model: response.model } : {}),
      ...(response.usage ? { usage: response.usage } : {}),
    };
  }

  const opportunities = dedupeOpportunities(
    (Array.isArray(parsed.opportunities) ? parsed.opportunities : [])
      .map((item, index) => normalizeOpportunity(item, index))
      .filter((item): item is OpportunityItem => Boolean(item)),
  );

  return applyRepoSignalCalibration({
    summary:
      typeof parsed.summary === "string" && parsed.summary.trim().length > 0
        ? truncate(parsed.summary.trim(), 700)
        : "Product-quality review completed.",
    overallScore: clampScore(parsed.overallScore, Math.max(0, Math.min(100, hiddenCheckScore * 0.9))),
    axes: normalizeAxes(parsed.axes),
    findings: normalizeStringList(parsed.findings, ["No specific product findings returned."]),
    recommendations: normalizeStringList(parsed.recommendations, [
      "Deepen the product in the next cycle instead of stopping at structural completeness.",
    ]),
    opportunities,
    ...(response.model ? { model: response.model } : {}),
    ...(response.usage ? { usage: response.usage } : {}),
  }, signals);
}
