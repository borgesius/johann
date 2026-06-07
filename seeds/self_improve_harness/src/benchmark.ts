import path from "node:path";
import fs from "node:fs/promises";
import type {
  HiddenCheck,
  LoadedConfig,
  ProductJudgeConfig,
  ResolvedBenchmarkSpec,
  RunPaths,
} from "./types.js";
import {
  copyDir,
  ensureDir,
  initializeGitRepo,
  makeRunId,
  pathExists,
  readJson,
  readText,
  slugify,
  writeJson,
  writeText,
} from "./utils.js";

export async function listBenchmarks(loaded: LoadedConfig): Promise<string[]> {
  const benchmarksRoot = path.join(loaded.rootDir, loaded.config.benchmarksDir);
  const entries = await fs.readdir(benchmarksRoot, { withFileTypes: true });
  const builtIn = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const generatedRoot = path.join(loaded.rootDir, ".bench", "generated", "briefs");
  if (!(await pathExists(generatedRoot))) {
    return builtIn;
  }

  const generatedEntries = await fs.readdir(generatedRoot, { withFileTypes: true });
  const generated = generatedEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  return [...new Set([...builtIn, ...generated])].sort();
}

export async function loadBenchmarkSpec(
  loaded: LoadedConfig,
  benchmarkId: string,
): Promise<ResolvedBenchmarkSpec> {
  const benchmarkDir = await resolveBenchmarkDir(loaded, benchmarkId);
  const specPath = path.join(benchmarkDir, "spec.json");
  const spec = await readJson<ResolvedBenchmarkSpec>(specPath);
  const publicBriefPath = path.join(loaded.rootDir, spec.publicBriefFile);
  const workspaceSeedPath = path.join(loaded.rootDir, spec.workspaceSeed);

  return {
    ...spec,
    benchmarkDir,
    publicBriefPath,
    publicBrief: await readText(publicBriefPath),
    workspaceSeedPath,
  };
}

async function resolveBenchmarkDir(
  loaded: LoadedConfig,
  benchmarkId: string,
): Promise<string> {
  const builtInDir = path.join(loaded.rootDir, loaded.config.benchmarksDir, benchmarkId);
  if (await pathExists(path.join(builtInDir, "spec.json"))) {
    return builtInDir;
  }

  const generatedDir = path.join(
    loaded.rootDir,
    ".bench",
    "generated",
    "briefs",
    benchmarkId,
    "benchmark",
  );
  if (await pathExists(path.join(generatedDir, "spec.json"))) {
    return generatedDir;
  }

  throw new Error(`Benchmark '${benchmarkId}' was not found.`);
}

export interface CustomBriefOptions {
  briefPath: string;
  briefId?: string;
  briefKind?: string;
  artifactTarget?: string;
}

function firstHeading(brief: string): string | undefined {
  const match = brief.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim();
}

function inferBriefKind(brief: string, explicit?: string): string {
  if (explicit) {
    return explicit;
  }
  const text = brief.toLowerCase();
  if (text.includes("electron")) {
    return "electron";
  }
  if (text.includes("api") || text.includes("service") || text.includes("backend")) {
    return "service";
  }
  if (text.includes("webapp") || text.includes("web app") || text.includes("browser")) {
    return "webapp";
  }
  if (text.includes("library") || text.includes("sdk")) {
    return "library";
  }
  return "general";
}

function customBriefAcceptanceCriteria(kind: string): string[] {
  const base = [
    "Ship a coherent implementation of the brief rather than a placeholder shell.",
    "Leave a production-like repo with readable structure, docs, and at least one validation path.",
  ];

  switch (kind) {
    case "electron":
      return [
        "Ship a coherent Electron shell with main, preload, and renderer structure.",
        ...base,
      ];
    case "service":
      return [
        "Ship a coherent server or service entrypoint with a testable architecture.",
        ...base,
      ];
    case "webapp":
      return [
        "Ship a coherent web application surface with a runnable UI shell.",
        ...base,
      ];
    case "library":
      return [
        "Ship a coherent library surface with readable modules and at least one usage path.",
        ...base,
      ];
    default:
      return base;
  }
}

function customBriefHiddenChecks(kind: string): HiddenCheck[] {
  const base: HiddenCheck[] = [
    {
      id: "custom-package",
      title: "package.json exists",
      category: "repo",
      weight: 1,
      required: true,
      type: "fileExists",
      path: "package.json",
    },
    {
      id: "custom-readme",
      title: "README exists",
      category: "docs",
      weight: 1,
      required: true,
      type: "fileExists",
      path: "README.md",
    },
    {
      id: "custom-src",
      title: "Source tree exists",
      category: "repo",
      weight: 1,
      required: true,
      type: "globCount",
      pattern: "src/**",
      count: 1,
    },
  ];

  switch (kind) {
    case "electron":
      return [
        ...base,
        {
          id: "custom-main-entry",
          title: "Main entry exists",
          category: "product",
          weight: 1,
          required: true,
          type: "globCount",
          pattern: "src/main.*",
          count: 1,
        },
        {
          id: "custom-preload-entry",
          title: "Preload entry exists",
          category: "product",
          weight: 1,
          required: true,
          type: "globCount",
          pattern: "src/preload.*",
          count: 1,
        },
        {
          id: "custom-renderer-entry",
          title: "Renderer assets exist",
          category: "product",
          weight: 1,
          required: true,
          type: "globCount",
          pattern: "src/renderer/**",
          count: 1,
        },
      ];
    case "service":
      return [
        ...base,
        {
          id: "custom-server-entry",
          title: "Server entry exists",
          category: "product",
          weight: 1,
          required: true,
          type: "globAnyCount",
          patterns: ["src/server.*", "src/index.*", "src/app.*"],
          count: 1,
        },
      ];
    default:
      return base;
  }
}

