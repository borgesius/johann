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

function briefRequestsTypeScript(brief: string): boolean {
  const text = brief.toLowerCase();
  return /\btypescript\b/.test(text)
    || /\bts\/electron\b/.test(text)
    || /\bts\b/.test(text) && /\belectron\b/.test(text);
}

function customBriefAcceptanceCriteria(kind: string, useTypeScript: boolean): string[] {
  const base = [
    "Ship a coherent implementation of the brief rather than a placeholder shell.",
    "Leave a production-like repo with readable structure, docs, and at least one validation path.",
    ...(useTypeScript ? ["Honor the requested TypeScript stack in the implementation, not just in documentation."] : []),
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

function customBriefHiddenChecks(kind: string, useTypeScript: boolean): HiddenCheck[] {
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
    ...(useTypeScript
      ? [
          {
            id: "custom-tsconfig",
            title: "TypeScript config exists",
            category: "repo",
            weight: 1,
            required: true,
            type: "fileExists" as const,
            path: "tsconfig.json",
          },
        ]
      : []),
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
          pattern: useTypeScript ? "src/main.ts" : "src/main.*",
          count: 1,
        },
        {
          id: "custom-preload-entry",
          title: "Preload entry exists",
          category: "product",
          weight: 1,
          required: true,
          type: "globCount",
          pattern: useTypeScript ? "src/preload.ts" : "src/preload.*",
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

function customProductJudge(kind: string, useTypeScript: boolean): ProductJudgeConfig {
  const reward = [
    "Feature depth, architecture coherence, thoughtful UX structure, and evidence of iteration.",
    "A shared system spine or core loop that makes the product feel like one thing rather than a cluster of parts.",
  ];
  const penalize = [
    "Shallow scaffolds, missing core loops, and implementations that technically pass but still feel empty.",
  ];

  if (kind === "electron") {
    reward.push(
      "For Electron products, a meaningful desktop structure and a real product surface, not just entrypoints.",
    );
    penalize.push(
      "Over-rewarding a clean Electron shell, passing TypeScript build, README, or trivial tests when the actual game/app logic remains mostly placeholder.",
    );
  }
  if (useTypeScript) {
    penalize.push(
      "Quietly falling back to plain JavaScript for the main product code when the brief explicitly asked for TypeScript.",
    );
  }
  if (kind === "service") {
    reward.push(
      "For services, API or runtime design that feels operationally credible, not just syntactically present.",
    );
  }

  return {
    enabled: true,
    workerModel: "qwen/qwen3-coder-flash",
    hiddenCheckWeight: 0.35,
    productQualityWeight: 0.65,
    minimumProductQualityScore: kind === "electron" ? 68 : 60,
    minimumTechnicalQualityScore: kind === "electron" ? 58 : 55,
    maximumSpecQualityGap: kind === "electron" ? 14 : 18,
    minimumValidationScore: 55,
    profile: {
      summary: "Judge whether the repo feels like a serious product attempt rather than a benchmark box-checker.",
      priorities: [
        "Treat hidden checks as the structural floor, not the main meaning of quality.",
        "Prefer one deeper, integrated system over broad but disconnected surfaces.",
      ],
      reward,
      penalize,
      opportunities: [
        "Suggest next moves that deepen the core product and improve technical integrity instead of expanding breadth for its own sake.",
      ],
    },
  };
}

export async function createCustomBriefBenchmark(
  loaded: LoadedConfig,
  options: CustomBriefOptions,
): Promise<ResolvedBenchmarkSpec> {
  const brief = await readText(options.briefPath);
  const kind = inferBriefKind(brief, options.briefKind);
  const useTypeScript = briefRequestsTypeScript(brief);
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
    acceptanceCriteria: customBriefAcceptanceCriteria(kind, useTypeScript),
    branchTemplates: [],
    hiddenChecks: customBriefHiddenChecks(kind, useTypeScript),
    judgeWeights: {},
    expectedRoleOutputs: {},
    successThreshold: 78,
    productJudge: customProductJudge(kind, useTypeScript),
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
