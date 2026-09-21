import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["./tests/setup/env.ts", "./tests/setup/db.ts", "./tests/setup/storage.ts"],
    testTimeout: 20_000,
  },
});
