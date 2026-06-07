import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const execFileAsync = promisify(execFile);

export async function ensureDir(target: string): Promise<void> {
  await fs.mkdir(target, { recursive: true });
}

export async function readJson<T>(target: string): Promise<T> {
  const raw = await fs.readFile(target, "utf8");
  return JSON.parse(raw) as T;
}

export async function writeJson(target: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(target));
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function writeJsonSync(target: string, value: unknown): void {
  fsSync.mkdirSync(path.dirname(target), { recursive: true });
  fsSync.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeText(target: string, value: string): Promise<void> {
  await ensureDir(path.dirname(target));
  await fs.writeFile(target, value, "utf8");
}

export function writeTextSync(target: string, value: string): void {
  fsSync.mkdirSync(path.dirname(target), { recursive: true });
  fsSync.writeFileSync(target, value, "utf8");
}

export async function readText(target: string): Promise<string> {
  return fs.readFile(target, "utf8");
}

export async function copyDir(source: string, destination: string): Promise<void> {
  await fs.rm(destination, { recursive: true, force: true });
  await fs.cp(source, destination, { recursive: true });
}

export async function copyDirFiltered(
  source: string,
  destination: string,
  shouldInclude: (sourcePath: string) => boolean | Promise<boolean>,
): Promise<void> {
  await fs.rm(destination, { recursive: true, force: true });
  await fs.cp(source, destination, {
    recursive: true,
    filter: shouldInclude,
  });
}

export async function copyDirContents(source: string, destination: string): Promise<void> {
  await ensureDir(destination);
  const entries = await fs.readdir(source, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const from = path.join(source, entry.name);
      const to = path.join(destination, entry.name);
      if (entry.isDirectory()) {
        await fs.cp(from, to, { recursive: true });
      } else {
        await ensureDir(path.dirname(to));
        await fs.copyFile(from, to);
      }
    }),
  );
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function makeRunId(parts: string[]): string {
  const prefix = parts.map(slugify).filter(Boolean).join("-");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = crypto.randomBytes(3).toString("hex");
  return `${prefix}-${stamp}-${suffix}`;
}

export function truncate(value: string, maxLength = 6000): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}\n...<truncated ${value.length - maxLength} chars>`;
}

export function extractJsonObject(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced?.[1] ?? raw;

  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== "{") {
      continue;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < source.length; index += 1) {
      const char = source[index];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }
      if (char === "{") {
        depth += 1;
        continue;
      }
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = source.slice(start, index + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            break;
          }
        }
      }
    }
  }

  return null;
}

export function safeResolveWithin(rootDir: string, relativePath: string): string {
  const resolved = path.resolve(rootDir, relativePath);
  const normalizedRoot = `${path.resolve(rootDir)}${path.sep}`;
  if (resolved !== path.resolve(rootDir) && !resolved.startsWith(normalizedRoot)) {
    throw new Error(`Path escapes workspace: ${relativePath}`);
  }
  return resolved;
}

export interface ShellResult {
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs = 120_000,
  envOverrides?: Record<string, string>,
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: {
        ...process.env,
        ...(envOverrides ?? {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let resolved = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimeout(timer);
      resolve({
        command,
        cwd,
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

export async function execFileText(
  file: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(file, args, {
    cwd,
    env: process.env,
    maxBuffer: 4 * 1024 * 1024,
  });
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function listFiles(
  rootDir: string,
  options?: { maxDepth?: number; includeHidden?: boolean },
): Promise<string[]> {
  const output: string[] = [];
  const maxDepth = options?.maxDepth ?? 5;
  const includeHidden = options?.includeHidden ?? false;
  const ignored = new Set([".git", "node_modules", "dist", ".bench"]);

  async function walk(currentDir: string, depth: number): Promise<void> {
    if (depth > maxDepth) {
      return;
    }

    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!includeHidden && entry.name.startsWith(".")) {
        continue;
      }
      if (ignored.has(entry.name)) {
        continue;
      }
      const absolute = path.join(currentDir, entry.name);
      const relative = path.relative(rootDir, absolute) || ".";
      output.push(entry.isDirectory() ? `${relative}/` : relative);
      if (entry.isDirectory()) {
        await walk(absolute, depth + 1);
      }
    }
  }

  await walk(rootDir, 0);
  return output;
}

export async function readFilesPreview(
  rootDir: string,
  relativePaths: string[],
  maxChars = 2400,
): Promise<Record<string, string>> {
  const previews: Record<string, string> = {};
  await Promise.all(
    relativePaths.map(async (relativePath) => {
      const absolute = safeResolveWithin(rootDir, relativePath);
      if (!(await pathExists(absolute))) {
        previews[relativePath] = "[missing]";
        return;
      }
      const stat = await fs.stat(absolute);
      if (stat.isDirectory()) {
        previews[relativePath] = "[directory]";
        return;
      }
      const raw = await fs.readFile(absolute, "utf8");
      previews[relativePath] = truncate(raw, maxChars);
    }),
  );
  return previews;
}

export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ":::DOUBLE_STAR:::")
    .replace(/\*/g, "[^/]*")
    .replace(/:::DOUBLE_STAR:::/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export async function findMatches(rootDir: string, pattern: string): Promise<string[]> {
  const files = await listFiles(rootDir, { includeHidden: true, maxDepth: 12 });
  const matcher = globToRegExp(pattern);
  return files
    .filter((item) => !item.endsWith("/"))
    .filter((item) => matcher.test(item));
}

export async function initializeGitRepo(repoDir: string): Promise<void> {
  await execFileText("git", ["init"], repoDir);
  await execFileText("git", ["add", "."], repoDir);
  try {
    await execFileText(
      "git",
      [
        "-c",
        "user.name=Bench Harness",
        "-c",
        "user.email=bench@example.com",
        "commit",
        "-m",
        "seed",
      ],
      repoDir,
    );
  } catch {
    // Some seeds may be empty. Keep the repo initialized so diff summaries still work.
  }
}

export async function getGitSummary(repoDir: string): Promise<{ status: string; diffStat: string }> {
  try {
    const [status, diffStat] = await Promise.all([
      execFileText("git", ["status", "--short"], repoDir),
      execFileText("git", ["diff", "--stat"], repoDir),
    ]);
    return {
      status: status.stdout.trim(),
      diffStat: diffStat.stdout.trim(),
    };
  } catch {
    return {
      status: "",
      diffStat: "",
    };
  }
}

export function minutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export function formatScore(value: number): string {
  return value.toFixed(1);
}
