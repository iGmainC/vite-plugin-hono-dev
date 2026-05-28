# @igmainc/vite-plugin-hono-dev

[![CI](https://github.com/iGmainC/vite-plugin-hono-dev/actions/workflows/ci.yml/badge.svg)](https://github.com/iGmainC/vite-plugin-hono-dev/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40igmainc%2Fvite-plugin-hono-dev)](https://www.npmjs.com/package/@igmainc/vite-plugin-hono-dev)
[![license](https://img.shields.io/npm/l/%40igmainc%2Fvite-plugin-hono-dev)](./LICENSE)

English | [简体中文](./docs/README.zh-CN.md)

A Vite plugin that dynamically reverse-proxies matched requests to a standalone Hono backend during development.

## Overview

- This plugin targets dual-service, dual-port development: Vite frontend and standalone Hono backend.
- It dynamically checks whether a request matches Hono routes and proxies only matched requests.
- It avoids maintaining a static `server.proxy` map.

## Inspiration

This plugin is inspired by the React template for Cloudflare Workers, specifically the development model built around `@cloudflare/vite-plugin`.

The shared idea is to plug a server-side runtime into Vite's dev pipeline so frontend HMR and server-side request handling can coexist in one development flow. The difference is that `@cloudflare/vite-plugin` targets the Cloudflare Workers / workerd runtime, while this project targets a standalone local Hono server running on Node.

## Features

- Dynamic route-aware proxying (`router.match` + `app.routes` intersection).
- Hot-reload backend entry and its SSR dependency graph without restarting Vite.
- Supports `HEAD -> GET` matching fallback.
- Preserves browser request semantics such as `Origin` while adding `X-Forwarded-*` proxy headers.
- Supports prefixed Hono middleware routes such as `/api/*` without letting global middleware-only routes take over Vite fallback.
- Proxies matched WebSocket upgrade requests when the backend entry exports an `injectWebSocket(server)` adapter hook.
- Keeps Vite internal modules and existing Vite-served files out of Hono catch-all proxying.
- Applies only in `vite dev` (`apply: "serve"`).

## Install

```bash
bun add -d @igmainc/vite-plugin-hono-dev
```

or

```bash
npm i -D @igmainc/vite-plugin-hono-dev
```

Supported Vite versions: `^6.0.0 || ^7.0.0 || ^8.0.0`.

## Quick Start

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

The backend entry must export a Hono app via `default` export or named export `app`. For WebSocket routes, the entry may also export `injectWebSocket(server)`, for example from `@hono/node-ws`, so the plugin can bind the WebSocket adapter to the backend Node server.

## Options

```ts
type HonoDevProxyPluginOptions = {
  entry: string;
  port?: number; // default: 8787
  host?: string; // default: "localhost"
  debug?: boolean; // default: false
  stripTrailingSlash?: boolean; // default: false
};
```

By default, request paths keep their original trailing slash semantics so Hono route matching stays strict. Set `stripTrailingSlash: true` only when you intentionally want the older trailing-slash normalization behavior.

## How It Works

It helps to look at `@cloudflare/vite-plugin` first, then at what this plugin borrows from it.

### How `@cloudflare/vite-plugin` works

`@cloudflare/vite-plugin` is more than a static proxy layer in front of Vite. It effectively brings the Cloudflare Workers runtime into the local Vite development loop.

1. It uses Vite's Environment API to create a dedicated development environment for Worker code instead of treating Worker entrypoints as plain frontend modules.
2. During development, requests that should hit the Worker are routed into a local Workers runtime so they execute the Worker's `fetch()` path directly.
3. That local runtime is powered by Miniflare / workerd, which is why the React template can feel like a single full-stack dev server rather than a frontend server talking to an unrelated backend.
4. For build and deploy workflows, it still cooperates with Wrangler's configuration model, organizing Worker entrypoints, frontend output, and platform configuration together. In the public repository implementation, this includes generating or coordinating intermediate `wrangler.json`-style config so `wrangler` remains responsible for preview, deployment, and platform integration.
5. The smooth full-stack feel comes from putting frontend HMR, Worker request handling, and local platform simulation into one Vite-driven workflow.

### How this plugin borrows that model

This project borrows the idea of integrating server-side logic into the Vite dev server, but it does not attempt to replicate the Cloudflare Workers runtime integration.

1. On startup, it loads the Hono backend entry with `ssrLoadModule`, so the backend can be resolved through Vite's SSR loader.
2. Inside `configureServer`, it starts a standalone local Hono server with `@hono/node-server` and delegates request handling to the currently loaded Hono app.
3. The backend server startup is awaited during Vite startup. If the configured backend host/port is unavailable, Vite startup fails instead of silently proxying to the wrong service.
4. For each incoming Vite request, it first lets Vite internal modules and existing Vite-served files continue through Vite, then checks `app.router.match()` and cross-validates the result against `app.routes`, proxying only real Hono route hits to the backend. Prefixed middleware routes can be proxied, while global middleware-only routes are not used as the sole proxy signal.
5. When backend SSR dependency files change, it reloads the entry module in `hotUpdate`, replacing the in-memory app and route index without restarting Vite.
6. Proxied requests preserve the original `Origin` header and add `X-Forwarded-Host`, `X-Forwarded-Proto`, and `X-Forwarded-For` so the backend can distinguish browser origin from proxy target.
7. Matched WebSocket upgrade requests are proxied to the backend server, while Vite's own HMR WebSocket remains in Vite's pipeline.
8. Requests that do not match Hono routes stay in Vite's normal pipeline and continue through static asset serving, HMR, and SPA fallback.

So this package should be read as inspired by `@cloudflare/vite-plugin` and borrowing its development model, not as a drop-in equivalent.

## Example 1: Node API Dual-Port

```bash
cd examples/node-api
bun install
bun run dev
```

Visit:
- `http://localhost:5173/` (Vite page)
- `http://localhost:5173/api/ping` (route hit and proxied to backend)

## Example 2: SSR Route-Aware Proxy

```bash
cd examples/ssr-route-hit
bun install
bun run dev
```

Visit:
- `http://localhost:5173/ssr` (HTML from Hono backend)
- `http://localhost:5173/api/user/42` (JSON from Hono backend)

## Example Project

This plugin is also used in [`node-fullstack-template`](https://github.com/iGmainC/node-fullstack-template), a full-stack starter built with `Bun + Vite + React + Hono + tRPC + Prisma`.

In that template, `bun run dev` starts the frontend Vite dev server while this plugin loads `apps/backend/server.ts`, starts the local Hono backend on `http://localhost:8787`, proxies requests based on registered Hono routes, and hot-reloads backend changes without a manual restart.

If you want a reference integration beyond the small examples in this repository, that template shows how to use this plugin in a real workspace with separate frontend/backend apps and shared packages.

## Limitations

- Dev-only plugin, not used in production build.
- Supports Vite 6, 7, and 8. Vite 5 is not supported because this plugin relies on Vite's Environment API and `hotUpdate` module metadata.
- Backend entry must be loadable via Vite SSR module loader.
- WebSocket adapter injection is bound when the backend server starts; restart `vite dev` after changing the adapter wiring itself.
- For release artifacts, use `bun run build` (tsup). `build:bun` is fallback-only.

## Publish

```bash
bun install
bun run typecheck
bun run build
bun run test:smoke
npm login
npm publish --access public
```

GitHub Actions templates:
- CI: `.github/workflows/ci.yml`
- Manual release template: `.github/workflows/release-manual-template.yml` (requires `NPM_TOKEN`)

## Future Integration Guide

```bash
bun add -d @igmainc/vite-plugin-hono-dev
```

```ts
import honoDevProxyPlugin from "@igmainc/vite-plugin-hono-dev";
```

## License

MIT
