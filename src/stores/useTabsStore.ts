import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { Tab, PersistedTab } from "../types";
import { usePersistenceStore } from "./usePersistenceStore";
import { useToastStore } from "./useToastStore";
import { fileSystem } from "../services/fileSystem";
import { basename, isPathUnder, isSamePath, normalizePath } from "../utils/path";
import { i18n } from "../i18n";
import { createDocumentStore } from "../editor/session/documentStore";
import { createUntitledSession, openEditorSession } from "../editor/session/editorSession";
import type { DocumentStore, EditorSession, SessionSnapshot } from "../editor/session/types";

/**
 * 标签页 Store
 * - 管理多 Tab 的打开/关闭/切换
 * - 每个 tab 持有一个编辑会话（EditorSession，ADR-0022）：脏态、草稿、磁盘基线的唯一真相
 * - 本 store 只保留「身份 / 顺序 / 激活态」，内容一律从会话快照派生
 * - 启动恢复：从 tabs.json 读取上次状态，结合草稿恢复内容
 */
export type DraftConflictChoice = "keep-draft" | "load-disk" | "cancel";

export interface DraftConflictInfo {
  path: string;
  diskContent: string;
  draftContent: string;
  /** 磁盘版本的最后修改时间（毫秒） */
  diskMtime: number;
  /** 草稿保存时间（毫秒） */
  draftSavedAt: number;
}

/**
 * 草稿与磁盘 mtime 不一致时的裁决入口（#425）。
 * 由 App.vue 注入弹窗实现；未注入时不替用户做决定：加载磁盘内容并保留草稿文件。
 */
type DraftConflictResolver = (info: DraftConflictInfo) => Promise<DraftConflictChoice>;

