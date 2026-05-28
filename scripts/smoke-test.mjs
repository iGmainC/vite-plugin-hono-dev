import { mkdtemp, writeFile, rm, readFile, access, mkdir } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import * as http from "node:http";
import * as net from "node:net";
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

/** 获取一个当前可用端口，用于隔离每个 smoke 场景 */
const getFreePort = async () => {
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

/** 生成 masked client text frame，用于不依赖外部 ws 客户端库的 smoke 验证 */
const createMaskedTextFrame = (message) => {
  const payload = Buffer.from(message);
  assert(payload.length < 126, "Smoke WebSocket payload should stay small");
  const mask = randomBytes(4);
  const frame = Buffer.alloc(2 + mask.length + payload.length);
  frame[0] = 0x81;
  frame[1] = 0x80 | payload.length;
  mask.copy(frame, 2);
  for (let index = 0; index < payload.length; index += 1) {
    frame[6 + index] = payload[index] ^ mask[index % 4];
  }
  return frame;
};

/** 解析 server text frame，覆盖 smoke 中的 connected / echo 两条消息 */
const parseTextFrames = (buffer) => {
  const messages = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const opcode = buffer[offset] & 0x0f;
    const lengthByte = buffer[offset + 1];
    const masked = (lengthByte & 0x80) !== 0;
    let payloadLength = lengthByte & 0x7f;
    let headerLength = 2;

    if (payloadLength === 126) {
      if (offset + 4 > buffer.length) break;
      payloadLength = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    }

    const maskLength = masked ? 4 : 0;
    const frameEnd = offset + headerLength + maskLength + payloadLength;
    if (frameEnd > buffer.length) break;

    const payloadStart = offset + headerLength + maskLength;
    const payload = Buffer.from(buffer.subarray(payloadStart, frameEnd));
    if (masked) {
      const mask = buffer.subarray(offset + headerLength, payloadStart);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] = payload[index] ^ mask[index % 4];
      }
    }
    if (opcode === 1) {
      messages.push(payload.toString("utf8"));
    }
    offset = frameEnd;
  }

  return { messages, remaining: buffer.subarray(offset) };
};

