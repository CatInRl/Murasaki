/**
 * 编辑会话（Editor Session）的接口定义。
 *
 * 会话是「当前文档」的唯一真相：缓冲区、脏态、磁盘基线、草稿与撤销历史。
 * 标签页只保留身份、顺序与激活态（见 ADR-0022）。
 *
 * 本文件只声明接口，不依赖 CodeMirror 或 Tauri，便于用内存假实现做单测。
 */
import type { CursorPosition, EditorMode, ScrollPosition } from "../../types";

export type { CursorPosition, ScrollPosition };

/** 草稿与磁盘版本不一致时的待裁决信息 */
export interface ConflictInfo {
  /** 磁盘上的当前内容 */
  diskContent: string;
  /** 草稿内容 */
  draftContent: string;
  /** 磁盘当前 mtime */
  diskMtime: number;
  /** 草稿保存时间 */
  draftSavedAt: number;
}

export type ConflictChoice = "disk" | "draft";

/** 会话对外暴露的只读视图；调用方不读会话内部字段 */
export interface SessionSnapshot {
  path: string | null;
  content: string;
  isDirty: boolean;
  baselineMtime: number | null;
  cursor: CursorPosition;
  scroll: ScrollPosition;
  pendingConflict: ConflictInfo | null;
}

export type OpenResult = { kind: "ready" } | { kind: "conflict"; conflict: ConflictInfo };

export type SaveResult = { kind: "saved"; mtime: number } | { kind: "failed"; error: unknown };

export interface DraftSnapshot {
  content: string;
  knownMtime: number;
  savedAt: number;
}

/**
 * 磁盘 seam：整文件读写、mtime 与草稿。
 * 生产实现见 documentStore.ts；测试用内存假实现。
 */
export interface DocumentStore {
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  mtime(path: string): Promise<number>;
  draftExists(path: string): Promise<boolean>;
  readDraft(path: string): Promise<DraftSnapshot>;
  writeDraft(path: string, content: string, knownMtime: number): Promise<void>;
  deleteDraft(path: string): Promise<void>;
}

/**
 * 编辑器 seam：会话通过它存取编辑状态与光标，不直接依赖 CodeMirror。
 * 三个 compartment（WYSIWYG / 字体 / 快捷键）的重建顺序由 adapter 负责。
 */
export interface EditorAdapter {
  mount(host: HTMLElement): void;
  destroy(): void;
  getState(): unknown;
  setState(state: unknown): void;
  replaceDoc(text: string): void;
  setMode(mode: EditorMode): void;
  onSelectionChange(callback: (position: CursorPosition) => void): () => void;
}

export interface DisposeOptions {
  /** keep：脏文档落草稿；discard：删除草稿（用户明确选择「不保存」） */
  draft?: "keep" | "discard";
}

export interface EditorSession {
  readonly id: string;
  snapshot(): SessionSnapshot;
  setContent(text: string): void;
  setScroll(position: ScrollPosition): void;
  save(): Promise<SaveResult>;
  saveAs(path: string): Promise<SaveResult>;
  resolveConflict(choice: ConflictChoice): void;
  /** 立即把脏内容写入草稿（关闭 / 退出时调用） */
  flushDraft(): Promise<void>;
  attachEditor(adapter: EditorAdapter): void;
  detachEditor(): void;
  dispose(options?: DisposeOptions): Promise<void>;
}

export interface OpenSessionOptions {
  id: string;
  path: string | null;
  store: DocumentStore;
  /** 未命名标签的初始内容 */
  initialContent?: string;
  /** 草稿自动写入的防抖时长，默认 2000ms */
  draftDebounceMs?: number;
  /** 内容 / 脏态变化的通知，供持久化模块做防抖落盘 */
  onChange?: () => void;
  /** 草稿写入失败的通知，供上层提示用户 */
  onDraftError?: (error: unknown) => void;
}
