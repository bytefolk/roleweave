import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const rendererRoot = fileURLToPath(new URL("./renderer", import.meta.url));
const require = createRequire(import.meta.url);
const reactDir = dirname(require.resolve("react/package.json"));
const reactDomDir = dirname(require.resolve("react-dom/package.json"));

export default defineConfig({
  root: rendererRoot,
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      react: reactDir,
      "react-dom": reactDomDir,
      "react/jsx-runtime": `${reactDir}/jsx-runtime`,
    },
    // The file-linked design system has its own install. Its ConfigProvider
    // and the desktop's Ant controls must share one context in packaged builds.
    dedupe: ["react", "react-dom", "antd"],
  },
  build: {
    outDir: fileURLToPath(new URL("./dist/renderer", import.meta.url)),
    emptyOutDir: true,
  },
});
