import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "node24",
    minify: false,
    lib: {
      entry: { "history-search": "src/index.ts" },
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
    },
    rolldownOptions: {
      platform: "node",
      external: [/^@opencode\//, /^zod(?:\/|$)/, /^node:/, /^bun:/],
    },
  },
});
