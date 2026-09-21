import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/unit/**/*.test.ts", "tests/contract/**/*.test.ts"],
    setupFiles: ["./tests/setup/env.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/lib/{redaction,rules,diagnosis-quality,storage,workbench-trace}.ts"],
      excludeAfterRemap: true,
      thresholds: { lines: 90, functions: 90, branches: 70, statements: 90 },
    },
  },
});
