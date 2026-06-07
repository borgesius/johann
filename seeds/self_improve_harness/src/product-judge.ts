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
    "Penalize generic templates, shallow shells, disconnected features, and products that technically exist but feel empty.",
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

  let response: { content: string; model?: string; usage?: TokenUsageSummary };
  try {
    response = await callOpenRouter(
      config,
      buildPrompt(
        benchmark,
        repoTree,
        previews,
        hiddenCheckScore,
        failedChecks,
        validationResults,
        validationScore,
        previousJudge,
        config,
      ),
    );
  } catch {
    return undefined;
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

  return {
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
  };
}
