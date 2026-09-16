import { join, resolve } from "node:path";

export type Config = {
  port: number;
  host: string;
  token: string | undefined;
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

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${raw}`);
  return n;
}

const runsDir = resolve(process.env["RUNS_DIR"] || "runs");

export const config: Config = {
  port: int("PORT", 8787),
  host: process.env["HOST"] || "127.0.0.1",
  token: process.env["PROXY_TOKEN"] || undefined,
  workdir: process.env["WORKDIR"] || process.cwd(),
  timeoutMs: int("TIMEOUT_MS", 120_000),
  maxBodyBytes: int("MAX_BODY_BYTES", 1_000_000),
  runsDir,
  runsDb: process.env["RUNS_DB"] || join(runsDir, "runs.sqlite"),
  runTimeoutMs: int("RUN_TIMEOUT_MS", 3_600_000),
  maxUploadBytes: int("MAX_UPLOAD_BYTES", 100_000_000),
  maxUnzipBytes: int("MAX_UNZIP_BYTES", 1_000_000_000),
  maxConcurrentRuns: int("MAX_CONCURRENT_RUNS", 2),
};
