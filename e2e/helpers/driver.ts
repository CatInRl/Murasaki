/**
 * WebDriver 客户端创建辅助
 * 通过 tauri-driver 启动 Murasaki binary，并返回一个 Browser 实例
 *
 * 关键能力格式（参考 tauri-driver 2.0.6 src/server.rs）：
 * - `tauri:options.application` 必须是字符串路径（PathBuf），不是对象
 * - 不要传 `browserName: "wry"`，tauri-driver 会自动注入 `browserName: "webview2"`
 *   + `ms:edgeOptions.binary` + `ms:edgeChromium: true` 转发给 msedgedriver
 * - 若传 `browserName`，msedgedriver 不识别 "wry" 会直接报 "No matching capabilities found"
 *
 * 注意：webdriverio 9.x 默认使用 undici（Node.js 内置 fetch）发送 HTTP 请求，
 * 与 tauri-driver 的 hyper 服务器存在兼容性问题（hyper::Error(IncompleteMessage)），
 * 会导致 tauri-driver 崩溃。因此用 Node.js 的 http 模块手动创建 session，
 * 然后用 webdriverio 的 attach 方法连接到已有 session。
 */
import { attach, type Browser } from "webdriverio";
import { resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { createConnection } from "node:net";
import { existsSync, rmSync } from "node:fs";
import { clearPersistedTabs, waitForAppReady, waitForPinia } from "./store";
import { IS_WINDOWS, IS_MACOS } from "./platform";
import { isProcessAlive, killProcessesByName } from "./processes";

const DEFAULT_BINARY = resolve(
  process.cwd(),
  IS_WINDOWS
    ? "src-tauri/target/release/murasaki.exe"
    : IS_MACOS
      ? // macOS e2e 必须 debug 构建：内嵌 WebDriver 服务端仅 debug 构建注册
        //（lib.rs run() 的 #[cfg(debug_assertions)] 门控），release 二进制没有 /status
        "src-tauri/target/debug/murasaki"
      : "src-tauri/target/release/murasaki"
);

// tauri-driver 监听地址。attach() 必须显式传入这些参数 —— webdriverio 9.x 的
// detectBackend() 在 options 为空时返回全 undefined（不会应用默认值），
// 导致 new URL("undefined://undefined:undefined/...") 抛 "Invalid URL"。
const DRIVER_HOSTNAME = "127.0.0.1";
const DRIVER_PORT = 4444;
// tauri-driver 默认把 msedgedriver 监听在这个端口（cli.rs --native-port 默认 4445）。
// 4444 在线但 4445 不在线 = tauri-driver 孤立（msedgedriver 被 cleanup 杀掉了），无法恢复。
const NATIVE_DRIVER_PORT = 4445;

// macOS 内嵌 WebDriver 服务端端口（tauri-plugin-wdio-webdriver 读 TAURI_WEBDRIVER_PORT，
// 默认即 4445）。macOS 上没有 msedgedriver，与 Windows/Linux 的 4445 用途不冲突。
const EMBEDDED_DRIVER_PORT = Number(process.env.TAURI_WEBDRIVER_PORT ?? 4445);

// macOS 分支自己 spawn 的应用进程。session 生命周期 = 应用进程生命周期
//（与 Windows/Linux 的「每个 spec 一个 fresh 实例」语义对齐），
// closeSession 负责杀掉；模块级持有是为了 closeSession 能精确杀自己拉起的进程，
// 而不是按进程名误杀 dev 中跑的 murasaki。
let embeddedAppProcess: ChildProcess | null = null;

/**
 * `browser.waitUntil` 的重试间隔 / 默认预算（#300）。
 *
 * `attach()` 不会合并 `remote()` 的那套默认配置，缺了这两个值时 `waitUntil` 会退化成
 * **单次判定**（详见 createSession 里的实测记录）。给 session options 补上即可一次修好
 * 所有只写 `{ timeout }` 的调用点。
 */
const WAITFOR_INTERVAL = 200;
const WAITFOR_TIMEOUT = 5000;

export function getBinaryPath(): string {
  return process.env.MURASAKI_BINARY ?? DEFAULT_BINARY;
}

/** 探测端口是否在线（用于 tauri-driver / msedgedriver 健康检查） */
function isPortListening(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise<boolean>((res) => {
    const sock = createConnection({ port, host });
    sock.setTimeout(800);
    sock.once("connect", () => {
      sock.destroy();
      res(true);
    });
    sock.once("error", () => {
      sock.destroy();
      res(false);
    });
    sock.once("timeout", () => {
      sock.destroy();
      res(false);
    });
  });
}

export interface CreateSessionOptions {
  /** 启动后等待窗口可见的超时（毫秒） */
  startupTimeout?: number;
}

/**
 * GET /status 探测 macOS 内嵌 WebDriver 服务是否就绪。
 *
 * `value.ready === true` 当且仅当应用至少存在一个 webview 窗口 —— 这是比
 * tauri-driver 的 /status（永远 ready）更强的信号：轮询它天然等到「应用窗口已建」。
 */
function embeddedServerReady(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: DRIVER_HOSTNAME, port, path: "/status", method: "GET" },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve(json.value?.ready === true);
          } catch {
            resolve(false);
          }
        });
      }
    );
    req.on("error", () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

// 单轮 25s：beforeAll hook 预算 60s，3 次重试若单轮 60s 会在首轮顶穿 hook，
// 失败时报错沦为 vitest 裸超时；收窄后至少完整跑完 2 轮，由这里抛出带排查指引的错误
async function waitForEmbeddedServer(port: number, timeout = 25000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await embeddedServerReady(port)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `内嵌 WebDriver 服务未在 ${timeout}ms 内就绪（GET /status 的 value.ready !== true）。` +
      "排查：应用是否 debug 构建（release 未注册插件）？端口是否被占用？"
  );
}

