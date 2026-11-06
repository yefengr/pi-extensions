import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ELAPSED_UPDATE_INTERVAL_MS = 1_000;
const MILLISECONDS_PER_SECOND = 1_000;
let nextOperationId = 0;

export interface OperationProgress {
  update(message: string): void;
}

export interface WorktreeProgress {
  run<T>(
    ctx: Pick<ExtensionContext, "mode" | "hasUI" | "ui">,
    message: string,
    task: (progress: OperationProgress) => Promise<T>,
    options?: { signal?: AbortSignal; onUpdate?: (text: string) => void },
  ): Promise<T>;
}

export function createWorktreeProgress(pi: Pick<ExtensionAPI, "on">): WorktreeProgress {
  const active = new Set<() => void>();
  let shutdown = false;
  pi.on("session_shutdown", async () => {
    shutdown = true;
    for (const stop of active) stop();
  });

  return {
    async run(ctx, message, task, options = {}) {
      const key = `worktree:progress:${++nextOperationId}`;
      const startedAt = performance.now();
      let currentMessage = message;
      let stopped = shutdown || options.signal?.aborted === true;
      let timer: ReturnType<typeof setInterval> | undefined;
      // shutdown 后连读取旧上下文的属性都不再需要。
      const ui = !stopped && ctx.hasUI && (ctx.mode === "tui" || ctx.mode === "rpc") ? ctx.ui : undefined;
      const setStatus = ui ? (text: string | undefined) => ui.setStatus(key, text) : undefined;
      const safely = (effect: (() => void) | undefined) => {
        try { effect?.(); } catch { /* 反馈失败不得改变操作结果。 */ }
      };
      const publish = () => {
        if (stopped) return;
        const elapsed = Math.max(0, Math.floor((performance.now() - startedAt) / MILLISECONDS_PER_SECOND));
        const text = `${currentMessage}（已耗时 ${elapsed} 秒）`;
        safely(setStatus ? () => setStatus(text) : undefined);
        safely(options.onUpdate ? () => options.onUpdate?.(text) : undefined);
      };
      const stop = () => {
        if (stopped) return;
        stopped = true;
        if (timer !== undefined) clearInterval(timer);
        options.signal?.removeEventListener("abort", stop);
        active.delete(stop);
        safely(setStatus ? () => setStatus(undefined) : undefined);
      };
      if (!stopped) {
        active.add(stop);
        options.signal?.addEventListener("abort", stop, { once: true });
        publish();
        if (!stopped && (setStatus || options.onUpdate)) {
          timer = setInterval(publish, ELAPSED_UPDATE_INTERVAL_MS);
          timer.unref?.();
        }
      }
      try {
        return await task({ update(nextMessage) { currentMessage = nextMessage; publish(); } });
      } finally {
        stop();
      }
    },
  };
}
