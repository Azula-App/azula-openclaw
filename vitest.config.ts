import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only the sources. `dist/` holds compiled copies of these same files, and
    // running both doubles every test while hiding which copy actually failed.
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
