import { Hono } from "hono";
import { ApiError } from "./errors";
import { runDeadlineReminders } from "./notify";
import { apiRoutes } from "./routes/api";
import { authRoutes } from "./routes/auth";
import { collabRoutes } from "./routes/collab";
import { opsRoutes } from "./routes/ops";
import { pageRoutes } from "./routes/pages";
import { syncRoutes } from "./routes/sync";
import { taskRoutes } from "./routes/tasks";
import { workRoutes } from "./routes/work";
import type { Env, Variables } from "./types";

export type { Env } from "./types";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get("/", (c) =>
  c.json({
    name: "Kosu",
    service: "kosu",
    status: "ok",
    version: "0.4.0",
  }),
);

app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/", authRoutes);
app.route("/", apiRoutes);
app.route("/", taskRoutes);
app.route("/", syncRoutes);
app.route("/", collabRoutes);
app.route("/", workRoutes);
app.route("/", opsRoutes);
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

/**
 * Cron entry point (hourly): deadline reminders for tasks that are
 * overdue, due today or due tomorrow. Errors are logged, never thrown,
 * so one bad tenant cannot wedge the schedule.
 */
async function scheduled(
  _event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  ctx.waitUntil(
    (async () => {
      try {
        const result = await runDeadlineReminders(env);
        console.log("deadline reminders", JSON.stringify(result));
      } catch (err) {
        console.error("deadline reminders failed", err);
      }
    })(),
  );
}

// The default export stays the Hono app (tests drive it through
// app.request); the scheduled handler is attached alongside fetch so
// the Workers runtime picks it up for Cron triggers.
export default Object.assign(app, { scheduled });
