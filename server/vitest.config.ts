import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The first test in a file that reaches the tool registry loads all of it:
    // over vitest's default 5 s when the whole suite runs in parallel.
    testTimeout: 20_000,
    // Keeps the GPU probe (PowerShell) out of every test file.
    setupFiles: ["./test/setup-resources.ts"],
    // `npm run test:coverage` (CI, Windows / Node 22) fails below this baseline:
    // about a point under what 0.7.0 measured (94.9 / 86.1 / 98.1 / 94.9).
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary", "html"],
      thresholds: { statements: 94, branches: 85, functions: 97, lines: 94 },
    },
  },
});
