import { start } from "./server.js";

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
