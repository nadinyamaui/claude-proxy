export type Config = {
  port: number;
  host: string;
  token: string | undefined;
  workdir: string;
  timeoutMs: number;
  maxBodyBytes: number;
};

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${raw}`);
  return n;
}

export const config: Config = {
  port: int("PORT", 8787),
  host: process.env["HOST"] || "127.0.0.1",
  token: process.env["PROXY_TOKEN"] || undefined,
  workdir: process.env["WORKDIR"] || process.cwd(),
  timeoutMs: int("TIMEOUT_MS", 120_000),
  maxBodyBytes: int("MAX_BODY_BYTES", 1_000_000),
};
