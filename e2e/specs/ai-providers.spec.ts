/**
 * AI Provider 配置 E2E 测试（Ticket #19）
 *
 * 验收标准：
 * - 新增/编辑/删除 provider
 * - 测试连接（错误路径，模拟不可达端点）
 * - 设为活动
 * - 重启后配置保留（关闭 session 后重建，provider 仍在）
 *
 * 注意：
 * - dirs::data_dir() 在 Windows 用 Win32 SHGetKnownFolderPath，不尊重 env 重定向，
 *   所以 secrets.json 写到真实 %APPDATA%\murasaki\，需在 Node 侧清理
 * - 通过 Pinia store actions 驱动（与现有 E2E 风格一致），store 走真实 Tauri 命令
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createSession, closeSession } from "../helpers/driver";

/** 真实 %APPDATA%\murasaki\ 目录（dirs::data_dir() 不尊重 env 重定向） */
function secretsDir(): string {
  const roaming = resolve(process.env.USERPROFILE!, "AppData", "Roaming");
  return join(roaming, "murasaki");
}

/** 清理 secrets.json，保证每个测试从干净状态开始 */
function cleanSecrets(): void {
  const dir = secretsDir();
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

let browser: Browser;

describe("AI Provider 配置", () => {
  beforeAll(async () => {
    cleanSecrets();
    browser = await createSession();
  }, 60000);

  afterAll(async () => {
    if (browser) await closeSession(browser);
    cleanSecrets();
  });

  beforeEach(async () => {
    // 每个测试前清空 provider 列表（磁盘 + 内存）
    cleanSecrets();
    await browser.executeAsync((done: (res: unknown) => void) => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const store = pinia._s.get("aiProviders");
      // 重置内存状态
      store.providers = [];
      store.loaded = false;
      done(null);
    });
  });

  it("新增 provider 后列表包含该 provider", async () => {
    await browser.executeAsync(
      (done: (res: unknown) => void) => {
        // @ts-ignore
        const pinia = window.__pinia__;
        const store = pinia._s.get("aiProviders");
        const newProvider = {
          id: "",
          name: "Test DeepSeek",
          type: "deepseek",
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-v4-flash",
          isActive: false,
        };
        Promise.resolve(store.saveProvider(newProvider, "sk-test-key"))
          .then(() => done(null))
          .catch((err: unknown) => done(err ? String(err) : null));
      }
    );

    const state = await browser.execute(() => {
      // @ts-ignore
      const store = window.__pinia__._s.get("aiProviders");
      return {
        count: store.providers.length,
        first: store.providers[0]
          ? {
              name: store.providers[0].name,
              type: store.providers[0].type,
              baseUrl: store.providers[0].baseUrl,
              model: store.providers[0].model,
              isActive: store.providers[0].isActive,
            }
          : null,
      };
    });

    expect(state.count).toBe(1);
    expect(state.first).not.toBeNull();
    expect(state.first!.name).toBe("Test DeepSeek");
    expect(state.first!.type).toBe("deepseek");
    expect(state.first!.baseUrl).toBe("https://api.deepseek.com");
    // saveProvider 不在前端保留 apiKeyEnc 明文
    expect(state.first!.isActive).toBe(false);
  });

  it("编辑已有 provider 名称后列表更新", async () => {
    // 先新增
    await browser.executeAsync(
      (done: (res: unknown) => void) => {
        // @ts-ignore
        const pinia = window.__pinia__;
        const store = pinia._s.get("aiProviders");
        Promise.resolve(
          store.saveProvider(
            {
              id: "",
              name: "Original",
              type: "custom",
              baseUrl: "https://example.com",
              model: "m1",
              isActive: false,
            },
            "sk-orig"
          )
        )
          .then(() => done(null))
          .catch((err: unknown) => done(err ? String(err) : null));
      }
    );

    // 获取 id 后编辑名称
    await browser.executeAsync(
      (done: (res: unknown) => void) => {
        // @ts-ignore
        const pinia = window.__pinia__;
        const store = pinia._s.get("aiProviders");
        const existing = store.providers[0];
        Promise.resolve(
          store.saveProvider(
            { ...existing, name: "Renamed" },
            "" // 空 key 表示保留原 key
          )
        )
          .then(() => done(null))
          .catch((err: unknown) => done(err ? String(err) : null));
      }
    );

    const name = await browser.execute(() => {
      // @ts-ignore
      const store = window.__pinia__._s.get("aiProviders");
      return store.providers[0]?.name ?? null;
    });

    expect(name).toBe("Renamed");
  });

  it("设为活动后该 provider 的 isActive 为 true", async () => {
    // 新增两个 provider
    for (const name of ["P1", "P2"]) {
      await browser.executeAsync(
        (n: string, done: (res: unknown) => void) => {
          // @ts-ignore
          const pinia = window.__pinia__;
          const store = pinia._s.get("aiProviders");
          Promise.resolve(
            store.saveProvider(
              {
                id: "",
                name: n,
                type: "custom",
                baseUrl: "https://example.com",
                model: "m1",
                isActive: false,
              },
              "sk-test"
            )
          )
            .then(() => done(null))
            .catch((err: unknown) => done(err ? String(err) : null));
        },
        name
      );
    }

    // 将第二个设为活动
    const p2Id = (await browser.execute(() => {
      // @ts-ignore
      const store = window.__pinia__._s.get("aiProviders");
      return store.providers[1].id;
    })) as string;

    await browser.executeAsync(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (id: any, done: (res: unknown) => void) => {
        // @ts-ignore
        const pinia = window.__pinia__;
        const store = pinia._s.get("aiProviders");
        Promise.resolve(store.setActive(id))
          .then(() => done(null))
          .catch((err: unknown) => done(err ? String(err) : null));
      },
      p2Id
    );

    const state = await browser.execute(() => {
      // @ts-ignore
      const store = window.__pinia__._s.get("aiProviders");
      return store.providers.map((p: any) => ({
        name: p.name,
        isActive: p.isActive,
      }));
    });

    expect(state).toHaveLength(2);
    expect(state[0].isActive).toBe(false);
    expect(state[1].isActive).toBe(true);
  });

  it("删除 provider 后列表不再包含该 provider", async () => {
    // 新增
    await browser.executeAsync(
      (done: (res: unknown) => void) => {
        // @ts-ignore
        const pinia = window.__pinia__;
        const store = pinia._s.get("aiProviders");
        Promise.resolve(
          store.saveProvider(
            {
              id: "",
              name: "ToDelete",
              type: "custom",
              baseUrl: "https://example.com",
              model: "m1",
              isActive: false,
            },
            "sk-test"
          )
        )
          .then(() => done(null))
          .catch((err: unknown) => done(err ? String(err) : null));
      }
    );

    const id = (await browser.execute(() => {
      // @ts-ignore
      const store = window.__pinia__._s.get("aiProviders");
      return store.providers[0].id;
    })) as string;

    await browser.executeAsync(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pid: any, done: (res: unknown) => void) => {
        // @ts-ignore
        const pinia = window.__pinia__;
        const store = pinia._s.get("aiProviders");
        Promise.resolve(store.deleteProvider(pid))
          .then(() => done(null))
          .catch((err: unknown) => done(err ? String(err) : null));
      },
      id
    );

    const count = await browser.execute(() => {
      // @ts-ignore
      const store = window.__pinia__._s.get("aiProviders");
      return store.providers.length;
    });

    expect(count).toBe(0);
  });

  it("测试连接：不可达端点返回 error 状态", async () => {
    // 使用不可达端口（127.0.0.1:1 几乎必定拒绝连接）
    await browser.executeAsync(
      (done: (res: unknown) => void) => {
        // @ts-ignore
        const pinia = window.__pinia__;
        const store = pinia._s.get("aiProviders");
        Promise.resolve(
          store.testConnection(
            "http://127.0.0.1:1",
            "sk-invalid",
            "test-model"
          )
        )
          .then(() => done(null))
          .catch(() => done(null)); // 预期失败，但仍继续验证状态
      }
    );

    const status = await browser.execute(() => {
      // @ts-ignore
      const store = window.__pinia__._s.get("aiProviders");
      return {
        testStatus: store.testStatus,
        testMessage: store.testMessage,
      };
    });

    expect(status.testStatus).toBe("error");
    expect(status.testMessage.length).toBeGreaterThan(0);
  });

  it("重启后配置保留（关闭 session 重建后 provider 仍在）", async () => {
    // 新增一个 provider
    await browser.executeAsync(
      (done: (res: unknown) => void) => {
        // @ts-ignore
        const pinia = window.__pinia__;
        const store = pinia._s.get("aiProviders");
        Promise.resolve(
          store.saveProvider(
            {
              id: "",
              name: "Persisted",
              type: "deepseek",
              baseUrl: "https://api.deepseek.com",
              model: "deepseek-v4-flash",
              isActive: true,
            },
            "sk-persist"
          )
        )
          .then(() => done(null))
          .catch((err: unknown) => done(err ? String(err) : null));
      }
    );

    // 关闭当前 session
    await closeSession(browser);

    // 重建 session（模拟重启）
    browser = await createSession();

    // 加载 providers（store.load 从磁盘读取）
    await browser.executeAsync(
      (done: (res: unknown) => void) => {
        // @ts-ignore
        const pinia = window.__pinia__;
        const store = pinia._s.get("aiProviders");
        Promise.resolve(store.load())
          .then(() => done(null))
          .catch((err: unknown) => done(err ? String(err) : null));
      }
    );

    const state = await browser.execute(() => {
      // @ts-ignore
      const store = window.__pinia__._s.get("aiProviders");
      return {
        count: store.providers.length,
        first: store.providers[0]
          ? {
              name: store.providers[0].name,
              type: store.providers[0].type,
              baseUrl: store.providers[0].baseUrl,
              model: store.providers[0].model,
              isActive: store.providers[0].isActive,
            }
          : null,
        hasActive: store.activeProvider !== null,
      };
    });

    expect(state.count).toBe(1);
    expect(state.first).not.toBeNull();
    expect(state.first!.name).toBe("Persisted");
    expect(state.first!.type).toBe("deepseek");
    expect(state.first!.baseUrl).toBe("https://api.deepseek.com");
    expect(state.first!.model).toBe("deepseek-v4-flash");
    expect(state.first!.isActive).toBe(true);
    expect(state.hasActive).toBe(true);
  }, 120000);
});
