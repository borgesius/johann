import fs from "node:fs";
import path from "node:path";
import { runBrowserSmoke } from "./app-smoke.js";
import type { ValidationResult } from "./types.js";
import { pathExists, readJson, runShellCommand, truncate } from "./utils.js";

type PackageManifest = {
  scripts?: Record<string, string>;
  main?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const TRIVIAL_SURFACE_LITERAL_PATTERN = /return\s*\(\s*<div>\s*([A-Z][A-Za-z0-9]*|Home|Page|Layout|Manifesto|ConceptMap|ExploratoryMode|InteractiveSurface)\s*<\/div>\s*\)|return\s*<div>\s*([A-Z][A-Za-z0-9]*|Home|Page|Layout|Manifesto|ConceptMap|ExploratoryMode|InteractiveSurface)\s*<\/div>/s;

type ValidationPlan = {
  id: ValidationResult["id"];
  label: string;
  category: ValidationResult["category"];
  command: string;
  timeoutMs: number;
};

const VALIDATION_ORDER: Array<{
  script: string;
  label: string;
  category: ValidationResult["category"];
  command: string;
  timeoutMs: number;
}> = [
  {
    script: "test",
    label: "Test suite passes",
    category: "test",
    command: "npm test",
    timeoutMs: 120_000,
  },
  {
    script: "build",
    label: "Build passes",
    category: "build",
    command: "npm run build",
    timeoutMs: 120_000,
  },
  {
    script: "typecheck",
    label: "Typecheck passes",
    category: "typecheck",
    command: "npm run typecheck",
    timeoutMs: 120_000,
  },
  {
    script: "lint",
    label: "Lint passes",
    category: "lint",
    command: "npm run lint",
    timeoutMs: 90_000,
  },
];

function isPlaceholderScript(name: string, command: string): boolean {
  const normalized = command.toLowerCase();
  if (name === "test" && normalized.includes("no test specified")) {
    return true;
  }
  if (
    normalized.includes("todo")
    || normalized.includes("not implemented")
    || normalized.includes("not yet implemented")
    || normalized.includes("placeholder")
    || normalized.includes("coming soon")
    || normalized.includes("stub")
  ) {
    return true;
  }
  return /^\s*(echo\b[^|&;]*)(\s*(?:&&|;)\s*exit\s+0\s*)?$/i.test(command)
    || /^\s*exit\s+0\s*$/i.test(command)
    || /^\s*true\s*$/i.test(command);
}

async function readPackageManifest(repoDir: string): Promise<PackageManifest | undefined> {
  const manifestPath = path.join(repoDir, "package.json");
  if (!(await pathExists(manifestPath))) {
    return undefined;
  }
  try {
    return await readJson<PackageManifest>(manifestPath);
  } catch {
    return undefined;
  }
}

function buildValidationPlan(manifest: PackageManifest | undefined): ValidationPlan[] {
  const scripts = manifest?.scripts ?? {};
  return VALIDATION_ORDER.filter((item) => {
    const command = scripts[item.script];
    return typeof command === "string" && command.trim().length > 0 && !isPlaceholderScript(item.script, command);
  }).map((item) => ({
    id: item.script,
    label: item.label,
    category: item.category,
    command: item.command,
    timeoutMs: item.timeoutMs,
  }));
}

function normalizeRepoPath(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().replace(/\\/g, "/");
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/^\.\//, "");
}

function isLikelyElectronManifest(manifest: PackageManifest | undefined): boolean {
  const deps = {
    ...(manifest?.dependencies ?? {}),
    ...(manifest?.devDependencies ?? {}),
  };
  if (typeof deps.electron === "string" && deps.electron.trim()) {
    return true;
  }
  const scripts = manifest?.scripts ?? {};
  return Object.values(scripts).some((script) => /\belectron\b/.test(script));
}

function isLikelyWebManifest(manifest: PackageManifest | undefined): boolean {
  const deps = {
    ...(manifest?.dependencies ?? {}),
    ...(manifest?.devDependencies ?? {}),
  };
  if (
    typeof deps.react === "string"
    || typeof deps.next === "string"
    || typeof deps.vite === "string"
  ) {
    return true;
  }
  const scripts = manifest?.scripts ?? {};
  return Object.values(scripts).some((script) => /\b(next|vite)\b/.test(script));
}

function webSmokeStartCommand(manifest: PackageManifest | undefined): string | undefined {
  const scripts = manifest?.scripts ?? {};
  const deps = {
    ...(manifest?.dependencies ?? {}),
    ...(manifest?.devDependencies ?? {}),
  };
  const devScript = typeof scripts.dev === "string" ? scripts.dev : "";
  const isNextApp =
    typeof deps.next === "string"
    || /\bnext\s+dev\b/.test(devScript);
  if (typeof scripts.dev === "string" && scripts.dev.trim()) {
    if (isNextApp) {
      return "HOSTNAME=127.0.0.1 PORT=4173 npm run dev";
    }
    return "npm run dev -- --host 127.0.0.1 --port 4173";
  }
  if (typeof scripts.start === "string" && scripts.start.trim()) {
    return "PORT=4173 npm run start";
  }
  return undefined;
}

function isCoreSurfaceFile(relativePath: string): boolean {
  return /^src\/app\/(page|layout)\.(ts|tsx|js|jsx)$/.test(relativePath)
    || /^src\/components\/[^/]+\.(ts|tsx|js|jsx)$/.test(relativePath)
    || /^app\/(page|layout)\.(ts|tsx|js|jsx)$/.test(relativePath)
    || /^components\/[^/]+\.(ts|tsx|js|jsx)$/.test(relativePath);
}

function classifyTrivialSurface(relativePath: string, content: string): string | undefined {
  const trimmed = content.trim();
  if (!trimmed) {
    return `${relativePath} is empty`;
  }
  if (trimmed.length <= 220 && TRIVIAL_SURFACE_LITERAL_PATTERN.test(trimmed)) {
    return `${relativePath} was reduced to a trivial placeholder component`;
  }
  if (
    trimmed.length <= 180
    && /export\s+default\s+function\s+\w+\s*\(/.test(trimmed)
    && /return\s*<div>.*<\/div>/.test(trimmed)
  ) {
    return `${relativePath} looks like a minimal placeholder UI stub`;
  }
  return undefined;
}

export async function findCoreSurfaceIntegrityIssues(repoDir: string): Promise<string[]> {
  const issues: string[] = [];
  const queue = ["src", "app", "components"];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    const absolute = path.join(repoDir, current);
    if (!(await pathExists(absolute))) {
      continue;
    }
    let entries;
    try {
      entries = await fs.promises.readdir(absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const relative = path.posix.join(current.replace(/\\/g, "/"), entry.name);
      if (seen.has(relative)) {
        continue;
      }
      seen.add(relative);
      if (entry.isDirectory()) {
        if (relative.split("/").length <= 3) {
          queue.push(relative);
        }
        continue;
      }
      if (!isCoreSurfaceFile(relative)) {
        continue;
      }
      try {
        const content = await fs.promises.readFile(path.join(repoDir, relative), "utf8");
        const issue = classifyTrivialSurface(relative, content);
        if (issue) {
          issues.push(issue);
        }
      } catch {
        continue;
      }
    }
  }

  return issues.slice(0, 8);
}

async function readTsConfigOutDir(repoDir: string): Promise<string | undefined> {
  const tsconfigPath = path.join(repoDir, "tsconfig.json");
  if (!(await pathExists(tsconfigPath))) {
    return undefined;
  }
  try {
    const tsconfig = await readJson<{
      compilerOptions?: {
        outDir?: string;
      };
    }>(tsconfigPath);
    return normalizeRepoPath(tsconfig.compilerOptions?.outDir);
  } catch {
    return undefined;
  }
}

async function readTsConfigCompilerOptions(repoDir: string): Promise<{
  outDir?: string;
  noEmit?: boolean;
}> {
  const tsconfigPath = path.join(repoDir, "tsconfig.json");
  if (!(await pathExists(tsconfigPath))) {
    return {};
  }
  try {
    const tsconfig = await readJson<{
      compilerOptions?: {
        outDir?: string;
        noEmit?: boolean;
      };
    }>(tsconfigPath);
    const outDir = normalizeRepoPath(tsconfig.compilerOptions?.outDir);
    return {
      ...(outDir ? { outDir } : {}),
      ...(typeof tsconfig.compilerOptions?.noEmit === "boolean"
        ? { noEmit: tsconfig.compilerOptions.noEmit }
        : {}),
    };
  } catch {
    return {};
  }
}

async function validateElectronRuntimeShape(
  repoDir: string,
  manifest: PackageManifest | undefined,
): Promise<ValidationResult | undefined> {
  if (!isLikelyElectronManifest(manifest)) {
    return undefined;
  }

  const mainEntry = normalizeRepoPath(manifest?.main);
  const compilerOptions = await readTsConfigCompilerOptions(repoDir);
  const outDir = compilerOptions.outDir;
  const builtMain = outDir ? `${outDir}/main.js` : undefined;
  const issues: string[] = [];

  if (!mainEntry) {
    issues.push("package.json is missing a main entry for Electron.");
  } else {
    if (mainEntry.endsWith(".ts")) {
      issues.push(`package.json main points to a TypeScript source file (${mainEntry}) instead of a runtime JS entry.`);
    }
    if (mainEntry.startsWith("src/")) {
      issues.push(`package.json main points into src/ (${mainEntry}) instead of the compiled runtime output.`);
    }
    if (!(await pathExists(path.join(repoDir, mainEntry)))) {
      issues.push(`package.json main points to ${mainEntry}, which does not exist in the repo.`);
    }
    if (outDir && builtMain) {
      const builtMainExists = await pathExists(path.join(repoDir, builtMain));
      if (builtMainExists && !mainEntry.startsWith(`${outDir}/`)) {
        issues.push(`TypeScript builds into ${outDir}/, but package.json main still points to ${mainEntry} instead of ${builtMain}.`);
      }
    }
    if (compilerOptions.noEmit === true && mainEntry.startsWith("dist/")) {
      issues.push(`tsconfig.json has noEmit=true, so package.json main cannot rely on built output at ${mainEntry}. Either emit JS for the Electron main/preload process or point main at a coherent runtime entry.`);
    }

    const mainSourceCandidates = ["src/main.ts", "src/main.js", mainEntry].filter(Boolean) as string[];
    for (const candidate of mainSourceCandidates) {
      const candidatePath = path.join(repoDir, candidate);
      if (!(await pathExists(candidatePath))) {
        continue;
      }
      try {
        const raw = await fs.promises.readFile(candidatePath, "utf8");
        const loadFileMatch = raw.match(/loadFile\s*\(\s*path\.join\(\s*__dirname\s*,\s*['"]([^'"]+\.html)['"]\s*\)\s*\)/);
        if (loadFileMatch?.[1]) {
          const runtimeDir = path.posix.dirname(mainEntry || candidate);
          const htmlPath = path.posix.normalize(path.posix.join(runtimeDir, loadFileMatch[1]));
          if (!(await pathExists(path.join(repoDir, htmlPath)))) {
            issues.push(`Electron main process loads ${htmlPath}, but that HTML file does not exist in the repo.`);
          }
        }
      } catch {
        // Ignore read/parse failures here and let other runtime checks speak.
      }
      break;
    }
  }

  if (issues.length === 0) {
    return {
      id: "runtime",
      label: "Electron runtime entry is coherent",
      category: "runtime",
      command: "static-electron-runtime-check",
      passed: true,
      exitCode: 0,
      summary: "Electron runtime entry is coherent: passed",
      ...(mainEntry ? { details: `package.json main resolves to ${mainEntry}.` } : {}),
    };
  }

  return {
    id: "runtime",
    label: "Electron runtime entry is coherent",
    category: "runtime",
    command: "static-electron-runtime-check",
    passed: false,
    exitCode: 1,
    summary: "Electron runtime entry is coherent: failed",
    details: truncate(issues.join(" "), 1200),
  };
}

function collectStringMatches(source: string, pattern: RegExp): string[] {
  const matches = new Set<string>();
  for (const match of source.matchAll(pattern)) {
    const value = match[1]?.trim();
    if (value) {
      matches.add(value);
    }
  }
  return [...matches];
}

async function validateElectronIpcSurface(
  repoDir: string,
  manifest: PackageManifest | undefined,
): Promise<ValidationResult | undefined> {
  if (!isLikelyElectronManifest(manifest)) {
    return undefined;
  }

  const mainPath = ["src/main.ts", "src/main.js"]
    .map((candidate) => path.join(repoDir, candidate))
    .find((candidate) => fs.existsSync(candidate));
  const preloadPath = ["src/preload.ts", "src/preload.js"]
    .map((candidate) => path.join(repoDir, candidate))
    .find((candidate) => fs.existsSync(candidate));

  if (!mainPath && !preloadPath) {
    return undefined;
  }

  const issues: string[] = [];
  const mainSource = mainPath ? await fs.promises.readFile(mainPath, "utf8").catch(() => "") : "";
  const preloadSource = preloadPath ? await fs.promises.readFile(preloadPath, "utf8").catch(() => "") : "";

  if (
    /\bipcRenderer\b/.test(mainSource)
    && /from\s+['"]electron['"]/.test(mainSource)
  ) {
    issues.push("Electron main process imports ipcRenderer, which should stay in renderer/preload code rather than the main process.");
  }

  if (mainSource && preloadSource) {
    const exposedInvokeChannels = collectStringMatches(
      preloadSource,
      /ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g,
    );
    const handledChannels = new Set(
      collectStringMatches(
        mainSource,
        /ipcMain\.(?:handle|on)\(\s*['"]([^'"]+)['"]/g,
      ),
    );
    const missingChannels = exposedInvokeChannels.filter((channel) => !handledChannels.has(channel));
    if (missingChannels.length > 0) {
      issues.push(
        `Preload exposes invoke channels with no ipcMain handler yet: ${missingChannels.slice(0, 8).join(", ")}.`,
      );
    }
  }

  if (issues.length === 0) {
    return {
      id: "ipc",
      label: "Electron IPC surface is coherent",
      category: "runtime",
      command: "static-electron-ipc-check",
      passed: true,
      exitCode: 0,
      summary: "Electron IPC surface is coherent: passed",
    };
  }

  return {
    id: "ipc",
    label: "Electron IPC surface is coherent",
    category: "runtime",
    command: "static-electron-ipc-check",
    passed: false,
    exitCode: 1,
    summary: "Electron IPC surface is coherent: failed",
    details: truncate(issues.join(" "), 1200),
  };
}

async function validateCoreSurfaceIntegrity(
  repoDir: string,
  manifest: PackageManifest | undefined,
): Promise<ValidationResult | undefined> {
  if (!isLikelyWebManifest(manifest)) {
    return undefined;
  }

  const issues = await findCoreSurfaceIntegrityIssues(repoDir);
  if (issues.length === 0) {
    return {
      id: "surface",
      label: "Core product surfaces are substantive",
      category: "runtime",
      command: "static-surface-integrity-check",
      passed: true,
      exitCode: 0,
      summary: "Core product surfaces are substantive: passed",
    };
  }

  return {
    id: "surface",
    label: "Core product surfaces are substantive",
    category: "runtime",
    command: "static-surface-integrity-check",
    passed: false,
    exitCode: 1,
    summary: "Core product surfaces are substantive: failed",
    details: truncate(issues.join(" "), 1200),
  };
}

async function hasLikelyWebEntry(repoDir: string): Promise<boolean> {
  const candidates = [
    "src/main.tsx",
    "src/main.jsx",
    "src/index.tsx",
    "src/index.jsx",
    "src/App.tsx",
    "src/App.jsx",
    "app/page.tsx",
    "app/page.jsx",
    "src/app/page.tsx",
    "src/app/page.jsx",
  ];
  for (const candidate of candidates) {
    if (await pathExists(path.join(repoDir, candidate))) {
      return true;
    }
  }
  return false;
}

async function validateWebRuntimeSmoke(
  repoDir: string,
  manifest: PackageManifest | undefined,
): Promise<ValidationResult | undefined> {
  if (!isLikelyWebManifest(manifest)) {
    return undefined;
  }

  const startCommand = webSmokeStartCommand(manifest);
  if (!startCommand || !(await hasLikelyWebEntry(repoDir))) {
    return undefined;
  }

  const result = await runBrowserSmoke({
    repoDir,
    url: "http://127.0.0.1:4173",
    startCommand,
    waitForSelector: "#root, #app, main",
    timeoutMs: 25_000,
  });

  return {
    id: "browser-smoke",
    label: "Browser smoke passes",
    category: "runtime",
    command: startCommand,
    passed: result.passed,
    exitCode: result.passed ? 0 : 1,
    summary: result.summary,
    ...(result.details ? { details: truncate(result.details, 1200) } : {}),
  };
}

export async function runAutoValidations(repoDir: string): Promise<ValidationResult[]> {
  const manifest = await readPackageManifest(repoDir);
  const plan = buildValidationPlan(manifest).slice(0, 4);
  const results: ValidationResult[] = [];

  for (const check of plan) {
    const execution = await runShellCommand(check.command, repoDir, check.timeoutMs);
    const details = `${execution.stdout}\n${execution.stderr}`.trim();
    results.push({
      id: check.id,
      label: check.label,
      category: check.category,
      command: check.command,
      passed: execution.exitCode === 0,
      exitCode: execution.exitCode,
      summary:
        execution.exitCode === 0
          ? `${check.label}: passed`
          : `${check.label}: failed`,
      ...(details ? { details: truncate(details, 1200) } : {}),
    });
  }

  const runtimeResult = await validateElectronRuntimeShape(repoDir, manifest);
  if (runtimeResult) {
    results.push(runtimeResult);
  }
  const ipcResult = await validateElectronIpcSurface(repoDir, manifest);
  if (ipcResult) {
    results.push(ipcResult);
  }
  const surfaceResult = await validateCoreSurfaceIntegrity(repoDir, manifest);
  if (surfaceResult) {
    results.push(surfaceResult);
  }
  const browserSmokeResult = await validateWebRuntimeSmoke(repoDir, manifest);
  if (browserSmokeResult) {
    results.push(browserSmokeResult);
  }

  return results;
}

export function scoreValidationResults(results: ValidationResult[]): number | undefined {
  if (results.length === 0) {
    return undefined;
  }

  const weights: Record<ValidationResult["category"], number> = {
    test: 1.3,
    build: 1.2,
    typecheck: 1.0,
    lint: 0.8,
    runtime: 1.4,
  };
  let earned = 0;
  let possible = 0;
  for (const result of results) {
    const weight = weights[result.category] ?? 1;
    possible += weight;
    if (result.passed) {
      earned += weight;
    }
  }
  return possible === 0 ? undefined : Number(((earned / possible) * 100).toFixed(1));
}
