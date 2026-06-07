import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/app-smoke.js", () => ({
  runBrowserSmoke: vi.fn(async () => ({
    passed: true,
    summary: "Browser smoke passed for http://127.0.0.1:4173",
    details: "Page title: mocked",
    screenshotPath: "/tmp/mock-browser-smoke.png",
  })),
}));

import { runBrowserSmoke } from "../src/app-smoke.js";
import { judgeRepo } from "../src/judge.js";
import type { ResolvedBenchmarkSpec } from "../src/types.js";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENROUTER_API_KEY;
});

describe("judgeRepo", () => {
  it("scores deterministic hidden checks and reports failures", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "judge-repo-"));
    await fs.mkdir(path.join(repoDir, "src"), { recursive: true });
    await fs.writeFile(path.join(repoDir, "src/app.js"), "export const health = '/health';\n", "utf8");
    await fs.writeFile(
      path.join(repoDir, "README.md"),
      "# Demo\n\n## Development\n\nRun it.\n",
      "utf8",
    );

    const benchmark: ResolvedBenchmarkSpec = {
      id: "judge-demo",
      title: "Judge Demo",
      summary: "Demo benchmark",
      artifactTarget: "Repo",
      publicBriefFile: "benchmarks/judge-demo/brief.md",
      publicBriefPath: path.join(repoDir, "brief.md"),
      publicBrief: "Demo",
      benchmarkDir: repoDir,
      workspaceSeed: "seeds/judge-demo",
      workspaceSeedPath: repoDir,
      budgets: { minMinutes: 20, maxMinutes: 40, defaultMinutes: 30 },
      acceptanceCriteria: [],
      branchTemplates: [],
      hiddenChecks: [
        {
          id: "app-file",
          title: "App file exists",
          category: "repo",
          weight: 1,
          required: true,
          type: "fileExists",
          path: "src/app.js",
        },
        {
          id: "health-string",
          title: "Health string exists",
          category: "product",
          weight: 1,
          required: true,
          type: "globTextIncludes",
          pattern: "src/*.js",
          includes: ["/health"],
          mode: "all",
        },
        {
          id: "alternate-module-name",
          title: "Alternate module naming is accepted",
          category: "repo",
          weight: 1,
          required: true,
          type: "globAnyCount",
          patterns: ["src/*store*.*", "src/*app*.*"],
          count: 1,
        },
        {
          id: "missing-tests",
          title: "Tests exist",
          category: "quality",
          weight: 1,
          required: true,
          type: "globCount",
          pattern: "test/**",
          count: 1,
        },
      ],
      judgeWeights: {},
      expectedRoleOutputs: {},
      successThreshold: 80,
    };

    const judge = await judgeRepo(benchmark, repoDir);
    expect(judge.hiddenCheckScore).toBeCloseTo(75, 1);
    expect(judge.failedChecks).toHaveLength(1);
    expect(judge.failedChecks[0]?.check.id).toBe("missing-tests");
    expect(judge.passedRequired).toBe(false);
  });

  it("applies benchmark category weights when computing the total score", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "judge-weighted-"));
    await fs.mkdir(path.join(repoDir, "src"), { recursive: true });
    await fs.writeFile(path.join(repoDir, "src/app.js"), "export const app = true;\n", "utf8");

    const benchmark: ResolvedBenchmarkSpec = {
      id: "judge-weighted",
      title: "Judge Weighted",
      summary: "Weighted scoring benchmark",
      artifactTarget: "Repo",
      publicBriefFile: "benchmarks/judge-weighted/brief.md",
      publicBriefPath: path.join(repoDir, "brief.md"),
      publicBrief: "Demo",
      benchmarkDir: repoDir,
      workspaceSeed: "seeds/judge-weighted",
      workspaceSeedPath: repoDir,
      budgets: { minMinutes: 20, maxMinutes: 40, defaultMinutes: 30 },
      acceptanceCriteria: [],
      branchTemplates: [],
      hiddenChecks: [
        {
          id: "repo-file",
          title: "Repo file exists",
          category: "repo",
          weight: 1,
          required: true,
          type: "fileExists",
          path: "src/app.js",
        },
        {
          id: "product-file",
          title: "Product file exists",
          category: "product",
          weight: 1,
          required: true,
          type: "fileExists",
          path: "src/missing.js",
        },
      ],
      judgeWeights: {
        repo: 0.2,
        product: 0.8,
      },
      expectedRoleOutputs: {},
      successThreshold: 80,
    };

    const judge = await judgeRepo(benchmark, repoDir);
    expect(judge.byCategory.repo).toBe(100);
    expect(judge.byCategory.product).toBe(0);
    expect(judge.hiddenCheckScore).toBeCloseTo(20, 1);
  });

  it("can score a browser smoke check and persist screenshot details", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "judge-browser-smoke-"));
    const artifactsDir = path.join(repoDir, "artifacts");
    await fs.mkdir(artifactsDir, { recursive: true });

    const benchmark: ResolvedBenchmarkSpec = {
      id: "judge-browser-smoke",
      title: "Judge Browser Smoke",
      summary: "Browser smoke benchmark",
      artifactTarget: "Repo",
      publicBriefFile: "benchmarks/judge-browser-smoke/brief.md",
      publicBriefPath: path.join(repoDir, "brief.md"),
      publicBrief: "Demo",
      benchmarkDir: repoDir,
      workspaceSeed: "seeds/judge-browser-smoke",
      workspaceSeedPath: repoDir,
      budgets: { minMinutes: 20, maxMinutes: 40, defaultMinutes: 30 },
      acceptanceCriteria: [],
      branchTemplates: [],
      hiddenChecks: [
        {
          id: "browser-smoke",
          title: "Browser smoke passes",
          category: "quality",
          weight: 2,
          required: true,
          type: "appSmoke",
          appTarget: "browser",
          startCommand: "PORT=4173 npm run start",
          url: "http://127.0.0.1:4173",
          waitForText: ["Release Queue"],
        },
      ],
      judgeWeights: {},
      expectedRoleOutputs: {},
      successThreshold: 80,
    };

    const judge = await judgeRepo(benchmark, repoDir, undefined, { artifactsDir });
    expect(judge.hiddenCheckScore).toBe(100);
    expect(judge.failedChecks).toHaveLength(0);
    expect(judge.passedRequired).toBe(true);
    expect(runBrowserSmoke).toHaveBeenCalledOnce();
    expect(judge.passedChecks[0]?.details).toContain("mock-browser-smoke.png");
  });

  it("runs automatic validation commands when package scripts exist", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "judge-validations-"));
    await fs.mkdir(path.join(repoDir, "src"), { recursive: true });
    await fs.writeFile(path.join(repoDir, "src/app.js"), "export const app = true;\n", "utf8");
    await fs.writeFile(
      path.join(repoDir, "package.json"),
      JSON.stringify(
        {
          name: "judge-validations",
          version: "1.0.0",
          scripts: {
            test: 'node -e "process.exit(0)"',
            build: 'node -e "process.exit(1)"',
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const benchmark: ResolvedBenchmarkSpec = {
      id: "judge-validations",
      title: "Judge Validations",
      summary: "Validation benchmark",
      artifactTarget: "Repo",
      publicBriefFile: "benchmarks/judge-validations/brief.md",
      publicBriefPath: path.join(repoDir, "brief.md"),
      publicBrief: "Demo",
      benchmarkDir: repoDir,
      workspaceSeed: "seeds/judge-validations",
      workspaceSeedPath: repoDir,
      budgets: { minMinutes: 20, maxMinutes: 40, defaultMinutes: 30 },
      acceptanceCriteria: [],
      branchTemplates: [],
      hiddenChecks: [
        {
          id: "package-json",
          title: "package.json exists",
          category: "repo",
          weight: 1,
          required: true,
          type: "fileExists",
          path: "package.json",
        },
      ],
      judgeWeights: {},
      expectedRoleOutputs: {},
      successThreshold: 80,
    };

    const judge = await judgeRepo(benchmark, repoDir);
    expect(judge.validationResults).toHaveLength(2);
    expect(judge.validationResults?.find((item) => item.id === "test")?.passed).toBe(true);
    expect(judge.validationResults?.find((item) => item.id === "build")?.passed).toBe(false);
    expect(judge.validationScore).toBeLessThan(100);
    expect(judge.passedValidation).toBe(false);
    expect(judge.recommendations).toContain("Fix failing validation: Build passes");
  });

  it("blends hidden checks with a product-quality review when enabled", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "judge-product-quality-"));
    await fs.mkdir(path.join(repoDir, "src"), { recursive: true });
    await fs.writeFile(path.join(repoDir, "src/app.js"), "export const app = true;\n", "utf8");
    process.env.OPENROUTER_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        model: "qwen/qwen3-coder-flash",
        usage: {
          prompt_tokens: 120,
          completion_tokens: 40,
          total_tokens: 160,
          cost: 0.0012,
        },
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "The repo has a promising start but still feels thin.",
                overallScore: 80,
                axes: {
                  product_depth: 72,
                  architecture_coherence: 84,
                },
                findings: ["Core flow exists but feature depth is still shallow."],
                recommendations: ["Deepen the operator flow and add one meaningful end-to-end path."],
                opportunities: [
                  {
                    id: "deepen-flow",
                    title: "Deepen operator flow",
                    rationale: "A fuller end-to-end path would make the product feel less like a shell.",
                    source: "product-judge",
                    severity: 4,
                    track: "delivery",
                  },
                ],
              }),
            },
          },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const benchmark: ResolvedBenchmarkSpec = {
      id: "judge-product-quality",
      title: "Judge Product Quality",
      summary: "Hybrid scoring benchmark",
      artifactTarget: "Operator console",
      publicBriefFile: "benchmarks/judge-product-quality/brief.md",
      publicBriefPath: path.join(repoDir, "brief.md"),
      publicBrief: "Build an operator console with a meaningful flow.",
      benchmarkDir: repoDir,
      workspaceSeed: "seeds/judge-product-quality",
      workspaceSeedPath: repoDir,
      budgets: { minMinutes: 20, maxMinutes: 40, defaultMinutes: 30 },
      acceptanceCriteria: [],
      branchTemplates: [],
      hiddenChecks: [
        {
          id: "app-file",
          title: "App file exists",
          category: "repo",
          weight: 1,
          required: true,
          type: "fileExists",
          path: "src/app.js",
        },
        {
          id: "readme-file",
          title: "README exists",
          category: "docs",
          weight: 1,
          required: true,
          type: "fileExists",
          path: "README.md",
        },
      ],
      judgeWeights: {},
      expectedRoleOutputs: {},
      successThreshold: 80,
      productJudge: {
        enabled: true,
        workerModel: "qwen/qwen3-coder-flash",
        hiddenCheckWeight: 0.25,
        productQualityWeight: 0.75,
        profile: {
          summary: "Judge this as an operator console with one meaty workflow, not as a panel gallery.",
          reward: [
            "A single strong operator journey with meaningful shared state.",
          ],
          penalize: [
            "Feature islands and disconnected panels that look broad but feel shallow.",
          ],
        },
      },
    };

    const judge = await judgeRepo(benchmark, repoDir);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(judge.hiddenCheckScore).toBeCloseTo(50, 1);
    expect(judge.productQualityScore).toBe(80);
    expect(judge.totalScore).toBeCloseTo(72.5, 1);
    expect(judge.judgeUsage?.totalTokens).toBe(160);
    expect(judge.byCategory.product_quality).toBe(80);
    expect(judge.productReview?.opportunities[0]?.title).toBe("Deepen operator flow");
    const fetchCall = fetchMock.mock.calls[0] as [unknown, { body?: string } | undefined] | undefined;
    const fetchArgs = fetchCall?.[1];
    const body = fetchArgs && typeof fetchArgs === "object" && "body" in fetchArgs
      ? JSON.parse(String(fetchArgs.body))
      : undefined;
    const systemPrompt = body?.messages?.[0]?.content;
    expect(systemPrompt).toContain("Judge this as an operator console with one meaty workflow");
    expect(systemPrompt).toContain("A single strong operator journey with meaningful shared state.");
    expect(systemPrompt).toContain("Feature islands and disconnected panels that look broad but feel shallow.");
  });

  it("falls back to a heuristic product review when the model judge is unavailable", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "judge-heuristic-fallback-"));
    await fs.mkdir(path.join(repoDir, "src/components"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, "src/App.tsx"),
      [
        "import { useState } from 'react';",
        "import ToolA from './components/ToolA';",
        "import ToolB from './components/ToolB';",
        "import ToolC from './components/ToolC';",
        "import ToolD from './components/ToolD';",
        "import ToolE from './components/ToolE';",
        "import ToolF from './components/ToolF';",
        "",
        "export default function App() {",
        "  const [tab, setTab] = useState('a');",
        "  const [mode, setMode] = useState('default');",
        "  const [panel, setPanel] = useState('left');",
        "  const [draft, setDraft] = useState('');",
        "  return <main>{tab}{mode}{panel}{draft}<ToolA /><ToolB /><ToolC /><ToolD /><ToolE /><ToolF /></main>;",
        "}",
        ...Array.from({ length: 230 }, (_, index) => `// shell filler ${index + 1}`),
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(repoDir, "src/components/ToolA.tsx"),
      "export default function ToolA() { return <section>ToolA</section>; }\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(repoDir, "src/components/ToolB.tsx"),
      "export default function ToolB() { return <section>ToolB</section>; }\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(repoDir, "src/components/ToolC.tsx"),
      "export default function ToolC() { return <section>ToolC</section>; }\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(repoDir, "src/components/ToolD.tsx"),
      "export default function ToolD() { return <section>ToolD</section>; }\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(repoDir, "src/components/ToolE.tsx"),
      "export default function ToolE() { return <section>ToolE</section>; }\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(repoDir, "src/components/ToolF.tsx"),
      "export default function ToolF() { return <section>ToolF</section>; }\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(repoDir, "package.json"),
      JSON.stringify({
        name: "heuristic-fallback",
        version: "1.0.0",
        scripts: {
          build: 'node -e "process.exit(0)"',
        },
      }, null, 2),
      "utf8",
    );
    await fs.writeFile(path.join(repoDir, "README.md"), "# Demo\n", "utf8");
    await fs.writeFile(path.join(repoDir, "tsconfig.json"), "{ }\n", "utf8");

    const benchmark: ResolvedBenchmarkSpec = {
      id: "judge-heuristic-fallback",
      title: "Judge Heuristic Fallback",
      summary: "Heuristic fallback benchmark",
      artifactTarget: "Interactive web app",
      publicBriefFile: "benchmarks/judge-heuristic-fallback/brief.md",
      publicBriefPath: path.join(repoDir, "brief.md"),
      publicBrief: "Build one deep loop rather than a tool gallery.",
      benchmarkDir: repoDir,
      workspaceSeed: "seeds/judge-heuristic-fallback",
      workspaceSeedPath: repoDir,
      budgets: { minMinutes: 20, maxMinutes: 40, defaultMinutes: 30 },
      acceptanceCriteria: [],
      branchTemplates: [],
      hiddenChecks: [
        {
          id: "app-file",
          title: "App file exists",
          category: "repo",
          weight: 1,
          required: true,
          type: "fileExists",
          path: "src/App.tsx",
        },
        {
          id: "readme-file",
          title: "README exists",
          category: "docs",
          weight: 1,
          required: true,
          type: "fileExists",
          path: "README.md",
        },
      ],
      judgeWeights: {},
      expectedRoleOutputs: {},
      successThreshold: 80,
      productJudge: {
        enabled: true,
        workerModel: "qwen/qwen3-coder-flash",
        hiddenCheckWeight: 0.25,
        productQualityWeight: 0.75,
      },
    };

    const judge = await judgeRepo(benchmark, repoDir);
    expect(judge.productQualityScore).toBeDefined();
    expect(judge.productReview?.model).toBe("heuristic-fallback");
    expect(judge.productReview?.findings.join(" ")).toContain("surface-heavy");
    expect(judge.recommendations.join(" ")).toContain("interaction loop");
    expect(judge.confidence).toBeLessThan(0.9);
  });

  it("calibrates down demo-like feature sprawl and overgrown entrypoint shells", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "judge-feature-sprawl-"));
    await fs.mkdir(path.join(repoDir, "src/components"), { recursive: true });
    process.env.OPENROUTER_API_KEY = "test-key";

    const giantApp = [
      "import { useState } from 'react';",
      "import SurfaceOne from './components/SurfaceOne';",
      "import SurfaceTwo from './components/SurfaceTwo';",
      "import SurfaceThree from './components/SurfaceThree';",
      "import SurfaceFour from './components/SurfaceFour';",
      "import SurfaceFive from './components/SurfaceFive';",
      "import SurfaceSix from './components/SurfaceSix';",
      "",
      "export default function App() {",
      "  const [tab, setTab] = useState('one');",
      "  const [mode, setMode] = useState('default');",
      "  const [view, setView] = useState('overview');",
      "  const [panel, setPanel] = useState('a');",
      "  const [focus, setFocus] = useState('x');",
      "  const [draft, setDraft] = useState('');",
      "  return <main>{tab}{mode}{view}{panel}{focus}{draft}<SurfaceOne /><SurfaceTwo /><SurfaceThree /><SurfaceFour /><SurfaceFive /><SurfaceSix /></main>;",
      "}",
      ...Array.from({ length: 240 }, (_, index) => `// orchestration filler ${index + 1}`),
      "",
    ].join("\n");

    await fs.writeFile(path.join(repoDir, "src/App.tsx"), giantApp, "utf8");
    await fs.writeFile(path.join(repoDir, "src/main.tsx"), "export {};\n", "utf8");
    for (const name of ["SurfaceOne", "SurfaceTwo", "SurfaceThree", "SurfaceFour", "SurfaceFive", "SurfaceSix"]) {
      await fs.writeFile(
        path.join(repoDir, "src/components", `${name}.tsx`),
        `export default function ${name}() { return <section>${name}</section>; }\n`,
        "utf8",
      );
    }
    await fs.writeFile(
      path.join(repoDir, "package.json"),
      JSON.stringify({
        name: "sprawl-demo",
        version: "1.0.0",
        scripts: {
          build: 'node -e "process.exit(0)"',
        },
        dependencies: {
          react: "^18.2.0",
        },
        devDependencies: {
          vite: "^5.0.0",
        },
      }, null, 2),
      "utf8",
    );
    await fs.writeFile(path.join(repoDir, "README.md"), "# Demo\n", "utf8");
    await fs.writeFile(path.join(repoDir, "tsconfig.json"), "{ }\n", "utf8");

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        model: "qwen/qwen3-coder-flash",
        usage: {
          prompt_tokens: 180,
          completion_tokens: 60,
          total_tokens: 240,
          cost: 0.0018,
        },
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "Looks like an ambitious polished product.",
                overallScore: 96,
                axes: {
                  product_depth: 95,
                  architecture_coherence: 94,
                  forward_readiness: 93,
                },
                findings: ["Many surfaces create a rich experience."],
                recommendations: ["Keep expanding the current feature set."],
                opportunities: [],
              }),
            },
          },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const benchmark: ResolvedBenchmarkSpec = {
      id: "judge-feature-sprawl",
      title: "Judge Feature Sprawl",
      summary: "Feature-sprawl calibration benchmark",
      artifactTarget: "Interactive web app",
      publicBriefFile: "benchmarks/judge-feature-sprawl/brief.md",
      publicBriefPath: path.join(repoDir, "brief.md"),
      publicBrief: "Build one or two deep interaction loops, not a demo shell with many disconnected tools.",
      benchmarkDir: repoDir,
      workspaceSeed: "seeds/judge-feature-sprawl",
      workspaceSeedPath: repoDir,
      budgets: { minMinutes: 20, maxMinutes: 40, defaultMinutes: 30 },
      acceptanceCriteria: [],
      branchTemplates: [],
      hiddenChecks: [
        {
          id: "app-file",
          title: "App file exists",
          category: "repo",
          weight: 1,
          required: true,
          type: "fileExists",
          path: "src/App.tsx",
        },
        {
          id: "readme-file",
          title: "README exists",
          category: "docs",
          weight: 1,
          required: true,
          type: "fileExists",
          path: "README.md",
        },
      ],
      judgeWeights: {},
      expectedRoleOutputs: {},
      successThreshold: 80,
      productJudge: {
        enabled: true,
        workerModel: "qwen/qwen3-coder-flash",
        hiddenCheckWeight: 0.25,
        productQualityWeight: 0.75,
      },
    };

    const judge = await judgeRepo(benchmark, repoDir);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(judge.productQualityScore).toBeLessThan(90);
    expect(judge.productReview?.findings.join(" ")).toContain("presentation surfaces");
    expect(judge.recommendations.join(" ")).toContain("central interaction loops");
  });

  it("calibrates down feature-island products without a shared underlying system", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "judge-feature-islands-"));
    await fs.mkdir(path.join(repoDir, "src"), { recursive: true });
    process.env.OPENROUTER_API_KEY = "test-key";

    await fs.writeFile(
      path.join(repoDir, "src/App.tsx"),
      [
        "import AlphaUI from './AlphaUI';",
        "import BetaUI from './BetaUI';",
        "import GammaUI from './GammaUI';",
        "export default function App() {",
        "  return <main><AlphaUI /><BetaUI /><GammaUI /></main>;",
        "}",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(path.join(repoDir, "src/AlphaUI.tsx"), "export default function AlphaUI() { return <section>Alpha</section>; }\n", "utf8");
    await fs.writeFile(path.join(repoDir, "src/BetaUI.tsx"), "export default function BetaUI() { return <section>Beta</section>; }\n", "utf8");
    await fs.writeFile(path.join(repoDir, "src/GammaUI.tsx"), "export default function GammaUI() { return <section>Gamma</section>; }\n", "utf8");
    await fs.writeFile(path.join(repoDir, "src/Alpha.ts"), "export const alpha = () => 'alpha';\n", "utf8");
    await fs.writeFile(path.join(repoDir, "src/Beta.ts"), "export const beta = () => 'beta';\n", "utf8");
    await fs.writeFile(path.join(repoDir, "src/Gamma.ts"), "export const gamma = () => 'gamma';\n", "utf8");
    await fs.writeFile(
      path.join(repoDir, "package.json"),
      JSON.stringify({
        name: "feature-islands",
        version: "1.0.0",
        scripts: {
          build: 'node -e "process.exit(0)"',
        },
      }, null, 2),
      "utf8",
    );
    await fs.writeFile(path.join(repoDir, "README.md"), "# Islands\n", "utf8");
    await fs.writeFile(path.join(repoDir, "tsconfig.json"), "{ }\n", "utf8");

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        model: "qwen/qwen3-coder-flash",
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "A rich and impressive product suite.",
                overallScore: 95,
                axes: {
                  product_depth: 94,
                  architecture_coherence: 93,
                  forward_readiness: 92,
                  technical_quality: 90,
                },
                findings: ["Several tools are available."],
                recommendations: ["Keep shipping more tools."],
                opportunities: [],
              }),
            },
          },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const benchmark: ResolvedBenchmarkSpec = {
      id: "judge-feature-islands",
      title: "Judge Feature Islands",
      summary: "Feature-island calibration benchmark",
      artifactTarget: "Interactive product",
      publicBriefFile: "benchmarks/judge-feature-islands/brief.md",
      publicBriefPath: path.join(repoDir, "brief.md"),
      publicBrief: "Build one coherent system, not isolated subtools.",
      benchmarkDir: repoDir,
      workspaceSeed: "seeds/judge-feature-islands",
      workspaceSeedPath: repoDir,
      budgets: { minMinutes: 20, maxMinutes: 40, defaultMinutes: 30 },
      acceptanceCriteria: [],
      branchTemplates: [],
      hiddenChecks: [
        {
          id: "app-file",
          title: "App file exists",
          category: "repo",
          weight: 1,
          required: true,
          type: "fileExists",
          path: "src/App.tsx",
        },
      ],
      judgeWeights: {},
      expectedRoleOutputs: {},
      successThreshold: 80,
      productJudge: {
        enabled: true,
      },
    };

    const judge = await judgeRepo(benchmark, repoDir);
    expect(judge.productQualityScore).toBeLessThan(90);
    expect(judge.productReview?.findings.join(" ")).toContain("feature islands");
    expect(judge.recommendations.join(" ")).toContain("shared state");
  });
});