/** 杀掉本模块 spawn 的 macOS 应用进程，等待退出（最多 8s），超时升级 SIGKILL */
async function killEmbeddedApp(): Promise<void> {
  const child = embeddedAppProcess;
  embeddedAppProcess = null;
  if (!child) return;
  if (child.exitCode === null && !child.killed) {
    try {
      child.kill();
    } catch {
      // 忽略：进程可能已退出
    }
  }
  // 只等自己 spawn 的这个进程退出 —— 不按进程名全局检查，
  // 否则开发者同时跑着 tauri:dev 的 murasaki 会被误判、误杀。
  for (let i = 0; i < 16; i++) {
    if (child.exitCode !== null) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  // SIGTERM 未生效，升级 SIGKILL
  try {
    child.kill("SIGKILL");
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 1000));
}

/**
 * macOS：harness 自己 spawn 应用（注入 TAURI_WEBDRIVER_PORT + WDIO_EMBEDDED_SERVER
 * 触发内嵌 WebDriver 服务端），轮询 /status 就绪后直连建 session。
 *
 * 没有 tauri-driver 代管应用进程，因此 spawn/kill 都在本文件内闭环，
 * session 生命周期与 Windows/Linux 语义一致 = 每个 spec 一个 fresh 应用实例。
 */
async function createEmbeddedSession(): Promise<Browser> {
  const binary = getBinaryPath();

  // 清掉上次 closeSession 失败的漏网进程，保证 fresh start
  await killEmbeddedApp();

  const env = {
    ...process.env,
    TAURI_WEBDRIVER_PORT: String(EMBEDDED_DRIVER_PORT),
    WDIO_EMBEDDED_SERVER: "true"
  };

  let lastError: unknown = null;
  let browser: Browser | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      embeddedAppProcess = spawn(binary, [], {
        stdio: ["ignore", "pipe", "pipe"],
        env
      });
      embeddedAppProcess.stdout?.on("data", (d: Buffer) =>
        process.stdout.write(`[app] ${d.toString()}`)
      );
      embeddedAppProcess.stderr?.on("data", (d: Buffer) =>
        process.stderr.write(`[app!] ${d.toString()}`)
      );

      await waitForEmbeddedServer(EMBEDDED_DRIVER_PORT);

      // 内嵌服务端不校验 capability（空 alwaysMatch 即可）；如需定向窗口可传
      // alwaysMatch["wdio:tauriServiceOptions"]["windowLabel"]
      const { sessionId } = await createSessionViaHttp(
        EMBEDDED_DRIVER_PORT,
        JSON.stringify({ capabilities: { alwaysMatch: {} } })
      );

      browser = await attach({
        sessionId,
        hostname: DRIVER_HOSTNAME,
        port: EMBEDDED_DRIVER_PORT,
        protocol: "http",
        path: "/",
        capabilities: { alwaysMatch: {} }
      } as any);
      // 同 #300：attach 不合并 remote() 默认配置，必须显式补 waitUntil 重试参数
      browser.options.waitforInterval = WAITFOR_INTERVAL;
      browser.options.waitforTimeout = WAITFOR_TIMEOUT;
      break;
    } catch (err) {
      lastError = err;
      console.warn(
        `[driver] 内嵌 session 创建失败 (attempt ${attempt + 1}/3):`,
        err instanceof Error ? err.message : String(err)
      );
      // 杀掉本轮 spawn 的应用再重试，避免残留进程占住端口
      await killEmbeddedApp();
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  if (!browser) throw lastError;

  // 就绪等待与 Windows/Linux 同一标准：__pinia__ 就绪 ≠ 应用恢复完毕（#315）
  try {
    await waitForPinia(browser);
    await waitForAppReady(browser);
  } catch (err) {
    await closeSession(browser).catch(() => {});
    throw err;
  }

  return browser;
}

