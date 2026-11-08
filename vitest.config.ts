import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run tests sequentially per file (important for shared in-memory SQLite state)
    pool: "forks",
    // Exclude live tests from the default test run
    exclude: ["**/live.test.ts", "**/node_modules/**"],
    testTimeout: 15_000,
  },
});
