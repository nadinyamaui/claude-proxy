import type { Provider, RunRequest, RunResult } from "./types.js";

/**
 * grok's headless mode mirrors claude's: `-p <prompt> --output-format json`.
 * The exact success payload could not be verified against a signed-in CLI, so
 * `parse` accepts the field names grok is documented to share with claude and
 * falls back to the raw text rather than failing the request.
 */
type GrokJson = {
  type?: string;
  result?: string;
  text?: string;
  message?: string;
  session_id?: string;
  sessionId?: string;
  total_cost_usd?: number;
};

export const grok: Provider = {
  name: "grok",
  bin: process.env["GROK_BIN"] || "grok",

  args(req: RunRequest): string[] {
    // grok takes the prompt as a `-p` value, not on stdin.
    const args = ["-p", req.prompt, "--output-format", "json"];
    if (req.sessionId) args.push("--resume", req.sessionId);
    if (req.model) args.push("-m", req.model);
    // Note: grok only offers a full override here, where claude appends.
    if (req.systemPrompt) args.push("--system-prompt-override", req.systemPrompt);
    return args;
  },

  parse(stdout: string): Omit<RunResult, "provider"> {
    let json: GrokJson;
    try {
      json = JSON.parse(stdout) as GrokJson;
    } catch {
      return { text: stdout.trim(), raw: stdout };
    }

    if (json.type === "error") throw new Error(json.message ?? "grok reported an error");

    const out: Omit<RunResult, "provider"> = {
      text: json.result ?? json.text ?? json.message ?? "",
      raw: json,
    };
    const sessionId = json.session_id ?? json.sessionId;
    if (sessionId) out.sessionId = sessionId;
    if (typeof json.total_cost_usd === "number") out.costUsd = json.total_cost_usd;
    return out;
  },
};
