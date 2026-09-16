import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const require = createRequire(import.meta.url);
const reactDir = dirname(require.resolve("react/package.json"));
const reactDomDir = dirname(require.resolve("react-dom/package.json"));

export default defineConfig({
  resolve: {
    alias: {
      react: reactDir,
      "react-dom": reactDomDir,
      "react/jsx-runtime": `${reactDir}/jsx-runtime`,
    },
    dedupe: ["react", "react-dom", "antd"],
  },
  test: {
    root: here("."),
    globals: true,
    environment: "jsdom",
    setupFiles: [here("./renderer/test/setup.ts")],
    include: ["renderer/test/**/*.test.ts", "renderer/test/**/*.test.tsx"],
    server: {
      deps: {
        // Route the file:-linked design-system facade through vite so its
        // JSX/TS output and css imports transform; react itself is deduped
        // at install level (see scripts/dedupe-react in the workspace root).
        inline: ["@fullstack-ai-infra/ui", /design-system\/dist/],
      },
    },
  },
});
