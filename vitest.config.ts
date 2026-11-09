import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Keep SQLite-backed tests in a single worker. File isolation is not needed
    // because each test resets its DB state.
    pool: "forks",
    fileParallelism: false,
    // Exclude live tests from the default test run
    exclude: ["**/live.test.ts", "**/node_modules/**"],
    testTimeout: 15_000,
  },
});
