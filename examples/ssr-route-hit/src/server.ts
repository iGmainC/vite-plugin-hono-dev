import { Hono } from "hono";

const app = new Hono();

app.get("/ssr", (c) => {
  const html = `<!doctype html><html><body><h1>SSR from Hono backend</h1></body></html>`;
  return c.html(html);
});

app.get("/api/user/:id", (c) => {
  return c.json({ id: c.req.param("id"), from: "hono-backend" });
});

export default app;
