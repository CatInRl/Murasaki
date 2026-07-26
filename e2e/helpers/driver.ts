/**
 * WebDriver 客户端创建辅助
 * 通过 tauri-driver 启动 Murasaki binary，并返回一个 Browser 实例
 *
 * 关键能力格式（参考 tauri-driver 2.0.6 src/server.rs）：
 * - `tauri:options.application` 必须是字符串路径（PathBuf），不是对象
 * - 不要传 `browserName: "wry"`，tauri-driver 会自动注入 `browserName: "webview2"`
 *   + `ms:edgeOptions.binary` + `ms:edgeChromium: true` 转发给 msedgedriver
 * - 若传 `browserName`，msedgedriver 不识别 "wry" 会直接报 "No matching capabilities found"
 */
import { remote, type Browser } from "webdriverio";
import { resolve } from "node:path";

const DEFAULT_BINARY = resolve(
  process.cwd(),
  "src-tauri/target/release/murasaki.exe"
);

export function getBinaryPath(): string {
  return process.env.MURASAKI_BINARY ?? DEFAULT_BINARY;
}

export interface CreateSessionOptions {
  /** 启动后等待窗口可见的超时（毫秒） */
  startupTimeout?: number;
}

export async function createSession(
  _opts: CreateSessionOptions = {}
): Promise<Browser> {
  const binary = getBinaryPath();
  return remote({
    hostname: "127.0.0.1",
    port: 4444,
    capabilities: {
      alwaysMatch: {
        // application 必须是字符串路径，不是 {binary: ...} 对象
        // tauri-driver 会自动注入 browserName="webview2" + ms:edgeOptions
        "tauri:options": {
          application: binary
        }
      }
    } as any
  });
}
