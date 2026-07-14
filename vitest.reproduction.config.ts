import base from "./vitest.config.js";
import { defineConfig } from "vitest/config";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["test/reproduction/**/*.repro.ts"],
    testTimeout: 5_000,
  },
});
