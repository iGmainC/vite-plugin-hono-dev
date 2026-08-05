import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "vite";

const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);
const distMjs = path.join(projectRoot, "dist", "index.mjs");

/** 断言 smoke 条件，失败时保留明确的运行时语义 */
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

/** 获取隔离端口，避免 runtime smoke 相互干扰 */
const getFreePort = async () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate runtime smoke port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });

/** 创建并启动单个运行时场景 */
const startRuntimeServer = async ({ root, plugin }) => {
  const server = await createServer({
    root,
    logLevel: "error",
    plugins: [plugin],
    optimizeDeps: { noDiscovery: true },
    server: { host: "127.0.0.1", port: 0 },
    appType: "spa",
  });
  try {
    await server.listen();
    return server;
  } catch (error) {
    // 启动失败也必须回收 Vite watcher，避免测试进程残留句柄。
    await server.close();
    throw error;
  }
};

/** 通过 Vite 代理建立 WebSocket，并验证 Bun 后端能够收到和返回消息 */
const requestWebSocketEcho = async (url, payload) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`WebSocket runtime smoke timed out: ${url}`));
    }, 3000);

    socket.addEventListener("open", () => socket.send(payload));
    socket.addEventListener("message", (event) => {
      clearTimeout(timeout);
      socket.close();
      resolve(String(event.data));
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket runtime smoke failed: ${url}`));
    });
  });

/** 在 Bun 宿主中验证 auto 和显式 bun 都走通真实 HTTP 请求 */
const verifyBunRuntime = async (createPlugin, tempRoot) => {
  for (const runtime of ["auto", "bun"]) {
    const scenarioRoot = path.join(tempRoot, runtime);
    await mkdir(scenarioRoot, { recursive: true });
    const entryFile = path.join(scenarioRoot, "server.ts");
    await writeFile(
      entryFile,
      `
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { upgradeWebSocket, websocket } from "hono/bun";
const database = new Database(":memory:");
const app = new Hono();
app.get("/runtime", (c) => c.json(database.query("select 'bun' as host").get()));
app.get("/runtime/ws", upgradeWebSocket(() => ({
  onMessage: (event, socket) => socket.send("echo:" + String(event.data)),
})));
export { websocket };
export default app;
`,
      "utf8",
    );
    await writeFile(path.join(scenarioRoot, "index.html"), "<html><body>runtime</body></html>", "utf8");

    const server = await startRuntimeServer({
      root: scenarioRoot,
      plugin: createPlugin({
        entry: entryFile,
        host: "127.0.0.1",
        port: await getFreePort(),
        runtime,
      }),
    });
    try {
      const address = server.httpServer?.address();
      assert(address && typeof address !== "string", `${runtime} should expose Vite address info`);
      const response = await fetch(`http://127.0.0.1:${address.port}/runtime`);
      assert(response.status === 200, `${runtime} Bun backend should respond`);
      const payload = await response.json();
      assert(payload.host === "bun", `${runtime} should load the backend entry in the Bun host`);

      const websocketMessage = await requestWebSocketEcho(`ws://127.0.0.1:${address.port}/runtime/ws`, "bun-ws");
      assert(websocketMessage === "echo:bun-ws", `${runtime} should proxy Bun WebSocket upgrades`);
    } finally {
      await server.close();
    }
  }
};

/** 非法运行时值必须在加载入口前失败，不能静默回退到 Node */
const verifyInvalidRuntimeRejected = async (createPlugin, tempRoot) => {
  const invalidRoot = path.join(tempRoot, "invalid-runtime");
  await mkdir(invalidRoot, { recursive: true });
  const entryFile = path.join(invalidRoot, "server.ts");
  await writeFile(entryFile, `throw new Error("invalid runtime must be rejected before loading this entry");`, "utf8");
  await writeFile(path.join(invalidRoot, "index.html"), "<html><body>invalid runtime</body></html>", "utf8");

  let rejected = false;
  try {
    await startRuntimeServer({
      root: invalidRoot,
      plugin: createPlugin({
        entry: entryFile,
        host: "127.0.0.1",
        port: await getFreePort(),
        runtime: "bnu",
      }),
    });
  } catch (error) {
    rejected = true;
    const message = error instanceof Error ? error.message : String(error);
    assert(message.includes('invalid runtime "bnu"'), "Invalid runtime should identify the unsupported value");
  }
  assert(rejected, "Invalid runtime must fail Vite startup");
};

/** 在 Node 宿主中验证显式 bun 不会静默退回 Node adapter */
const verifyNodeRejectsBunRuntime = async (createPlugin, tempRoot) => {
  const entryFile = path.join(tempRoot, "server.ts");
  await writeFile(
    entryFile,
    `throw new Error("runtime validation must happen before loading this entry");`,
    "utf8",
  );
  await writeFile(path.join(tempRoot, "index.html"), "<html><body>runtime</body></html>", "utf8");

  let rejected = false;
  let server;
  try {
    server = await startRuntimeServer({
      root: tempRoot,
      plugin: createPlugin({
        entry: entryFile,
        host: "127.0.0.1",
        port: await getFreePort(),
        runtime: "bun",
      }),
    });
  } catch (error) {
    rejected = true;
    const message = error instanceof Error ? error.message : String(error);
    assert(message.includes('runtime "bun" requires Vite to run under Bun'), "Node rejection should explain how to run Bun");
  } finally {
    await server?.close();
  }
  assert(rejected, "Node host must reject explicit Bun runtime");
};

const run = async () => {
  await access(distMjs);
  const { default: createPlugin } = await import(pathToFileURL(distMjs).href);
  const smokeBase = path.join(projectRoot, ".tmp-smoke");
  await mkdir(smokeBase, { recursive: true });
  const tempRoot = await mkdtemp(path.join(smokeBase, "runtime-"));

  try {
    await verifyInvalidRuntimeRejected(createPlugin, tempRoot);
    if (typeof globalThis.Bun === "undefined") {
      await verifyNodeRejectsBunRuntime(createPlugin, tempRoot);
      console.log("runtime-smoke-test passed (node host)");
      return;
    }
    await verifyBunRuntime(createPlugin, tempRoot);
    console.log("runtime-smoke-test passed (bun host)");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
