import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useFileOpsStore, type ConflictResolver } from "./useFileOpsStore";

// ===== Mock @tauri-apps/api/core 的 invoke =====
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";

// ===== Mock useWorkspaceStore.refreshTree =====
vi.mock("./useWorkspaceStore", () => ({
  useWorkspaceStore: () => ({
    refreshTree: vi.fn().mockResolvedValue(undefined),
    workspacePath: "/test/workspace",
    selectedFilePath: null,
  }),
}));

const mockedInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  setActivePinia(createPinia());
  mockedInvoke.mockReset();
});

describe("useFileOpsStore", () => {
  describe("剪贴板操作", () => {
    it("初始状态无剪贴板", () => {
      const store = useFileOpsStore();
      expect(store.hasClipboard()).toBe(false);
    });

    it("cut 后 hasClipboard 返回 true", () => {
      const store = useFileOpsStore();
      store.cut("/test/workspace/a.md");
      expect(store.hasClipboard()).toBe(true);
    });

    it("copy 后 hasClipboard 返回 true", () => {
      const store = useFileOpsStore();
      store.copy("/test/workspace/a.md");
      expect(store.hasClipboard()).toBe(true);
    });
  });

  describe("createFile", () => {
    it("调用 create_file 命令并刷新文件树", async () => {
      const fakeNode = { name: "new.md", path: "/test/workspace/new.md", type: "file" as const };
      mockedInvoke.mockResolvedValueOnce(fakeNode);

      const store = useFileOpsStore();
      const result = await store.createFile("/test/workspace", "new.md");

      expect(result).toEqual(fakeNode);
      expect(mockedInvoke).toHaveBeenCalledWith("create_file", {
        path: "/test/workspace/new.md",
      });
      // 第二次调用应该是 refreshTree 中的，但 useWorkspaceStore 已 mock，不验证
    });

    it("失败时抛出错误", async () => {
      mockedInvoke.mockRejectedValueOnce(new Error("文件已存在"));

      const store = useFileOpsStore();
      await expect(
        store.createFile("/test/workspace", "exists.md")
      ).rejects.toThrow("文件已存在");
    });
  });

  describe("createDirectory", () => {
    it("调用 create_directory 命令", async () => {
      const fakeNode = {
        name: "newdir",
        path: "/test/workspace/newdir",
        type: "directory" as const,
      };
      mockedInvoke.mockResolvedValueOnce(fakeNode);

      const store = useFileOpsStore();
      const result = await store.createDirectory("/test/workspace", "newdir");

      expect(result).toEqual(fakeNode);
      expect(mockedInvoke).toHaveBeenCalledWith("create_directory", {
        path: "/test/workspace/newdir",
      });
    });
  });

  describe("deletePath", () => {
    it("调用 delete_path 命令", async () => {
      mockedInvoke.mockResolvedValueOnce(undefined);

      const store = useFileOpsStore();
      await store.deletePath("/test/workspace/trash.md");

      expect(mockedInvoke).toHaveBeenCalledWith("delete_path", {
        path: "/test/workspace/trash.md",
      });
    });
  });

  describe("renamePath", () => {
    it("目标不存在时直接重命名", async () => {
      // path_exists 返回 false
      mockedInvoke.mockResolvedValueOnce(false);
      // rename_path 返回新节点
      const fakeNode = {
        name: "renamed.md",
        path: "/test/workspace/renamed.md",
        type: "file" as const,
      };
      mockedInvoke.mockResolvedValueOnce(fakeNode);

      const store = useFileOpsStore();
      const result = await store.renamePath(
        "/test/workspace/old.md",
        "renamed.md"
      );

      expect(result).toEqual(fakeNode);
      expect(mockedInvoke).toHaveBeenCalledWith("rename_path", {
        from: "/test/workspace/old.md",
        to: "/test/workspace/renamed.md",
      });
    });

    it("同名重命名返回 null（不调用 rename_path）", async () => {
      const store = useFileOpsStore();
      const result = await store.renamePath(
        "/test/workspace/same.md",
        "same.md"
      );
      expect(result).toBeNull();
      // 不应调用任何 invoke
      expect(mockedInvoke).not.toHaveBeenCalled();
    });

    it("目标已存在且是目录时抛出错误", async () => {
      // path_exists 返回 true
      mockedInvoke.mockResolvedValueOnce(true);
      // path_type 返回 "directory"
      mockedInvoke.mockResolvedValueOnce("directory");

      const store = useFileOpsStore();
      await expect(
        store.renamePath("/test/workspace/a.md", "existing-dir")
      ).rejects.toThrow("无法覆盖目录");
    });

    it("目标已存在且用户选择取消时返回 null", async () => {
      // path_exists 返回 true
      mockedInvoke.mockResolvedValueOnce(true);
      // path_type 返回 "file"
      mockedInvoke.mockResolvedValueOnce("file");

      const resolver: ConflictResolver = vi
        .fn()
        .mockResolvedValue({ action: "cancel" });

      const store = useFileOpsStore();
      store.setConflictResolver(resolver);

      const result = await store.renamePath(
        "/test/workspace/a.md",
        "existing.md"
      );

      expect(result).toBeNull();
      expect(resolver).toHaveBeenCalledWith(
        "/test/workspace/existing.md",
        "rename",
        "/test/workspace/a.md"
      );
    });

    it("目标已存在且用户选择覆盖时先删除再重命名", async () => {
      // path_exists 返回 true
      mockedInvoke.mockResolvedValueOnce(true);
      // path_type 返回 "file"
      mockedInvoke.mockResolvedValueOnce("file");
      // delete_path
      mockedInvoke.mockResolvedValueOnce(undefined);
      // rename_path
      const fakeNode = {
        name: "renamed.md",
        path: "/test/workspace/renamed.md",
        type: "file" as const,
      };
      mockedInvoke.mockResolvedValueOnce(fakeNode);

      const resolver: ConflictResolver = vi
        .fn()
        .mockResolvedValue({ action: "overwrite" });

      const store = useFileOpsStore();
      store.setConflictResolver(resolver);

      const result = await store.renamePath(
        "/test/workspace/a.md",
        "existing.md"
      );

      expect(result).toEqual(fakeNode);
      // 验证 delete_path 被调用
      expect(mockedInvoke).toHaveBeenCalledWith("delete_path", {
        path: "/test/workspace/existing.md",
      });
      // 验证 rename_path 被调用
      expect(mockedInvoke).toHaveBeenCalledWith("rename_path", {
        from: "/test/workspace/a.md",
        to: "/test/workspace/existing.md",
      });
    });

    it("目标已存在且用户选择重命名时用新名字重试", async () => {
      // 第一次 path_exists 返回 true（existing.md）
      mockedInvoke.mockResolvedValueOnce(true);
      // path_type 返回 "file"
      mockedInvoke.mockResolvedValueOnce("file");
      // 第二次 path_exists 返回 false（new-name.md）
      mockedInvoke.mockResolvedValueOnce(false);
      // rename_path 返回新节点
      const fakeNode = {
        name: "new-name.md",
        path: "/test/workspace/new-name.md",
        type: "file" as const,
      };
      mockedInvoke.mockResolvedValueOnce(fakeNode);

      const resolver: ConflictResolver = vi
        .fn()
        .mockResolvedValue({ action: "rename", newName: "new-name.md" });

      const store = useFileOpsStore();
      store.setConflictResolver(resolver);

      const result = await store.renamePath(
        "/test/workspace/a.md",
        "existing.md"
      );

      expect(result).toEqual(fakeNode);
      // 验证最终 rename_path 用新名字
      expect(mockedInvoke).toHaveBeenLastCalledWith("rename_path", {
        from: "/test/workspace/a.md",
        to: "/test/workspace/new-name.md",
      });
    });

    it("未配置冲突解决器时抛出错误", async () => {
      // path_exists 返回 true
      mockedInvoke.mockResolvedValueOnce(true);
      // path_type 返回 "file"
      mockedInvoke.mockResolvedValueOnce("file");

      const store = useFileOpsStore();
      // 不设置 resolver
      await expect(
        store.renamePath("/test/workspace/a.md", "existing.md")
      ).rejects.toThrow("未配置冲突对话框");
    });
  });

  describe("paste - cut 模式", () => {
    it("目标不存在时直接移动", async () => {
      // path_exists 返回 false
      mockedInvoke.mockResolvedValueOnce(false);
      // rename_path
      mockedInvoke.mockResolvedValueOnce({ name: "a.md", path: "/dst/a.md", type: "file" });

      const store = useFileOpsStore();
      store.cut("/src/a.md");
      await store.paste("/dst");

      expect(mockedInvoke).toHaveBeenCalledWith("rename_path", {
        from: "/src/a.md",
        to: "/dst/a.md",
      });
      // 粘贴后剪贴板应清空
      expect(store.hasClipboard()).toBe(false);
    });

    it("源与目标同路径时清空剪贴板不调用 invoke", async () => {
      const store = useFileOpsStore();
      store.cut("/dst/a.md");
      await store.paste("/dst");

      expect(mockedInvoke).not.toHaveBeenCalled();
      expect(store.hasClipboard()).toBe(false);
    });
  });

  describe("paste - copy 模式", () => {
    it("目标不存在时调用 copy_file", async () => {
      // path_exists 返回 false
      mockedInvoke.mockResolvedValueOnce(false);
      // copy_file
      mockedInvoke.mockResolvedValueOnce({ name: "a.md", path: "/dst/a.md", type: "file" });

      const store = useFileOpsStore();
      store.copy("/src/a.md");
      await store.paste("/dst");

      expect(mockedInvoke).toHaveBeenCalledWith("copy_file", {
        from: "/src/a.md",
        to: "/dst/a.md",
      });
      // copy 模式下剪贴板保留
      expect(store.hasClipboard()).toBe(true);
    });
  });

  describe("revealInExplorer", () => {
    it("调用 reveal_in_explorer 命令", async () => {
      mockedInvoke.mockResolvedValueOnce(undefined);

      const store = useFileOpsStore();
      await store.revealInExplorer("/test/workspace/a.md");

      expect(mockedInvoke).toHaveBeenCalledWith("reveal_in_explorer", {
        path: "/test/workspace/a.md",
      });
    });
  });

  describe("setConflictResolver", () => {
    it("可以设置和清除冲突解决器", () => {
      const store = useFileOpsStore();
      const resolver: ConflictResolver = vi.fn();

      store.setConflictResolver(resolver);
      // 设置后不影响其他方法（仅在冲突时使用）
      expect(store.hasClipboard()).toBe(false);

      store.setConflictResolver(null);
      // 清除后也不影响其他方法
      expect(store.hasClipboard()).toBe(false);
    });
  });
});
