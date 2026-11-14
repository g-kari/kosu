import { Hono } from "hono";
import { ApiError } from "./errors";
import { apiRoutes } from "./routes/api";
import { authRoutes } from "./routes/auth";
import { collabRoutes } from "./routes/collab";
import { pageRoutes } from "./routes/pages";
import { syncRoutes } from "./routes/sync";
import { taskRoutes } from "./routes/tasks";
import type { Env, Variables } from "./types";

export type { Env } from "./types";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get("/", (c) =>
  c.json({
    name: "Kosu",
    service: "kosu",
    status: "ok",
    version: "0.3.0",
  }),
);

app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/", authRoutes);
app.route("/", apiRoutes);
app.route("/", taskRoutes);
app.route("/", syncRoutes);
app.route("/", collabRoutes);
app.route("/", pageRoutes);

app.notFound((c) =>
  c.json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404),
);

app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json(
      { error: { code: err.code, message: err.message } },
      err.status as 400,
    );
  }
  console.error("unhandled error", err);
  return c.json(
    { error: { code: "INTERNAL", message: "Internal server error" } },
    500,
  );
});

export default app;
