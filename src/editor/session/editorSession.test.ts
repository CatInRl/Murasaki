import { afterEach, describe, expect, it, vi } from "vitest";
import { openEditorSession } from "./editorSession";
import type {
  CursorPosition,
  DocumentStore,
  DraftSnapshot,
  EditorAdapter,
  ScrollPosition,
} from "./types";

class MemoryStore implements DocumentStore {
  readonly files = new Map<string, { content: string; mtime: number }>();
  readonly drafts = new Map<string, { content: string; knownMtime: number; savedAt: number }>();

  constructor(files: Record<string, { content: string; mtime: number }> = {}) {
    for (const [path, file] of Object.entries(files)) {
      this.files.set(path, { ...file });
    }
  }

  async readText(path: string): Promise<string> {
    const file = this.files.get(path);
    if (!file) throw new Error(`not found: ${path}`);
    return file.content;
  }

  async writeText(path: string, content: string): Promise<void> {
    const previous = this.files.get(path);
    this.files.set(path, { content, mtime: (previous?.mtime ?? 0) + 1 });
  }

  async mtime(path: string): Promise<number> {
    const file = this.files.get(path);
    if (!file) throw new Error(`not found: ${path}`);
    return file.mtime;
  }

  async draftExists(path: string): Promise<boolean> {
    return this.drafts.has(path);
  }

  async readDraft(path: string): Promise<DraftSnapshot> {
    const draft = this.drafts.get(path);
    if (!draft) throw new Error(`no draft: ${path}`);
    return { ...draft };
  }

  async writeDraft(path: string, content: string, knownMtime: number): Promise<void> {
    this.drafts.set(path, { content, knownMtime, savedAt: Date.now() });
  }

  async deleteDraft(path: string): Promise<void> {
    this.drafts.delete(path);
  }
}

