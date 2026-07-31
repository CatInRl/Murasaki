import { describe, it, expect } from "vitest";
import { usePromiseModal } from "./usePromiseModal";

describe("usePromiseModal", () => {
  it("初始状态为不可见且无 payload/resolver", () => {
    const { state } = usePromiseModal<string, string>();
    expect(state.value.visible).toBe(false);
    expect(state.value.payload).toBeNull();
    expect(state.value.resolver).toBeNull();
  });

  it("show 设置 visible+payload 并返回未决 Promise", () => {
    const { state, show } = usePromiseModal<"save" | "cancel", string>();
    const p = show("readme.md");
    expect(state.value.visible).toBe(true);
    expect(state.value.payload).toBe("readme.md");
    expect(state.value.resolver).not.toBeNull();
    // Promise 仍未决
    let resolved = false;
    void p.then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
  });

  it("resolve 传递结果给 await 方并清空状态", async () => {
    const { state, show, resolve } = usePromiseModal<
      "save" | "dont-save" | "cancel",
      string
    >();
    const p = show("notes.md");
    resolve("save");
    expect(await p).toBe("save");
    expect(state.value.visible).toBe(false);
    expect(state.value.payload).toBeNull();
    expect(state.value.resolver).toBeNull();
  });

  it("resolve 在无 resolver 时安全无操作", () => {
    const { resolve } = usePromiseModal<string, void>();
    expect(() => resolve("x")).not.toThrow();
  });

  it("支持无 payload 的模态 (P=void)", async () => {
    const { state, show, resolve } = usePromiseModal<"ok" | "cancel", void>();
    const p = show(undefined as void);
    expect(state.value.visible).toBe(true);
    resolve("ok");
    expect(await p).toBe("ok");
  });

  it("支持对象 payload (如 fileName + mode)", async () => {
    type Payload = { fileName: string; mode: "merged" | "simple" };
    const { state, show, resolve } = usePromiseModal<
      "save" | "close" | "cancel",
      Payload
    >();
    const p = show({ fileName: "draft.md", mode: "merged" });
    expect(state.value.payload).toEqual({
      fileName: "draft.md",
      mode: "merged",
    });
    resolve("close");
    expect(await p).toBe("close");
    expect(state.value.payload).toBeNull();
  });

  it("连续 show+resolve 不串状态", async () => {
    const { show, resolve } = usePromiseModal<string, string>();
    const p1 = show("a.md");
    resolve("save");
    expect(await p1).toBe("save");

    const p2 = show("b.md");
    resolve("dont-save");
    expect(await p2).toBe("dont-save");
  });
});
