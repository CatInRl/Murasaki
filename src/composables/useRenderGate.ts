/**
 * 预览渲染节流门（#431）。
 *
 * 预览的重渲染包含同步 markdown-it + DOMPurify，以及串行的 Shiki / Mermaid /
 * PlantUML 异步渲染。快速输入时若每次变更都立即全量重渲染：
 * - 主线程被同步渲染反复阻塞；
 * - 多个渲染并发，旧渲染仍在为已被覆盖的 DOM 做无用功。
 *
 * 该门提供两件事：
 * - **防抖**：窗口内的连续变更合并成一次渲染；
 * - **代际**：每次调度都让在途渲染立即过期，渲染任务通过 `isStale()` 在
 *   每个 await 之后自检，过期就放弃后续 DOM 操作。
 */

export interface RenderGateOptions {
  /** 防抖窗口（ms） */
  debounceMs: number;
  /** 执行一次渲染；`isStale()` 为 true 时表示已有更新调度，应尽快返回 */
  run: (isStale: () => boolean) => Promise<void>;
  /** 首次调度立即执行（避免挂载后空白一个防抖窗口） */
  immediateFirst?: boolean;
}

export interface RenderGate {
  /** 调度一次渲染（窗口内多次调用合并为一次） */
  schedule(): void;
  /** 取消排队中的渲染，并让在途渲染过期（卸载时调用） */
  cancel(): void;
}

export function createRenderGate({
  debounceMs,
  run,
  immediateFirst = false,
}: RenderGateOptions): RenderGate {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let started = false;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function schedule(): void {
    const current = ++generation;
    const isStale = (): boolean => current !== generation;
    const runNow = immediateFirst && !started;
    started = true;

    clearTimer();
    if (runNow) {
      void run(isStale);
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      void run(isStale);
    }, debounceMs);
  }

  function cancel(): void {
    // 递增代际：在途渲染在下一次自检时放弃
    generation++;
    clearTimer();
  }

  return { schedule, cancel };
}