function createFakeEditor(initialDoc = "") {
  let doc = initialDoc;
  const listeners = new Set<(position: CursorPosition) => void>();
  const setState = vi.fn((state: unknown) => {
    doc = String(state);
  });

  const adapter: EditorAdapter = {
    mount: vi.fn(),
    destroy: vi.fn(),
    getState: () => doc,
    setState,
    replaceDoc: (text: string) => {
      doc = text;
    },
    setMode: vi.fn(),
    onSelectionChange: (callback: (position: CursorPosition) => void) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
  };

  return {
    adapter,
    setState,
    get doc() {
      return doc;
    },
    emitSelection(position: CursorPosition) {
      listeners.forEach((callback) => callback(position));
    },
    listenerCount: () => listeners.size,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("openEditorSession", () => {
  it("打开磁盘文件时以磁盘内容为基线，且不脏", async () => {
    const store = new MemoryStore({ "/a.md": { content: "hello", mtime: 100 } });
    const { session, result } = await openEditorSession({ id: "t1", path: "/a.md", store });

    expect(result.kind).toBe("ready");
    const snapshot = session.snapshot();
    expect(snapshot.content).toBe("hello");
    expect(snapshot.path).toBe("/a.md");
    expect(snapshot.isDirty).toBe(false);
    expect(snapshot.baselineMtime).toBe(100);
    expect(snapshot.pendingConflict).toBeNull();
  });

  it("草稿基线与磁盘 mtime 一致时恢复草稿内容", async () => {
    const store = new MemoryStore({ "/a.md": { content: "disk", mtime: 100 } });
    store.drafts.set("/a.md", { content: "draft", knownMtime: 100, savedAt: 1 });

    const { session, result } = await openEditorSession({ id: "t1", path: "/a.md", store });

    expect(result.kind).toBe("ready");
    expect(session.snapshot().content).toBe("draft");
    expect(session.snapshot().isDirty).toBe(true);
  });

  it("草稿基线过期时返回冲突，且不删除草稿", async () => {
    const store = new MemoryStore({ "/a.md": { content: "disk", mtime: 200 } });
    store.drafts.set("/a.md", { content: "draft", knownMtime: 100, savedAt: 5 });

    const { session, result } = await openEditorSession({ id: "t1", path: "/a.md", store });

    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") return;
    expect(result.conflict.diskContent).toBe("disk");
    expect(result.conflict.draftContent).toBe("draft");
    expect(session.snapshot().content).toBe("disk");
    expect(session.snapshot().pendingConflict?.draftContent).toBe("draft");
    expect(store.drafts.has("/a.md")).toBe(true);
  });

  it("未裁决冲突时关闭会话仍保留草稿", async () => {
    const store = new MemoryStore({ "/a.md": { content: "disk", mtime: 200 } });
    store.drafts.set("/a.md", { content: "draft", knownMtime: 100, savedAt: 5 });
    const { session } = await openEditorSession({ id: "t1", path: "/a.md", store });

    await session.dispose();

    expect(store.drafts.get("/a.md")?.content).toBe("draft");
  });
});

describe("resolveConflict", () => {
  async function openWithConflict() {
    const store = new MemoryStore({ "/a.md": { content: "disk", mtime: 200 } });
    store.drafts.set("/a.md", { content: "draft", knownMtime: 100, savedAt: 5 });
    const { session } = await openEditorSession({ id: "t1", path: "/a.md", store });
    return { store, session };
  }

  it("选择草稿时采用草稿内容并保持脏", async () => {
    const { store, session } = await openWithConflict();
    session.resolveConflict("draft");

    expect(session.snapshot().content).toBe("draft");
    expect(session.snapshot().isDirty).toBe(true);
    expect(session.snapshot().pendingConflict).toBeNull();
    expect(store.drafts.has("/a.md")).toBe(true);
  });

  it("选择磁盘时回到磁盘内容、清除脏态并删除草稿", async () => {
    const { store, session } = await openWithConflict();
    session.resolveConflict("disk");

    expect(session.snapshot().content).toBe("disk");
    expect(session.snapshot().isDirty).toBe(false);
    expect(store.drafts.has("/a.md")).toBe(false);
  });
});

describe("内容与草稿", () => {
  it("脏态只看内容是否与基线不同", async () => {
    const store = new MemoryStore({ "/a.md": { content: "hello", mtime: 1 } });
    const { session } = await openEditorSession({ id: "t1", path: "/a.md", store });

    session.setContent("hello!");
    expect(session.snapshot().isDirty).toBe(true);

    session.setContent("hello");
    expect(session.snapshot().isDirty).toBe(false);
  });

  it("内容变更后按防抖写入草稿", async () => {
    vi.useFakeTimers();
    const store = new MemoryStore({ "/a.md": { content: "a", mtime: 1 } });
    const { session } = await openEditorSession({
      id: "t1",
      path: "/a.md",
      store,
      draftDebounceMs: 2000,
    });

    session.setContent("ab");
    expect(store.drafts.has("/a.md")).toBe(false);

    await vi.advanceTimersByTimeAsync(1999);
    expect(store.drafts.has("/a.md")).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(store.drafts.get("/a.md")).toEqual({
      content: "ab",
      knownMtime: 1,
      savedAt: expect.any(Number),
    });
  });

  it("内容回到基线时清理已落盘的旧草稿", async () => {
    const store = new MemoryStore({ "/a.md": { content: "a", mtime: 1 } });
    const { session } = await openEditorSession({ id: "t1", path: "/a.md", store });

    session.setContent("ab");
    await session.flushDraft();
    expect(store.drafts.has("/a.md")).toBe(true);

    session.setContent("a");
    await session.flushDraft();
    expect(store.drafts.has("/a.md")).toBe(false);
  });

  it("未命名会话不写草稿", async () => {
    const store = new MemoryStore();
    const { session } = await openEditorSession({ id: "t1", path: null, store });
    session.setContent("untitled");

    await session.flushDraft();

    expect(store.drafts.size).toBe(0);
    expect(session.snapshot().isDirty).toBe(true);
  });

  it("dispose 默认保留草稿", async () => {
    const store = new MemoryStore({ "/a.md": { content: "a", mtime: 1 } });
    const { session } = await openEditorSession({ id: "t1", path: "/a.md", store });
    session.setContent("changed");

    await session.dispose();

    expect(store.drafts.get("/a.md")?.content).toBe("changed");
  });

  it("dispose 明确丢弃时不写草稿并删除已有草稿", async () => {
    const store = new MemoryStore({ "/a.md": { content: "a", mtime: 1 } });
    const { session } = await openEditorSession({ id: "t1", path: "/a.md", store });
    session.setContent("changed");
    await session.flushDraft();
    expect(store.drafts.has("/a.md")).toBe(true);

    await session.dispose({ draft: "discard" });

    expect(store.drafts.has("/a.md")).toBe(false);
  });
});

describe("保存", () => {
  it("保存后更新基线、删除草稿并清除脏态", async () => {
    const store = new MemoryStore({ "/a.md": { content: "a", mtime: 1 } });
    const { session } = await openEditorSession({ id: "t1", path: "/a.md", store });

    session.setContent("saved content");
    await session.flushDraft();
    expect(store.drafts.has("/a.md")).toBe(true);

    const result = await session.save();

    expect(result).toEqual({ kind: "saved", mtime: 2 });
    expect(store.files.get("/a.md")?.content).toBe("saved content");
    expect(session.snapshot().isDirty).toBe(false);
    expect(session.snapshot().baselineMtime).toBe(2);
    expect(store.drafts.has("/a.md")).toBe(false);
  });

  it("另存为切换路径并清理旧路径草稿", async () => {
    const store = new MemoryStore({ "/a.md": { content: "a", mtime: 1 } });
    const { session } = await openEditorSession({ id: "t1", path: "/a.md", store });
    session.setContent("content");
    await session.flushDraft();

    const result = await session.saveAs("/b.md");

    expect(result).toEqual({ kind: "saved", mtime: 1 });
    expect(store.files.get("/b.md")?.content).toBe("content");
    expect(session.snapshot().path).toBe("/b.md");
    expect(store.drafts.has("/a.md")).toBe(false);
  });

  it("未命名会话保存返回失败", async () => {
    const store = new MemoryStore();
    const { session } = await openEditorSession({ id: "t1", path: null, store });

    const result = await session.save();

    expect(result.kind).toBe("failed");
  });
});

describe("rebaseline", () => {
  it("只对齐 mtime 基线，不改内容与脏态", async () => {
    const store = new MemoryStore({ "/a.md": { content: "a", mtime: 1 } });
    const { session } = await openEditorSession({ id: "t1", path: "/a.md", store });
    session.setContent("本地修改");

    session.rebaseline(200);

    const snapshot = session.snapshot();
    expect(snapshot.baselineMtime).toBe(200);
    expect(snapshot.content).toBe("本地修改");
    expect(snapshot.isDirty).toBe(true);
  });

  it("重设基线后，草稿带上的 knownMtime 是新的磁盘 mtime", async () => {
    const store = new MemoryStore({ "/a.md": { content: "a", mtime: 1 } });
    const { session } = await openEditorSession({ id: "t1", path: "/a.md", store });
    session.setContent("本地修改");
    // 「保留本地版本」：磁盘已被外部改动，基线对齐到磁盘当前 mtime
    session.rebaseline(200);

    await session.flushDraft();

    expect(store.drafts.get("/a.md")).toEqual({
      content: "本地修改",
      knownMtime: 200,
      savedAt: expect.any(Number),
    });
  });

  it("dispose 后不再接受重设基线", async () => {
    const store = new MemoryStore({ "/a.md": { content: "a", mtime: 1 } });
    const { session } = await openEditorSession({ id: "t1", path: "/a.md", store });

    await session.dispose();
    session.rebaseline(200);

    expect(session.snapshot().baselineMtime).toBe(1);
  });
});

describe("编辑器 seam", () => {
  it("首次挂载把会话内容写入编辑器，并保存编辑器状态", async () => {
    const store = new MemoryStore({ "/a.md": { content: "hello", mtime: 1 } });
    const { session } = await openEditorSession({ id: "t1", path: "/a.md", store });
    const editor = createFakeEditor();

    session.attachEditor(editor.adapter);
    expect(editor.doc).toBe("hello");

    editor.adapter.replaceDoc("edited in editor");
    session.detachEditor();
    expect(editor.listenerCount()).toBe(0);

    const second = createFakeEditor();
    session.attachEditor(second.adapter);
    expect(second.doc).toBe("edited in editor");
    expect(second.setState).toHaveBeenCalled();
  });

  it("重复挂载不退订旧 adapter 会泄漏监听，这里保证只保留一份", async () => {
    const store = new MemoryStore({ "/a.md": { content: "hello", mtime: 1 } });
    const { session } = await openEditorSession({ id: "t1", path: "/a.md", store });
    const first = createFakeEditor();
    const second = createFakeEditor();

    session.attachEditor(first.adapter);
    session.attachEditor(second.adapter);

    expect(first.listenerCount()).toBe(0);
    expect(second.listenerCount()).toBe(1);
  });

  it("光标变化经 adapter 写回快照", async () => {
    const store = new MemoryStore({ "/a.md": { content: "hello", mtime: 1 } });
    const { session } = await openEditorSession({ id: "t1", path: "/a.md", store });
    const editor = createFakeEditor();

    session.attachEditor(editor.adapter);
    editor.emitSelection({ line: 3, ch: 2 });

    expect(session.snapshot().cursor).toEqual({ line: 3, ch: 2 });
  });

  it("滚动位置由容器上报进快照", async () => {
    const store = new MemoryStore({ "/a.md": { content: "hello", mtime: 1 } });
    const { session } = await openEditorSession({ id: "t1", path: "/a.md", store });
    const scroll: ScrollPosition = { x: 10, y: 240 };

    session.setScroll(scroll);

    expect(session.snapshot().scroll).toEqual(scroll);
  });
});
