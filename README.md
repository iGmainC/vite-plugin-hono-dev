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
- Hot-reload backend entry without restarting Vite.
- Supports `HEAD -> GET` matching fallback.
- Applies only in `vite dev` (`apply: "serve"`).

## Install

```bash
bun add -d @igmainc/vite-plugin-hono-dev
```

or

```bash
npm i -D @igmainc/vite-plugin-hono-dev
```

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

The backend entry must export a Hono app via `default` export or named export `app`.

## Options

```ts
type HonoDevProxyPluginOptions = {
  entry: string;
  port?: number; // default: 8787
  host?: string; // default: "localhost"
};
```

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
3. For each incoming Vite request, it checks `app.router.match()` and cross-validates the result against `app.routes`, proxying only real Hono route hits to the backend.
4. When backend-related files change, it reloads the entry module in `hotUpdate`, replacing the in-memory app and route index without restarting Vite.
5. Requests that do not match Hono routes stay in Vite's normal pipeline and continue through static asset serving, HMR, and SPA fallback.

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

## Limitations

- Dev-only plugin, not used in production build.
- Backend entry must be loadable via Vite SSR module loader.
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
