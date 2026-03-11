import { defineConfig } from "vite";
import honoDevProxyPlugin from "@igmainc/vite-plugin-hono-dev";

export default defineConfig({
  plugins: [
    honoDevProxyPlugin({
      entry: "./src/server.ts",
      host: "127.0.0.1",
      port: 8788,
    }),
  ],
});
