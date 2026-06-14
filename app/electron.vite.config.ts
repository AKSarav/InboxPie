import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    // onnxruntime-node is a transitive dep (via @xenova/transformers) but we import it
    // directly in ort-env.ts to cap its thread pool. Force-externalize it so its native
    // .node binding is required at runtime from node_modules instead of being bundled
    // (bundling breaks its dynamic requireBinding path).
    plugins: [externalizeDepsPlugin({ include: ["onnxruntime-node"] })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/preload/index.ts"),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    publicDir: resolve(__dirname, "src/renderer/public"),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
        },
      },
    },
  },
});
