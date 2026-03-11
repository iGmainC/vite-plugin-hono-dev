import { Hono } from "hono";

const app = new Hono();

app.get("/api/ping", (c) => c.json({ ok: true, source: "hono-backend" }));

export default app;
