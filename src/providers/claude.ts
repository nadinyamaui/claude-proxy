import type { Provider, RunRequest, RunResult } from "./types.js";

/** Shape of `claude -p --output-format json` on success. */
type ClaudeJson = {
  type?: string;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  is_error?: boolean;
};

const MAX_FAILURE_MESSAGE_LENGTH = 2000;

function flags(req: RunRequest): string[] {
  const args: string[] = [];
  if (req.sessionId) args.push("--resume", req.sessionId);
  if (req.model) args.push("--model", req.model);
  if (req.systemPrompt) args.push("--append-system-prompt", req.systemPrompt);
  return args;
}

function normalize(json: ClaudeJson): Omit<RunResult, "provider"> {
  const out: Omit<RunResult, "provider"> = { text: json.result ?? "", raw: json };
  if (json.session_id) out.sessionId = json.session_id;
  if (typeof json.total_cost_usd === "number") out.costUsd = json.total_cost_usd;
  return out;
}

function lastResultEvent(stdout: string): ClaudeJson | undefined {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let event: ClaudeJson;
    try {
      event = JSON.parse(line) as ClaudeJson;
    } catch {
      continue;
    }
    if (event.type === "result") return event;
  }
  return undefined;
}

export const claude: Provider = {
  name: "claude",
  bin: process.env["CLAUDE_BIN"] || "claude",

  // Print mode has nobody to answer permission prompts, so every tool call
  // would be denied; the proxy is the trust boundary and runs unattended.
  args(req: RunRequest): string[] {
    return ["-p", "--dangerously-skip-permissions", "--output-format", "json", ...flags(req)];
  },

  // `stream-json` needs `--verbose` in print mode. It emits one JSON event per
  // line and finishes with the same `result` object the json format returns.
  streamArgs(req: RunRequest): string[] {
    return [
      "-p",
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--verbose",
      ...flags(req),
    ];
  },

  parse(stdout: string): Omit<RunResult, "provider"> {
    return normalize(JSON.parse(stdout) as ClaudeJson);
  },

  parseStream(stdout: string): Omit<RunResult, "provider"> {
    const event = lastResultEvent(stdout);
    if (event) return normalize(event);
    throw new Error("stream ended without a result event");
  },

  failureMessage(stdout: string): string | undefined {
    const event = lastResultEvent(stdout);
    if (!event?.is_error || typeof event.result !== "string") return undefined;
    const message = event.result.trim();
    return message ? message.slice(0, MAX_FAILURE_MESSAGE_LENGTH) : undefined;
  },
};
