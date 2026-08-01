import { describe, it, expect, beforeEach, vi } from "vitest";
import { useUpdater, type UpdateInfo, type UpdaterDeps } from "./useUpdater";

// ===== Mock @tauri-apps/plugin-updater =====
const mockUpdate = {
  version: "0.4.0",
  currentVersion: "0.3.1",
  date: "2026-08-02",
  body: "## 新功能\n- 自动更新",
  downloadAndInstall: vi.fn(),
  close: vi.fn(),
};

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: vi.fn(),
}));

// ===== Mock @tauri-apps/plugin-process =====
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: vi.fn(),
}));

import { check as updaterCheck } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

const mockedCheck = updaterCheck as unknown as ReturnType<typeof vi.fn>;
const mockedRelaunch = relaunch as unknown as ReturnType<typeof vi.fn>;

function makeDeps(overrides: Partial<UpdaterDeps> = {}): UpdaterDeps {
  return {
    toast: {
      success: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      progress: vi.fn().mockReturnValue("toast-1"),
      update: vi.fn(),
      dismiss: vi.fn(),
    },
    onUpdateAvailable: vi.fn(),
    ...overrides,
  } as never;
}

beforeEach(() => {
  mockedCheck.mockReset();
  mockedRelaunch.mockReset();
  mockUpdate.downloadAndInstall.mockReset();
  mockUpdate.close.mockReset();
});

describe("useUpdater - check", () => {
  it("有更新时返回 UpdateInfo 并触发 onUpdateAvailable 回调（非静默）", async () => {
    mockedCheck.mockResolvedValue(mockUpdate);
    const deps = makeDeps();
    const { check, availableUpdate } = useUpdater(deps);

    const result = await check();

    expect(result).toEqual({
      version: "0.4.0",
      currentVersion: "0.3.1",
      date: "2026-08-02",
      body: "## 新功能\n- 自动更新",
    } as UpdateInfo);
    expect(availableUpdate.value).toEqual(result);
    expect(deps.onUpdateAvailable).toHaveBeenCalledWith(result);
    // 有更新时不显示「已是最新版本」toast
    expect(deps.toast.success).not.toHaveBeenCalled();
  });

  it("无更新时返回 null 并 toast 成功（非静默）", async () => {
    mockedCheck.mockResolvedValue(null);
    const deps = makeDeps();
    const { check, availableUpdate } = useUpdater(deps);

    const result = await check();

    expect(result).toBeNull();
    expect(availableUpdate.value).toBeNull();
    expect(deps.toast.success).toHaveBeenCalledWith("已是最新版本");
    expect(deps.onUpdateAvailable).not.toHaveBeenCalled();
  });

  it("静默模式下无更新不 toast", async () => {
    mockedCheck.mockResolvedValue(null);
    const deps = makeDeps();
    const { check } = useUpdater(deps);

    await check(true); // silent

    expect(deps.toast.success).not.toHaveBeenCalled();
  });

  it("静默模式下有更新不触发 onUpdateAvailable 回调", async () => {
    mockedCheck.mockResolvedValue(mockUpdate);
    const deps = makeDeps();
    const { check } = useUpdater(deps);

    const result = await check(true);

    expect(result).not.toBeNull();
    expect(deps.onUpdateAvailable).not.toHaveBeenCalled();
  });

  it("检查失败时 toast 错误并返回 null（非静默）", async () => {
    mockedCheck.mockRejectedValue(new Error("network error"));
    const deps = makeDeps();
    const { check } = useUpdater(deps);

    const result = await check();

    expect(result).toBeNull();
    expect(deps.toast.error).toHaveBeenCalledWith(
      expect.stringContaining("检查更新失败")
    );
  });

  it("静默模式下检查失败不 toast", async () => {
    mockedCheck.mockRejectedValue(new Error("network error"));
    const deps = makeDeps();
    const { check } = useUpdater(deps);

    await check(true);

    expect(deps.toast.error).not.toHaveBeenCalled();
  });

  it("正在检查时再次调用返回 null（防重入）", async () => {
    let resolveCheck!: (v: unknown) => void;
    mockedCheck.mockReturnValue(
      new Promise((r) => {
        resolveCheck = r;
      })
    );
    const deps = makeDeps();
    const { check } = useUpdater(deps);

    const first = check();
    const second = check();

    expect(await second).toBeNull();
    resolveCheck(null);
    await first;
  });

  it("checking 状态在检查期间为 true，结束后为 false", async () => {
    let resolveCheck!: (v: unknown) => void;
    mockedCheck.mockReturnValue(
      new Promise((r) => {
        resolveCheck = r;
      })
    );
    const deps = makeDeps();
    const { check, checking } = useUpdater(deps);

    const promise = check();
    expect(checking.value).toBe(true);

    resolveCheck(null);
    await promise;

    expect(checking.value).toBe(false);
  });
});

