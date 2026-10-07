import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/e2e/**/*.test.ts"], testTimeout: 900000, hookTimeout: 900000, maxWorkers: 1 },
});
