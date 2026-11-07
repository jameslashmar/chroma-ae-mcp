import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The first test in a file that reaches the tool registry loads all of it:
    // over vitest's default 5 s when the whole suite runs in parallel.
    testTimeout: 20_000,
  },
});
