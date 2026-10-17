/**
 * 编辑会话（Editor Session）的核心实现。
 *
 * 设计约束（ADR-0022）：
 * - 脏态只有一个判据：content !== baselineContent
 * - 草稿与磁盘基线（内容 + mtime）由会话持有，冲突只返回结果、不自行裁决
 * - 不直接依赖 CodeMirror 或 Tauri：两个 seam 由调用方注入
 */
import type {
  ConflictChoice,
  ConflictInfo,
  CursorPosition,
  DisposeOptions,
  DocumentStore,
  EditorAdapter,
  EditorSession,
  OpenResult,
  OpenSessionOptions,
  SaveResult,
  ScrollPosition,
  SessionSnapshot,
} from "./types";

const DEFAULT_DRAFT_DEBOUNCE_MS = 2000;

/**
 * 打开（或新建）一个编辑会话。
 *
 * 磁盘读取失败会抛出——由调用方决定如何提示；草稿与磁盘 mtime 不一致时
 * 不抛错，而是通过 `OpenResult.conflict` 返回待裁决信息。
 */
export async function openEditorSession(
  options: OpenSessionOptions
): Promise<{ session: EditorSession; result: OpenResult }> {
  const {
    id,
    path,
    store,
    initialContent = "",
    draftDebounceMs = DEFAULT_DRAFT_DEBOUNCE_MS,
    onChange,
    onDraftError,
  } = options;

  let content = initialContent;
  let baselineContent = "";
  let baselineMtime: number | null = null;
  let pendingConflict: ConflictInfo | null = null;
  let result: OpenResult = { kind: "ready" };

  if (path !== null) {
    baselineMtime = await store.mtime(path);
    const diskContent = await store.readText(path);
    content = diskContent;
    baselineContent = diskContent;

    if (await store.draftExists(path)) {
      const draft = await store.readDraft(path);
      if (draft.knownMtime === baselineMtime) {
        // 草稿基于当前磁盘版本：直接恢复，脏态由内容比较自然得出
        content = draft.content;
      } else {
        // 磁盘已被外部修改：不静默丢弃草稿，交给用户裁决
        pendingConflict = {
          diskContent,
          draftContent: draft.content,
          diskMtime: baselineMtime,
          draftSavedAt: draft.savedAt,
        };
        result = { kind: "conflict", conflict: pendingConflict };
      }
    }
  }

  const session = createSession({
    id,
    path,
    store,
    content,
    baselineContent,
    baselineMtime,
    pendingConflict,
    draftDebounceMs,
    onChange,
    onDraftError,
  });

  return { session, result };
}

interface CreateSessionParams {
  id: string;
  path: string | null;
  store: DocumentStore;
  content: string;
  baselineContent: string;
  baselineMtime: number | null;
  pendingConflict: ConflictInfo | null;
  draftDebounceMs: number;
  onChange?: () => void;
  onDraftError?: (error: unknown) => void;
}

