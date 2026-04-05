import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "cli/main": "src/cli/main.ts",
    index: "src/index.ts",
    tui: "src/tui.ts",
    dream: "src/dream.ts",
    scheduler: "src/scheduler.ts",
    "list-models": "src/list-models.ts",
    "daemon/supervisor": "src/daemon/supervisor.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  bundle: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  outDir: "dist",
  external: ["better-sqlite3"],
  shims: false,
  minify: false,
});
