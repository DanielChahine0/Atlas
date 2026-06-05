// @atlas/tasks — the thin D1 data-access surface for the tasks/subtasks system-of-record.
// Storage + dedupe only (no extraction/LLM logic, no Wire emit). Forge writes via
// upsertTask; Sundial reads readOpenDeadlineTasks; Compass reads readOpenTasks.
export { normalizeTitle, dedupeKey } from "./dedupe.js";
export {
  upsertTask,
  readOpenDeadlineTasks,
  readOpenTasks,
} from "./store.js";
export type {
  TaskInput,
  SubtaskInput,
  TaskRow,
  UpsertAction,
} from "./store.js";
