import { shallowRef, type Ref } from "vue";

export interface PromiseModalState<T, P> {
  visible: boolean;
  /** 展示用 payload（如 fileName/mode），由调用方在 show 时传入 */
  payload: P | null;
  resolver: ((res: T) => void) | null;
}

/**
 * Promise/resolver 模态工具：去重 visible + payload + resolver + show/resolve 样板。
 *
 * P 为展示用 payload（如 fileName/mode），T 为用户选择结果。
 * 调用方在模板上绑定 state.visible 与 state.payload，用户选择后调 resolve(choice)。
 *
 * 使用 shallowRef：state 整体替换（show/resolve 都赋新对象），无需深度响应。
 */
export function usePromiseModal<T, P = void>(): {
  state: Ref<PromiseModalState<T, P>>;
  show: (payload: P) => Promise<T>;
  resolve: (res: T) => void;
} {
  const state = shallowRef<PromiseModalState<T, P>>({
    visible: false,
    payload: null,
    resolver: null,
  });

  function show(payload: P): Promise<T> {
    return new Promise<T>((resolve) => {
      state.value = { visible: true, payload, resolver: resolve };
    });
  }

  function resolve(res: T): void {
    const r = state.value.resolver;
    state.value = { visible: false, payload: null, resolver: null };
    if (r) r(res);
  }

  return { state, show, resolve };
}
