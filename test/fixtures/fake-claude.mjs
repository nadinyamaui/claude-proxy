#!/usr/bin/env node
// Stands in for the real `claude` CLI so the suite never makes a network call.
// Echoes back what it was given, in the shape `claude -p --output-format json`
// produces (or the `stream-json` event stream when asked for it). Exits
// non-zero when the prompt is the literal "FAIL".
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const streaming = args.includes("stream-json");

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  const prompt = stdin.trim();

  if (prompt === "RATE_LIMIT") {
    const message = "You've hit your session limit · resets 11:10am (UTC)";
    const result = {
      type: "result",
      subtype: "success",
      is_error: true,
      result: message,
      session_id: "fake-session-1",
      api_error_status: 429,
    };
    if (streaming) {
      process.stdout.write(JSON.stringify({ type: "rate_limit_event" }) + "\n");
      process.stdout.write(JSON.stringify(result) + "\n");
    } else {
      process.stdout.write(JSON.stringify(result));
    }
    process.exit(1);
  }

  if (prompt === "FAIL") {
    process.stderr.write("fake-claude: asked to fail\n");
    process.exit(3);
  }
  if (prompt === "NOTJSON") {
    process.stdout.write("this is not json");
    process.exit(0);
  }
  if (prompt === "HANG") {
    // Keep running until killed; announce it so cancellation tests can wait
    // for the process to actually be up.
    if (streaming) process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\n");
    process.on("SIGTERM", () => process.exit(143));
    setTimeout(() => {}, 60_000);
    return;
  }
  if (prompt === "WRITE") {
    // Prove the working directory: leave a file behind.
    writeFileSync("written-by-fake-claude.txt", "hello from the agent\n");
  }

  // ENV reports FAKE_ENV reversed, so tests can prove it arrived without the
  // literal value showing up in the stored result.
  const text =
    prompt === "ENV"
      ? `env: ${[...(process.env.FAKE_ENV ?? "(unset)")].reverse().join("")}`
      : `echo: ${prompt}`;
  const result = {
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    session_id: "fake-session-1",
    total_cost_usd: 0.42,
    argv: args,
    cwd: process.cwd(),
  };

  if (!streaming) {
    process.stdout.write(JSON.stringify(result));
    return;
  }

  process.stderr.write("fake-claude: streaming\n");
  process.stdout.write(
    JSON.stringify({ type: "system", subtype: "init", session_id: "fake-session-1" }) + "\n",
  );
  process.stdout.write(
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }) + "\n",
  );
  process.stdout.write(JSON.stringify(result) + "\n");
});
