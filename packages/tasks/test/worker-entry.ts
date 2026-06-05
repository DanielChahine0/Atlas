// Test-only Worker entry for @cloudflare/vitest-pool-workers. @atlas/tasks is a
// data-access package, not a deployed Worker — the store tests call its functions
// directly with the `cloudflare:test` D1 binding. The pool still requires a `main`
// entry, so this is a deliberate no-op fetch handler used by no test.
export default {
  fetch(): Response {
    return new Response("atlas-tasks test harness", { status: 200 });
  },
} satisfies ExportedHandler;
