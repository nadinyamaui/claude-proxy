import { describe, expect, it } from "vitest";
import { claude } from "../src/providers/claude.js";
import { codex } from "../src/providers/codex.js";
import { grok } from "../src/providers/grok.js";
import { isProviderName, providers } from "../src/providers/index.js";

describe("registry", () => {
  it("exposes the three providers", () => {
    expect(Object.keys(providers).sort()).toEqual(["claude", "codex", "grok"]);
  });

  it("narrows only known names", () => {
    expect(isProviderName("claude")).toBe(true);
    expect(isProviderName("gemini")).toBe(false);
    expect(isProviderName(undefined)).toBe(false);
  });
});

describe("claude", () => {
  it("asks for json and passes the prompt over stdin, not argv", () => {
    const args = claude.args({ prompt: "hello" });
    expect(args).toEqual(["-p", "--output-format", "json"]);
    expect(args).not.toContain("hello");
  });

  it("maps resume, model and system prompt onto flags", () => {
    expect(claude.args({ prompt: "x", sessionId: "s1", model: "m1", systemPrompt: "be terse" })).toEqual([
      "-p",
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
