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
import { execSync } from "node:child_process";
import http from "node:http";
import { createConnection } from "node:net";

const DEFAULT_BINARY = resolve(
  process.cwd(),
  "src-tauri/target/release/murasaki.exe"
);

// tauri-driver 监听地址。attach() 必须显式传入这些参数 —— webdriverio 9.x 的
// detectBackend() 在 options 为空时返回全 undefined（不会应用默认值），
// 导致 new URL("undefined://undefined:undefined/...") 抛 "Invalid URL"。
const DRIVER_HOSTNAME = "127.0.0.1";
const DRIVER_PORT = 4444;
// tauri-driver 默认把 msedgedriver 监听在这个端口（cli.rs --native-port 默认 4445）。
// 4444 在线但 4445 不在线 = tauri-driver 孤立（msedgedriver 被 cleanup 杀掉了），无法恢复。
const NATIVE_DRIVER_PORT = 4445;

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
 * 用 Node.js http 模块发送 POST /session 请求
 * 绕过 webdriverio 9.x undici 与 tauri-driver hyper 的兼容性问题
 */
function createSessionViaHttp(binary: string): Promise<{ sessionId: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      capabilities: {
        alwaysMatch: {
          "tauri:options": { application: binary }
        }
      }
    });

    const req = http.request(
      {
        hostname: DRIVER_HOSTNAME,
        port: DRIVER_PORT,
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
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // 1. 用 Node.js http 模块创建 session（绕过 undici 兼容性问题）
      const { sessionId } = await createSessionViaHttp(binary);

      // 2. 用 webdriverio attach 连接到已有 session
      //    attach 不发送新的 POST /session 请求，直接复用 sessionId
      //    必须显式传入 hostname/port/protocol —— 见上方 DRIVER_HOSTNAME 注释
      const browser = await attach({
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

      return browser;
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
  throw lastError;
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
 */
export async function closeSession(browser: Browser): Promise<void> {
  try {
    await browser.deleteSession();
  } catch {
    // 忽略：session 可能已经失效
  }
  // 等待 murasaki 进程退出（最多 8 秒）
  for (let i = 0; i < 16; i++) {
    try {
      execSync(
        'powershell -NoProfile -Command "if (Get-Process -Name murasaki -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"',
        { timeout: 2000, stdio: "ignore" }
      );
      return; // 进程已退出
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  // 超时后强制清理 murasaki（不要杀 msedgedriver —— 会孤立 tauri-driver，
  // 而 tauri-driver 只在启动时 spawn 一次 msedgedriver，无法恢复）。
  try {
    execSync(
      'powershell -NoProfile -Command "Get-Process -Name murasaki -ErrorAction SilentlyContinue | Stop-Process -Force"',
      { timeout: 5000, stdio: "ignore" }
    );
  } catch {
    // 忽略
  }
  await new Promise((r) => setTimeout(r, 1500));
}
