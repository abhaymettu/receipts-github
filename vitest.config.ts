import { defineConfig } from "vitest/config";

export default defineConfig({
  ssr: { resolve: { conditions: ["source"] } },
  test: { include: ["packages/*/test/**/*.test.ts"] },
});
