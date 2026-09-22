import { describe, expect, it } from "vitest";
import { claude } from "../src/providers/claude.js";
import { codex } from "../src/providers/codex.js";
import { grok } from "../src/providers/grok.js";
import { credentialEnv, isProviderName, providers } from "../src/providers/index.js";

describe("registry", () => {
  it("exposes the three providers", () => {
    expect(Object.keys(providers).toSorted()).toEqual(["claude", "codex", "grok"]);
  });

  it("narrows only known names", () => {
    expect(isProviderName("claude")).toBe(true);
    expect(isProviderName("gemini")).toBe(false);
    expect(isProviderName(undefined)).toBe(false);
  });
});

describe("credentialEnv", () => {
  it("maps apiKey and baseUrl onto each CLI's own variables", () => {
    const creds = { apiKey: "k", baseUrl: "https://gw.example" };
    expect(credentialEnv("claude", creds)).toEqual({
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_API_KEY: "k",
      ANTHROPIC_BASE_URL: "https://gw.example",
    });
    expect(credentialEnv("codex", creds)).toEqual({
      OPENAI_API_KEY: "k",
      CODEX_API_KEY: "k",
      OPENAI_BASE_URL: "https://gw.example",
    });
    expect(credentialEnv("grok", creds)).toEqual({
      GROK_API_KEY: "k",
      GROK_BASE_URL: "https://gw.example",
    });
  });

  it("sets nothing for credentials that were not given", () => {
    expect(credentialEnv("claude", {})).toEqual({});
    expect(credentialEnv("claude", { apiKey: "k" })).toEqual({
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_API_KEY: "k",
    });
    expect(credentialEnv("claude", { baseUrl: "https://gw.example" })).toEqual({
      ANTHROPIC_BASE_URL: "https://gw.example",
    });
  });
});

describe("claude", () => {
  it("asks for json, skips permission prompts and passes the prompt over stdin, not argv", () => {
    const args = claude.args({ prompt: "hello" });
    expect(args).toEqual(["-p", "--dangerously-skip-permissions", "--output-format", "json"]);
    expect(args).not.toContain("hello");
  });

  it("maps resume, model and system prompt onto flags", () => {
    expect(claude.args({ prompt: "x", sessionId: "s1", model: "m1", systemPrompt: "be terse" })).toEqual([
      "-p",
      "--dangerously-skip-permissions",
      "--output-format",
      "json",
      "--resume",
      "s1",
      "--model",
      "m1",
      "--append-system-prompt",
      "be terse",
    ]);
  });

  it("normalizes a success payload", () => {
    const out = claude.parse(
      JSON.stringify({ result: "hi", session_id: "s1", total_cost_usd: 0.5, extra: 1 }),
    );
    expect(out.text).toBe("hi");
    expect(out.sessionId).toBe("s1");
    expect(out.costUsd).toBe(0.5);
    expect(out.raw).toMatchObject({ extra: 1 });
  });

  it("omits optional fields the provider did not report", () => {
    const out = claude.parse(JSON.stringify({ result: "hi" }));
    expect(out.sessionId).toBeUndefined();
    expect(out.costUsd).toBeUndefined();
  });

  it("streams with stream-json plus --verbose, keeping the same flags", () => {
    expect(claude.streamArgs?.({ prompt: "x", model: "m1" })).toEqual([
      "-p",
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "m1",
    ]);
  });

  it("takes the result from the last result event of a stream", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
      "not json",
      JSON.stringify({ type: "assistant", message: {} }),
      JSON.stringify({ type: "result", result: "done", session_id: "s1", total_cost_usd: 0.1 }),
      "",
    ].join("\n");
    expect(claude.parseStream?.(stdout)).toMatchObject({ text: "done", sessionId: "s1", costUsd: 0.1 });
  });

  it("fails a stream that never produced a result", () => {
    expect(() => claude.parseStream?.(JSON.stringify({ type: "system" }))).toThrow(/without a result/);
  });

  it("extracts feedback from a failed result event", () => {
    const stdout = [
      JSON.stringify({ type: "rate_limit_event" }),
      JSON.stringify({ type: "result", is_error: true, result: "Session limit reached" }),
    ].join("\n");

    expect(claude.failureMessage?.(stdout)).toBe("Session limit reached");
    expect(claude.failureMessage?.(JSON.stringify({ type: "result", result: "done" }))).toBeUndefined();
  });
});

describe("codex", () => {
  it("reads the prompt from stdin via a trailing dash", () => {
    expect(codex.args({ prompt: "x" })).toEqual(["exec", "--json", "-"]);
  });

  it("resumes through the subcommand, keeping --json ahead of it", () => {
    const args = codex.args({ prompt: "x", sessionId: "abc", model: "o3" });
    expect(args).toEqual(["exec", "--json", "resume", "abc", "-m", "o3", "-"]);
    expect(args.indexOf("--json")).toBeLessThan(args.indexOf("resume"));
  });

  it("prepends the system prompt to stdin, since codex has no flag for it", () => {
    expect(codex.stdin?.({ prompt: "do it", systemPrompt: "be terse" })).toBe("be terse\n\n---\n\ndo it");
    expect(codex.stdin?.({ prompt: "do it" })).toBe("do it");
  });

  it("keeps the last agent message from the event stream", () => {
    const stdout = [
      JSON.stringify({ session_id: "sess-9" }),
      "not json at all",
      JSON.stringify({ msg: { type: "agent_message", message: "first" } }),
      JSON.stringify({ msg: { type: "token_count" } }),
      JSON.stringify({ msg: { type: "agent_message", message: "final" } }),
      "",
    ].join("\n");

    const out = codex.parse(stdout);
    expect(out.text).toBe("final");
    expect(out.sessionId).toBe("sess-9");
  });

  it("survives a stream with no agent message", () => {
    expect(codex.parse(JSON.stringify({ msg: { type: "token_count" } })).text).toBe("");
  });
});

describe("grok", () => {
  it("passes the prompt in argv, where grok expects it", () => {
    expect(grok.args({ prompt: "hello" })).toEqual(["-p", "hello", "--output-format", "json"]);
  });

  it("uses grok's own flag spellings", () => {
    const args = grok.args({ prompt: "x", sessionId: "s", model: "m", systemPrompt: "sp" });
    expect(args).toContain("--resume");
    expect(args).toContain("-m");
    expect(args).toContain("--system-prompt-override");
  });

  it("accepts claude-style and plain field names", () => {
    expect(grok.parse(JSON.stringify({ result: "a" })).text).toBe("a");
    expect(grok.parse(JSON.stringify({ text: "b" })).text).toBe("b");
    expect(grok.parse(JSON.stringify({ sessionId: "s2", result: "c" })).sessionId).toBe("s2");
  });

  it("falls back to raw text when the output is not json", () => {
    const out = grok.parse("  plain answer  ");
    expect(out.text).toBe("plain answer");
  });

  it("throws on an error payload so the runner reports it", () => {
    expect(() => grok.parse(JSON.stringify({ type: "error", message: "not signed in" }))).toThrow(
      /not signed in/,
    );
  });
});
