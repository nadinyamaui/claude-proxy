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

export function run(name: ProviderName, req: RunRequest): Promise<RunResult> {
  const provider = providers[name];

  return new Promise((resolve, reject) => {
    const child = spawn(provider.bin, provider.args(req), {
      cwd: req.cwd ?? config.workdir,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, config.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new ProviderError(`failed to spawn ${provider.bin}`, name, null, err.message));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new ProviderError(`${name} timed out after ${config.timeoutMs}ms`, name, code, stderr.trim()));
        return;
      }
      if (code !== 0) {
        reject(new ProviderError(`${name} exited with code ${code}`, name, code, stderr.trim()));
        return;
      }
      try {
        resolve({ provider: name, ...provider.parse(stdout) });
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

export { ProviderError };
export type { Provider, ProviderName, RunRequest, RunResult };