describe("useUpdater - downloadAndInstall", () => {
  it("成功下载安装后 dismiss 进度 toast + success toast + 自动重启", async () => {
    mockedCheck.mockResolvedValue(mockUpdate);
    mockUpdate.downloadAndInstall.mockResolvedValue(undefined);
    mockedRelaunch.mockResolvedValue(undefined);

    const deps = makeDeps();
    const { check, downloadAndInstall, downloading } = useUpdater(deps);

    const info = await check();
    await downloadAndInstall(info!);

    expect(mockUpdate.downloadAndInstall).toHaveBeenCalled();
    // 显示 indeterminate 进度 toast
    expect(deps.toast.progress).toHaveBeenCalledWith(
      "正在下载更新…",
      expect.objectContaining({ duration: 0 })
    );
    // 完成后 dismiss 进度 toast
    expect(deps.toast.dismiss).toHaveBeenCalledWith("toast-1");
    // 显示成功 toast
    expect(deps.toast.success).toHaveBeenCalledWith("更新已安装，即将重启…");
    // 自动重启
    expect(mockedRelaunch).toHaveBeenCalled();
    // downloading 状态复位
    expect(downloading.value).toBe(false);
  });

  it("未先 check 就调用 downloadAndInstall → toast 错误", async () => {
    const deps = makeDeps();
    const { downloadAndInstall } = useUpdater(deps);

    await downloadAndInstall({
      version: "0.4.0",
      currentVersion: "0.3.1",
    });

    expect(deps.toast.error).toHaveBeenCalledWith(
      expect.stringContaining("无可安装")
    );
    expect(mockUpdate.downloadAndInstall).not.toHaveBeenCalled();
  });

  it("下载失败时 dismiss 进度 toast + toast 错误，不重启", async () => {
    mockedCheck.mockResolvedValue(mockUpdate);
    mockUpdate.downloadAndInstall.mockRejectedValue(new Error("download failed"));

    const deps = makeDeps();
    const { check, downloadAndInstall } = useUpdater(deps);

    const info = await check();
    await downloadAndInstall(info!);

    expect(deps.toast.dismiss).toHaveBeenCalledWith("toast-1");
    expect(deps.toast.error).toHaveBeenCalledWith(
      expect.stringContaining("下载更新失败")
    );
    expect(mockedRelaunch).not.toHaveBeenCalled();
  });

  it("正在下载时忽略重复调用", async () => {
    mockedCheck.mockResolvedValue(mockUpdate);
    let resolveDl!: (v: unknown) => void;
    mockUpdate.downloadAndInstall.mockReturnValue(
      new Promise((r) => {
        resolveDl = r;
      })
    );

    const deps = makeDeps();
    const { check, downloadAndInstall } = useUpdater(deps);

    const info = await check();
    const first = downloadAndInstall(info!);
    await downloadAndInstall(info!); // 应立即返回，不重复下载

    // downloadAndInstall 只被调用一次
    expect(mockUpdate.downloadAndInstall).toHaveBeenCalledTimes(1);

    resolveDl(undefined);
    await first;
  });
});

describe("useUpdater - restart", () => {
  it("调用 relaunch", async () => {
    mockedRelaunch.mockResolvedValue(undefined);
    const deps = makeDeps();
    const { restart } = useUpdater(deps);

    await restart();

    expect(mockedRelaunch).toHaveBeenCalled();
  });

  it("relaunch 失败时 toast 错误", async () => {
    mockedRelaunch.mockRejectedValue(new Error("relaunch failed"));
    const deps = makeDeps();
    const { restart } = useUpdater(deps);

    await restart();

    expect(deps.toast.error).toHaveBeenCalledWith(
      expect.stringContaining("重启失败")
    );
  });
});