/** 通过原生 TCP 执行 WebSocket 握手和 echo 验证，避免新增 smoke 客户端依赖 */
const requestWebSocketEcho = async (wsUrl, payload) => {
  const url = new URL(wsUrl);
  const key = randomBytes(16).toString("base64");
  const expectedAccept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port), url.hostname);
    const messages = [];
    let buffer = Buffer.alloc(0);
    let handshakeDone = false;
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("WebSocket smoke request timed out"));
    }, 5000);

    const finish = () => {
      clearTimeout(timeout);
      socket.end();
      resolve(messages);
    };

    socket.on("connect", () => {
      const requestPath = `${url.pathname}${url.search}`;
      socket.write(
        [
          `GET ${requestPath} HTTP/1.1`,
          `Host: ${url.host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      );
    });

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (!handshakeDone) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const headerText = buffer.subarray(0, headerEnd).toString("utf8");
        assert(headerText.startsWith("HTTP/1.1 101"), "WebSocket upgrade should return 101");
        assert(headerText.includes(`Sec-WebSocket-Accept: ${expectedAccept}`), "WebSocket accept key should match");
        handshakeDone = true;
        buffer = buffer.subarray(headerEnd + 4);
        socket.write(createMaskedTextFrame(payload));
      }

      const parsed = parseTextFrames(buffer);
      buffer = parsed.remaining;
      messages.push(...parsed.messages);
      if (messages.includes(`echo:${payload}`)) {
        finish();
      }
    });

    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
};

/** 写入最小 Hono app，用于验证基础代理与入口热更新 */
const writeAppFile = async (file, version) => {
  await writeFile(
    file,
    `
import { Hono } from "hono";
const app = new Hono();
app.use("*", async (_c, next) => next());
app.use("/api/middleware/*", async (c, _next) => c.text("middleware:" + c.req.path));
app.get("/api/ok", (c) => c.text("${version}"));
app.get("/api/head-ok", (c) => c.text("head-${version}"));
app.get("/api/exact", (c) => c.text(c.req.path));
app.get("/api/slash/", (c) => c.text("slash:" + c.req.path));
app.post("/api/headers", (c) =>
  c.json({
    origin: c.req.header("origin"),
    host: c.req.header("host"),
    forwardedHost: c.req.header("x-forwarded-host"),
    forwardedProto: c.req.header("x-forwarded-proto"),
    forwardedFor: c.req.header("x-forwarded-for"),
  }),
);
export default app;
`,
    "utf8",
  );
};

/** 写入带目录外 shared 依赖的 Hono app，用于验证 SSR 依赖图热更新 */
const writeSharedBackendFiles = async ({ entryFile, sharedFile, version }) => {
  await writeFile(sharedFile, `export const message = "${version}";\n`, "utf8");
  await writeFile(
    entryFile,
    `
import { Hono } from "hono";
import { message } from "../shared/message";
const app = new Hono();
app.get("/api/message", (c) => c.text(message));
export default app;
`,
    "utf8",
  );
};

/** 写入 catch-all Hono app，用于验证不会劫持 Vite 内部资源 */
const writeCatchAllAppFile = async (file) => {
  await writeFile(
    file,
    `
import { Hono } from "hono";
const app = new Hono();
app.get("*", (c) => c.text("backend:" + c.req.path));
export default app;
`,
    "utf8",
  );
};

/** 写入显式开启尾斜杠归一化的验证 app */
const writeTrailingSlashAppFile = async (file) => {
  await writeFile(
    file,
    `
import { Hono } from "hono";
const app = new Hono();
app.get("/api/exact", (c) => c.text(c.req.path));
export default app;
`,
    "utf8",
  );
};

/** 写入 Node WebSocket app，用于验证 upgrade 请求只在命中 Hono 路由时代理 */
const writeWebSocketAppFile = async (file) => {
  await writeFile(
    file,
    `
import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
export const app = new Hono();
export const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
app.get("/api/ws", upgradeWebSocket(() => ({
  onOpen: (_event, ws) => ws.send("connected"),
  onMessage: (event, ws) => ws.send("echo:" + String(event.data)),
})));
`,
    "utf8",
  );
};

/** 写入前后端同目录文件，用于验证前端 HMR 不会被后端热更新逻辑吞掉 */
const writeFrontendHmrFiles = async ({ entryFile, mainFile, indexFile }) => {
  await writeFile(
    entryFile,
    `
import { Hono } from "hono";
const app = new Hono();
app.get("/api/ok", (c) => c.text("hmr-backend"));
export default app;
`,
    "utf8",
  );
  await writeFile(mainFile, `console.log("frontend hmr");\n`, "utf8");
  await writeFile(indexFile, `<script type="module" src="/src/main.tsx"></script><div>hmr</div>`, "utf8");
};

/** 创建测试专用 Vite dev server，统一关闭依赖扫描以减少无关噪声 */
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

/** 启动一个普通 HTTP server，占用端口以验证后端启动冲突 */
const listenHttpServer = async (server, host = "127.0.0.1") => {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string", "HTTP server should expose address info");
  return address.port;
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
  const sharedRoot = await mkdtemp(path.join(smokeBase, "shared-"));
  const conflictRoot = await mkdtemp(path.join(smokeBase, "conflict-"));
  const catchAllRoot = await mkdtemp(path.join(smokeBase, "catch-all-"));
  const slashCompatRoot = await mkdtemp(path.join(smokeBase, "slash-compat-"));
  const frontendHmrRoot = await mkdtemp(path.join(smokeBase, "frontend-hmr-"));
  const websocketRoot = await mkdtemp(path.join(smokeBase, "websocket-"));

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

      // 命中 Hono 路由时必须代理到后端。
      const apiResponse = await fetch(`${base}/api/ok`);
      assert(apiResponse.status === 200, "Matched route should be proxied to backend");
      assert((await apiResponse.text()) === "v1", "Matched route should return backend payload");

      // HEAD 请求应复用 GET 路由匹配结果。
      const headResponse = await fetch(`${base}/api/head-ok`, { method: "HEAD" });
      assert(headResponse.status !== 502, "HEAD request should be proxied when route is matched");

      // 未命中后端路由时必须继续走 Vite 默认流程。
      const fallbackResponse = await fetch(`${base}/not-a-backend-route`);
      assert(fallbackResponse.status !== 502, "Unmatched route should not proxy to backend");

      const headerResponse = await fetch(`${base}/api/headers`, {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          origin: base,
        },
        body: "headers",
      });
      const headerJson = await headerResponse.json();
      assert(headerJson.origin === base, "Proxy should preserve original Origin header");
      assert(headerJson.host === `127.0.0.1:${backendPort}`, "Proxy Host should point to backend target");
      assert(headerJson.forwardedHost === `127.0.0.1:${address.port}`, "Proxy should expose original Host");
      assert(headerJson.forwardedProto === "http", "Proxy should expose original protocol");
      assert(typeof headerJson.forwardedFor === "string" && headerJson.forwardedFor.length > 0, "Proxy should set X-Forwarded-For");

      const slashResponse = await fetch(`${base}/api/slash/`);
      assert((await slashResponse.text()) === "slash:/api/slash/", "Default mode should preserve trailing slash route");

      const exactWithSlashResponse = await fetch(`${base}/api/exact/`);
      const exactWithSlashText = await exactWithSlashResponse.text();
      assert(
        exactWithSlashText !== "/api/exact",
        "Default mode should not strip trailing slash and hit /api/exact",
      );

      const middlewareResponse = await fetch(`${base}/api/middleware/foo`);
      assert(
        (await middlewareResponse.text()) === "middleware:/api/middleware/foo",
        "Prefixed middleware-only route should be proxied",
      );

      const globalMiddlewareOnlyResponse = await fetch(`${base}/global-middleware-only`);
      const globalMiddlewareOnlyText = await globalMiddlewareOnlyResponse.text();
      assert(
        globalMiddlewareOnlyText.includes("id='app'"),
        "Global middleware-only route should not proxy Vite fallback by itself",
      );

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

    await mkdir(path.join(sharedRoot, "backend"), { recursive: true });
    await mkdir(path.join(sharedRoot, "shared"), { recursive: true });
    const sharedEntry = path.join(sharedRoot, "backend", "server.ts");
    const sharedFile = path.join(sharedRoot, "shared", "message.ts");
    await writeSharedBackendFiles({ entryFile: sharedEntry, sharedFile, version: "v1" });
    await writeFile(path.join(sharedRoot, "index.html"), "<html><body>shared</body></html>", "utf8");

    const sharedServer = await createViteServer({
      root: sharedRoot,
      plugin: esmModule.default({
        entry: sharedEntry,
        host: "127.0.0.1",
        port: await getFreePort(),
      }),
    });
    await sharedServer.listen();

    try {
      const address = sharedServer.httpServer?.address();
      assert(address && typeof address !== "string", "Shared Vite server should expose address info");
      const base = `http://127.0.0.1:${address.port}`;

      // 目录外 shared 依赖初始值应参与后端响应。
      const before = await fetch(`${base}/api/message`);
      assert((await before.text()) === "v1", "Shared backend dependency should return initial value");

      // 修改 shared 依赖后，应由 SSR 模块图触发后端 reload。
      await writeFile(sharedFile, `export const message = "v2";\n`, "utf8");
      await sleep(1200);

      const after = await fetch(`${base}/api/message`);
      assert((await after.text()) === "v2", "Backend should hot-reload when a shared SSR dependency changes");
    } finally {
      await sharedServer.close();
    }

    const occupiedServer = http.createServer((_req, res) => {
      res.statusCode = 418;
      res.end("occupied");
    });
    const occupiedPort = await listenHttpServer(occupiedServer);
    const conflictEntry = path.join(conflictRoot, "server.ts");
    await writeAppFile(conflictEntry, "conflict");
    await writeFile(path.join(conflictRoot, "index.html"), "<html><body>conflict</body></html>", "utf8");

    let conflictFailed = false;
    let conflictServer;
    try {
      conflictServer = await createViteServer({
        root: conflictRoot,
        plugin: esmModule.default({
          entry: conflictEntry,
          host: "127.0.0.1",
          port: occupiedPort,
        }),
      });
      await conflictServer.listen();
    } catch (error) {
      conflictFailed = true;
      const message = error instanceof Error ? error.message : String(error);
      assert(message.includes("failed to start backend"), "Port conflict should fail Vite startup clearly");
    } finally {
      if (conflictServer) {
        await conflictServer.close();
      }
      await new Promise((resolve) => occupiedServer.close(resolve));
    }

    assert(conflictFailed, "Backend port conflict should fail startup");

    const websocketEntry = path.join(websocketRoot, "server.ts");
    await writeWebSocketAppFile(websocketEntry);
    await writeFile(path.join(websocketRoot, "index.html"), "<html><body>websocket</body></html>", "utf8");

    const websocketServer = await createViteServer({
      root: websocketRoot,
      plugin: esmModule.default({
        entry: websocketEntry,
        host: "127.0.0.1",
        port: await getFreePort(),
      }),
    });
    await websocketServer.listen();

    try {
      const address = websocketServer.httpServer?.address();
      assert(address && typeof address !== "string", "WebSocket Vite server should expose address info");
      const messages = await requestWebSocketEcho(`ws://127.0.0.1:${address.port}/api/ws`, "smoke-ws");
      assert(messages.includes("connected"), "WebSocket route should receive open event");
      assert(messages.includes("echo:smoke-ws"), "WebSocket route should echo client message through proxy");
    } finally {
      await websocketServer.close();
    }

    await mkdir(path.join(catchAllRoot, "src"), { recursive: true });
    const catchAllEntry = path.join(catchAllRoot, "server.ts");
    await writeCatchAllAppFile(catchAllEntry);
    await writeFile(
      path.join(catchAllRoot, "index.html"),
      `<script type="module" src="/src/main.tsx"></script><div>catch-all</div>`,
      "utf8",
    );
    await writeFile(path.join(catchAllRoot, "src", "main.tsx"), `console.log("frontend");\n`, "utf8");

    const catchAllServer = await createViteServer({
      root: catchAllRoot,
      plugin: esmModule.default({
        entry: catchAllEntry,
        host: "127.0.0.1",
        port: await getFreePort(),
      }),
    });
    await catchAllServer.listen();

    try {
      const address = catchAllServer.httpServer?.address();
      assert(address && typeof address !== "string", "Catch-all Vite server should expose address info");
      const base = `http://127.0.0.1:${address.port}`;

      // catch-all 后端路由不能劫持 Vite client，否则 HMR 会失效。
      const viteClientResponse = await fetch(`${base}/@vite/client`);
      const viteClientText = await viteClientResponse.text();
      assert(viteClientText.includes("createHotContext"), "Hono catch-all should not proxy Vite client");
      assert(!viteClientText.startsWith("backend:"), "Vite client should come from Vite, not backend");

      // root 下真实存在的源码文件必须仍由 Vite transform 管线处理。
      const sourceResponse = await fetch(`${base}/src/main.tsx`);
      const sourceText = await sourceResponse.text();
      assert(sourceText.includes("console.log"), "Hono catch-all should not proxy source modules");
      assert(!sourceText.startsWith("backend:"), "Source module should come from Vite, not backend");

      // 非 Vite 资源路径仍然允许后端 catch-all 接管。
      const backendResponse = await fetch(`${base}/ssr`);
      assert((await backendResponse.text()) === "backend:/ssr", "Non-file route should still reach Hono catch-all");
    } finally {
      await catchAllServer.close();
    }

    const slashCompatEntry = path.join(slashCompatRoot, "server.ts");
    await writeTrailingSlashAppFile(slashCompatEntry);
    await writeFile(path.join(slashCompatRoot, "index.html"), "<html><body>slash compat</body></html>", "utf8");

    const slashCompatServer = await createViteServer({
      root: slashCompatRoot,
      plugin: esmModule.default({
        entry: slashCompatEntry,
        host: "127.0.0.1",
        port: await getFreePort(),
        stripTrailingSlash: true,
      }),
    });
    await slashCompatServer.listen();

    try {
      const address = slashCompatServer.httpServer?.address();
      assert(address && typeof address !== "string", "Slash compat Vite server should expose address info");
      const base = `http://127.0.0.1:${address.port}`;

      const compatResponse = await fetch(`${base}/api/exact/`);
      assert(
        (await compatResponse.text()) === "/api/exact",
        "Explicit stripTrailingSlash should keep the old trailing slash normalization behavior",
      );
    } finally {
      await slashCompatServer.close();
    }

    await mkdir(path.join(frontendHmrRoot, "src"), { recursive: true });
    const frontendHmrEntry = path.join(frontendHmrRoot, "src", "server.ts");
    const frontendHmrMain = path.join(frontendHmrRoot, "src", "main.tsx");
    await writeFrontendHmrFiles({
      entryFile: frontendHmrEntry,
      mainFile: frontendHmrMain,
      indexFile: path.join(frontendHmrRoot, "index.html"),
    });

    const frontendHmrPlugin = esmModule.default({
      entry: frontendHmrEntry,
      host: "127.0.0.1",
      port: await getFreePort(),
    });
    const frontendHmrServer = await createViteServer({
      root: frontendHmrRoot,
      plugin: frontendHmrPlugin,
    });
    await frontendHmrServer.listen();

    try {
      const address = frontendHmrServer.httpServer?.address();
      assert(address && typeof address !== "string", "Frontend HMR Vite server should expose address info");
      const base = `http://127.0.0.1:${address.port}`;

      // 先分别触发后端 SSR 加载与前端模块加载，模拟真实 dev server 模块图状态。
      assert((await (await fetch(`${base}/api/ok`)).text()) === "hmr-backend", "HMR backend route should respond");
      assert(
        (await (await fetch(`${base}/src/main.tsx`)).text()).includes("frontend hmr"),
        "Frontend source should be served by Vite",
      );

      const hotUpdateResult = frontendHmrPlugin.hotUpdate?.({
        type: "update",
        file: frontendHmrMain,
        timestamp: Date.now(),
        modules: [{ environment: "client" }],
        read: async () => readFile(frontendHmrMain, "utf8"),
        server: frontendHmrServer,
      });
      assert(
        hotUpdateResult === undefined || hotUpdateResult.some((moduleNode) => moduleNode.environment === "client"),
        "Frontend file in backend entry directory should not be swallowed by backend hotUpdate",
      );
    } finally {
      await frontendHmrServer.close();
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(badRoot, { recursive: true, force: true });
    await rm(sharedRoot, { recursive: true, force: true });
    await rm(conflictRoot, { recursive: true, force: true });
    await rm(catchAllRoot, { recursive: true, force: true });
    await rm(slashCompatRoot, { recursive: true, force: true });
    await rm(frontendHmrRoot, { recursive: true, force: true });
    await rm(websocketRoot, { recursive: true, force: true });
  }

  console.log("smoke-test passed");
  process.exit(0);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
