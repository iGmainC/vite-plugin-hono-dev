import type { IncomingMessage, RequestOptions, ServerResponse } from "node:http";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";
import type { Socket } from "node:net";
import type { ServerType } from "@hono/node-server";
import { METHOD_NAME_ALL, type Result } from "hono/router";
import type { RouterRoute } from "hono/types";
import { isMiddleware } from "hono/utils/handler";
import { getPath } from "hono/utils/url";
import {
  type EnvironmentModuleGraph,
  type EnvironmentModuleNode,
  type HotUpdateOptions,
  normalizePath,
  type Plugin,
  type ResolvedConfig,
  type ViteDevServer,
} from "vite";
import WebSocket, { WebSocketServer, type RawData } from "ws";

/**
 * 插件入参：
 * - entry: Hono 主入口文件（需导出 app，默认导出或命名导出 app）
 * - port/host: 启动后端 Hono 服务所绑定的地址
 */
export interface HonoDevProxyPluginOptions {
  entry: string;
  port?: number;
  host?: string;
  /** 精确匹配这些 hostname 时，即使路径未命中显式 Hono route 也代理 */
  proxyHosts?: readonly string[];
  runtime?: HonoDevRuntime;
  debug?: boolean;
  stripTrailingSlash?: boolean;
}

/** 后端服务使用的运行时；auto 跟随启动 Vite 的宿主运行时 */
export type HonoDevRuntime = "auto" | "node" | "bun";

/** 插件实际解析出的后端运行时 */
type ResolvedHonoDevRuntime = Exclude<HonoDevRuntime, "auto">;

/** 单次请求的代理判定；Host 命中时需要把标准化 authority 传给后端中间件 */
type ProxyDecision = {
  shouldProxy: boolean;
  reason?: "host" | "route";
  requestHostname?: string;
  normalizedHost?: string;
};

/** 标准化后的 Host authority 与 hostname */
type NormalizedHost = {
  authority: string;
  hostname: string;
};

/**
 * Hono 路由匹配结果类型：
 * Hono 的 router.match 会返回一个结构化数组，包含命中的路由与参数。
 * 这里将 handler 元组中的第二项约束为 RouterRoute，便于后续读取 method/path。
 */
type MatchedRouteResult = Result<[unknown, RouterRoute]>;

/**
 * 插件内部对 Hono app 的最小能力约束：
 * - fetch: 用于真正处理请求（启动 node server 需要）
 * - routes: 已注册的路由列表
 * - router.match: 路由匹配函数
 */
type HonoLikeApp = {
  fetch: (request: Request, ...args: unknown[]) => Promise<Response> | Response;
  routes: RouterRoute[];
  router: {
    match: (method: string, path: string) => MatchedRouteResult;
  };
};

/** 后端入口可选导出的 WebSocket 注入器，用于把 adapter 绑定到实际 Node server */
type BackendWebSocketInjector = (server: ServerType) => void;

/** Bun.serve 所需的 WebSocket handlers，由后端入口从 hono/bun 导出 */
type BackendBunWebSocketHandler = Record<PropertyKey, unknown>;

/** 插件使用的最小 Bun Server 能力，避免要求 Node 用户安装 Bun 类型包 */
type BunBackendServer = {
  hostname: string;
  port: number;
  url: URL;
  stop: (closeActiveConnections?: boolean) => void;
};

/** 插件使用的最小 Bun 全局能力 */
type BunRuntimeApi = {
  serve: (options: {
    hostname: string;
    port: number;
    fetch: (request: Request, ...args: unknown[]) => Promise<Response> | Response;
    websocket?: BackendBunWebSocketHandler;
  }) => BunBackendServer;
};

const DEFAULT_HOST = "localhost";
const DEFAULT_PORT = 8787;
const DEFAULT_RUNTIME: HonoDevRuntime = "auto";
// 后端连接建立前最多缓存的 WebSocket 消息数，防止异常客户端无限占用内存。
const MAX_PENDING_WEBSOCKET_MESSAGES = 100;
// ws 客户端会自行生成这些握手头，不能从浏览器请求中重复透传。
const GENERATED_WEBSOCKET_HEADERS = new Set([
  "host",
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
]);

/** 判断 close code 是否允许出现在 WebSocket close frame 中 */
const isForwardableWebSocketCloseCode = (code: number): boolean => {
  if (code >= 3000 && code <= 4999) return true;
  if (code < 1000 || code > 1014) return false;
  return code !== 1004 && code !== 1005 && code !== 1006;
};
// Vite dev server 内部模块路径前缀，必须优先交给 Vite 自己处理。
const VITE_INTERNAL_PATH_PREFIXES = ["/@vite/", "/@id/", "/@fs/", "/@react-refresh"];
// Vite dev server 内部固定探活路径，不能被后端 catch-all 路由接管。
const VITE_INTERNAL_PATHS = new Set(["/__vite_ping"]);
type MiddlewareNext = (error?: unknown) => void;

/** 判断值是否为非 null 对象 */
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** 读取当前宿主进程暴露的 Bun API；Node 下返回 undefined */
const getBunRuntimeApi = (): BunRuntimeApi | undefined =>
  (globalThis as typeof globalThis & { Bun?: BunRuntimeApi }).Bun;

