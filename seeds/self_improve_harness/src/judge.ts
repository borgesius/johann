import path from "node:path";
import fs from "node:fs/promises";
import { runBrowserSmoke } from "./app-smoke.js";
import { evaluateProductQuality, resolveProductJudgeConfig } from "./product-judge.js";
import type {
  JudgeCheckResult,
  JudgeResult,
  HiddenCheck,
  ResolvedBenchmarkSpec,
} from "./types.js";
import { findMatches, pathExists, readText, runShellCommand } from "./utils.js";
import { runAutoValidations, scoreValidationResults } from "./validation.js";

function textMatchSummary(raw: string, includes: string[], mode: "all" | "any"): {
  passed: boolean;
  matched: string[];
} {
  const matched = includes.filter((snippet) => raw.includes(snippet));
  const passed = mode === "all" ? matched.length === includes.length : matched.length > 0;
  return { passed, matched };
}

type JudgeOptions = {
  artifactsDir?: string;
};

async function runCheck(
  repoDir: string,
  check: HiddenCheck,
  options?: JudgeOptions,
): Promise<JudgeCheckResult> {
  switch (check.type) {
    case "fileExists": {
      const target = check.path ? path.join(repoDir, check.path) : "";
      const passed = check.path ? await pathExists(target) : false;
      return {
        check,
        passed,
        score: passed ? check.weight : 0,
        message: passed
          ? `${check.path} exists`
          : `${check.path ?? "path"} is missing`,
      };
    }
    case "globCount": {
      const matches = check.pattern ? await findMatches(repoDir, check.pattern) : [];
      const passed = matches.length >= (check.count ?? 1);
      return {
        check,
        passed,
        score: passed ? check.weight : 0,
        message: passed
          ? `Found ${matches.length} matches for ${check.pattern}`
          : `Expected at least ${check.count ?? 1} matches for ${check.pattern}, found ${matches.length}`,
        details: matches.join("\n"),
      };
    }
    case "globAnyCount": {
      if (!check.patterns || check.patterns.length === 0) {
        return {
          check,
          passed: false,
          score: 0,
          message: "Invalid globAnyCount check configuration",
        };
      }
      const uniqueMatches = new Set<string>();
      for (const pattern of check.patterns) {
        const matches = await findMatches(repoDir, pattern);
        for (const match of matches) {
          uniqueMatches.add(match);
        }
      }
      const matchList = [...uniqueMatches].sort();
      const passed = matchList.length >= (check.count ?? 1);
      return {
        check,
        passed,
        score: passed ? check.weight : 0,
        message: passed
          ? `Found ${matchList.length} matches across alternate globs`
          : `Expected at least ${check.count ?? 1} matches across alternate globs, found ${matchList.length}`,
        details: matchList.join("\n"),
      };
    }
    case "textIncludes": {
      if (!check.path || !check.includes || check.includes.length === 0) {
        return {
          check,
          passed: false,
          score: 0,
          message: "Invalid textIncludes check configuration",
        };
      }

      const target = path.join(repoDir, check.path);
      if (!(await pathExists(target))) {
        return {
          check,
          passed: false,
          score: 0,
          message: `${check.path} is missing`,
        };
      }

      const raw = await readText(target);
      const mode = check.mode ?? "all";
      const { passed, matched } = textMatchSummary(raw, check.includes, mode);
      return {
        check,
        passed,
        score: passed ? check.weight : 0,
        message: passed
          ? `${check.path} contains expected text`
          : `${check.path} is missing expected text`,
        details: `Matched ${matched.length}/${check.includes.length} snippets`,
      };
    }
    case "globTextIncludes": {
      if (!check.pattern || !check.includes || check.includes.length === 0) {
        return {
          check,
          passed: false,
          score: 0,
          message: "Invalid globTextIncludes check configuration",
        };
      }

      const matches = await findMatches(repoDir, check.pattern);
      if (matches.length === 0) {
        return {
          check,
          passed: false,
          score: 0,
          message: `No files matched ${check.pattern}`,
        };
      }

      const mode = check.mode ?? "all";
      const satisfiedFiles: string[] = [];
      for (const relativePath of matches) {
        const raw = await readText(path.join(repoDir, relativePath));
        const result = textMatchSummary(raw, check.includes, mode);
        if (result.passed) {
          satisfiedFiles.push(relativePath);
        }
      }

      const passed = satisfiedFiles.length > 0;
      return {
        check,
        passed,
        score: passed ? check.weight : 0,
        message: passed
          ? `Found expected text in ${satisfiedFiles[0]}`
          : `Files matching ${check.pattern} are missing expected text`,
        details: satisfiedFiles.length > 0 ? satisfiedFiles.join("\n") : matches.join("\n"),
      };
    }
    case "commandExitZero": {
      if (!check.command) {
        return {
          check,
          passed: false,
          score: 0,
          message: "Invalid commandExitZero configuration",
        };
      }

      const result = await runShellCommand(
        check.command,
        repoDir,
        (check.timeoutSeconds ?? 120) * 1_000,
        check.env,
      );
      const passed = result.exitCode === 0;
      return {
        check,
        passed,
        score: passed ? check.weight : 0,
        message: passed
          ? `Command passed: ${check.command}`
          : `Command failed: ${check.command}`,
        details: `${result.stdout}\n${result.stderr}`.trim(),
      };
    }
    case "appSmoke": {
      if (!check.url) {
        return {
          check,
          passed: false,
          score: 0,
          message: "Invalid appSmoke configuration",
        };
      }
      if (check.appTarget && check.appTarget !== "browser") {
        return {
          check,
          passed: false,
          score: 0,
          message: `Unsupported appSmoke target: ${check.appTarget}`,
        };
      }

      const screenshotPath = options?.artifactsDir
        ? path.join(
            options.artifactsDir,
            "judge-smoke",
            check.screenshotName ?? `${check.id}.png`,
          )
        : undefined;
      const result = await runBrowserSmoke({
        repoDir,
        url: check.url,
        timeoutMs: (check.timeoutSeconds ?? 45) * 1_000,
        ...(check.startCommand ? { startCommand: check.startCommand } : {}),
        ...(check.waitForText ? { waitForText: check.waitForText } : {}),
        ...(check.waitForSelector ? { waitForSelector: check.waitForSelector } : {}),
        ...(screenshotPath ? { screenshotPath } : {}),
      });

      return {
        check,
        passed: result.passed,
        score: result.passed ? check.weight : 0,
        message: result.summary,
        details: truncateSmokeDetails(result.details, result.screenshotPath),
      };
    }
  }
}

