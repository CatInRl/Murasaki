/**
 * Vitest globalSetup：
 * 1. 重定向 APPDATA 到 e2e/.appdata/，保证每次测试干净启动
 * 2. 启动 tauri-driver 子进程，监听 4444 端口
 * 3. teardown 时关闭 driver
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const DRIVER_PORT = 4444;

let driverProcess: ChildProcessWithoutNullStreams | null = null;

/** 轮询等待端口可连 */
async function waitForPort(
  port: number,
  host = "127.0.0.1",
  timeout = 30000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ok = await new Promise<boolean>((res) => {
      const sock = createConnection({ port, host });
      sock.setTimeout(1500);
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
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`tauri-driver 未在 ${timeout}ms 内监听 ${port}`);
}

/** 查找 tauri-driver 二进制路径（优先 .cargo\bin） */
function findDriverPath(): string {
  if (process.env.TAURI_DRIVER_PATH) return process.env.TAURI_DRIVER_PATH;
  if (process.env.USERPROFILE) {
    const p = `${process.env.USERPROFILE}\\.cargo\\bin\\tauri-driver.exe`;
    if (existsSync(p)) return p;
  }
  // Windows 上 spawn 不会查 PATH，回退到 'tauri-driver' 让系统查找
  return "tauri-driver.exe";
}

/** 查找 msedgedriver 二进制路径 */
function findNativeDriverPath(): string | null {
  if (process.env.MSEDGEDRIVER_PATH) return process.env.MSEDGEDRIVER_PATH;
  if (process.env.USERPROFILE) {
    const p = `${process.env.USERPROFILE}\\.cargo\\bin\\msedgedriver.exe`;
    if (existsSync(p)) return p;
  }
  return null;
}

export default async function setup(): Promise<void | (() => Promise<void>)> {
  // 1. 重定向 APPDATA（保证每次测试干净启动）
  //    注意：tauri-plugin-store 和 WebView2 使用 Win32 SHGetKnownFolderPath
  //    读取真实 APPDATA，不尊重环境变量。所以还需要单独清理真实目录。
  const appdataRoaming = resolve(process.cwd(), "e2e/.appdata/Roaming");
  const appdataLocal = resolve(process.cwd(), "e2e/.appdata/Local");
  for (const dir of [appdataRoaming, appdataLocal]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
  process.env.APPDATA = appdataRoaming;
  process.env.LOCALAPPDATA = appdataLocal;

  // 1b. 清理真实的 Tauri 应用数据目录（bundle identifier = com.murasaki.app）
  //     - %APPDATA%\com.murasaki.app\  -> tauri-plugin-store (settings/recent/tabs.json)
  //     - %LOCALAPPDATA%\com.murasaki.app\  -> WebView2 用户数据 + murasaki-args.log
  const identifier = "com.murasaki.app";
  for (const base of [
    `${process.env.USERPROFILE}\\AppData\\Roaming`,
    `${process.env.USERPROFILE}\\AppData\\Local`
  ]) {
    const realDir = resolve(base, identifier);
    if (existsSync(realDir)) {
      console.log(`[e2e] cleaning real app data: ${realDir}`);
      try {
        rmSync(realDir, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[e2e] failed to clean ${realDir}:`, err);
      }
    }
  }

  // 2. 启动 tauri-driver，显式传入 --native-driver 路径
  const driverPath = findDriverPath();
  const nativeDriver = findNativeDriverPath();
  const args: string[] = [];
  if (nativeDriver) {
    args.push("--native-driver", nativeDriver);
  }

  driverProcess = spawn(driverPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env }
  });

  driverProcess.stdout?.on("data", (d: Buffer) =>
    process.stdout.write(`[driver] ${d.toString()}`)
  );
  driverProcess.stderr?.on("data", (d: Buffer) =>
    process.stderr.write(`[driver!] ${d.toString()}`)
  );

  driverProcess.once("error", (err) => {
    console.error("[e2e] tauri-driver 启动失败：", err);
    console.error(
      "请先安装 tauri-driver：\n" +
        "  方式 1：cargo install tauri-driver\n" +
        "  方式 2：从 https://github.com/tauri-apps/tauri-driver/releases 下载\n" +
        "  并通过 TAURI_DRIVER_PATH 指定路径"
    );
  });

  await waitForPort(DRIVER_PORT);
  console.log(`[e2e] tauri-driver 已监听 ${DRIVER_PORT}`);

  return async () => {
    if (driverProcess && !driverProcess.killed) {
      driverProcess.kill();
      driverProcess = null;
    }
  };
}
