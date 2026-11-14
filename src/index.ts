import { Hono } from "hono";

/** Worker bindings (see wrangler.toml). */
export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  APP_ORIGIN?: string;
  OIDC_ISSUER?: string;
  /** Base64-encoded 32-byte key for AES-GCM field encryption (Worker secret). */
  FIELD_ENCRYPTION_KEY?: string;
  SESSION_SECRET?: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) =>
  c.json({
    name: "Kosu",
    service: "kosu",
    status: "ok",
    version: "0.1.0",
  }),
);

app.get("/health", (c) => c.json({ status: "ok" }));

export default app;