function truncateSmokeDetails(details: string, screenshotPath?: string): string {
  const lines = [details.trim()];
  if (screenshotPath) {
    lines.push(`Screenshot: ${screenshotPath}`);
  }
  return lines.filter(Boolean).join("\n");
}

function scoreByCategory(checks: JudgeCheckResult[]): Record<string, number> {
  const totals = new Map<string, { earned: number; possible: number }>();

  for (const result of checks) {
    const current = totals.get(result.check.category) ?? { earned: 0, possible: 0 };
    current.earned += result.score;
    current.possible += result.check.weight;
    totals.set(result.check.category, current);
  }

  return Object.fromEntries(
    [...totals.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([category, value]) => [
        category,
        value.possible === 0 ? 0 : Number(((value.earned / value.possible) * 100).toFixed(1)),
      ]),
  );
}

function weightedTotalScore(
  checks: JudgeCheckResult[],
  judgeWeights: Record<string, number>,
): number {
  const totals = new Map<string, { earned: number; possible: number }>();
  for (const result of checks) {
    const current = totals.get(result.check.category) ?? { earned: 0, possible: 0 };
    current.earned += result.score;
    current.possible += result.check.weight;
    totals.set(result.check.category, current);
  }

  const configuredWeights = Object.entries(judgeWeights).filter(
    ([, value]) => typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  if (configuredWeights.length === 0) {
    const totalPossible = checks.reduce((sum, check) => sum + check.check.weight, 0);
    const totalEarned = checks.reduce((sum, check) => sum + check.score, 0);
    return totalPossible === 0 ? 0 : Number(((totalEarned / totalPossible) * 100).toFixed(1));
  }

  const totalWeight = configuredWeights.reduce((sum, [, weight]) => sum + weight, 0);
  const weightedScore = configuredWeights.reduce((sum, [category, weight]) => {
    const categoryTotal = totals.get(category);
    const ratio =
      !categoryTotal || categoryTotal.possible === 0 ? 0 : categoryTotal.earned / categoryTotal.possible;
    return sum + ratio * (weight / totalWeight) * 100;
  }, 0);

  return Number(weightedScore.toFixed(1));
}

function blendScores(
  hiddenCheckScore: number,
  productQualityScore: number | undefined,
  benchmark: ResolvedBenchmarkSpec,
): number {
  if (productQualityScore === undefined) {
    return hiddenCheckScore;
  }

  const config = resolveProductJudgeConfig(benchmark);
  if (!config) {
    return hiddenCheckScore;
  }

  const totalWeight = config.hiddenCheckWeight + config.productQualityWeight;
  if (totalWeight <= 0) {
    return hiddenCheckScore;
  }

  return Number(
    (
      (hiddenCheckScore * config.hiddenCheckWeight +
        productQualityScore * config.productQualityWeight)
      / totalWeight
    ).toFixed(1),
  );
}

export async function judgeRepo(
  benchmark: ResolvedBenchmarkSpec,
  repoDir: string,
  previousJudge?: JudgeResult,
  options?: JudgeOptions,
): Promise<JudgeResult> {
  const checks: JudgeCheckResult[] = [];
  for (const check of benchmark.hiddenChecks) {
    checks.push(await runCheck(repoDir, check, options));
  }
  const failedChecks = checks.filter((check) => !check.passed);
  const passedChecks = checks.filter((check) => check.passed);
  const previousPassed = new Set(previousJudge?.passedChecks.map((check) => check.check.id) ?? []);
  const regressions = failedChecks
    .filter((check) => previousPassed.has(check.check.id))
    .map((check) => check.check.title);
  const hiddenCheckScore = weightedTotalScore(checks, benchmark.judgeWeights);
  const validationResults = await runAutoValidations(repoDir);
  const validationScore = scoreValidationResults(validationResults);
  const productReview = await evaluateProductQuality(
    benchmark,
    repoDir,
    hiddenCheckScore,
    failedChecks,
    validationResults,
    validationScore,
    previousJudge,
  );
  const productQualityScore = productReview?.overallScore;
  const technicalQualityScore = productReview?.axes.technical_quality;
  const recommendations = [
    ...failedChecks
      .filter((check) => check.check.required)
      .map((check) => `Fix required gap: ${check.check.title}`),
    ...failedChecks
      .filter((check) => !check.check.required)
      .map((check) => `Improve quality: ${check.check.title}`),
    ...validationResults
      .filter((result) => !result.passed)
      .map((result) => `Fix failing validation: ${result.label}`),
    ...(productReview?.recommendations ?? []),
  ].filter((value, index, items) => items.indexOf(value) === index);
  const byCategory = scoreByCategory(checks);
  if (productQualityScore !== undefined) {
    byCategory.product_quality = productQualityScore;
  }
  if (technicalQualityScore !== undefined) {
    byCategory.technical_quality = technicalQualityScore;
  }
  if (validationScore !== undefined) {
    byCategory.validation = validationScore;
  }
  const passedValidation =
    validationResults.length > 0 ? validationResults.every((result) => result.passed) : undefined;

  return {
    scoredAt: new Date().toISOString(),
    totalScore: blendScores(hiddenCheckScore, productQualityScore, benchmark),
    hiddenCheckScore,
    ...(productQualityScore !== undefined ? { productQualityScore } : {}),
    ...(technicalQualityScore !== undefined ? { technicalQualityScore } : {}),
    ...(validationScore !== undefined ? { validationScore } : {}),
    ...(productReview?.usage ? { judgeUsage: productReview.usage } : {}),
    byCategory,
    passedRequired: failedChecks.every((check) => !check.check.required),
    ...(passedValidation !== undefined ? { passedValidation } : {}),
    confidence: Number(
      (
        0.7 +
        Math.min(0.2, checks.length * 0.025) +
        (productReview ? 0.08 : 0)
      ).toFixed(2),
    ),
    failedChecks,
    passedChecks,
    regressions,
    recommendations,
    ...(productReview ? { productReview } : {}),
    ...(validationResults.length > 0 ? { validationResults } : {}),
  };
}

export async function writeJudgeArtifact(target: string, judge: JudgeResult): Promise<void> {
  await fs.writeFile(target, `${JSON.stringify(judge, null, 2)}\n`, "utf8");
}
