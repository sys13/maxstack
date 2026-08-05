import { Hono } from "hono";

export const app = new Hono();

app.get("/", (c) => c.json({ name: "{{PROJECT_NAME}}", status: "ok" }));

app.get("/health", (c) => c.json({ status: "healthy" }));