/**
 * 用 Node.js http 模块发送 POST /session 请求
 * 绕过 webdriverio 9.x undici 与 tauri-driver hyper 的兼容性问题
 *
 * @param port 服务端口：Windows/Linux = tauri-driver（4444），macOS = 应用内嵌服务端
 * @param body 请求体：Windows/Linux 带 tauri:options.application（driver 负责拉起应用）；
 *              macOS 空 alwaysMatch（内嵌服务端不校验 capability，应用已由 harness 拉起）
 */
function createSessionViaHttp(
  port: number,
  body: string
): Promise<{ sessionId: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: DRIVER_HOSTNAME,
        port,
        path: "/session",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        }
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(
              new Error(
                `Session creation failed: HTTP ${res.statusCode}\n${data.substring(0, 500)}`
              )
            );
            return;
          }
          try {
            const json = JSON.parse(data);
            const sessionId = json.value?.sessionId;
            if (!sessionId) {
              reject(
                new Error(
                  `Session creation failed: no sessionId in response\n${data.substring(0, 500)}`
                )
              );
              return;
            }
            resolve({ sessionId });
          } catch (e) {
            reject(
              new Error(
                `Session creation failed: invalid JSON response\n${data.substring(0, 500)}`
              )
            );
          }
        });
      }
    );

    req.on("error", (e) => reject(new Error(`HTTP request error: ${e.message}`)));
    req.setTimeout(60000, () => {
      req.destroy(new Error("Session creation timeout (60s)"));
    });

    req.write(body);
    req.end();
  });
}

