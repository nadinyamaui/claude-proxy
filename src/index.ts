import type { start as Start } from "./server.js";

// Loaded dynamically so a configuration error (a missing PROXY_TOKEN, say)
// surfaces as a one-line message instead of a module-load stack trace.
let start: typeof Start;
try {
  ({ start } = await import("./server.js"));
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const app = start();

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    app.server.close();
    // Kill background CLIs rather than orphan them; they are marked cancelled.
    void app.shutdown().finally(() => process.exit(0));
  });
}
