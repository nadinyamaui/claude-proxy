import { join, resolve } from "node:path";

export type Config = {
  port: number;
  host: string;
  token: string;
  workdir: string;
  timeoutMs: number;
  maxBodyBytes: number;
  /** Background runs: where each run's working directory and the database live. */
  runsDir: string;
  runsDb: string;
  runTimeoutMs: number;
  maxUploadBytes: number;
  maxUnzipBytes: number;
  maxConcurrentRuns: number;
};

export type Env = Record<string, string | undefined>;

function int(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${raw}`);
  return n;
}

/**
 * Every endpoint except `/health` is behind this token, and the proxy runs
 * agent CLIs on request, so there is no safe default: refuse to start rather
 * than come up unauthenticated.
 */
function requireToken(env: Env): string {
  const token = env["PROXY_TOKEN"] ?? "";
  if (!token) {
    throw new Error("PROXY_TOKEN is required. Generate one with `openssl rand -hex 32` and set it in .env.");
  }
  return token;
}

export function loadConfig(env: Env = process.env): Config {
  const runsDir = resolve(env["RUNS_DIR"] || "runs");
  return {
    port: int(env, "PORT", 8787),
    host: env["HOST"] || "127.0.0.1",
    token: requireToken(env),
    workdir: env["WORKDIR"] || process.cwd(),
    timeoutMs: int(env, "TIMEOUT_MS", 120_000),
    maxBodyBytes: int(env, "MAX_BODY_BYTES", 1_000_000),
    runsDir,
    runsDb: env["RUNS_DB"] || join(runsDir, "runs.sqlite"),
    runTimeoutMs: int(env, "RUN_TIMEOUT_MS", 3_600_000),
    maxUploadBytes: int(env, "MAX_UPLOAD_BYTES", 100_000_000),
    maxUnzipBytes: int(env, "MAX_UNZIP_BYTES", 1_000_000_000),
    maxConcurrentRuns: int(env, "MAX_CONCURRENT_RUNS", 2),
  };
}

export const config: Config = loadConfig();
