import type { Provider, RunRequest, RunResult } from "./types.js";

/** Shape of `claude -p --output-format json` on success. */
type ClaudeJson = {
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  is_error?: boolean;
};

export const claude: Provider = {
  name: "claude",
  bin: process.env["CLAUDE_BIN"] || "claude",

  args(req: RunRequest): string[] {
    const args = ["-p", "--output-format", "json"];
    if (req.sessionId) args.push("--resume", req.sessionId);
    if (req.model) args.push("--model", req.model);
    if (req.systemPrompt) args.push("--append-system-prompt", req.systemPrompt);
    return args;
  },

  parse(stdout: string): Omit<RunResult, "provider"> {
    const json = JSON.parse(stdout) as ClaudeJson;
    const out: Omit<RunResult, "provider"> = { text: json.result ?? "", raw: json };
    if (json.session_id) out.sessionId = json.session_id;
    if (typeof json.total_cost_usd === "number") out.costUsd = json.total_cost_usd;
    return out;
  },
};