/**
 * 解析后端运行时：
 * - auto 跟随当前 Vite 宿主，避免入口在不同 JavaScript 运行时之间执行
 * - 显式 bun 时要求 Vite 本身由 Bun 启动
 */
const resolveBackendRuntime = (runtime: HonoDevRuntime): ResolvedHonoDevRuntime => {
  const bunRuntime = getBunRuntimeApi();
  if (runtime === "auto") return bunRuntime ? "bun" : "node";
  if (runtime !== "node" && runtime !== "bun") {
    throw new Error(`[hono-dev-proxy] invalid runtime "${String(runtime)}"; expected "auto", "node", or "bun".`);
  }
  if (runtime === "bun" && !bunRuntime) {
    throw new Error(
      '[hono-dev-proxy] runtime "bun" requires Vite to run under Bun. Start Vite with `bun run vite` or use runtime "node".',
    );
  }
  return runtime;
};

/**
 * 运行时校验是否为“可用的 Hono app”。
 * 这里不用 `instanceof Hono`，避免不同构建上下文导致的实例判断问题。
 */
const isHonoLikeApp = (value: unknown): value is HonoLikeApp => {
  if (!isObject(value)) return false;
  if (!("fetch" in value) || typeof value.fetch !== "function") return false;
  if (!("routes" in value) || !Array.isArray(value.routes)) return false;
  if (!("router" in value) || !isObject(value.router)) return false;
  if (!("match" in value.router) || typeof value.router.match !== "function") return false;
  return true;
};

/**
 * 从入口模块中提取 Hono app：
 * - 优先读取 default 导出
 * - 其次读取命名导出 app
 * 若导出不符合预期，会抛出清晰错误，方便定位配置问题。
 */
const extractHonoApp = (moduleExports: unknown, entry: string): HonoLikeApp => {
  if (!isObject(moduleExports)) {
    throw new Error(`[hono-dev-proxy] Failed to load module: ${entry}`);
  }

  const maybeApp = moduleExports.default ?? moduleExports.app;
  if (!isHonoLikeApp(maybeApp)) {
    throw new Error(`[hono-dev-proxy] "${entry}" must export a Hono app via default export or named export "app".`);
  }
  return maybeApp;
};

/**
 * 从入口模块中提取可选 WebSocket 注入器。
 * 约定后端入口导出 `injectWebSocket(server)`，例如 `@hono/node-ws` 的返回值。
 */
const extractBackendWebSocketInjector = (moduleExports: unknown): BackendWebSocketInjector | undefined => {
  if (!isObject(moduleExports)) return undefined;
  const maybeInjector = moduleExports.injectWebSocket;
  return typeof maybeInjector === "function" ? (maybeInjector as BackendWebSocketInjector) : undefined;
};

/** 从入口模块提取 hono/bun 的 WebSocket handlers */
const extractBackendBunWebSocketHandler = (moduleExports: unknown): BackendBunWebSocketHandler | undefined => {
  if (!isObject(moduleExports)) return undefined;
  const maybeWebSocket = moduleExports.websocket;
  return isObject(maybeWebSocket) ? maybeWebSocket : undefined;
};

/**
 * 获取原始请求 URL：
 * - Connect/Express 风格中间件可能存在 originalUrl
 * - 否则退回 req.url
 */
const getOriginalUrl = (req: IncomingMessage): string => {
  const originalUrl = (req as IncomingMessage & { originalUrl?: string }).originalUrl;
  return originalUrl ?? req.url ?? "/";
};

/**
 * 将 Node 请求转换为可供 Hono 路由器匹配的 pathname。
 * 这里复用 hono/utils/url 的 getPath，确保路径解析与 Hono 一致。
 */
const getRequestPathname = (req: IncomingMessage): string => {
  const rawUrl = getOriginalUrl(req);
  const requestUrl =
    rawUrl.startsWith("http://") || rawUrl.startsWith("https://")
      ? rawUrl
      : `http://${req.headers.host ?? "localhost"}${rawUrl}`;
  return getPath(new Request(requestUrl));
};

/** 解码 URL pathname，解码失败时退回原始路径，避免中间件抛错中断请求 */
const decodePathname = (pathName: string): string => {
  try {
    return decodeURIComponent(pathName);
  } catch {
    return pathName;
  }
};

const stripTrailingSlash = (pathName: string): string =>
  pathName.length > 1 && pathName.endsWith("/") ? pathName.slice(0, -1) : pathName;

/** 判断磁盘路径是否存在且是文件，目录仍交给 Vite 的 SPA/HTML 流程处理 */
const isExistingFile = (filePath: string): boolean => {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
};

/**
 * 判断请求是否应跳过 Hono 代理：
 * - Vite 内部资源必须优先交给 Vite
 * - root/public 中真实存在的文件也应由 Vite 静态与 transform 管线处理
 */
const shouldBypassProxy = (pathName: string, config: ResolvedConfig): boolean => {
  if (VITE_INTERNAL_PATHS.has(pathName)) return true;
  if (VITE_INTERNAL_PATH_PREFIXES.some((prefix) => pathName.startsWith(prefix))) return true;

  const decodedPath = decodePathname(pathName);
  const relativePath = decodedPath.replace(/^\/+/, "");
  if (!relativePath) return false;

  // root 下的源码或静态文件存在时，让 Vite 继续处理 transform/HMR。
  if (isExistingFile(path.resolve(config.root, relativePath))) return true;

  // publicDir 可以为 false；启用时，已存在的 public 资源也不能被后端 catch-all 劫持。
  if (typeof config.publicDir === "string" && isExistingFile(path.resolve(config.publicDir, relativePath))) {
    return true;
  }

  return false;
};