function customProductJudge(kind: string): ProductJudgeConfig {
  const rubric = [
    "Score whether the repo feels like a serious product attempt rather than a benchmark box-checker.",
    "Reward feature depth, architecture coherence, thoughtful UX structure, and evidence of iteration.",
    "Penalize shallow scaffolds, missing core loops, and implementations that technically pass but feel empty.",
  ];

  if (kind === "electron") {
    rubric.push(
      "For Electron products, judge whether the app has a meaningful desktop structure and a real product surface, not just entrypoints.",
    );
  }
  if (kind === "service") {
    rubric.push(
      "For services, judge whether the API or runtime design feels operationally credible, not just syntactically present.",
    );
  }

  return {
    enabled: true,
    workerModel: "qwen/qwen3-coder-flash",
    hiddenCheckWeight: 0.35,
    productQualityWeight: 0.65,
    minimumProductQualityScore: kind === "electron" ? 62 : 58,
    minimumTechnicalQualityScore: 55,
    maximumSpecQualityGap: 18,
    minimumValidationScore: 55,
    rubric,
  };
}

export async function createCustomBriefBenchmark(
  loaded: LoadedConfig,
  options: CustomBriefOptions,
): Promise<ResolvedBenchmarkSpec> {
  const brief = await readText(options.briefPath);
  const kind = inferBriefKind(brief, options.briefKind);
  const title = firstHeading(brief) ?? options.briefId ?? "Custom Brief";
  const benchmarkId = options.briefId
    ? slugify(options.briefId)
    : `brief-${slugify(path.basename(options.briefPath, path.extname(options.briefPath)) || title)}`;
  const generatedDir = path.join(loaded.rootDir, ".bench", "generated", "briefs", benchmarkId);
  const seedDir = path.join(generatedDir, "seed");
  const benchmarkDir = path.join(generatedDir, "benchmark");
  const briefPath = path.join(benchmarkDir, "brief.md");
  await ensureDir(seedDir);
  await ensureDir(benchmarkDir);
  await writeText(path.join(seedDir, ".gitkeep"), "");
  await writeText(briefPath, brief);
  const spec = {
    id: benchmarkId,
    title,
    summary: `Custom brief (${kind}) generated from ${path.basename(options.briefPath)}.`,
    artifactTarget:
      options.artifactTarget
      ?? (kind === "electron"
        ? "Production-like Electron application repo"
        : kind === "service"
          ? "Production-like service repo"
          : kind === "webapp"
            ? "Production-like web application repo"
            : "Production-like application repo"),
    publicBriefFile: path.relative(loaded.rootDir, briefPath),
    publicBriefPath: briefPath,
    publicBrief: brief,
    benchmarkDir,
    workspaceSeed: path.relative(loaded.rootDir, seedDir),
    workspaceSeedPath: seedDir,
    budgets: { minMinutes: 20, maxMinutes: 480, defaultMinutes: 120 },
    acceptanceCriteria: customBriefAcceptanceCriteria(kind),
    branchTemplates: [],
    hiddenChecks: customBriefHiddenChecks(kind),
    judgeWeights: {},
    expectedRoleOutputs: {},
    successThreshold: 78,
    productJudge: customProductJudge(kind),
  };
  await writeJson(path.join(benchmarkDir, "spec.json"), spec);

  return {
    ...spec,
    benchmarkDir,
    publicBriefPath: briefPath,
    publicBrief: brief,
    workspaceSeedPath: seedDir,
  };
}

export async function createRunPaths(
  loaded: LoadedConfig,
  benchmarkId: string,
  workerId: string,
  policyId: string,
): Promise<RunPaths> {
  const runId = makeRunId([benchmarkId, workerId, policyId]);
  const runDir = path.join(loaded.rootDir, loaded.config.runsDir, runId);
  const paths: RunPaths = {
    runDir,
    repoDir: path.join(runDir, "repo"),
    inputDir: path.join(runDir, "input"),
    phasesDir: path.join(runDir, "phases"),
    branchesDir: path.join(runDir, "branches"),
    reportsDir: path.join(runDir, "reports"),
    artifactsDir: path.join(runDir, "artifacts"),
    ledgerPath: path.join(runDir, "ledger.json"),
    resultPath: path.join(runDir, "result.json"),
  };

  await Promise.all(
    Object.values(paths)
      .filter((value) => !value.endsWith(".json"))
      .map((value) => ensureDir(value)),
  );

  return paths;
}

export async function prepareRunWorkspace(
  spec: ResolvedBenchmarkSpec,
  paths: RunPaths,
  seedOverride?: string,
): Promise<void> {
  const seedPath = seedOverride ?? spec.workspaceSeedPath;
  await copyDir(seedPath, paths.repoDir);
  await fs.rm(path.join(paths.repoDir, ".git"), { recursive: true, force: true });
  await fs.rm(path.join(paths.repoDir, ".bench"), { recursive: true, force: true });
  await initializeGitRepo(paths.repoDir);
  await writeJson(path.join(paths.inputDir, "benchmark.snapshot.json"), spec);
  await fs.copyFile(spec.publicBriefPath, path.join(paths.inputDir, "brief.md"));
}
