#!/usr/bin/env node
// Stands in for the real `claude` CLI so the suite never makes a network call.
// Echoes back what it was given, in the shape `claude -p --output-format json`
// produces. Exits non-zero when the prompt is the literal "FAIL".

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  if (stdin.trim() === "FAIL") {
    process.stderr.write("fake-claude: asked to fail\n");
    process.exit(3);
  }
  if (stdin.trim() === "NOTJSON") {
    process.stdout.write("this is not json");
    process.exit(0);
  }
  if (stdin.trim() === "HANG") {
    setTimeout(() => {}, 60_000);
    return;
  }

  const args = process.argv.slice(2);
  process.stdout.write(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: `echo: ${stdin.trim()}`,
      session_id: "fake-session-1",
      total_cost_usd: 0.42,
      argv: args,
    }),
  );
});
