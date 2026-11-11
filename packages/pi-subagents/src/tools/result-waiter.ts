import type { Subagent } from "#src/types";

export const DEFAULT_RESULT_WAIT_SECONDS = 60;
export const MAX_RESULT_WAIT_SECONDS = 3600;

/** Ends only the query waiter; execution retains its own signal and budget. */
export async function waitForAgentResult(
  record: Pick<Subagent, "waitUntilSettled">,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;
  const waiter = new AbortController();
  const interrupt = () => waiter.abort();
  signal?.addEventListener("abort", interrupt, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    waiter.abort();
  }, timeoutSeconds * 1000);
  try {
    await record.waitUntilSettled(waiter.signal);
    return timedOut;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", interrupt);
  }
}