export async function createSession(
  _opts: CreateSessionOptions = {}
): Promise<Browser> {
  // macOS 走内嵌服务端：无 tauri-driver，应用由本文件 spawn
  if (IS_MACOS) return createEmbeddedSession();

  const binary = getBinaryPath();

  // 预检：tauri-driver 在线但 msedgedriver 端口（4445）不在线 = 孤立状态。
  // tauri-driver 只在启动时 spawn 一次 msedgedriver，无法恢复；这种情况下重试
  // POST /session 永远只会得到 socket hang up / 10061，浪费 60s 超时。
  // 失败快、失败清晰，让 setup.ts 的健康检查去重启 driver 栈。
  const driverUp = await isPortListening(DRIVER_PORT);
  const nativeUp = await isPortListening(NATIVE_DRIVER_PORT);
  if (driverUp && !nativeUp) {
    throw new Error(
      `tauri-driver (${DRIVER_PORT}) 在线但 msedgedriver (${NATIVE_DRIVER_PORT}) 未监听 —— tauri-driver 已孤立。\n` +
        "tauri-driver 只在启动时 spawn 一次 msedgedriver，无法恢复。\n" +
        "修复：Stop-Process -Name tauri-driver -Force 后重新跑 e2e/scripts/start-driver.ps1"
    );
  }

  // 重试机制：session 创建偶发失败
  //（DevToolsActivePort file doesn't exist / Chrome instance exited）
  // 注意：不要在重试间杀 msedgedriver —— 那会孤立 tauri-driver。
  let lastError: unknown = null;
  let browser: Browser | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // 1. 用 Node.js http 模块创建 session（绕过 undici 兼容性问题）
      const { sessionId } = await createSessionViaHttp(
        DRIVER_PORT,
        JSON.stringify({
          capabilities: {
            alwaysMatch: {
              "tauri:options": { application: binary }
            }
          }
        })
      );

      // 2. 用 webdriverio attach 连接到已有 session
      //    attach 不发送新的 POST /session 请求，直接复用 sessionId
      //    必须显式传入 hostname/port/protocol —— 见上方 DRIVER_HOSTNAME 注释
      browser = await attach({
        sessionId,
        hostname: DRIVER_HOSTNAME,
        port: DRIVER_PORT,
        protocol: "http",
        path: "/",
        capabilities: {
          alwaysMatch: {
            "tauri:options": { application: binary }
          }
        } as any
      } as any);

      // 关键（#300）：补上 waitUntil 的重试间隔默认值。
      //
      // `attach()` 是复用既有 session，不会走 `remote()` 那套默认配置合并，于是
      // `browser.options.waitforInterval` / `waitforTimeout` 都是 undefined。
      // 而 webdriverio 的 `waitUntil`（node_modules/webdriverio/build/index.js:6435-6448）
      // 是「解构默认值 + typeof 二次兜底」：
      //     interval = this.options.waitforInterval      // 解构默认
      //     if (typeof interval !== "number") interval = this.options.waitforInterval
      // 两者都取不到数时 interval 是 NaN，Timer 的 `_hasTime(NaN)` 为 false →
      // **首轮条件返回 false 就直接 reject**，并抛出
      // `waitUntil condition timed out after <timeout>ms`（消息里的耗时是假的）。
      //
      // 实测（条件恒返回 false）：
      //   `{ timeout: 20000 }`                        → 1 次，0–15ms
      //   `{ timeout: 20000, interval: 200 }`         → 101 次，20008ms
      //   设本默认值后 `{ timeout: 20000 }`            → 100 次，20000ms（符合预期）
      //
      // 因此在这里补默认值，而不是去 90 个 `waitUntil` 调用点逐个加 `interval`
      // （`e2e/specs` 里 90 处，其中只有 25 处带了 `interval`）。
      browser.options.waitforInterval = WAITFOR_INTERVAL;
      browser.options.waitforTimeout = WAITFOR_TIMEOUT;
      break;
    } catch (err) {
      lastError = err;
      console.warn(
        `[driver] session 创建失败 (attempt ${attempt + 1}/3):`,
        err instanceof Error ? err.message : String(err)
      );
      // 等待后重试。不杀 msedgedriver —— 杀了会孤立 tauri-driver。
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  if (!browser) throw lastError;

  // 3. 等应用就绪后再交还给调用方：WebView2 起来不等于前端就绪，Vue/Pinia 还在
  //    加载期间 window.__pinia__ 是 undefined，任何读 store 的 helper 都会抛
  //    "Cannot read properties of undefined (reading '_s')"。
  //    放在重试循环之外：就绪超时应带着清晰报错直接失败，而不是再试 3 遍（30s × 3
  //    会顶穿 beforeAll 的 60s hook 超时）。
  try {
    await waitForPinia(browser);
    // __pinia__ 就绪 ≠ 应用恢复完毕：`onMounted` 里还有一串 await（恢复上次设置 / 工作区 / 标签）。
    // 不等它，spec 的清场可能被这些恢复覆盖（#315）。两者放同一个 try：任一超时都走下面的收尾。
    await waitForAppReady(browser);
  } catch (err) {
    // 就绪超时：调用方的 `browser = await createSession()` 还没赋值，spec 的
    // afterAll 会跳过 closeSession —— 这里自行收尾，否则残留的 murasaki 进程与
    // EBWebView 状态会污染下一个 spec。收尾自身出错不掩盖原始的就绪错误。
    await closeSession(browser).catch(() => {});
    throw err;
  }

  return browser;
}

/**
 * 关闭 session 并确保 murasaki 进程完全退出
 *
 * tauri-driver 的 deleteSession 会通知 msedgedriver 关闭 WebView2，
 * 但 murasaki.exe 主进程可能延迟退出（file watcher 释放句柄需要时间）。
 * 如果不等待，下一个 spec 的 beforeAll 写入 fixture 文件时会遇到 EPERM。
 *
 * msedgedriver 子进程也可能残留，导致下一个 session 创建失败
 *（DevToolsActivePort file doesn't exist / Chrome instance exited）。
 *
 * 关键：murasaki 退出后必须清理 WebView2 用户数据目录（EBWebView），
 * 否则下一次启动 murasaki 时 WebView2 会恢复上次的窗口状态
 *（例如 settings-window 测试遗留的设置窗口），导致新 session 的
 * active window 不是主窗口（title != "Murasaki"），__pinia__ 也不可见。
 */
