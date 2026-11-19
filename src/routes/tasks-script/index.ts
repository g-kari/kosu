/**
 * The /app/tasks inline script, assembled from its sections.
 *
 * Split from a single ~19KB template literal in routes/ui.ts
 * (KAZAMI-345). Concatenation order is the original source
 * order and the assembled string is byte-identical to the
 * former inline script.
 */
import { TASKS_SCRIPT_DETAIL } from "./detail";
import { TASKS_SCRIPT_INIT } from "./init";
import { TASKS_SCRIPT_LIST } from "./list";
import { TASKS_SCRIPT_STATE } from "./state";

export const TASKS_SCRIPT =
  TASKS_SCRIPT_STATE + TASKS_SCRIPT_LIST + TASKS_SCRIPT_DETAIL + TASKS_SCRIPT_INIT;
