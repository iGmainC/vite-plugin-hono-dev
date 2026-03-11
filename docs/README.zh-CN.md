# @igmainc/vite-plugin-hono-dev

[![CI](https://github.com/iGmainC/vite-plugin-hono-dev/actions/workflows/ci.yml/badge.svg)](https://github.com/iGmainC/vite-plugin-hono-dev/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40igmainc%2Fvite-plugin-hono-dev)](https://www.npmjs.com/package/@igmainc/vite-plugin-hono-dev)
[![license](https://img.shields.io/npm/l/%40igmainc%2Fvite-plugin-hono-dev)](../LICENSE)

[English](../README.md) | 简体中文

一个用于 Vite 开发阶段的插件：在请求命中 Hono 路由时，动态反向代理到独立 Hono 后端。

## 简介

- 面向“双服务双端口”开发模式：Vite 前端和 Hono 后端分别运行。
- 在 Vite 中间件层动态判断请求是否命中 Hono 路由，命中才代理到后端。
- 不依赖静态 `server.proxy` 路由表。

## 灵感来源

这个插件的设计灵感来自 Cloudflare Workers 的 React 模板，也就是基于 `@cloudflare/vite-plugin` 的那套开发体验。

两者的共同点，是都试图把“服务端运行时”接入到 Vite 的开发链路里：前端继续享受 Vite 的 HMR 和中间件能力，服务端逻辑也能在同一套 dev server 流程里参与请求处理。不同点在于，`@cloudflare/vite-plugin` 面向的是 Cloudflare Workers / workerd 运行时，而本项目面向的是本地独立运行的 Hono Node 服务。

## 特性

- 动态路由命中代理（`router.match` + `app.routes` 交叉校验）。
- 后端入口热重载（无需重启 Vite）。
- 支持 `HEAD -> GET` 匹配回退。
- 仅在 `vite dev` 生效（`apply: "serve"`）。

## 安装

```bash
bun add -d @igmainc/vite-plugin-hono-dev
```

或

```bash
npm i -D @igmainc/vite-plugin-hono-dev
```

## 快速使用

```ts
// vite.config.ts
import { defineConfig } from "vite";
import honoDevProxyPlugin from "@igmainc/vite-plugin-hono-dev";

export default defineConfig({
  plugins: [
    honoDevProxyPlugin({
      entry: "../backend/src/server.ts",
      host: "127.0.0.1",
      port: 8787,
    }),
  ],
});
```

后端入口必须导出 Hono app：`default` 导出或命名导出 `app`。

## 配置项

```ts
type HonoDevProxyPluginOptions = {
  entry: string;
  port?: number; // 默认 8787
  host?: string; // 默认 "localhost"
};
```

## 工作原理

先看 `@cloudflare/vite-plugin` 的思路，再看本插件借鉴了什么。

### `@cloudflare/vite-plugin` 的工作方式

`@cloudflare/vite-plugin` 不是简单给 Vite 加一层静态代理。它更像是把 Cloudflare Workers 的本地运行时接进了 Vite 的开发过程。

1. 它基于 Vite 的 Environment API，为 Worker 代码建立一个专门的开发环境，而不是只把 Worker 当成普通前端模块处理。
2. 开发时，插件会把需要进入 Worker 的请求导向本地 Workers 运行时，让请求真正经过 Worker 的 `fetch()` 逻辑，而不是仅仅转发到另一个手写端口。
3. 这个本地运行时通常依赖 Miniflare / workerd 来模拟 Cloudflare Workers 平台能力，所以模板里的 SSR、API、静态资源协作看起来像“一个全栈 dev server”。
4. 构建和部署阶段，它会继续和 Wrangler 的配置体系配合，把 Worker 入口、前端构建产物以及平台配置组织起来；在当前仓库公开实现里，可以看到它会生成或协调 `wrangler.json` 一类的中间配置，让 `wrangler` 继续负责预览、部署和平台侧能力接入。
5. Cloudflare 的 React 模板之所以体验流畅，本质上是前端 HMR、Worker 请求处理、平台运行时模拟被整合进了同一套 Vite 开发链路。

### 本插件如何借鉴并简化这套思路

本项目借鉴的是“让服务端逻辑接入 Vite dev server”的开发模型，但没有复刻 Cloudflare 的 Worker 运行时集成。

1. Vite 启动时，插件通过 `ssrLoadModule` 加载 Hono 后端入口，因此后端代码可以直接用 Vite 的 SSR loader 处理 TS / ESM。
2. 在 `configureServer` 阶段，插件使用 `@hono/node-server` 启动一个独立的本地 Hono 服务，并把实际请求处理委托给当前加载的 Hono app。
3. 对每个进入 Vite 的请求，插件先用 `app.router.match()` 和 `app.routes` 做交叉校验，只在真正命中 Hono 路由时才反向代理到后端。
4. 后端相关文件变更时，插件在 `hotUpdate` 中重新加载入口模块，更新内存中的 Hono app 和路由索引，从而做到“不重启 Vite 也能刷新后端逻辑”。
5. 没有命中 Hono 路由的请求会继续留在 Vite 默认流程里，仍然由静态资源服务、HMR 和 SPA fallback 处理。

所以，这个插件并不是 `@cloudflare/vite-plugin` 的等价替代品，而是借鉴了它的开发模型：让前端 dev server 和服务端运行时协同工作，再根据 Hono + Node 的场景做了更轻量的实现。

## 示例一：Node API 双端口

```bash
cd examples/node-api
bun install
bun run dev
```

访问：
- `http://localhost:5173/`（Vite 页面）
- `http://localhost:5173/api/ping`（命中后动态代理到后端）

## 示例二：SSR 路由命中代理

```bash
cd examples/ssr-route-hit
bun install
bun run dev
```

访问：
- `http://localhost:5173/ssr`（由 Hono 后端返回 HTML）
- `http://localhost:5173/api/user/42`（由 Hono 后端返回 JSON）

## 限制与注意事项

- 仅用于开发期，不参与生产构建。
- 后端入口需可被 Vite SSR loader 正常加载。
- 正式发布请使用 `bun run build`（tsup）。`build:bun` 仅用于备用验证。

## 发布流程

```bash
bun install
bun run typecheck
bun run build
bun run test:smoke
npm login
npm publish --access public
```

GitHub Actions 模板：
- CI：`.github/workflows/ci.yml`
- 手动发布模板：`.github/workflows/release-manual-template.yml`（需配置 `NPM_TOKEN`）

## 后续接入指引

```bash
bun add -d @igmainc/vite-plugin-hono-dev
```

```ts
import honoDevProxyPlugin from "@igmainc/vite-plugin-hono-dev";
```

## 许可证

MIT