const getProxyRequestPath = (req: IncomingMessage, enableStripTrailingSlash: boolean): string => {
  const rawUrl = getOriginalUrl(req);
  const requestUrl =
    rawUrl.startsWith("http://") || rawUrl.startsWith("https://")
      ? rawUrl
      : `http://${req.headers.host ?? "localhost"}${rawUrl}`;
  const url = new URL(requestUrl);

  if (enableStripTrailingSlash) {
    url.pathname = stripTrailingSlash(url.pathname);
  }
  return `${url.pathname}${url.search}`;
};

const getRouteKey = (route: Pick<RouterRoute, "method" | "path">): string =>
  `${route.method.toUpperCase()} ${route.path}`;

/** 判断是否是会覆盖整站的全局 Hono 路由 */
const isGlobalRoutePath = (routePath: string): boolean => routePath === "*" || routePath === "/*";

/**
 * 判断 Hono route 是否可作为代理命中依据：
 * - endpoint route 可直接代理
 * - 带明确前缀的 middleware route 也可能直接返回响应，应代理
 * - 全局 middleware route 常用于 logger/cors 等横切逻辑，不能单独劫持 Vite fallback
 */
const isProxyableRoute = (route: RouterRoute): boolean => {
  if (!isMiddleware(route.handler as (...args: unknown[]) => unknown)) return true;
  return !isGlobalRoutePath(route.path);
};

/** 将 header 值规范成首个字符串，便于拼接代理头 */
const getFirstHeaderValue = (headerValue: string | string[] | undefined): string | undefined => {
  if (Array.isArray(headerValue)) return headerValue[0];
  return headerValue;
};

/**
 * 将 HTTP authority 规范化为精确 hostname：
 * - 忽略端口并统一小写
 * - 拒绝协议、认证信息、路径、查询和 hash，避免把过宽输入误当成 hostname
 */
