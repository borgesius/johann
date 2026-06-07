import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { ensureDir, truncate } from "./utils.js";

const COMMON_BROWSER_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];

export interface BrowserSmokeOptions {
  repoDir: string;
  startCommand?: string;
  url: string;
  waitForText?: string[];
  waitForSelector?: string;
  timeoutMs?: number;
  screenshotPath?: string;
}

export interface AppSmokeResult {
  passed: boolean;
  summary: string;
  details: string;
  title?: string;
  screenshotPath?: string;
}

function parseHostAndPort(targetUrl: string): { host: string; port: string } {
  try {
    const parsed = new URL(targetUrl);
    return {
      host: parsed.hostname || "127.0.0.1",
      port: parsed.port || (parsed.protocol === "https:" ? "443" : "80"),
    };
  } catch {
    return { host: "127.0.0.1", port: "4173" };
  }
}

export function normalizeBrowserStartCommand(command: string, targetUrl: string): string {
  const trimmed = command.trim();
  if (!trimmed) {
    return trimmed;
  }

  const { host, port } = parseHostAndPort(targetUrl);
  const withoutNetworkEnv = trimmed
    .replace(/\b(?:HOSTNAME|HOST|PORT|VITE_PORT)=\S+\s*/g, "")
    .trim();

  const hasHost = /(?:^|\s)--host(?:\s|=)|\bHOSTNAME=|\bHOST=/.test(trimmed);
  const hasPort = /(?:^|\s)--port(?:\s|=)|\bPORT=|\bVITE_PORT=/.test(trimmed);

  if (/\b(?:npm|pnpm|yarn)\s+run\s+preview\b/.test(withoutNetworkEnv)) {
    if (hasHost && hasPort) {
      return trimmed;
    }
    return `${withoutNetworkEnv} -- --host ${host} --port ${port}`.trim();
  }

  if (/\bvite\s+preview\b/.test(withoutNetworkEnv)) {
    if (hasHost && hasPort) {
      return trimmed;
    }
    return `${withoutNetworkEnv} --host ${host} --port ${port}`.trim();
  }

  return trimmed;
}