export const useTabsStore = defineStore("tabs", () => {
  const toast = useToastStore();
  /** 文案翻译（用户可见文本必须走 i18n，禁止硬编码） */
  const t = i18n.global.t.bind(i18n.global);

  let draftConflictResolver: DraftConflictResolver | null = null;

  /** 注入草稿冲突裁决器（App.vue 在启动时调用） */
  function setDraftConflictResolver(resolver: DraftConflictResolver | null): void {
    draftConflictResolver = resolver;
  }

  // ===== State =====
  /** 标签页列表 */
  const tabs = ref<Tab[]>([]);
  /** 当前激活的 tab id */
  const activeTabId = ref<string | null>(null);
  /** 加载中标志（启动恢复时） */
  const restoring = ref(false);

  // ===== 编辑会话（ADR-0022）=====
  /**
   * 每个 tab 一份会话，持有缓冲区、脏态、磁盘基线与草稿。
   * store 只通过快照读它，写入口一律走会话命令——不再有第二份内容真相。
   *
   * 单测 mock `editor/session/documentStore` 模块即可替换磁盘能力（见 store 测试头部）。
   */
  const sessions = new Map<string, EditorSession>();
  const documentStore: DocumentStore = createDocumentStore();

  /**
   * 会话内容/脏态变化的响应式信号（tabId → 版本号）。
   *
   * 会话本身是普通对象、不经 Vue 响应式包裹，`snapshot()` 读出来的是普通值；
   * TabBar 的 dirty 圆点、状态栏的「未保存」、关闭前的未保存确认都依赖
   * 「tabs 变化时重算」。故每个 tab 挂一个 ref，会话 onChange 时自增，
   * 派生字段的 getter 先读它建立依赖（ADR-0022 落地时踩过的坑：#449）。
   */
  const revisions = new Map<string, { value: number }>();

  /** 取会话；未命名/已释放返回 null */
  function getSession(tabId: string): EditorSession | null {
    return sessions.get(tabId) ?? null;
  }

  /** 把会话快照铺成 Tab 的派生字段（content / isDirty / lastMtime 只读） */
  function materialize(tab: Tab, snapshot: SessionSnapshot): Tab {
    return {
      id: tab.id,
      path: tab.path,
      content: snapshot.content,
      lastMtime: snapshot.baselineMtime,
      isDirty: snapshot.isDirty,
      hasExternalChange: tab.hasExternalChange,
      cursor: tab.cursor,
      scroll: tab.scroll,
    };
  }

  /**
   * 把派生字段挂成 getter：调用方（openFile 的返回值、restore 的光标回写）
   * 会持有 tab 对象跨越多次内容变更，快照拷贝会让它停在旧值。
   * getter 每次读取都回到会话，保证「拿到的是活的 tab」。
   *
   * 先读 revision 再读快照：revision 是 ref，读取即建立依赖，
   * 否则会话内容变化不会触发重算（UI 上的 dirty 指示会停住）。
   */
  function materializeLive(tab: Tab, session: EditorSession, revision: { value: number }): Tab {
    return {
      id: tab.id,
      path: tab.path,
      get content() {
        void revision.value;
        return session.snapshot().content;
      },
      get lastMtime() {
        void revision.value;
        return session.snapshot().baselineMtime;
      },
      get isDirty() {
        void revision.value;
        return session.snapshot().isDirty;
      },
      // 外部修改标记不属于会话（ADR-0022 把它判为 watcher 领域、Phase 3 删除），
      // 这里转发到底层 tab，保证 markExternalChange 写的值能被读到
      get hasExternalChange() {
        return tab.hasExternalChange;
      },
      set hasExternalChange(value: boolean) {
        tab.hasExternalChange = value;
      },
      cursor: tab.cursor,
      scroll: tab.scroll,
    };
  }

  /** 新建一个 tab 的会话 + 响应式版本号，并把 onChange 接上（内容变化 → 版本号自增 + 合并落盘） */
  function createTrackedSession(
    id: string,
    makeSession: (onChange: () => void) => EditorSession
  ): { session: EditorSession; revision: { value: number } } {
    const revision = ref(0);
    const session = makeSession(() => {
      revision.value++;
      schedulePersistOnChange();
    });
    revisions.set(id, revision);
    return { session, revision };
  }

  // ===== Getters =====
  /** 当前激活的 tab 索引 */
  const activeIndex = computed(() => {
    if (!activeTabId.value) return -1;
    return tabs.value.findIndex((t) => t.id === activeTabId.value);
  });

  /**
   * 当前激活的 tab（派生字段取自会话快照）。
   * 内容变化 → 会话通知 → 触发本 computed 重算，读点拿到的始终是新值。
   */
  const activeTab = computed<Tab | null>(() => {
    const idx = activeIndex.value;
    const tab = idx >= 0 ? tabs.value[idx] : null;
    if (!tab) return null;
    const session = sessions.get(tab.id);
    if (!session) return tab;
    // 读版本号建立依赖：会话内容变化时本 computed 才会重算
    void revisions.get(tab.id)?.value;
    return materialize(tab, session.snapshot());
  });

  /** 是否有打开的标签页 */
  const hasTabs = computed(() => tabs.value.length > 0);

  /** 生成唯一 tab id */
  function genId(): string {
    return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * 草稿写入失败的用户反馈（#378）。
   * 失败不阻断编辑，但未保存内容可能随之丢失，必须让用户知道。
   */
  function notifyDraftError(err: unknown): void {
    console.error("保存草稿失败:", err);
    toast.warning(t("common.toast.draftSaveFailed"));
  }

  /** 会话内容/脏态变化 → 合并落盘（替代 watcher 对 content 的深监听部分） */
  function schedulePersistOnChange(): void {
    if (initializedForPersist && !restoring.value) {
      requestPersist();
    }
  }

  /**
   * 合并写入口由 store 自己的 {@link schedulePersist} 提供，但生命周期 watcher
   * 在 store 构造之后才注册，故用这个间接层解耦初始化顺序。
   */
  let initializedForPersist = false;
  let requestPersist: () => void = () => {};

  /** 供 useAppLifecycle 注入：标记可落盘（合并写入口就是本 store 的 schedulePersist） */
  function bindPersist(): void {
    initializedForPersist = true;
    requestPersist = schedulePersist;
  }

  /**
   * 获取 tab 显示标题（仅文件名）。
   * #385：store 层不存本地化字符串——未命名文案由渲染层按当前语言注入，
   * 否则切换语言后标签标题仍是旧语言的硬编码。
   */
  function getTabTitle(tab: Tab, untitledText: string): string {
    return tab.path ? basename(tab.path) : untitledText;
  }

  /** 按 tab id 取派生后的 tab（读点统一入口，保证拿到最新快照） */
  function getTabById(tabId: string): Tab | null {
    const tab = tabs.value.find((t) => t.id === tabId);
    if (!tab) return null;
    const session = sessions.get(tab.id);
    if (!session) return tab;
    void revisions.get(tab.id)?.value;
    return materialize(tab, session.snapshot());
  }

  // ===== Actions =====
  /**
   * 打开文件为标签页
   * - 若该路径已在某个 tab 中，则激活该 tab
   * - 否则创建新 tab + 对应的编辑会话
   *
   * `activate: false` 用于启动恢复：只把 tab 放进列表、不切换激活项，
   * 避免恢复过程中编辑器（tabId 变化会整体替换 EditorState）逐个文件切换一遍。
   *
   * 草稿恢复与 mtime 冲突检测（ADR-0001）由会话负责：
   *   - 草稿基线与磁盘 mtime 一致 → 自动恢复草稿内容（脏态由内容比较自然得出）
   *   - 不一致 → 磁盘被外部改过，交由用户裁决（#425）：
   *     保留草稿 / 加载磁盘版本 / 稍后处理（用磁盘内容打开，草稿文件保留）
   */
  async function openFile(path: string, options: { activate?: boolean } = {}): Promise<Tab> {
    const activate = options.activate ?? true;
    // 检查是否已打开。走 getTabByPath（按归一化路径比较）—— 同一文件可能以 `\` 或 `/`
    // 的写法到达（外部入口 / 命令行参数 / 手工拼接），字面量比较会重复开 tab
    const existing = getTabByPath(path);
    if (existing) {
      if (activate) activeTabId.value = existing.id;
      return existing;
    }

    const id = genId();
    const revision = ref(0);
    const { session, result } = await openEditorSession({
      id,
      path,
      store: documentStore,
      onChange: () => {
        revision.value++;
        schedulePersistOnChange();
      },
      onDraftError: notifyDraftError,
    });
    revisions.set(id, revision);

    if (result.kind === "conflict") {
      const { conflict } = result;
      const choice: DraftConflictChoice = draftConflictResolver
        ? await draftConflictResolver({
            path,
            diskContent: conflict.diskContent,
            draftContent: conflict.draftContent,
            diskMtime: conflict.diskMtime,
            draftSavedAt: conflict.draftSavedAt,
          })
        : // 没有裁决器（如单测）时不替用户做决定：保留草稿文件
          "cancel";

      if (choice === "keep-draft") {
        session.resolveConflict("draft");
      } else if (choice === "load-disk") {
        // 只有用户明确选择磁盘版才删除草稿
        session.resolveConflict("disk");
      }
      // cancel：使用磁盘内容，草稿文件保留，下次打开仍可裁决
    }

    sessions.set(id, session);
    const tab: Tab = materializeLive(
      {
        id,
        path,
        content: "",
        lastMtime: null,
        isDirty: false,
        hasExternalChange: false,
        cursor: { line: 1, ch: 0 },
        scroll: { x: 0, y: 0 },
      },
      session,
      revision
    );
    tabs.value.push(tab);
    if (activate) activeTabId.value = tab.id;
    return tab;
  }

  /**
   * 创建新标签页（未关联文件）
   * `activate: false` 用于启动恢复（见 openFile 同名参数）
   */
  function newTab(initialContent = "", options: { activate?: boolean } = {}): Tab {
    // 未命名会话没有磁盘基线（baseline 为空串），
    // 因此 isDirty = content !== "" = initialContent.length > 0，与原逻辑一致
    const id = genId();
    const { session, revision } = createTrackedSession(id, (onChange) =>
      createUntitledSession(id, initialContent, { onChange, onDraftError: notifyDraftError })
    );
    sessions.set(id, session);
    const tab: Tab = materializeLive(
      {
        id,
        path: null,
        content: "",
        lastMtime: null,
        isDirty: false,
        hasExternalChange: false,
        cursor: { line: 1, ch: 0 },
        scroll: { x: 0, y: 0 },
      },
      session,
      revision
    );
    tabs.value.push(tab);
    if (options.activate ?? true) activeTabId.value = tab.id;
    return tab;
  }

  /**
   * 关闭标签页
   * - 若有未保存修改，由调用方决定如何处理（保存/不保存/取消）
   *   - 选择"保存"：调用方先调 saveTab / saveTabAs，再调本方法
   *   - 选择"不保存"：调 `doCloseTab(id, { keepDraft: false })`，不写草稿并清掉已有草稿
   *   - 选择"取消"：调用方不调本方法
   * - 本方法只负责释放会话（草稿随之落盘或清理）+ 从列表中移除 + 调整激活 tab
   */
  async function closeTab(tabId: string): Promise<{ needsConfirm: boolean; tab: Tab | null }> {
    const tab = getTabById(tabId);
    if (!tab) return { needsConfirm: false, tab: null };

    // 通知调用方：此 tab 需要弹出"保存/不保存/取消"对话框
    // 调用方应处理完用户选择后再调用本方法执行真正的关闭
    if (tab.isDirty) {
      return { needsConfirm: true, tab };
    }

    // 无未保存修改：直接关闭
    return doCloseTab(tabId);
  }

  /**
   * 真正执行关闭动作（释放会话 + 移除 + 调整激活）
   * 调用方处理完未保存确认后调用本方法
   * @param options.keepDraft 用户明确「不保存」时传 false：不写草稿并清掉已有草稿
   */
  async function doCloseTab(
    tabId: string,
    options: { keepDraft?: boolean } = {}
  ): Promise<{ needsConfirm: boolean; tab: Tab | null }> {
    const idx = tabs.value.findIndex((t) => t.id === tabId);
    if (idx < 0) return { needsConfirm: false, tab: null };

    // 先取快照：会话随后会被释放，返回值代表「关闭那一刻的状态」
    const tab = getTabById(tabId) ?? tabs.value[idx];
    const session = sessions.get(tabId);
    if (session) {
      // keepDraft:false = 用户明确「不保存」：删草稿；
      // 其余情况 flushDraft 把脏内容写进草稿（下次启动恢复），
      // 内容已与磁盘一致时 flush 会顺带清掉过期草稿（#426）
      await session.dispose({ draft: options.keepDraft === false ? "discard" : "keep" });
      sessions.delete(tabId);
      revisions.delete(tabId);
    }

    tabs.value.splice(idx, 1);

    // 调整激活的 tab
    if (activeTabId.value === tabId) {
      if (tabs.value.length === 0) {
        activeTabId.value = null;
      } else {
        // 激活相邻 tab（优先前一个）
        const newIdx = Math.min(idx, tabs.value.length - 1);
        activeTabId.value = tabs.value[newIdx].id;
      }
    }

    return { needsConfirm: false, tab };
  }

  /** 按路径查找 tab（消除 App.vue 中的 message chain）。
   *  同样按归一化路径比较 —— 外部修改事件的路径写法未必与打开时一致（见 isSamePath）。 */
  function getTabByPath(filePath: string): Tab | null {
    const tab = tabs.value.find((t) => t.path !== null && isSamePath(t.path, filePath));
    return tab ? (getTabById(tab.id) ?? tab) : null;
  }

  /**
   * 应用内重命名/移动后同步标签路径（#427）。
   * 文件与其所在目录都要处理：目录被移动时，其下所有已打开文件的路径前缀一起替换。
   * 草稿以原路径为键，因此同时把脏标签的草稿迁到新键下，避免旧草稿成为孤儿。
   */
  async function syncPathsAfterMove(oldPath: string, newPath: string): Promise<void> {
    const oldNorm = normalizePath(oldPath).replace(/\/+$/g, "");
    const newNorm = normalizePath(newPath).replace(/\/+$/g, "");
    const moved: Array<{ tab: Tab; previousPath: string }> = [];

    for (const tab of tabs.value) {
      if (tab.path === null) continue;
      const tabNorm = normalizePath(tab.path);
      let nextPath: string | null = null;
      if (isSamePath(tabNorm, oldNorm)) {
        nextPath = newNorm;
      } else if (isPathUnder(oldNorm, tabNorm)) {
        // isPathUnder 大小写不敏感，但长度一致，可直接按长度截取后缀
        nextPath = newNorm + tabNorm.slice(oldNorm.length);
      }
      if (nextPath === null) continue;

      moved.push({ tab, previousPath: tab.path });
      tab.path = nextPath;
    }

    for (const { tab, previousPath } of moved) {
      const session = getSession(tab.id);
      if (session) {
        // 先写新键再删旧键：写失败时旧草稿仍在，不会同时丢掉两份兜底
        session.renamePath(tab.path ?? previousPath);
        if (session.snapshot().isDirty) {
          await session.flushDraft();
        }
      }
      await fileSystem.deleteDraft(previousPath);
    }
  }

  /**
   * 应用外部修改处理结果到 tab
   * - "load-disk"：用磁盘内容覆盖 tab 内容，更新 mtime，清除 dirty；
   *   覆盖会丢弃本地未保存内容，故先写草稿兜底（issue #378，ADR-0001）
   * - "keep-local"：用户选择保留本地版本，将 mtime 基线对齐到磁盘当前 mtime，
   *   否则后续草稿的 knownMtime 与磁盘不一致，下次打开会被判定为过期草稿而丢弃
   */
  async function applyExternalResolution(
    filePath: string,
    choice: "load-disk" | "keep-local",
    externalContent?: string
  ): Promise<void> {
    const tab = getTabByPath(filePath);
    const session = tab ? getSession(tab.id) : null;
    if (!tab || !session) return;

    const mtime = await fileSystem.getMtime(filePath);
    if (choice === "load-disk") {
      // issue #378：本地未保存内容即将被磁盘内容覆盖，先写草稿兜底，
      // 让用户事后仍可经 ADR-0001 的草稿恢复找回来。knownMtime 必须用磁盘
      // 当前 mtime，否则下次打开会被判为过期草稿而直接丢弃，兜底失效。
      // 故先把基线对齐到磁盘 mtime，再 flush —— 草稿带上正确的 knownMtime。
      if (session.snapshot().isDirty) {
        session.rebaseline(mtime);
        await session.flushDraft();
      }
      await session.reloadBaseline(
        externalContent !== undefined ? { content: externalContent, mtime } : undefined
      );
      // 已与磁盘同步，外部修改标记随之清除
      markExternalChange(filePath, false);
    } else {
      // keep-local：将 mtime 基线对齐磁盘当前 mtime，保证草稿 knownMtime 与磁盘一致
      // 这样关闭未保存时草稿能被下次启动正确恢复
      session.rebaseline(mtime);
      // 用户明确选择保留本地：外部修改标记置位，提示磁盘与编辑器内容已分叉
      markExternalChange(filePath, true);
    }
  }

  /**
   * 标记 tab 的外部修改状态（用于文件被外部删除 / 保留本地版本等场景）。
   *
   * ADR-0022 判定它属于死状态，计划在 Phase 3（#450）删除；
   * Phase 2 保留真实实现 —— e2e 用它断言「自动重载后标记清除」与
   * 「保留本地后标记置位」两条既有行为契约。
   */
  function markExternalChange(filePath: string, changed: boolean): void {
    const tab = tabs.value.find((t) => t.path !== null && isSamePath(t.path, filePath));
    if (tab) tab.hasExternalChange = changed;
  }

  /**
   * 从磁盘重新加载 tab 内容（覆盖本地修改，外部修改未弹窗时使用）
   * 有未保存改动时先写草稿兜底，避免重载把本地内容彻底抹掉
   */
  async function reloadFromDisk(filePath: string): Promise<void> {
    const tab = getTabByPath(filePath);
    const session = tab ? getSession(tab.id) : null;
    if (!tab || !session) return;
    // knownMtime 取「重载前的磁盘基线」：草稿代表基于旧版本的本地内容。
    // 磁盘被外部改过时，下次打开会因基线不一致而走冲突裁决（#425），
    // 而不是把用户明确丢弃的修改当成最新内容直接复活。
    if (session.snapshot().isDirty) {
      await session.flushDraft();
    }
    await session.reloadBaseline();
    // 已与磁盘一致：外部修改标记清除
    markExternalChange(filePath, false);
  }

  /**
   * 写入合并后的内容到磁盘并更新 tab（对比窗口保存时调用）
   */
  async function writeMergedContent(filePath: string, mergedContent: string): Promise<void> {
    const tab = getTabByPath(filePath);
    const session = tab ? getSession(tab.id) : null;
    if (session) {
      // 保存即「写盘 + 更新基线 + 删草稿」，正是会话的 save 语义
      session.setContent(mergedContent);
      await session.save();
      // 合并结果已写盘，本地与磁盘重新一致
      markExternalChange(filePath, false);
      return;
    }
    await fileSystem.writeText(filePath, mergedContent);
  }

  /**
   * 关闭当前激活的 tab
   */
  async function closeActive(): Promise<void> {
    if (activeTabId.value) {
      await closeTab(activeTabId.value);
    }
  }

  /**
   * 切换激活的 tab
   */
  function switchTo(tabId: string): void {
    if (tabs.value.some((t) => t.id === tabId)) {
      activeTabId.value = tabId;
    }
  }

  /**
   * 切换到下一个 tab（Ctrl+Tab）
   */
  function switchNext(): void {
    if (tabs.value.length === 0) return;
    const idx = activeIndex.value;
    const nextIdx = (idx + 1) % tabs.value.length;
    activeTabId.value = tabs.value[nextIdx].id;
  }

  /**
   * 切换到上一个 tab（Ctrl+Shift+Tab）
   */
  function switchPrev(): void {
    if (tabs.value.length === 0) return;
    const idx = activeIndex.value;
    const prevIdx = (idx - 1 + tabs.value.length) % tabs.value.length;
    activeTabId.value = tabs.value[prevIdx].id;
  }

  /**
   * 更新 tab 内容（编辑器输入时调用）
   */
  function updateContent(tabId: string, content: string): void {
    // 脏态由会话按「内容 !== 磁盘基线」判定：撤销回到原始内容时自动不脏
    getSession(tabId)?.setContent(content);
  }

  /**
   * 更新当前激活 tab 的内容
   */
  function updateActiveContent(content: string): void {
    if (activeTabId.value) {
      updateContent(activeTabId.value, content);
    }
  }

  /**
   * 保存 tab 到磁盘文件
   */
  async function saveTab(tabId: string): Promise<void> {
    const tab = tabs.value.find((t) => t.id === tabId);
    if (!tab || !tab.path) {
      throw new Error("无文件路径，请使用另存为");
    }
    const session = getSession(tabId);
    if (!session) {
      throw new Error("该标签的编辑会话已释放，无法保存");
    }
    const result = await session.save();
    if (result.kind === "failed") {
      throw result.error;
    }
  }

  /**
   * 另存为：将 tab 内容保存到新路径，并更新 tab.path
   */
  async function saveTabAs(tabId: string, newPath: string): Promise<void> {
    const tab = tabs.value.find((t) => t.id === tabId);
    if (!tab) return;
    const session = getSession(tabId);
    if (!session) {
      throw new Error("该标签的编辑会话已释放，无法保存");
    }
    const result = await session.saveAs(newPath);
    if (result.kind === "failed") {
      throw result.error;
    }
    // 会话已切换到新路径，tab 的身份字段跟随
    tab.path = session.snapshot().path;
  }

  /** 合并写窗口：高频输入时最多每 1.5s 落一次盘（#429） */
  const PERSIST_THROTTLE_MS = 1500;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** 落盘串行链：后一次写快照必须等前一次写完，避免旧快照后落覆盖新快照 */
  let persistChain: Promise<void> = Promise.resolve();

  function cancelPendingPersist(): void {
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
  }

  /**
   * 排一次合并落盘（#429）。
   *
   * 定时器已在等待时不重置 —— 连续输入期间也保证最多 1.5s 落一次盘，
   * 不会因为「一直有改动」而无限延后（固定窗口节流，不是 trailing debounce）。
   */
  function schedulePersist(): void {
    if (persistTimer !== null) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persist();
    }, PERSIST_THROTTLE_MS);
  }

  /**
   * 持久化当前 tabs 状态（用于启动恢复）。
   * 会先取消已排队的合并写：本次调用写的就是最新状态，再写一次纯属浪费。
   */
  function persist(): Promise<void> {
    cancelPendingPersist();
    const persistence = usePersistenceStore();
    // 内容一律取自会话快照（tabs 里的 content 只是派生副本，可能已过期）
    const toSave: PersistedTab[] = tabs.value.map((t) => {
      const derived = getTabById(t.id);
      return {
        path: t.path,
        content: derived?.content ?? "",
        lastMtime: derived?.lastMtime ?? null,
        cursor: t.cursor,
        scroll: t.scroll,
      };
    });
    const indexSnapshot = Math.max(0, activeIndex.value);
    // 串行而非并发：定时器触发的写与退出时的强制 flush 可能撞在一起
    persistChain = persistChain
      .then(() => persistence.saveTabs(toSave, indexSnapshot))
      .catch(() => {
        // saveTabs 内部已记录错误；链上不能留 rejected，否则后续写全被跳过
      });
    return persistChain;
  }

  /**
   * 从持久化状态恢复 tabs（应用启动时调用）
   * 注意：草稿内容已在 openFile 中读取，这里仅恢复路径列表
   *
   * 关键：按持久化顺序恢复 tab，避免 openFile（追加到末尾）和 newTab
   * （追加到末尾）混合调用导致顺序错位。例如持久化顺序为
   * [fileA, newFile, fileB]，如果先 openFile(fileA)、openFile(fileB)、
   * 再 newTab(newFile)，恢复后顺序变为 [fileA, fileB, newFile]，
   * activeIndex 会指向错误的 tab。
   *
   * 修复方案：先按顺序恢复所有 tab（path tab 通过 openFile 追加，
   * newFile tab 通过 newTab 追加），然后按持久化顺序重排 tabs 数组。
   */
  async function restore(): Promise<void> {
    restoring.value = true;
    try {
      const persistence = usePersistenceStore();
      const state = await persistence.loadTabs();
      if (state.tabs.length === 0) return;

      // 阶段 1：按持久化顺序恢复每个 tab，记录持久化路径到 tab id 的映射
      // 全部传 activate:false —— 恢复期间不切换激活项：
      // 每个 tab 激活都会让编辑器整体替换 EditorState（见 SourceEditor 的 tabId watch），
      // 逐个激活会表现为启动时把每个文件都切换一遍
      const orderedTabIds: string[] = []; // 按持久化顺序记录 tab id
      /** 恢复失败的路径：结束后汇总提示，避免逐个弹窗刷屏 */
      const failedPaths: string[] = [];

      for (const persisted of state.tabs) {
        if (persisted.path) {
          try {
            const tab = await openFile(persisted.path, { activate: false });
            // 覆盖光标/滚动位置（openFile 不恢复这些）
            if (tab) {
              tab.cursor = persisted.cursor;
              tab.scroll = persisted.scroll;
            }
            if (tab) orderedTabIds.push(tab.id);
          } catch (err) {
            console.warn(`恢复 tab 失败: ${persisted.path}`, err);
            failedPaths.push(persisted.path);
            // 失败的 tab 不计入 orderedTabIds，后续重排时跳过
          }
        } else {
          // 未保存的新文件 tab
          const tab = newTab(persisted.content, { activate: false });
          orderedTabIds.push(tab.id);
        }
      }

      // 恢复失败的文件汇总提示一次：给出数量、前几个路径与重试入口（#436）
      if (failedPaths.length > 0) {
        useToastStore().warning(
          i18n.global.t("common.error.restoreTabsFailed", { count: failedPaths.length }),
          {
            description: failedPaths.slice(0, 3).join("\n"),
            action: {
              label: i18n.global.t("common.retry"),
              onClick: () => {
                for (const path of failedPaths) void openFile(path).catch(() => {});
              },
            },
          }
        );
      }

      // 阶段 2：按持久化顺序重排 tabs 数组
      // openFile 和 newTab 都追加到末尾，但混合调用时顺序可能错位
      // 通过 orderedTabIds 重建正确的顺序
      if (orderedTabIds.length === tabs.value.length) {
        const tabMap = new Map(tabs.value.map((t) => [t.id, t]));
        const reordered = orderedTabIds
          .map((id) => tabMap.get(id))
          .filter((t): t is Tab => t !== undefined);
        if (reordered.length === tabs.value.length) {
          tabs.value = reordered;
        }
      }

      // 阶段 3：一次性恢复激活 tab（仅在最后切一次，避免逐文件切换）
      // activeIndex 越界时回落到最后一个 tab，保持与旧行为一致（旧逻辑默认激活最后恢复的 tab）
      const activeIdx =
        state.activeIndex >= 0 && state.activeIndex < tabs.value.length
          ? state.activeIndex
          : tabs.value.length - 1;
      if (activeIdx >= 0) {
        activeTabId.value = tabs.value[activeIdx].id;
      }
    } finally {
      restoring.value = false;
    }
  }

  /**
   * 清除所有 tabs（不写草稿，用于"关闭工作区"等场景）
   *
   * 关键：本方法不触发 persist（否则会覆盖 tabs.json 为空数组，导致 restore 读不到数据）。
   * 通过临时设置 restoring=true，让 useAppLifecycle 的 watcher 在 tabs 变化时跳过 persist。
   * restoring 在下一个 macrotask 恢复（setTimeout 0），确保 Vue 的 microtask watcher
   * 在 restoring=true 时触发。
   */
  function clearAll(): void {
    // 已排队但尚未触发的合并写必须取消：否则它会在清空后把 [] 写进 tabs.json
    cancelPendingPersist();
    // 释放全部会话：撤销历史与草稿定时器随之回收（否则内存单调增长）
    for (const session of sessions.values()) {
      void session.dispose({ draft: "keep" }).catch(() => {});
    }
    sessions.clear();
    revisions.clear();
    restoring.value = true;
    tabs.value = [];
    activeTabId.value = null;
    // 用 setTimeout 在下一个 macrotask 恢复，确保 Vue watcher（microtask）在 restoring=true 时触发
    setTimeout(() => {
      restoring.value = false;
    }, 0);
  }

  /** 退出前把全部脏会话的草稿强制落盘（useExitFlush 调它） */
  async function flushAllDrafts(): Promise<number> {
    let failed = 0;
    for (const tab of tabs.value) {
      const session = sessions.get(tab.id);
      if (!session || !session.snapshot().isDirty) continue;
      try {
        await session.flushDraft();
      } catch (err) {
        failed++;
        console.error("[Murasaki] 退出前保存草稿失败:", err);
      }
    }
    return failed;
  }

  /** 退出前「不保存」：清掉全部会话的草稿（useExitFlush 调它） */
  async function discardAllDrafts(): Promise<void> {
    for (const tab of tabs.value) {
      const session = sessions.get(tab.id);
      if (!session || !session.snapshot().isDirty) continue;
      await session.dispose({ draft: "discard" }).catch(() => {});
    }
  }

  return {
    // state
    tabs,
    activeTabId,
    restoring,
    // getters
    activeIndex,
    activeTab,
    hasTabs,
    // actions
    openFile,
    newTab,
    closeTab,
    doCloseTab,
    closeActive,
    switchTo,
    switchNext,
    switchPrev,
    updateContent,
    updateActiveContent,
    saveTab,
    saveTabAs,
    schedulePersist,
    persist,
    bindPersist,
    restore,
    clearAll,
    // 外部修改相关
    getTabByPath,
    getTabById,
    setDraftConflictResolver,
    syncPathsAfterMove,
    applyExternalResolution,
    markExternalChange,
    reloadFromDisk,
    writeMergedContent,
    // 退出落盘（useExitFlush）
    flushAllDrafts,
    discardAllDrafts,
    // helpers
    getTabTitle,
  };
});
