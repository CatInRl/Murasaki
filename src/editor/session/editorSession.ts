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
    cursor,
    scroll,
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
    cursor,
    scroll,
    onChange,
    onDraftError,
  });

  return { session, result };
}

/**
 * 同步创建一个「未命名」会话（无磁盘路径、无草稿）。
 *
 * 调用方（如新建标签）是同步入口，不值得为它引入 await；
 * 未命名会话没有磁盘基线（基线为空串），脏态由内容比较自然得出。
 *
 * **必须传 store**：会话虽然还没有路径，但「另存为」要立刻写盘并取 mtime
 *（`saveTo` 的第一步就是 `store.writeText`）。早先这里传 `null`，导致未命名 tab
 * 的另存为必定失败、弹出「另存为失败」—— 因为没有路径，代码里的草稿/读取分支
 * 都不会用到 store，所以那个 `null` 一路没人发现，直到用户真的去保存新文件。
 * 没有路径时 `scheduleDraft` / `flushDraft` 都已按 `currentPath === null` 早退，
 * 因此传入 store 不会产生任何草稿写入。
 */
export function createUntitledSession(
  id: string,
  store: DocumentStore,
  initialContent = "",
  hooks: Pick<OpenSessionOptions, "onChange" | "onDraftError"> = {}
): EditorSession {
  return createSession({
    id,
    path: null,
    store,
    content: initialContent,
    baselineContent: "",
    baselineMtime: null,
    pendingConflict: null,
    draftDebounceMs: DEFAULT_DRAFT_DEBOUNCE_MS,
    onChange: hooks.onChange,
    onDraftError: hooks.onDraftError,
  });
}

interface CreateSessionParams {
  id: string;
  path: string | null;
  /**
   * 磁盘能力。未命名会话也要传真实 store —— 「另存为」要用它写盘并取 mtime。
   * 允许为 null 只是为了保留「会话完全没有磁盘能力」这一防御性分支（见 `saveTo`）。
   */
  store: DocumentStore | null;
  content: string;
  baselineContent: string;
  baselineMtime: number | null;
  pendingConflict: ConflictInfo | null;
  draftDebounceMs: number;
  /** 恢复上次会话时的光标位置（跨重启恢复） */
  cursor?: CursorPosition;
  /** 恢复上次会话时的滚动位置（跨重启恢复） */
  scroll?: ScrollPosition;
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
  let cursor: CursorPosition = params.cursor ?? { line: 1, ch: 0 };
  let scroll: ScrollPosition = params.scroll ?? { x: 0, y: 0 };
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
    if (store === null || currentPath === null || pendingConflict !== null || isDirty()) return;
    try {
      await store.deleteDraft(currentPath);
    } catch (error) {
      onDraftError?.(error);
    }
  }

  async function draftWriteNow(): Promise<void> {
    if (store === null || currentPath === null) return;
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

  function setCursor(position: CursorPosition): void {
    if (disposed) return;
    cursor = { ...position };
  }

  async function saveTo(target: string): Promise<SaveResult> {
    if (disposed) {
      return { kind: "failed", error: new Error("session disposed") };
    }
    if (store === null) {
      return { kind: "failed", error: new Error("session has no document store") };
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
      if (store !== null && currentPath !== null) {
        void store.deleteDraft(currentPath).catch(() => {});
      }
    }
    notify();
  }

  /**
   * 只对齐 mtime 基线（「保留本地版本」）：内容与脏态不变，
   * 但后续草稿写入带上新的 knownMtime，下次打开不会被判为过期草稿。
   */
  function rebaseline(mtime: number): void {
    if (disposed) return;
    baselineMtime = mtime;
  }

  /**
   * 路径迁移（应用内重命名/移动）：草稿以路径为键，键变了后续草稿写入
   * 必须落到新键下。旧键草稿由调用方删除。
   */
  function renamePath(path: string): void {
    if (disposed) return;
    currentPath = path;
  }

  /**
   * 以磁盘内容重设基线（重新加载 / 用户选「加载磁盘版本」）。
   *
   * `disk` 由调用方在已知时传入（它刚为弹窗读过盘），省一次重复 IO；
   * 未传则自己读。
   *
   * **不删草稿**：#378 的兜底语义是「本地内容被覆盖前先留一份草稿，
   * 让用户事后仍能找回」。删草稿由调用方显式决定（reloadFromDisk 是
   * 用户主动丢弃，删；load-disk 弹窗路径留）。
   */
  async function reloadBaseline(disk?: { content: string; mtime: number }): Promise<void> {
    if (disposed || store === null || currentPath === null) {
      throw new Error("cannot reload baseline: session has no document");
    }
    const nextContent = disk?.content ?? (await store.readText(currentPath));
    const mtime = disk?.mtime ?? (await store.mtime(currentPath));
    content = nextContent;
    baselineContent = nextContent;
    baselineMtime = mtime;
    pendingConflict = null;
    cancelDraftTimer();
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
      if (store !== null && currentPath !== null) {
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
    setCursor,
    save,
    saveAs,
    resolveConflict,
    flushDraft,
    rebaseline,
    renamePath,
    reloadBaseline,
    attachEditor,
    detachEditor,
    dispose,
  };
}