type BackgroundProcess = {
  pid: number;
  stdout: string[];
  stderr: string[];
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isExecutable(target: string): Promise<boolean> {
  try {
    await fs.access(target, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveBrowserExecutable(): Promise<string> {
  const configured = [
    process.env.BENCH_BROWSER_EXECUTABLE,
    process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  for (const candidate of [...configured, ...COMMON_BROWSER_PATHS]) {
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "No supported browser executable found. Set BENCH_BROWSER_EXECUTABLE or install Chrome/Brave/Edge locally.",
  );
}

function startBackgroundProcess(command: string, cwd: string): BackgroundProcess {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const child = spawn(command, {
    cwd,
    shell: true,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  child.stdout?.on("data", (chunk) => {
    stdout.push(chunk.toString());
    if (stdout.join("").length > 8_000) {
      stdout.splice(0, stdout.length, truncate(stdout.join(""), 8_000));
    }
  });
  child.stderr?.on("data", (chunk) => {
    stderr.push(chunk.toString());
    if (stderr.join("").length > 6_000) {
      stderr.splice(0, stderr.length, truncate(stderr.join(""), 6_000));
    }
  });

  child.unref();

  return {
    pid: child.pid ?? 0,
    stdout,
    stderr,
  };
}

function stopBackgroundProcess(processInfo?: BackgroundProcess): void {
  if (!processInfo?.pid) {
    return;
  }

  try {
    process.kill(-processInfo.pid, "SIGTERM");
  } catch {
    try {
      process.kill(processInfo.pid, "SIGTERM");
    } catch {
      // Ignore cleanup failures.
    }
  }
}

function collectedOutput(processInfo?: BackgroundProcess): string {
  if (!processInfo) {
    return "";
  }

  const stdout = truncate(processInfo.stdout.join(""), 4_000);
  const stderr = truncate(processInfo.stderr.join(""), 4_000);
  return [`stdout:\n${stdout || "[empty]"}`, `stderr:\n${stderr || "[empty]"}`].join("\n\n");
}

async function matchesRequiredText(
  page: { locator: (selector: string) => { textContent: () => Promise<string | null> } },
  required: string[],
): Promise<boolean> {
  if (required.length === 0) {
    return true;
  }
  const body = (await page.locator("body").textContent()) ?? "";
  return required.every((snippet) => body.includes(snippet));
}

export async function runBrowserSmoke(options: BrowserSmokeOptions): Promise<AppSmokeResult> {
  const executablePath = await resolveBrowserExecutable();
  const timeoutMs = options.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;
  const requiredText = options.waitForText ?? [];
  const normalizedStartCommand = options.startCommand
    ? normalizeBrowserStartCommand(options.startCommand, options.url)
    : undefined;
  const background = normalizedStartCommand
    ? startBackgroundProcess(normalizedStartCommand, options.repoDir)
    : undefined;

  let browser: { close: () => Promise<void>; newPage: () => Promise<any> } | undefined;
  let page:
    | {
        goto: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
        waitForSelector: (selector: string, options?: Record<string, unknown>) => Promise<unknown>;
        locator: (selector: string) => { textContent: () => Promise<string | null> };
        title: () => Promise<string>;
        screenshot: (options: { path: string; fullPage?: boolean }) => Promise<unknown>;
      }
    | undefined;
  let lastError = "";

  try {
    const playwright = await import("playwright-core");
    browser = await playwright.chromium.launch({
      headless: true,
      executablePath,
    });
    page = await browser.newPage();

    while (Date.now() < deadline) {
      try {
        const currentPage = page;
        if (!currentPage) {
          throw new Error("Browser page failed to initialize.");
        }

        await currentPage.goto(options.url, {
          waitUntil: "domcontentloaded",
          timeout: Math.min(5_000, Math.max(1_000, deadline - Date.now())),
        });

        if (options.waitForSelector) {
          await currentPage.waitForSelector(options.waitForSelector, {
            timeout: Math.min(2_000, Math.max(500, deadline - Date.now())),
          });
        }

        const textReady = await matchesRequiredText(currentPage, requiredText);
        if (!textReady) {
          lastError = `Page loaded but is missing required text: ${requiredText.join(", ")}`;
          await sleep(400);
          continue;
        }

        if (options.screenshotPath) {
          await ensureDir(path.dirname(options.screenshotPath));
          await currentPage.screenshot({
            path: options.screenshotPath,
            fullPage: true,
          });
        }

        const title = await currentPage.title();
        return {
          passed: true,
          summary: `Browser smoke passed for ${options.url}`,
          details: title ? `Page title: ${title}` : "Page loaded and matched expected content.",
          ...(title ? { title } : {}),
          ...(options.screenshotPath ? { screenshotPath: options.screenshotPath } : {}),
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await sleep(500);
      }
    }

    if (options.screenshotPath && page) {
      try {
        await ensureDir(path.dirname(options.screenshotPath));
        await page.screenshot({
          path: options.screenshotPath,
          fullPage: true,
        });
      } catch {
        // Best-effort debug artifact only.
      }
    }

    const processLogs = collectedOutput(background);
    return {
      passed: false,
      summary: `Browser smoke failed for ${options.url}`,
      details: truncate(
        [
          lastError ? `Last browser error: ${lastError}` : undefined,
          normalizedStartCommand && normalizedStartCommand !== options.startCommand
            ? `Normalized start command: ${normalizedStartCommand}`
            : undefined,
          processLogs ? `Process logs:\n${processLogs}` : undefined,
        ]
          .filter(Boolean)
          .join("\n\n"),
        8_000,
      ),
      ...(options.screenshotPath ? { screenshotPath: options.screenshotPath } : {}),
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
    stopBackgroundProcess(background);
  }
}
