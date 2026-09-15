import { defineConfig } from "vitest/config";

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
    },
    coverage: {
      include: ["src/**/*.ts"],
      reporter: ["text", "lcov"],
    },
  },
});
