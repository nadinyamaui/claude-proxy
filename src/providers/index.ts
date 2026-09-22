import { spawn } from "node:child_process";
import { config } from "../config.js";
import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { grok } from "./grok.js";
import { ProviderError, type Provider, type ProviderName, type RunRequest, type RunResult } from "./types.js";

export const providers: Record<ProviderName, Provider> = { claude, codex, grok };

export function isProviderName(v: unknown): v is ProviderName {
  return typeof v === "string" && v in providers;
}

export type Credentials = { apiKey?: string; baseUrl?: string };

/** Maps a request's credentials onto the environment variables `name`'s CLI reads. */
export function credentialEnv(name: ProviderName, creds: Credentials): Record<string, string> {
  const vars = providers[name].credentialEnv;
  const env: Record<string, string> = {};
  if (creds.apiKey) for (const key of vars.apiKey) env[key] = creds.apiKey;
  if (creds.baseUrl) for (const key of vars.baseUrl) env[key] = creds.baseUrl;
  return env;
}

export type OutputStream = "stdout" | "stderr";

export type ExecOptions = {
  cwd?: string;
  /** Replaces (not merges with) the child's environment. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /**
   * When set, the provider's streaming mode is used and every complete line
   * of stdout and stderr is reported as it arrives.
   */
  onLine?: (stream: OutputStream, line: string) => void;
  /** Aborting sends SIGTERM, then SIGKILL five seconds later. */
  signal?: AbortSignal;
};

const KILL_GRACE_MS = 5_000;

/** Splits a chunked text stream into lines, holding back a partial tail. */
function lineSplitter(emit: (line: string) => void): { push: (chunk: string) => void; flush: () => void } {
  let tail = "";
  return {
    push(chunk) {
      tail += chunk;
      let nl = tail.indexOf("\n");
      while (nl !== -1) {
        emit(tail.slice(0, nl).replace(/\r$/, ""));
        tail = tail.slice(nl + 1);
        nl = tail.indexOf("\n");
      }
    },
    flush() {
      if (tail) emit(tail);
      tail = "";
    },
  };
}

export function execProvider(
  name: ProviderName,
  req: RunRequest,
  opts: ExecOptions = {},
): Promise<RunResult> {
  const provider = providers[name];
  const streaming = opts.onLine !== undefined && provider.streamArgs !== undefined;
  const args = streaming ? provider.streamArgs!(req) : provider.args(req);
  const parse = streaming ? (provider.parseStream ?? provider.parse) : provider.parse;
  const timeoutMs = opts.timeoutMs ?? config.timeoutMs;

  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new ProviderError(`${name} was cancelled`, name, null, ""));
      return;
    }

    const child = spawn(provider.bin, args, {
      cwd: opts.cwd ?? req.cwd ?? config.workdir,
      stdio: ["pipe", "pipe", "pipe"],
      env: opts.env ?? process.env,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const onAbort = () => {
      cancelled = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    const outLines = lineSplitter((line) => opts.onLine?.("stdout", line));
    const errLines = lineSplitter((line) => opts.onLine?.("stderr", line));

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      stdout += c;
      if (opts.onLine) outLines.push(c);
    });
    child.stderr.on("data", (c: string) => {
      stderr += c;
      if (opts.onLine) errLines.push(c);
    });

    child.on("error", (err) => {
      cleanup();
      reject(new ProviderError(`failed to spawn ${provider.bin}`, name, null, err.message));
    });

    child.on("close", (code) => {
      cleanup();
      if (opts.onLine) {
        outLines.flush();
        errLines.flush();
      }
      if (cancelled) {
        reject(new ProviderError(`${name} was cancelled`, name, code, stderr.trim()));
        return;
      }
      if (timedOut) {
        reject(new ProviderError(`${name} timed out after ${timeoutMs}ms`, name, code, stderr.trim()));
        return;
      }
      if (code !== 0) {
        reject(
          new ProviderError(
            `${name} exited with code ${code}`,
            name,
            code,
            stderr.trim(),
            provider.failureMessage?.(stdout),
          ),
        );
        return;
      }
      try {
        resolve({ provider: name, ...parse(stdout) });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        reject(
          new ProviderError(`could not parse ${name} output: ${detail}`, name, code, stdout.slice(0, 2000)),
        );
      }
    });

    child.stdin.on("error", () => {
      // A provider that takes the prompt in argv may close stdin early; that
      // is not a request failure.
    });
    child.stdin.end(provider.stdin?.(req) ?? req.prompt, "utf8");
  });
}

/**
 * One synchronous run: spawn, wait, normalize. Backs `POST /run`. `env` is
 * merged over the proxy's environment for this call only.
 */
export function run(
  name: ProviderName,
  req: RunRequest,
  env: Record<string, string> = {},
): Promise<RunResult> {
  return execProvider(name, req, Object.keys(env).length > 0 ? { env: { ...process.env, ...env } } : {});
}

export { ProviderError };
export type { Provider, ProviderName, RunRequest, RunResult };
