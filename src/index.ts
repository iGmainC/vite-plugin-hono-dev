import type { IncomingMessage, RequestOptions, ServerResponse } from "node:http";
import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";
import { createAdaptorServer, type ServerType } from "@hono/node-server";
import { METHOD_NAME_ALL, type Result } from "hono/router";
import type { RouterRoute } from "hono/types";
import { isMiddleware } from "hono/utils/handler";
import { getPath } from "hono/utils/url";
import { type HotUpdateOptions, normalizePath, type Plugin, type ResolvedConfig, type ViteDevServer } from "vite";

/**
 * 插件入参：
 * - entry: Hono 主入口文件（需导出 app，默认导出或命名导出 app）
 * - port/host: 启动后端 Hono 服务所绑定的地址
 */
export interface HonoDevProxyPluginOptions {
  entry: string;
  port?: number;
  host?: string;
  debug?: boolean;
  stripTrailingSlash?: boolean;
}

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

const DEFAULT_HOST = "localhost";
const DEFAULT_PORT = 8787;
type MiddlewareNext = (error?: unknown) => void;

/** 判断值是否为非 null 对象 */
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

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

const stripTrailingSlash = (pathName: string): string =>
  pathName.length > 1 && pathName.endsWith("/") ? pathName.slice(0, -1) : pathName;

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

const isProxyableRoute = (route: RouterRoute): boolean =>
  !isMiddleware(route.handler as (...args: unknown[]) => unknown);

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
const shouldProxyRequest = (
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
    headers: {
      ...requestHeaders,
      host: targetUrl.host,
      origin: targetOrigin,
    },
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

export default function honoDevProxyPlugin(options: HonoDevProxyPluginOptions): Plugin {
  const backendHost = options.host ?? DEFAULT_HOST;
  const backendPort = options.port ?? DEFAULT_PORT;
  const debugEnabled = options.debug ?? false;
  const stripTrailingSlashEnabled = options.stripTrailingSlash ?? true;

  // 在 configResolved 后会转换为绝对路径
  let entryPath = options.entry;
  let normalizedEntryPath = options.entry;
  let backendBaseDir = "";
  let backendBaseDirPrefix = "";
  let backendTarget = `http://${backendHost}:${backendPort}`;
  let backendServer: ServerType | undefined;
  let loadedApp: HonoLikeApp | undefined;
  // 存储 app.routes 的 method+path 索引，快速做命中校验
  let appRoutes = new Set<string>();
  // 将热更新串行化，避免短时间内多次改动触发并发加载
  let reloadQueue = Promise.resolve();
  // 同一文件改动会在 client/ssr 环境各触发一次 hotUpdate，这里用于去重
  let lastReloadEventKey = "";

  /** 判断改动文件是否属于后端入口目录 */
  const isBackendRelatedFile = (filePath: string): boolean => {
    const normalizedFilePath = normalizePath(filePath);
    return normalizedFilePath === normalizedEntryPath || normalizedFilePath.startsWith(backendBaseDirPrefix);
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
      const proxyableRoutes = nextApp.routes.filter(isProxyableRoute);
      appRoutes = new Set(proxyableRoutes.map(getRouteKey));

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

  return {
    name: "hono-dev-proxy-plugin",
    apply: "serve",
    configResolved(config: ResolvedConfig) {
      // 以 Vite root 为基准解析入口，避免 cwd 差异
      entryPath = path.resolve(config.root, options.entry);
      normalizedEntryPath = normalizePath(entryPath);
      backendBaseDir = normalizePath(path.dirname(entryPath));
      backendBaseDirPrefix = backendBaseDir.endsWith("/") ? backendBaseDir : `${backendBaseDir}/`;
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

      // 后端文件改动由本插件处理，阻止 Vite 默认 page reload / hmr 广播
      return [];
    },
    async configureServer(server: ViteDevServer) {
      // 通过 Vite 的 SSR 模块加载能力导入后端入口（支持 TS/ESM）
      await loadBackendApp(server, "initial", true);

      // 启动独立 Hono Node 服务，供命中路由时代理转发
      backendServer = createAdaptorServer({
        // 使用委托函数读取最新 loadedApp，从而支持后端热重载
        fetch: (request, ...args) => {
          if (!loadedApp) {
            return new Response("Hono backend is not ready.", { status: 503 });
          }
          return loadedApp.fetch(request, ...args);
        },
        hostname: backendHost,
        port: backendPort,
      });

      server.config.logger.info(`[hono-dev-proxy] starting backend on http://${backendHost}:${backendPort}`);

      backendServer.once("listening", () => {
        const address = backendServer?.address();
        if (address && typeof address === "object") {
          server.config.logger.info(`[hono-dev-proxy] backend ready on http://${address.address}:${address.port}`);
          return;
        }
        server.config.logger.info(`[hono-dev-proxy] backend ready on http://${backendHost}:${backendPort}`);
      });

      backendServer.on("error", (error) => {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        server.config.logger.error(`[hono-dev-proxy] backend error: ${normalizedError.message}`);
      });
      backendServer.listen(backendPort, backendHost);

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
        const directMatchedRoutes = collectMatchedRouteKeys(loadedApp.router.match(method, pathName), appRoutes);
        const fallbackMatchedRoutes =
          method === "HEAD" ? collectMatchedRouteKeys(loadedApp.router.match("GET", pathName), appRoutes) : [];
        const shouldProxy = shouldProxyRequest(loadedApp, appRoutes, method, pathName);

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
              `  matchedRoutes: ${matchedDebugText}\n` +
              `  proxy: ${shouldProxy}`,
          );
        }

        if (!shouldProxy) {
          next();
          return;
        }

        proxyToBackend(res, backendTarget, requestPath, req.method, req.headers, req, (error) => {
          server.config.logger.error(`[hono-dev-proxy] proxy error: ${error.message}`);
        });
      });

      // Vite 关闭时回收后端服务，避免端口泄漏
      const closeBackendServer = () => {
        if (backendServer) {
          backendServer.close();
          backendServer = undefined;
        }
      };

      server.httpServer?.once("close", closeBackendServer);
    },
  };
}