import type { Provider, RunRequest, RunResult } from "./types.js";

/**
 * `codex exec --json` emits JSONL events. We keep the last agent message as
 * the answer and pick the session id off whichever event carries one.
 */
type CodexEvent = {
  type?: string;
  msg?: { type?: string; message?: string; session_id?: string };
  session_id?: string;
};

export const codex: Provider = {
  name: "codex",
  bin: process.env["CODEX_BIN"] || "codex",
  // `codex exec` reads CODEX_API_KEY; older builds only know OPENAI_API_KEY.
  credentialEnv: { apiKey: ["OPENAI_API_KEY", "CODEX_API_KEY"], baseUrl: ["OPENAI_BASE_URL"] },

  args(req: RunRequest): string[] {
    // `codex exec [--json] [resume <id>] [-m model] -`; the trailing `-` makes
    // codex read the prompt from stdin. It has no system-prompt flag, so
    // `systemPrompt` is prepended to the prompt by the runner instead.
    const args = ["exec", "--json"];
    if (req.sessionId) args.push("resume", req.sessionId);
    if (req.model) args.push("-m", req.model);
    args.push("-");
    return args;
  },

  stdin(req: RunRequest): string {
    return req.systemPrompt ? `${req.systemPrompt}\n\n---\n\n${req.prompt}` : req.prompt;
  },

  parse(stdout: string): Omit<RunResult, "provider"> {
    const events: CodexEvent[] = [];
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as CodexEvent);
      } catch {
        // codex interleaves plain log lines; skip anything that isn't JSON.
      }
    }

    let text = "";
    let sessionId: string | undefined;
    for (const e of events) {
      sessionId = e.session_id ?? e.msg?.session_id ?? sessionId;
      if (e.msg?.type === "agent_message" && e.msg.message) text = e.msg.message;
    }

    const out: Omit<RunResult, "provider"> = { text, raw: events };
    if (sessionId) out.sessionId = sessionId;
    return out;
  },
};
