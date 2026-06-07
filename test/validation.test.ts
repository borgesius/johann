import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/app-smoke.js", () => ({
  runBrowserSmoke: vi.fn(async () => ({
    passed: true,
    summary: "Browser smoke passed for http://127.0.0.1:4173",
    details: "Page title: mocked",
  })),
}));

import { runBrowserSmoke } from "../src/app-smoke.js";
import { runAutoValidations, scoreValidationResults } from "../src/validation.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("validation runtime checks", () => {
  it("runs browser smoke validation for likely web apps and reports live failures", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bench-validation-web-smoke-"));
    tempRoots.push(root);

    vi.mocked(runBrowserSmoke).mockResolvedValueOnce({
      passed: false,
      summary: "Browser smoke failed for http://127.0.0.1:4173",
      details: "Last browser error: connection refused",
    });

    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "becoming-site",
        scripts: {
          dev: "vite",
          build: "vite build",
        },
        dependencies: {
          react: "^18.0.0",
        },
        devDependencies: {
          vite: "^5.0.0",
        },
      }, null, 2) + "\n",
      "utf8",
    );
    await fs.writeFile(path.join(root, "src/main.tsx"), "console.log('boot');\n", "utf8");
    await fs.writeFile(path.join(root, "src/App.tsx"), "export default function App() { return <main>hello</main>; }\n", "utf8");

    const results = await runAutoValidations(root);
    const browserSmoke = results.find((result) => result.id === "browser-smoke");

    expect(runBrowserSmoke).toHaveBeenCalledOnce();
    expect(browserSmoke?.passed).toBe(false);
    expect(browserSmoke?.command).toContain("npm run dev");
    expect(browserSmoke?.summary).toContain("Browser smoke failed");
    expect(scoreValidationResults(results)).toBeLessThan(100);
  });

  it("skips placeholder validation scripts that only echo unfinished status", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bench-validation-placeholder-script-"));
    tempRoots.push(root);

    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "placeholder-validation",
        scripts: {
          test: "echo \"Tests not yet implemented\" && exit 0",
        },
      }, null, 2) + "\n",
      "utf8",
    );

    const results = await runAutoValidations(root);

    expect(results).toEqual([]);
    expect(scoreValidationResults(results)).toBeUndefined();
  });

  it("fails Electron runtime validation when package.json main points at src TypeScript", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bench-validation-electron-fail-"));
    tempRoots.push(root);

    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "electron-bad-main",
        main: "src/main.ts",
        devDependencies: {
          electron: "^27.0.0",
        },
      }, null, 2) + "\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          outDir: "dist",
        },
      }, null, 2) + "\n",
      "utf8",
    );
    await fs.writeFile(path.join(root, "src/main.ts"), "export const main = true;\n", "utf8");
    await fs.writeFile(path.join(root, "dist/main.js"), "exports.main = true;\n", "utf8");

    const results = await runAutoValidations(root);
    const runtime = results.find((result) => result.id === "runtime");

    expect(runtime?.passed).toBe(false);
    expect(runtime?.details).toContain("package.json main points to a TypeScript source file");
    expect(runtime?.details).toContain("dist/main.js");
    expect(scoreValidationResults(results)).toBeLessThan(60);
  });

  it("passes Electron runtime validation when package.json main matches the built entry", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bench-validation-electron-pass-"));
    tempRoots.push(root);

    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "electron-good-main",
        main: "dist/main.js",
        devDependencies: {
          electron: "^27.0.0",
        },
      }, null, 2) + "\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          outDir: "dist",
        },
      }, null, 2) + "\n",
      "utf8",
    );
    await fs.writeFile(path.join(root, "dist/main.js"), "exports.main = true;\n", "utf8");

    const results = await runAutoValidations(root);
    const runtime = results.find((result) => result.id === "runtime");

    expect(runtime?.passed).toBe(true);
    expect(scoreValidationResults(results)).toBe(100);
  });

  it("fails Electron runtime validation when main process points at a missing HTML file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bench-validation-electron-html-"));
    tempRoots.push(root);

    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "electron-missing-html",
        main: "dist/main.js",
        devDependencies: {
          electron: "^27.0.0",
        },
      }, null, 2) + "\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "src/main.ts"),
      "import * as path from 'path';\nfunction boot(){ mainWindow.loadFile(path.join(__dirname, '../dist/index.html')); }\n",
      "utf8",
    );
    await fs.writeFile(path.join(root, "dist/main.js"), "exports.main = true;\n", "utf8");

    const results = await runAutoValidations(root);
    const runtime = results.find((result) => result.id === "runtime");

    expect(runtime?.passed).toBe(false);
    expect(runtime?.details).toContain("dist/index.html");
  });

  it("fails Electron IPC validation when preload invokes missing handlers and main imports ipcRenderer", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bench-validation-electron-ipc-"));
    tempRoots.push(root);

    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "electron-ipc-bad",
        main: "dist/main.js",
        devDependencies: {
          electron: "^27.0.0",
        },
      }, null, 2) + "\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "src/main.ts"),
      "import { app, BrowserWindow, ipcMain, ipcRenderer } from 'electron';\nipcMain.handle('get-game-state', async () => ({}));\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "src/preload.ts"),
      "import { contextBridge, ipcRenderer } from 'electron';\ncontextBridge.exposeInMainWorld('hftGame', { getGameState: () => ipcRenderer.invoke('get-game-state'), executeTrade: () => ipcRenderer.invoke('execute-trade') });\n",
      "utf8",
    );

    const results = await runAutoValidations(root);
    const ipc = results.find((result) => result.id === "ipc");

    expect(ipc?.passed).toBe(false);
    expect(ipc?.details).toContain("imports ipcRenderer");
    expect(ipc?.details).toContain("execute-trade");
  });

  it("fails web surface validation when core screens are reduced to trivial placeholders", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bench-validation-web-surface-"));
    tempRoots.push(root);

    await fs.mkdir(path.join(root, "src/app"), { recursive: true });
    await fs.mkdir(path.join(root, "src/components"), { recursive: true });
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "philosophy-site",
        scripts: {
          build: "next build",
        },
        dependencies: {
          next: "^15.0.0",
          react: "^19.0.0",
          "react-dom": "^19.0.0",
        },
      }, null, 2) + "\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "src/app/page.tsx"),
      "export default function HomePage() { return <div>Home</div>; }\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "src/components/Manifesto.tsx"),
      "export default function Manifesto() { return <div>Manifesto</div>; }\n",
      "utf8",
    );

    const results = await runAutoValidations(root);
    const surface = results.find((result) => result.id === "surface");

    expect(surface?.passed).toBe(false);
    expect(surface?.details).toContain("src/app/page.tsx");
    expect(surface?.details).toContain("src/components/Manifesto.tsx");
  });
});