const normalizeHost = (hostValue: string): NormalizedHost | undefined => {
  const authority = hostValue.trim();
  if (!authority) return undefined;

  try {
    const url = new URL(`http://${authority}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return undefined;
    return {
      authority: url.host.toLowerCase(),
      hostname: url.hostname.toLowerCase(),
    };
  } catch {
    return undefined;
  }
};

/** 校验并规范化 proxyHosts；v1 仅支持精确 hostname，不接受通配符或 URL */
const normalizeProxyHosts = (proxyHosts: readonly string[] | undefined): ReadonlySet<string> => {
  if (proxyHosts === undefined) return new Set<string>();
  if (!Array.isArray(proxyHosts)) {
    throw new Error('[hono-dev-proxy] "proxyHosts" must be an array of exact hostnames.');
  }

  const normalizedHosts = new Set<string>();
  for (const host of proxyHosts) {
    const normalizedHost = typeof host === "string" ? normalizeHost(host) : undefined;
    if (!normalizedHost || normalizedHost.hostname.includes("*") || normalizedHost.hostname.startsWith(".")) {
      throw new Error(
        `[hono-dev-proxy] invalid proxyHosts entry "${String(host)}"; expected an exact hostname with an optional port.`,
      );
    }
    normalizedHosts.add(normalizedHost.hostname);
  }
  return normalizedHosts;
};

/** 追加 X-Forwarded-For，保留上游代理已经写入的来源链 */
const appendForwardedFor = (currentValue: string | string[] | undefined, remoteAddress: string | undefined): string => {
  const current = getFirstHeaderValue(currentValue);
  if (!remoteAddress) return current ?? "";
  return current ? `${current}, ${remoteAddress}` : remoteAddress;
};

/** 推断原始请求协议；本地 Vite dev server 默认是 http */
const getForwardedProto = (requestStream: IncomingMessage): string => {
  const forwardedProto = getFirstHeaderValue(requestStream.headers["x-forwarded-proto"]);
  if (forwardedProto) return forwardedProto;
  const maybeEncryptedSocket = requestStream.socket as typeof requestStream.socket & { encrypted?: boolean };
  return maybeEncryptedSocket.encrypted ? "https" : "http";
};

/** 构建代理请求头：保留 Origin，只补充标准 X-Forwarded-* 信息 */
const buildProxyRequestHeaders = (
  targetUrl: URL,
  requestHeaders: IncomingMessage["headers"],
  requestStream: IncomingMessage,
  normalizedHost: string | undefined,
): IncomingMessage["headers"] => {
  const forwardedFor = appendForwardedFor(requestHeaders["x-forwarded-for"], requestStream.socket.remoteAddress);
  const originalHost = getFirstHeaderValue(requestHeaders.host);
  return {
    ...requestHeaders,
    // Host 路由传递标准化 authority；普通 route-aware 代理继续使用后端 target。
    host: normalizedHost ?? targetUrl.host,
    "x-forwarded-host": originalHost ?? targetUrl.host,
    "x-forwarded-proto": getForwardedProto(requestStream),
    ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}),
  };
};

const collectMatchedRouteKeys = (matchedResult: MatchedRouteResult, appRoutes: ReadonlySet<string>): string[] => {
  const [matchedRoutes] = matchedResult;
  return matchedRoutes
    .map(([matchedRouteEntry]) => getRouteKey(matchedRouteEntry[1]))
    .filter((routeKey) => appRoutes.has(routeKey));
};

/**
 * 判断当前 router.match 的结果中，是否包含“真正来自 app.routes 的命中路由”。
 * 之所以额外和 app.routes 交叉校验，是为了严格满足“基于获取到的全部路由做匹配检查”的要求。
 */
const hasRouteMatch = (matchedResult: MatchedRouteResult, appRoutes: ReadonlySet<string>, method: string): boolean => {
  const [matchedRoutes] = matchedResult;
  if (matchedRoutes.length === 0) return false;

  const requestMethod = method.toUpperCase();
  return matchedRoutes.some(([matchedRouteEntry]) => {
    const route = matchedRouteEntry[1];
    if (!appRoutes.has(getRouteKey(route))) return false;
    return route.method === requestMethod || route.method === METHOD_NAME_ALL;
  });
};

/**
 * 是否应代理到后端：
 * 1. 先按原始 method 匹配
 * 2. 对 HEAD 做 GET 回退（很多框架会复用 GET 处理 HEAD）
 */
const shouldProxyRoute = (
  app: HonoLikeApp,
  appRoutes: ReadonlySet<string>,
  method: string,
  pathName: string,
): boolean => {
  if (hasRouteMatch(app.router.match(method, pathName), appRoutes, method)) {
    return true;
  }
  if (method === "HEAD") {
    return hasRouteMatch(app.router.match("GET", pathName), appRoutes, "GET");
  }
  return false;
};

/**
 * 统一 HTTP 与 WebSocket 的代理判定：
 * - 精确 Host 命中优先，允许全局中间件处理任意 pathname
 * - Host 未命中时维持原有 route-aware 语义
 */
const getProxyDecision = (
  app: HonoLikeApp,
  appRoutes: ReadonlySet<string>,
  method: string,
  pathName: string,
  requestHeaders: IncomingMessage["headers"],
  proxyHosts: ReadonlySet<string>,
): ProxyDecision => {
  const rawHost = getFirstHeaderValue(requestHeaders.host);
  const normalizedHost = rawHost ? normalizeHost(rawHost) : undefined;
  const requestHostname = normalizedHost?.hostname;
  if (requestHostname && proxyHosts.has(requestHostname)) {
    return {
      shouldProxy: true,
      reason: "host",
      requestHostname,
      normalizedHost: normalizedHost.authority,
    };
  }
  if (shouldProxyRoute(app, appRoutes, method, pathName)) {
    return { shouldProxy: true, reason: "route", requestHostname };
  }
  return { shouldProxy: false, requestHostname };
};

/** 读取 WebSocket 子协议；Vite HMR 使用 vite-hmr，必须留在 Vite 自身 upgrade 流程 */
const getRequestedWebSocketProtocols = (requestHeaders: IncomingMessage["headers"]): string[] =>
  (getFirstHeaderValue(requestHeaders["sec-websocket-protocol"]) ?? "")
    .split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);

/**
 * 反向代理到后端 Hono 服务：
 * - 透传 method/path/query/header
 * - 回写后端响应状态码、响应头与响应体
 * - 处理代理错误与请求中断
 */
const proxyToBackend = (
  res: ServerResponse,
  targetOrigin: string,
  requestPath: string,
  requestMethod: string | undefined,
  requestHeaders: IncomingMessage["headers"],
  requestStream: IncomingMessage,
  normalizedHost: string | undefined,
  onError: (error: Error) => void,
): void => {
  const targetUrl = new URL(requestPath, targetOrigin);
  const isSecure = targetUrl.protocol === "https:";

  const requestOptions: RequestOptions = {
    protocol: targetUrl.protocol,
    hostname: targetUrl.hostname,
    port: targetUrl.port,
    method: requestMethod,
    path: `${targetUrl.pathname}${targetUrl.search}`,
    headers: buildProxyRequestHeaders(targetUrl, requestHeaders, requestStream, normalizedHost),
  };
  const proxyRequest = (isSecure ? https : http).request(requestOptions, (proxyResponse) => {
    // 将后端状态码与状态文本透传给 Vite 当前请求
    res.statusCode = proxyResponse.statusCode ?? 502;
    if (proxyResponse.statusMessage) {
      res.statusMessage = proxyResponse.statusMessage;
    }
    // 将后端响应头完整转发到客户端
    for (const [headerName, headerValue] of Object.entries(proxyResponse.headers)) {
      if (headerValue !== undefined) {
        res.setHeader(headerName, headerValue);
      }
    }
    // 响应体流式透传，避免大响应体造成内存堆积
    proxyResponse.pipe(res);
  });

  proxyRequest.on("error", (error) => {
    onError(error);
    if (!res.headersSent) {
      res.statusCode = 502;
    }
    if (!res.writableEnded) {
      res.end("Failed to proxy request to Hono backend.");
    }
  });

  requestStream.on("aborted", () => {
    proxyRequest.destroy();
  });

  const normalizedMethod = requestMethod?.toUpperCase() ?? "GET";
  // 无 body 的请求直接结束；其余请求将 body 管道传给后端
  if (normalizedMethod === "GET" || normalizedMethod === "HEAD" || requestStream.readableEnded) {
    proxyRequest.end();
    return;
  }

  requestStream.pipe(proxyRequest);
};

/**
 * 反向代理 WebSocket upgrade 请求：
 * - 只处理已命中 Hono 路由的 upgrade，避免吞掉 Vite 自己的 HMR WebSocket
 * - 同步接管前端握手，再以独立后端连接双向转发消息和关闭语义
 */
const proxyWebSocketToBackend = (
  bridgeServer: WebSocketServer,
  requestStream: IncomingMessage,
  clientSocket: Socket,
  head: Buffer,
  targetOrigin: string,
  requestPath: string,
  requestHeaders: IncomingMessage["headers"],
  normalizedHost: string | undefined,
  onError: (error: Error) => void,
): void => {
  const targetUrl = new URL(requestPath, targetOrigin);
  targetUrl.protocol = targetUrl.protocol === "https:" ? "wss:" : "ws:";
  const proxyHeaders = buildProxyRequestHeaders(targetUrl, requestHeaders, requestStream, normalizedHost);
  const backendHeaders = Object.fromEntries(
    Object.entries(proxyHeaders).filter(([headerName, headerValue]) => {
      if (headerValue === undefined) return false;
      const normalizedHeaderName = headerName.toLowerCase();
      // ws 可用显式 Host 覆盖其自动生成值；其他握手头仍由 ws 负责。
      if (normalizedHost && normalizedHeaderName === "host") return true;
      return !GENERATED_WEBSOCKET_HEADERS.has(normalizedHeaderName);
    }),
  );
  const requestedProtocols = getRequestedWebSocketProtocols(requestHeaders);
  // 前端 ws server 默认选择首个协议，后端也只协商同一个值，避免两侧协议不一致。
  const selectedProtocol = requestedProtocols[0];

  bridgeServer.handleUpgrade(requestStream, clientSocket, head, (frontendSocket) => {
    const pendingMessages: Array<{ data: RawData; isBinary: boolean }> = [];
    const backendSocket = new WebSocket(targetUrl, selectedProtocol, { headers: backendHeaders });
    let backendErrorReported = false;

    /** 上报一次后端连接错误，并以服务端错误语义关闭前端连接 */
    const handleBackendError = (error: Error): void => {
      if (!backendErrorReported) {
        backendErrorReported = true;
        onError(error);
      }
      if (frontendSocket.readyState === WebSocket.OPEN) {
        frontendSocket.close(1011, "Hono backend WebSocket failed");
      } else if (frontendSocket.readyState === WebSocket.CONNECTING) {
        frontendSocket.terminate();
      }
    };

    frontendSocket.on("message", (data, isBinary) => {
      if (backendSocket.readyState === WebSocket.OPEN) {
        backendSocket.send(data, { binary: isBinary });
        return;
      }
      if (backendSocket.readyState !== WebSocket.CONNECTING) return;
      if (pendingMessages.length >= MAX_PENDING_WEBSOCKET_MESSAGES) {
        handleBackendError(new Error("WebSocket backend connection did not become ready before the message queue filled."));
        backendSocket.terminate();
        return;
      }
      pendingMessages.push({ data, isBinary });
    });

    backendSocket.on("open", () => {
      for (const { data, isBinary } of pendingMessages.splice(0)) {
        backendSocket.send(data, { binary: isBinary });
      }
    });
    backendSocket.on("message", (data, isBinary) => {
      if (frontendSocket.readyState === WebSocket.OPEN) {
        frontendSocket.send(data, { binary: isBinary });
      }
    });

    frontendSocket.on("close", (code, reason) => {
      if (backendSocket.readyState === WebSocket.CONNECTING) {
        backendSocket.terminate();
      } else if (backendSocket.readyState === WebSocket.OPEN) {
        if (isForwardableWebSocketCloseCode(code)) {
          backendSocket.close(code, reason.toString());
        } else {
          backendSocket.terminate();
        }
      }
    });
    backendSocket.on("close", (code, reason) => {
      if (frontendSocket.readyState === WebSocket.OPEN) {
        if (isForwardableWebSocketCloseCode(code)) {
          frontendSocket.close(code, reason.toString());
        } else {
          frontendSocket.terminate();
        }
      }
    });
    frontendSocket.on("error", () => backendSocket.terminate());
    backendSocket.on("error", handleBackendError);
  });
};

export default function honoDevProxyPlugin(options: HonoDevProxyPluginOptions): Plugin {
  const backendHost = options.host ?? DEFAULT_HOST;
  const backendPort = options.port ?? DEFAULT_PORT;
  const debugEnabled = options.debug ?? false;
  const stripTrailingSlashEnabled = options.stripTrailingSlash ?? false;
  const configuredRuntime = options.runtime ?? DEFAULT_RUNTIME;
  const proxyHosts = normalizeProxyHosts(options.proxyHosts);
  // 同步接管 Vite upgrade socket，再与后端建立独立 WebSocket 连接。
  const websocketBridgeServer = new WebSocketServer({ noServer: true });

  // 在 configResolved 后会转换为绝对路径
  let entryPath = options.entry;
  let normalizedEntryPath = options.entry;
  let backendTarget = `http://${backendHost}:${backendPort}`;
  let resolvedRuntime: ResolvedHonoDevRuntime | undefined;
  let stopBackendServer: (() => void) | undefined;
  let loadedApp: HonoLikeApp | undefined;
  let backendWebSocketInjector: BackendWebSocketInjector | undefined;
  let backendBunWebSocketHandler: BackendBunWebSocketHandler | undefined;
  // 存储 app.routes 的 method+path 索引，快速做命中校验
  let appRoutes = new Set<string>();
  // 存储 SSR 模块图中从后端入口可达的真实文件，避免用目录前缀误判前端文件
  let backendModuleFiles = new Set<string>();
  // 将热更新串行化，避免短时间内多次改动触发并发加载
  let reloadQueue = Promise.resolve();
  // 同一文件改动会在 client/ssr 环境各触发一次 hotUpdate，这里用于去重
  let lastReloadEventKey = "";

  /** 获取 Vite SSR 环境的模块图 */
  const getSsrModuleGraph = (server: ViteDevServer): EnvironmentModuleGraph | undefined =>
    server.environments.ssr?.moduleGraph;

  /** 从模块图中找后端入口模块，兼容 id/file 两种索引 */
  const getBackendEntryModule = (server: ViteDevServer): EnvironmentModuleNode | undefined => {
    const ssrModuleGraph = getSsrModuleGraph(server);
    if (!ssrModuleGraph) return undefined;

    const moduleById = ssrModuleGraph.getModuleById(entryPath) ?? ssrModuleGraph.getModuleById(normalizedEntryPath);
    if (moduleById) return moduleById;

    const modulesByFile =
      ssrModuleGraph.getModulesByFile(entryPath) ?? ssrModuleGraph.getModulesByFile(normalizedEntryPath);
    return modulesByFile?.values().next().value;
  };

  /** 收集后端入口在 SSR 模块图中的全部静态依赖文件 */
  const collectBackendModuleFiles = (entryModule: EnvironmentModuleNode | undefined): Set<string> => {
    const files = new Set<string>();
    const visited = new Set<EnvironmentModuleNode>();

    const visit = (moduleNode: EnvironmentModuleNode): void => {
      if (visited.has(moduleNode)) return;
      visited.add(moduleNode);

      if (moduleNode.file) {
        files.add(normalizePath(moduleNode.file));
      }

      // importedModules 表示当前 SSR 后端入口真实依赖，能覆盖目录外 shared 文件。
      for (const importedModule of moduleNode.importedModules) {
        visit(importedModule);
      }
    };

    if (entryModule) visit(entryModule);
    files.add(normalizedEntryPath);
    return files;
  };

  /** 后端文件改动时只过滤 SSR 模块，保留同文件的 client HMR 能力 */
  const getClientHotUpdateModules = (modules: HotUpdateOptions["modules"]): EnvironmentModuleNode[] => {
    return modules.filter((moduleNode) => moduleNode.environment === "client");
  };

  /** 判断改动文件是否属于后端 SSR 模块图 */
  const isBackendRelatedFile = (filePath: string): boolean => {
    return backendModuleFiles.has(normalizePath(filePath));
  };

  /**
   * 重新加载后端 app（不重启端口）：
   * - 重新 ssrLoadModule 入口
   * - 更新 loadedApp 与 routes 索引
   * 后端 Node Server 的 fetch 是“委托函数”，读取最新 loadedApp，
   * 所以后端逻辑会随这里的更新即时生效。
   */
  const loadBackendApp = async (server: ViteDevServer, reason: string, failOnError: boolean): Promise<boolean> => {
    try {
      const moduleExports = await server.ssrLoadModule(entryPath);
      const nextApp = extractHonoApp(moduleExports, options.entry);
      loadedApp = nextApp;
      backendWebSocketInjector = extractBackendWebSocketInjector(moduleExports);
      backendBunWebSocketHandler = extractBackendBunWebSocketHandler(moduleExports);
      const proxyableRoutes = nextApp.routes.filter(isProxyableRoute);
      appRoutes = new Set(proxyableRoutes.map(getRouteKey));
      backendModuleFiles = collectBackendModuleFiles(getBackendEntryModule(server));

      const routeSummary = nextApp.routes.map((route) => `${route.method} ${route.path}`).join(", ");
      const proxyableRouteSummary = proxyableRoutes.map((route) => `${route.method} ${route.path}`).join(", ");
      if (debugEnabled) {
        const routeList = nextApp.routes.map((route) => ({
          method: route.method,
          path: route.path,
          proxyable: isProxyableRoute(route),
        }));
        server.config.logger.info(`[hono-dev-proxy][debug] app.routes:\n${JSON.stringify(routeList, null, 2)}`);
      }
      if (reason === "initial") {
        server.config.logger.info(
          `[hono-dev-proxy] loaded ${nextApp.routes.length} route(s), proxyable ${proxyableRoutes.length} route(s): ` +
            `all=${routeSummary || "none"}; proxyable=${proxyableRouteSummary || "none"}`,
        );
      } else {
        server.config.logger.info(
          `[hono-dev-proxy] backend reloaded (${reason}), ${nextApp.routes.length} route(s), proxyable ${proxyableRoutes.length} route(s): ` +
            `all=${routeSummary || "none"}; proxyable=${proxyableRouteSummary || "none"}`,
        );
      }
      return true;
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      server.ssrFixStacktrace(normalizedError);
      server.config.logger.error(`[hono-dev-proxy] failed to load backend app (${reason}): ${normalizedError.message}`);
      if (failOnError) {
        throw normalizedError;
      }
      return false;
    }
  };

  /** 串行执行后端重载任务 */
  const enqueueBackendReload = (server: ViteDevServer, reason: string): void => {
    reloadQueue = reloadQueue
      .then(async () => {
        await loadBackendApp(server, reason, false);
      })
      .catch((error) => {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        server.config.logger.error(`[hono-dev-proxy] backend reload queue error: ${normalizedError.message}`);
      });
  };

  /** 生成相对路径日志，便于定位触发重载的文件 */
  const toChangedPath = (server: ViteDevServer, filePath: string): string =>
    path.relative(server.config.root, filePath) || filePath;

  /** 创建读取最新 app 的委托 fetch，使 Node/Bun adapter 共享热更新语义 */
  const fetchLoadedApp = (request: Request, ...args: unknown[]): Promise<Response> | Response => {
    if (!loadedApp) {
      return new Response("Hono backend is not ready.", { status: 503 });
    }
    return loadedApp.fetch(request, ...args);
  };

  /** 使用 Node adapter 启动后端，并在监听成功前阻塞 Vite 启动 */
  const startNodeBackendServer = async (server: ViteDevServer): Promise<void> => {
    // 延迟加载 Node adapter，Bun 路径不会初始化另一套后端 server adapter。
    const { createAdaptorServer } = await import("@hono/node-server");
    // 启动独立 Hono Node 服务，供命中路由时代理转发
    const backendServer = createAdaptorServer({
      fetch: fetchLoadedApp,
      hostname: backendHost,
      port: backendPort,
    });
    backendWebSocketInjector?.(backendServer);
    stopBackendServer = () => backendServer.close();

    server.config.logger.info(`[hono-dev-proxy] starting node backend on http://${backendHost}:${backendPort}`);

    await new Promise<void>((resolve, reject) => {
      const cleanupStartupListeners = (): void => {
        backendServer.off("listening", handleListening);
        backendServer.off("error", handleStartupError);
      };

      const handleListening = (): void => {
        cleanupStartupListeners();
        const address = backendServer.address();
        if (address && typeof address === "object") {
          backendTarget = `http://${backendHost}:${address.port}`;
          server.config.logger.info(`[hono-dev-proxy] backend ready on http://${address.address}:${address.port}`);
          return resolve();
        }
        server.config.logger.info(`[hono-dev-proxy] backend ready on http://${backendHost}:${backendPort}`);
        resolve();
      };

      const handleStartupError = (error: Error): void => {
        cleanupStartupListeners();
        backendServer.close();
        stopBackendServer = undefined;
        reject(new Error(`[hono-dev-proxy] failed to start backend on ${backendHost}:${backendPort}: ${error.message}`));
      };

      backendServer.once("listening", handleListening);
      backendServer.once("error", handleStartupError);
      backendServer.listen(backendPort, backendHost);
    });

    backendServer.on("error", (error) => {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      server.config.logger.error(`[hono-dev-proxy] backend error: ${normalizedError.message}`);
    });
  };

  /** 使用当前宿主的 Bun.serve 启动后端 */
  const startBunBackendServer = (server: ViteDevServer): void => {
    const bunRuntime = getBunRuntimeApi();
    if (!bunRuntime) {
      // resolveBackendRuntime 已提供面向用户的错误；这里防止运行时状态在启动期间异常变化。
      throw new Error('[hono-dev-proxy] runtime "bun" is unavailable in the current Vite process.');
    }

    server.config.logger.info(`[hono-dev-proxy] starting bun backend on http://${backendHost}:${backendPort}`);
    try {
      const backendServer = bunRuntime.serve({
        hostname: backendHost,
        port: backendPort,
        fetch: fetchLoadedApp,
        ...(backendBunWebSocketHandler ? { websocket: backendBunWebSocketHandler } : {}),
      });
      backendTarget = `http://${backendHost}:${backendServer.port}`;
      // true 会同时关闭活跃连接，确保 Vite 退出后不残留开发端口。
      stopBackendServer = () => backendServer.stop(true);
      server.config.logger.info(`[hono-dev-proxy] backend ready on ${backendServer.url.toString()}`);
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      throw new Error(`[hono-dev-proxy] failed to start backend on ${backendHost}:${backendPort}: ${normalizedError.message}`);
    }
  };

  /** 按已解析的单一运行时启动后端服务 */
  const startBackendServer = async (server: ViteDevServer): Promise<void> => {
    if (!resolvedRuntime) {
      throw new Error("[hono-dev-proxy] backend runtime must be resolved before server startup.");
    }
    server.config.logger.info(`[hono-dev-proxy] using ${resolvedRuntime} runtime (configured: ${configuredRuntime})`);
    if (resolvedRuntime === "bun") {
      startBunBackendServer(server);
      return;
    }
    await startNodeBackendServer(server);
  };

  return {
    name: "hono-dev-proxy-plugin",
    apply: "serve",
    config(config) {
      if (proxyHosts.size === 0 || config.server?.allowedHosts === true) return;
      // Vite 的 Host 安全检查早于插件中间件；仅放行显式 proxyHosts，避免调用方维护第二份配置。
      return {
        server: {
          allowedHosts: [...(config.server?.allowedHosts ?? []), ...proxyHosts],
        },
      };
    },
    configResolved(config: ResolvedConfig) {
      // 以 Vite root 为基准解析入口，避免 cwd 差异
      entryPath = path.resolve(config.root, options.entry);
      normalizedEntryPath = normalizePath(entryPath);
      backendTarget = `http://${backendHost}:${backendPort}`;
    },
    hotUpdate(options: HotUpdateOptions) {
      if (!isBackendRelatedFile(options.file)) return;

      // client/ssr 两个环境会各触发一次，这里按 timestamp+file+type 去重
      const eventKey = `${options.timestamp}:${normalizePath(options.file)}:${options.type}`;
      if (eventKey !== lastReloadEventKey) {
        lastReloadEventKey = eventKey;
        const reasonType = options.type === "delete" ? "unlink" : options.type;
        enqueueBackendReload(options.server, `${reasonType}: ${toChangedPath(options.server, options.file)}`);
      }

      // 后端文件改动由本插件处理；若该文件同时属于前端模块，保留 client HMR。
      return getClientHotUpdateModules(options.modules);
    },
    async configureServer(server: ViteDevServer) {
      // 必须先验证运行时，再加载可能包含 Bun-only / Node-only 模块的后端依赖图。
      resolvedRuntime = resolveBackendRuntime(configuredRuntime);

      // 通过 Vite 的 SSR 模块加载能力导入后端入口（支持 TS/ESM）
      await loadBackendApp(server, "initial", true);

      await startBackendServer(server);

      const handleWebSocketUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer): void => {
        if (!loadedApp) return;

        const rawPathName = getRequestPathname(req);
        const pathName = stripTrailingSlashEnabled ? stripTrailingSlash(rawPathName) : rawPathName;
        if (getRequestedWebSocketProtocols(req.headers).includes("vite-hmr")) return;
        if (shouldBypassProxy(rawPathName, server.config)) return;
        const proxyDecision = getProxyDecision(loadedApp, appRoutes, "GET", pathName, req.headers, proxyHosts);
        if (!proxyDecision.shouldProxy) return;

        const requestPath = getProxyRequestPath(req, stripTrailingSlashEnabled);
        proxyWebSocketToBackend(
          websocketBridgeServer,
          req,
          socket,
          head,
          backendTarget,
          requestPath,
          req.headers,
          proxyDecision.normalizedHost,
          (error) => {
            server.config.logger.error(`[hono-dev-proxy] websocket proxy error: ${error.message}`);
          },
        );
      };

      server.httpServer?.on("upgrade", handleWebSocketUpgrade);

      // 挂载到 Vite 中间件链：
      // - 路由命中 => 代理到后端
      // - 路由未命中 => next()，继续走 Vite 默认开发流程（静态资源/HMR/SPA fallback）
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: MiddlewareNext) => {
        if (!loadedApp) {
          next();
          return;
        }

        const method = req.method?.toUpperCase() ?? "GET";
        const rawPathName = getRequestPathname(req);
        const pathName = stripTrailingSlashEnabled ? stripTrailingSlash(rawPathName) : rawPathName;
        const requestPath = getProxyRequestPath(req, stripTrailingSlashEnabled);
        if (shouldBypassProxy(rawPathName, server.config)) {
          next();
          return;
        }

        const directMatchedRoutes = collectMatchedRouteKeys(loadedApp.router.match(method, pathName), appRoutes);
        const fallbackMatchedRoutes =
          method === "HEAD" ? collectMatchedRouteKeys(loadedApp.router.match("GET", pathName), appRoutes) : [];
        const proxyDecision = getProxyDecision(loadedApp, appRoutes, method, pathName, req.headers, proxyHosts);

        if (debugEnabled) {
          const matchedRoutesForDebug =
            method === "HEAD"
              ? {
                  direct: directMatchedRoutes,
                  headFallbackGet: fallbackMatchedRoutes,
                }
              : directMatchedRoutes;
          const matchedDebugText =
            method === "HEAD" ? JSON.stringify(matchedRoutesForDebug, null, 2) : JSON.stringify(matchedRoutesForDebug);
          server.config.logger.info(
            `[hono-dev-proxy][debug] request:\n` +
              `  method: ${method}\n` +
              `  path: ${pathName}\n` +
              `  rawPath: ${rawPathName}\n` +
              `  hostname: ${proxyDecision.requestHostname ?? "unavailable"}\n` +
              `  matchedRoutes: ${matchedDebugText}\n` +
              `  proxy: ${proxyDecision.shouldProxy}\n` +
              `  proxyReason: ${proxyDecision.reason ?? "none"}`,
          );
        }

        if (!proxyDecision.shouldProxy) {
          next();
          return;
        }

        proxyToBackend(
          res,
          backendTarget,
          requestPath,
          req.method,
          req.headers,
          req,
          proxyDecision.normalizedHost,
          (error) => {
            server.config.logger.error(`[hono-dev-proxy] proxy error: ${error.message}`);
          },
        );
      });

      // Vite 关闭时回收后端服务，避免端口泄漏
      const closeBackendServer = () => {
        server.httpServer?.off("upgrade", handleWebSocketUpgrade);
        for (const websocketClient of websocketBridgeServer.clients) {
          websocketClient.terminate();
        }
        websocketBridgeServer.close();
        stopBackendServer?.();
        stopBackendServer = undefined;
      };

      server.httpServer?.once("close", closeBackendServer);
    },
  };
}
