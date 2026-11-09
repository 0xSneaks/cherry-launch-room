import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    // @pump-fun/* ship ESM that named-imports from CJS @coral-xyz/anchor; let Vite handle the interop.
    server: { deps: { inline: [/@pump-fun\//] } },
  },
});
