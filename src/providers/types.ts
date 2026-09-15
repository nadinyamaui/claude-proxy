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
  /** argv for a single non-interactive run. */
  args: (req: RunRequest) => string[];
  /** What to write to the child's stdin. Defaults to the bare prompt. */
  stdin?: (req: RunRequest) => string;
  /** Turn raw stdout into a normalized result. */
  parse: (stdout: string) => Omit<RunResult, "provider">;
};

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: ProviderName,
    readonly code: number | null,
    readonly detail: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
