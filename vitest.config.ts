import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Background runs write working directories and a SQLite file. Give the suite
// its own throwaway root; this config loads once per `vitest` invocation, so
// clearing it here wipes the previous run's leftovers.
const runsDir = join(tmpdir(), "claude-proxy-vitest");
rmSync(runsDir, { recursive: true, force: true });
mkdirSync(runsDir, { recursive: true });

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // config.ts reads process.env at import time, so the suite's settings have
    // to be in place before any module loads.
    env: {
      PROXY_TOKEN: "test-token",
      CLAUDE_BIN: new URL("test/fixtures/fake-claude.mjs", import.meta.url).pathname,
      TIMEOUT_MS: "5000",
      MAX_BODY_BYTES: "1024",
      RUNS_DIR: runsDir,
      RUN_TIMEOUT_MS: "5000",
      MAX_UPLOAD_BYTES: "200000",
      MAX_UNZIP_BYTES: "100000",
      MAX_CONCURRENT_RUNS: "1",
    },
    coverage: {
      include: ["src/**/*.ts"],
      reporter: ["text", "lcov"],
    },
  },
});
