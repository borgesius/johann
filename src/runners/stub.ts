import path from "node:path";
import type {
  PriorityItem,
  RunnerAdapter,
  RunnerPhaseContext,
  RunnerPhaseResult,
} from "../types.js";
import { writeText, readText, pathExists } from "../utils.js";
import { buildPhasePrompt, createFallbackPhaseOutput } from "../prompts.js";

function backlogFromJudge(context: RunnerPhaseContext): PriorityItem[] {
  const judge = context.previousJudge;
  if (!judge) {
    return context.visibleBacklog;
  }
  return [
    ...judge.regressions.map((item, index) => ({
      id: `regression-${index + 1}`,
      bucket: "must_fix_regression" as const,
      title: item,
      rationale: "Regression reported by the previous judge.",
      source: "judge",
      severity: 5,
    })),
    ...judge.recommendations.slice(0, 6).map((item, index) => ({
      id: `rec-${index + 1}`,
      bucket: "quality_improvement" as const,
      title: item,
      rationale: "Judge recommendation queued for the next pass.",
      source: "judge",
      severity: 2,
    })),
  ];
}

async function scaffoldElectronRepo(repoDir: string): Promise<void> {
  await writeText(
    path.join(repoDir, "package.json"),
    `{
  "name": "bench-electron-shell",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  },
  "devDependencies": {
    "electron": "^31.0.0"
  }
}
`,
  );
  await writeText(
    path.join(repoDir, "src/main.js"),
    `import { app, BrowserWindow, Menu } from "electron";

function createWindow() {
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    title: "SpecForge",
    webPreferences: {
      preload: new URL("./preload.js", import.meta.url).pathname
    }
  });
  window.loadFile(new URL("./renderer/index.html", import.meta.url).pathname);

  const template = [
    {
      label: "File",
      submenu: [
        { role: "quit" }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(createWindow);
`,
  );
  await writeText(
    path.join(repoDir, "src/preload.js"),
    `import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("specforge", {
  version: "0.1.0"
});
`,
  );
  await writeText(
    path.join(repoDir, "src/renderer/index.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SpecForge</title>
    <style>
      body {
        font-family: Georgia, serif;
        margin: 0;
        background: linear-gradient(160deg, #f4efe1, #dfe9e4);
        color: #1f2d24;
      }
      main {
        max-width: 920px;
        margin: 0 auto;
        padding: 48px 24px 72px;
      }
      .card {
        background: rgba(255,255,255,0.76);
        border-radius: 18px;
        padding: 24px;
        box-shadow: 0 16px 40px rgba(31,45,36,0.12);
      }
    </style>
  </head>
  <body>
    <main>
      <div class="card">
        <h1>SpecForge Desktop</h1>
        <p>Design-led project workspace with keyboard-first navigation and a packaging-ready Electron shell.</p>
      </div>
    </main>
  </body>
</html>
`,
  );
  await writeText(
    path.join(repoDir, "test/smoke.test.js"),
    `import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("electron entry points exist", () => {
  assert.equal(fs.existsSync("src/main.js"), true);
  assert.equal(fs.existsSync("src/preload.js"), true);
});
`,
  );
  await writeText(
    path.join(repoDir, "README.md"),
    `# SpecForge

## Development

- Install dependencies with \`npm install\`
- Run smoke tests with \`npm test\`

## Packaging

- Add your preferred Electron packager and wire it into CI.

## Notes

- The shell includes preload wiring, a renderer entry, and menu scaffolding.
`,
  );
}

async function scaffoldMicrosaasRepo(repoDir: string): Promise<void> {
  await writeText(
    path.join(repoDir, "package.json"),
    `{
  "name": "bench-microsaas",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test"
  }
}
`,
  );
  await writeText(
    path.join(repoDir, "src/logger.js"),
    `export function log(event, context = {}) {
  return JSON.stringify({
    level: "info",
    event,
    context,
    timestamp: new Date().toISOString()
  });
}
`,
  );
  await writeText(
    path.join(repoDir, "src/telemetry.js"),
    `export function healthSnapshot() {
  return {
    status: "ok",
    service: "bench-microsaas",
    timestamp: new Date().toISOString()
  };
}
`,
  );
  await writeText(
    path.join(repoDir, "src/server.js"),
    `import http from "node:http";
import { log } from "./logger.js";
import { healthSnapshot } from "./telemetry.js";

const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(healthSnapshot()));
    return;
  }

  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    product: "bench-microsaas",
    message: log("landing_page_served", { path: request.url ?? "/" })
  }));
});

if (process.env.NODE_ENV !== "test") {
  server.listen(3000);
}

export { server };
`,
  );
  await writeText(
    path.join(repoDir, "test/server.test.js"),
    `import test from "node:test";
import assert from "node:assert/strict";
import { server } from "../src/server.js";

test("health endpoint returns ok", async () => {
  const address = await new Promise((resolve) => {
    const instance = server.listen(0, () => resolve(instance.address()));
  });
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const response = await fetch(\`http://127.0.0.1:\${port}/health\`);
    const body = await response.json();
    assert.equal(body.status, "ok");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
`,
  );
  await writeText(
    path.join(repoDir, "docs/observability.md"),
    `# Observability

- Health endpoint: \`/health\`
- Logging: JSON log helper in \`src/logger.js\`
- Telemetry snapshot: \`src/telemetry.js\`
`,
  );
  await writeText(
    path.join(repoDir, "README.md"),
    `# Bench MicrosaaS

## Development

- \`npm start\`
- \`npm test\`

## Operations

- Health endpoint at \`/health\`
- Structured logs in \`src/logger.js\`
- Observability notes in \`docs/observability.md\`
`,
  );
}

async function repairEvalLoopRepo(repoDir: string): Promise<void> {
  await writeText(
    path.join(repoDir, "src/logger.js"),
    `export function log(level, event, context = {}) {
  return JSON.stringify({
    level,
    event,
    context,
    timestamp: new Date().toISOString()
  });
}
`,
  );
  await writeText(
    path.join(repoDir, "src/server.js"),
    `import http from "node:http";
import { log } from "./logger.js";

const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      status: "ok",
      uptimeHint: "stub-repaired"
    }));
    return;
  }

  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    message: "todo service",
    log: log("info", "homepage_served", { path: request.url ?? "/" })
  }));
});

if (process.env.NODE_ENV !== "test") {
  server.listen(3030);
}

export { server };
`,
  );
  const testFile = path.join(repoDir, "test/server.test.js");
  if (!(await pathExists(testFile))) {
    await writeText(
      testFile,
      `import test from "node:test";
import assert from "node:assert/strict";
import { server } from "../src/server.js";

test("health endpoint responds", async () => {
  const address = await new Promise((resolve) => {
    const instance = server.listen(0, () => resolve(instance.address()));
  });
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const response = await fetch(\`http://127.0.0.1:\${port}/health\`);
    const body = await response.json();
    assert.equal(body.status, "ok");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
`,
    );
  }
  await writeText(
    path.join(repoDir, "README.md"),
    `# Eval Loop Seed

## Development

- Run tests with \`npm test\`

## Ops

- Health endpoint at \`/health\`
- Structured logger in \`src/logger.js\`
`,
  );
  if (await pathExists(path.join(repoDir, "package.json"))) {
    const current = await readText(path.join(repoDir, "package.json"));
    if (!current.includes('"test"')) {
      await writeText(
        path.join(repoDir, "package.json"),
        `{
  "name": "eval-loop-seed",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test"
  }
}
`,
      );
    }
  }
}

export class StubRunner implements RunnerAdapter {
  async runPhase(context: RunnerPhaseContext): Promise<RunnerPhaseResult> {
    const prompt = buildPhasePrompt(context, ["stub-runner"]);

    switch (context.phase) {
      case "pm_intake":
        return {
          summary: "Converted the benchmark brief into an initial backlog.",
          output: {
            summary: "Converted the benchmark brief into an initial backlog.",
            backlog: context.visibleBacklog,
            initiatives: [
              {
                id: "initiative-core-loop",
                title: "Deepen the primary product loop",
                rationale: "A stronger central loop should guide later execution instead of only chasing visible checks.",
                source: "stub",
                severity: 4,
                track: "delivery",
                acceptanceHint: "Pick one meaningful end-to-end flow and make it feel complete.",
              },
            ],
            acceptanceChecklist: context.benchmark.acceptanceCriteria,
            architectureDirectives: [
              "Prefer clear module boundaries over clever consolidation.",
              "Keep README and operational notes close to the implementation.",
            ],
            risks: ["Stub worker cannot simulate real model uncertainty."],
            recommendations: ["Run a real Qwen worker after harness validation."],
          },
          metadata: { prompt },
        };

      case "planning":
        const planningTemplate =
          context.policyId === "branch_rank_revise"
            ? context.benchmark.branchTemplates[0]
            : undefined;
        return {
          summary: "Produced a simple execution plan and branch recommendation.",
          output: {
            summary: "Use a single focused implementation pass, then judge and reprioritize.",
            initiatives: [
              {
                id: "initiative-follow-through",
                title: "Carry one initiative across multiple cycles",
                rationale: "The harness should keep a medium-horizon arc alive instead of reducing everything to local fixes.",
                source: "stub",
                severity: 4,
                track: "exploration",
                acceptanceHint: "Promote this into delivery if the repo stays shallow.",
                branchHingeHint: "Compare narrow scaffold-first vs deeper workflow-first execution.",
              },
            ],
            branchDecision: planningTemplate
              ? {
                  shouldBranch: true,
                  templateId: planningTemplate.id,
                  selectedCandidateIds: planningTemplate.candidates
                    .slice(0, planningTemplate.maxKeep ?? 2)
                    .map((candidate) => candidate.id),
                  rationale: "Exercise the branch-and-rank path for harness validation.",
                }
              : {
                  shouldBranch: false,
                  rationale: "No branch template is active for this phase.",
                },
            architectureDirectives: [
              "Keep a stable top-level layout so later loops can navigate the repo cheaply.",
              "Treat observability and tests as first-class architecture, not cleanup tasks.",
            ],
            testStrategy: ["Run deterministic hidden checks after execution."],
            risks: ["Benchmarks with richer UI still need a real worker pass."],
            recommendations: ["Favor the smallest slice that proves the loop."],
          },
          metadata: { prompt },
        };

      case "execution": {
        if (context.benchmark.id === "electron_spec") {
          await scaffoldElectronRepo(context.repoDir);
        } else if (context.benchmark.id === "microsaas_obs") {
          await scaffoldMicrosaasRepo(context.repoDir);
        } else if (context.benchmark.id === "eval_loop") {
          await repairEvalLoopRepo(context.repoDir);
        }
        return {
          summary: `Stub execution updated the repo for ${context.benchmark.id}.`,
          output: {
            summary: `Stub execution updated the repo for ${context.benchmark.id}.`,
            commandsRun: ["stub:apply-template"],
            filesTouched: ["multiple scaffold files"],
            unresolvedIssues: ["This is scaffolding, not a true autonomous implementation."],
            recommendations: ["Validate with a real OpenRouter worker next."],
          },
          metadata: { prompt },
        };
      }

      case "review":
        return {
          summary: "Stub review completed.",
          output: {
            summary: "The repo has the core expected files but still needs a stronger real-worker pass for depth and polish.",
            initiatives: [
              {
                id: "initiative-depth",
                title: "Turn the scaffold into a coherent product",
                rationale: "The stub can satisfy structure quickly, but the next real pass should add a stronger connected experience.",
                source: "stub-review",
                severity: 4,
                track: "delivery",
              },
            ],
            unresolvedIssues: ["Implementation depth is shallow because this is a stub."],
            recommendations: ["Run the same benchmark on a Qwen worker and compare judge output."],
            risks: ["Stub-generated repos can overfit file-existence checks."],
          },
          metadata: { prompt },
        };

      case "pm_reprioritization":
        return {
          summary: "Turned judge and review feedback into a next-step queue.",
          output: {
            summary: "Turned judge and review feedback into a next-step queue.",
            backlog: backlogFromJudge(context),
            ...(context.visibleInitiatives ? { initiatives: context.visibleInitiatives } : {}),
            architectureDirectives: [
              "Preserve the existing repo shape unless a rewrite clearly improves maintainability.",
            ],
            recommendations: ["Promote remaining required failures ahead of polish."],
            risks: ["A single cycle may hide integration debt."],
            notes: ["Loop is ready for another pass if budget remains."],
          },
          metadata: { prompt },
        };
    }

    return {
      summary: "Stub runner fallback.",
      output: createFallbackPhaseOutput(context.phase, "Stub runner fallback."),
      metadata: { prompt },
    };
  }
}
