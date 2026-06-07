import path from "node:path";
import type { ValidationResult } from "./types.js";
import { pathExists, readJson, runShellCommand, truncate } from "./utils.js";

type PackageManifest = {
  scripts?: Record<string, string>;
};

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
  return normalized.includes("todo") || normalized.includes("not implemented");
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

