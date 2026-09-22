export type ProviderName = "claude" | "codex" | "grok";

export type RunRequest = {
  prompt: string;
  /** Resume a prior session, so the proxy can hold a conversation. */
  sessionId?: string;
  model?: string;
  systemPrompt?: string;
  cwd?: string;
};

export type RunResult = {
  provider: ProviderName;
  text: string;
  sessionId?: string;
  costUsd?: number;
  raw: unknown;
};

export type Provider = {
  name: ProviderName;
  /** Binary to spawn; overridable per provider via env. */
  bin: string;
  /**
   * Environment variables the CLI reads its API key and endpoint from, so a
   * request's `apiKey` / `baseUrl` can be handed to it without touching argv.
   */
  credentialEnv: { apiKey: readonly string[]; baseUrl: readonly string[] };
  /** argv for a single non-interactive run. */
  args: (req: RunRequest) => string[];
  /**
   * argv for a run whose output should be streamed line by line (background
   * runs log every line). Falls back to `args` when the CLI has no streaming
   * mode; `parseStream` must then be omitted too.
   */
  streamArgs?: (req: RunRequest) => string[];
  /** What to write to the child's stdin. Defaults to the bare prompt. */
  stdin?: (req: RunRequest) => string;
  /** Turn raw stdout into a normalized result. */
  parse: (stdout: string) => Omit<RunResult, "provider">;
  /** Like `parse`, for the output `streamArgs` produces. */
  parseStream?: (stdout: string) => Omit<RunResult, "provider">;
  /** Extracts a concise provider-reported failure from structured output. */
  failureMessage?: (stdout: string) => string | undefined;
};

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: ProviderName,
    readonly code: number | null,
    readonly detail: string,
    readonly feedback?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