export async function closeSession(browser: Browser): Promise<void> {
  // 先断掉跨 spec 的标签泄漏（#303）：本 spec 结束时若还开着标签，它们会随 tabs.json
  // 留给下一个 spec —— 后者启动时 App.vue 的 `onMounted` 会 `restore()` 出这批标签，
  // 而它的 `beforeEach` 往往又 `resetWorkspace` 把这些**仍处于打开状态**的文件删掉，
  // 于是触发「文件已被外部删除」模态告警遮挡后续点击（#297 的 CI 失败、#300 排查时
  // 实测 editor-preview 留下 3 个 tab，都是这条路）。
  //
  // 之所以放在这里而不是各 spec 的 afterEach：全部 42 个 spec 都经 closeSession 收尾，
  // 一处即可覆盖；且「本文件最后一个用例」同样会留标签，逐个 spec 补 hook 容易漏。
  try {
    await clearPersistedTabs(browser);
  } catch {
    // 忽略：session 可能已失效，或应用还没就绪（createSession 的就绪失败分支会调本函数）
  }

  try {
    await browser.deleteSession();
  } catch {
    // 忽略：session 可能已经失效
  }

  // macOS：应用进程由本模块 spawn，deleteSession 不会杀它（没有 driver 代管进程
  // 生命周期），必须自己收尸。WebKitGTK/WKWebView 都没有 WebView2 的窗口状态恢复
  // 行为，EBWebView 清理是 Windows 专属，macOS 无需处理。
  if (IS_MACOS) {
    await killEmbeddedApp();
    // 等待文件句柄释放（与下方 Windows/Linux 的收尾等待对齐）
    await new Promise((r) => setTimeout(r, 1200));
    return;
  }

  // 等待 murasaki 进程退出（最多 8 秒）
  let exited = false;
  for (let i = 0; i < 16; i++) {
    if (!isProcessAlive("murasaki")) {
      exited = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!exited) {
    // 超时后强制清理 murasaki（不要杀 msedgedriver —— 会孤立 tauri-driver，
    // 而 tauri-driver 只在启动时 spawn 一次 msedgedriver，无法恢复）。
    killProcessesByName("murasaki", 5000);
  }
  // 等待文件句柄释放（无论正常退出还是强杀）
  await new Promise((r) => setTimeout(r, 1200));

  // 清理 WebView2 用户数据目录：避免下一次 session 恢复上次的窗口状态
  // （例如 settings 窗口）。目录在 %LOCALAPPDATA%\com.murasaki.app\EBWebView\
  //
  // 仅 Windows 执行：Linux 上 Tauri 的 WebKitGTK 数据目录直接就是应用数据目录
  // （~/.local/share/com.murasaki.app/），settings.json（含 zh-CN 预置）也在其中，
  // 整体删除会破坏语言保证；且 WebKitGTK 没有 WebView2 那种窗口状态恢复行为，
  // 无需清理。跨 spec 的持久化设置泄漏仍由各 spec 的 resetPersistenceSettings 处理。
  //
  // 注意：tauri-plugin-store 的持久化设置（sidebarView/editorMode 等）不在此时清理。
  // TRAE Sandbox 会阻止 Node.js 和 PowerShell 子进程删除 %APPDATA%\com.murasaki.app\，
  // 直接 kill 进程。持久化设置泄漏通过 resetPersistenceSettings(browser) 在
  // 各 spec 的 beforeEach 中重置（走 Pinia store API，不涉及文件操作）。
  if (IS_WINDOWS) {
    const identifier = "com.murasaki.app";
    const localAppData = `${process.env.USERPROFILE}\\AppData\\Local`;
    const webviewDir = resolve(localAppData, identifier, "EBWebView");
    if (existsSync(webviewDir)) {
      try {
        rmSync(webviewDir, { recursive: true, force: true });
      } catch (err) {
        // 忽略：偶发 EPERM（WebView2 子进程残留句柄）
        console.warn(`[driver] failed to clean EBWebView:`, err instanceof Error ? err.message : String(err));
      }
    }
  }
}
