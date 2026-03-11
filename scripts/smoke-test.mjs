import { mkdtemp, writeFile, rm, readFile, access, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "vite";
import { createRequire } from "node:module";

const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);
const distMjs = path.join(projectRoot, "dist", "index.mjs");
const distCjs = path.join(projectRoot, "dist", "index.cjs");
const distDts = path.join(projectRoot, "dist", "index.d.ts");

const require = createRequire(import.meta.url);

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getFreePort = async () => {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate free port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
};

const writeAppFile = async (file, version) => {
  await writeFile(
    file,
    `
import { Hono } from "hono";
const app = new Hono();
app.get("/api/ok", (c) => c.text("${version}"));
app.get("/api/head-ok", (c) => c.text("head-${version}"));
export default app;
`,
    "utf8",
  );
};

const createViteServer = async ({ root, plugin }) => {
  return createServer({
    root,
    logLevel: "error",
    plugins: [plugin],
    optimizeDeps: {
      noDiscovery: true,
    },
    server: {
      host: "127.0.0.1",
      port: 0,
    },
    appType: "spa",
  });
};

const run = async () => {
  await access(distMjs);
  await access(distCjs);
  await access(distDts);

  const esmModule = await import(pathToFileURL(distMjs).href);
  assert(typeof esmModule.default === "function", "ESM default export should be a function");

  const cjsModule = require(distCjs);
  const cjsDefault = cjsModule.default ?? cjsModule;
  assert(typeof cjsDefault === "function", "CJS default export should be a function");

  const dtsContent = await readFile(distDts, "utf8");
  assert(dtsContent.includes("HonoDevProxyPluginOptions"), "Type declaration should include options type");

  const smokeBase = path.join(projectRoot, ".tmp-smoke");
  await mkdir(smokeBase, { recursive: true });

  const tempRoot = await mkdtemp(path.join(smokeBase, "ok-"));
  const badRoot = await mkdtemp(path.join(smokeBase, "bad-"));

  try {
    const entryFile = path.join(tempRoot, "server.ts");
    await writeAppFile(entryFile, "v1");
    await writeFile(path.join(tempRoot, "index.html"), "<html><body><div id='app'>ok</div></body></html>", "utf8");

    const backendPort = await getFreePort();
    const plugin = esmModule.default({
      entry: entryFile,
      host: "127.0.0.1",
      port: backendPort,
    });

    const server = await createViteServer({ root: tempRoot, plugin });
    await server.listen();

    try {
      const address = server.httpServer?.address();
      assert(address && typeof address !== "string", "Vite should expose address info");
      const base = `http://127.0.0.1:${address.port}`;

      const apiResponse = await fetch(`${base}/api/ok`);
      assert(apiResponse.status === 200, "Matched route should be proxied to backend");
      assert((await apiResponse.text()) === "v1", "Matched route should return backend payload");

      const headResponse = await fetch(`${base}/api/head-ok`, { method: "HEAD" });
      assert(headResponse.status !== 502, "HEAD request should be proxied when route is matched");

      const fallbackResponse = await fetch(`${base}/not-a-backend-route`);
      assert(fallbackResponse.status !== 502, "Unmatched route should not proxy to backend");

      await writeAppFile(entryFile, "v2");
      await sleep(1200);

      const reloadedResponse = await fetch(`${base}/api/ok`);
      assert((await reloadedResponse.text()) === "v2", "Backend should hot-reload on entry updates");
    } finally {
      await server.close();
    }

    const badEntry = path.join(badRoot, "server.ts");
    await writeFile(badEntry, `export const notApp = { hello: "world" };`, "utf8");
    await writeFile(path.join(badRoot, "index.html"), "<html><body>bad</body></html>", "utf8");

    const badPlugin = esmModule.default({
      entry: badEntry,
      host: "127.0.0.1",
      port: await getFreePort(),
    });

    let badFailed = false;
    let badServer;
    try {
      badServer = await createViteServer({ root: badRoot, plugin: badPlugin });
      await badServer.listen();
    } catch (error) {
      badFailed = true;
      const message = error instanceof Error ? error.message : String(error);
      assert(message.includes("must export a Hono app"), "Invalid entry should produce clear export error");
    } finally {
      if (badServer) {
        await badServer.close();
      }
    }

    assert(badFailed, "Invalid entry scenario should fail");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(badRoot, { recursive: true, force: true });
  }

  console.log("smoke-test passed");
  process.exit(0);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
