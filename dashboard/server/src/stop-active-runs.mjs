// Graceful-shutdown helper: ask EVERY in-flight run to stop so each can record
// its terminal state before the db closes, then wait (bounded) for all to settle.
// With no active runs the loop is empty and idle() resolves immediately.
export async function stopActiveRuns(runManager, timeoutMs) {
  for (const id of runManager.activeRunIds()) runManager.stop(id);
  let timer;
  await Promise.race([
    runManager.idle(),
    new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
}