function createSession(params: CreateSessionParams): EditorSession {
  const { id, store, draftDebounceMs, onChange, onDraftError } = params;

  let currentPath = params.path;
  let content = params.content;
  let baselineContent = params.baselineContent;
  let baselineMtime = params.baselineMtime;
  let pendingConflict = params.pendingConflict;
  let cursor: CursorPosition = { line: 1, ch: 0 };
  let scroll: ScrollPosition = { x: 0, y: 0 };
  let disposed = false;

  let draftTimer: ReturnType<typeof setTimeout> | null = null;
  let draftWriteChain: Promise<void> = Promise.resolve();

  let editorState: unknown = null;
  let adapter: EditorAdapter | null = null;
  let unsubscribeSelection: (() => void) | null = null;

  function isDirty(): boolean {
    return content !== baselineContent;
  }

  function notify(): void {
    onChange?.();
  }

  function cancelDraftTimer(): void {
    if (draftTimer !== null) {
      clearTimeout(draftTimer);
      draftTimer = null;
    }
  }

  function scheduleDraft(): void {
    if (disposed || currentPath === null || !isDirty()) return;
    cancelDraftTimer();
    draftTimer = setTimeout(() => {
      draftTimer = null;
      void flushDraft();
    }, draftDebounceMs);
  }

  async function discardDraftIfClean(): Promise<void> {
    // 待裁决冲突期间不得删除草稿：那正是用户还没决定要不要保留的内容
    if (currentPath === null || pendingConflict !== null || isDirty()) return;
    try {
      await store.deleteDraft(currentPath);
    } catch (error) {
      onDraftError?.(error);
    }
  }

  async function draftWriteNow(): Promise<void> {
    if (currentPath === null) return;
    if (!isDirty()) {
      await discardDraftIfClean();
      return;
    }
    try {
      await store.writeDraft(currentPath, content, baselineMtime ?? 0);
    } catch (error) {
      // 草稿写失败不阻断编辑，但要让上层有机会提示
      onDraftError?.(error);
    }
  }

  async function flushDraft(): Promise<void> {
    if (disposed) return;
    cancelDraftTimer();
    draftWriteChain = draftWriteChain.then(draftWriteNow);
    await draftWriteChain;
  }

  function snapshot(): SessionSnapshot {
    return {
      path: currentPath,
      content,
      isDirty: isDirty(),
      baselineMtime,
      cursor: { ...cursor },
      scroll: { ...scroll },
      pendingConflict: pendingConflict ? { ...pendingConflict } : null,
    };
  }

  function setContent(text: string): void {
    if (disposed || text === content) return;
    content = text;
    if (isDirty()) {
      scheduleDraft();
    } else {
      // 内容回到基线：取消待写入的草稿，并清掉已落盘的旧草稿
      cancelDraftTimer();
      void draftWriteChain.then(discardDraftIfClean);
    }
    notify();
  }

  function setScroll(position: ScrollPosition): void {
    if (disposed) return;
    scroll = { ...position };
  }

  async function saveTo(target: string): Promise<SaveResult> {
    if (disposed) {
      return { kind: "failed", error: new Error("session disposed") };
    }
    const previousPath = currentPath;
    try {
      await store.writeText(target, content);
      const mtime = await store.mtime(target);

      currentPath = target;
      baselineContent = content;
      baselineMtime = mtime;
      cancelDraftTimer();
      // 等正在进行的草稿写入结束，否则它可能在删除之后又把草稿写回来
      await draftWriteChain;
      await store.deleteDraft(target);
      if (previousPath !== null && previousPath !== target) {
        await store.deleteDraft(previousPath).catch(() => {});
      }

      notify();
      return { kind: "saved", mtime };
    } catch (error) {
      return { kind: "failed", error };
    }
  }

  async function save(): Promise<SaveResult> {
    if (currentPath === null) {
      return { kind: "failed", error: new Error("untitled session has no path") };
    }
    return saveTo(currentPath);
  }

  async function saveAs(path: string): Promise<SaveResult> {
    return saveTo(path);
  }

  function resolveConflict(choice: ConflictChoice): void {
    if (disposed || pendingConflict === null) return;
    const resolved = pendingConflict;
    pendingConflict = null;

    if (choice === "draft") {
      content = resolved.draftContent;
      scheduleDraft();
    } else {
      content = resolved.diskContent;
      baselineContent = resolved.diskContent;
      if (currentPath !== null) {
        void store.deleteDraft(currentPath).catch(() => {});
      }
    }
    notify();
  }

  function attachEditor(next: EditorAdapter): void {
    if (disposed) return;
    if (adapter !== null) {
      // 重复挂载时先退订旧 adapter，避免监听器泄漏
      detachEditor();
    }
    adapter = next;
    if (editorState !== null) {
      next.setState(editorState);
    } else {
      next.replaceDoc(content);
    }
    unsubscribeSelection = next.onSelectionChange((position) => {
      cursor = position;
    });
  }

  function detachEditor(): void {
    if (adapter === null) return;
    editorState = adapter.getState();
    unsubscribeSelection?.();
    unsubscribeSelection = null;
    adapter = null;
  }

  async function dispose(options: DisposeOptions = {}): Promise<void> {
    if (disposed) return;
    const draftPolicy = options.draft ?? "keep";

    if (draftPolicy === "keep") {
      await flushDraft();
    } else {
      cancelDraftTimer();
      if (currentPath !== null) {
        await store.deleteDraft(currentPath).catch(() => {});
      }
    }

    detachEditor();
    disposed = true;
  }

  return {
    id,
    snapshot,
    setContent,
    setScroll,
    save,
    saveAs,
    resolveConflict,
    flushDraft,
    attachEditor,
    detachEditor,
    dispose,
  };
}
