import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Keep SQLite-backed tests in a single forked process. Running multiple
    // Vitest workers is unstable with the native better-sqlite3 addon in CI,
    // and file isolation is not actually needed because each test resets its DB state.
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    fileParallelism: false,
    // Exclude live tests from the default test run
    exclude: ["**/live.test.ts", "**/node_modules/**"],
    testTimeout: 15_000,
  },
});
