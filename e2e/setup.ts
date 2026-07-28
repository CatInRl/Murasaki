/**
 * Vitest globalSetup：
 * 1. 重定向 APPDATA 到 e2e/.appdata/，保证每次测试干净启动
 * 2. 启动 tauri-driver 子进程，监听 4444 端口
 * 3. teardown 时关闭 driver
 */
import { spawn, execSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const DRIVER_PORT = 4444;
// tauri-driver 默认把 msedgedriver 监听在这个端口（cli.rs --native-port 默认 4445）。
// 4444 在线但 4445 不在线 = tauri-driver 孤立（msedgedriver 被 cleanup 杀掉了），无法恢复。
const NATIVE_DRIVER_PORT = 4445;

let driverProcess: ChildProcessWithoutNullStreams | null = null;

/**
 * 清理残留的 murasaki 进程
 * 避免上一次测试运行残留的 murasaki 进程持有文件句柄（file watcher）
 * 导致下一次测试的 fixture 文件写入失败（EPERM）
 *
 * 注意：永远不要在这里杀 msedgedriver。tauri-driver 只在启动时 spawn 一次
 * msedgedriver，无法恢复。直接杀 msedgedriver 会让 tauri-driver 永久孤立，
 * 后续 POST /session 全部失败（socket hang up / 10061）。
 * 如需清理整个 driver 栈，杀 tauri-driver —— Windows Job Object
 * (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) 会自动带走它的 msedgedriver 子进程。
 */
function killStaleProcesses(): void {
  try {
    execSync(
      'powershell -NoProfile -Command "Get-Process -Name murasaki -ErrorAction SilentlyContinue | Stop-Process -Force"',
      { timeout: 10000, stdio: "ignore" }
    );
  } catch {
    // 忽略：可能没有残留进程
  }
}

/** 杀掉残留的 tauri-driver（Job Object 会带走 msedgedriver 子进程） */
function killStaleDriver(): void {
  try {
    execSync(
      'powershell -NoProfile -Command "Get-Process -Name tauri-driver -ErrorAction SilentlyContinue | Stop-Process -Force"',
      { timeout: 10000, stdio: "ignore" }
    );
  } catch {
    // 忽略
  }
}

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

/** 检查端口是否已被监听（用于判断是否已外部启动 tauri-driver） */
async function isPortListening(port: number, host = "127.0.0.1"): Promise<boolean> {
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

export default async function setup(): Promise<void | (() => Promise<void>)> {
  // 0. 清理残留进程（避免上一次测试残留的 murasaki 持有文件句柄）
  killStaleProcesses();

  // 1. 清理真实的 Tauri 应用数据目录（bundle identifier = com.murasaki.app）
  //    - %APPDATA%\com.murasaki.app\  -> tauri-plugin-store (settings/recent/tabs.json)
  //    - %LOCALAPPDATA%\com.murasaki.app\  -> WebView2 用户数据 + murasaki-args.log
  //
  //    注意：tauri-plugin-store 和 WebView2 使用 Win32 SHGetKnownFolderPath
  //    读取真实 APPDATA，不尊重环境变量。所以不重定向 APPDATA，只清理真实目录。
  //    之前重定向 APPDATA 会导致 msedgedriver 启动 murasaki 时，
  //    murasaki 继承了重定向的 APPDATA，但 WebView2 在 msedgedriver 子进程中
  //    可能因路径异常而启动失败（murasaki-argv.log 不生成 = murasaki 未启动）。
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
  //    用 detached + shell 方式启动，避免 vitest fork 环境影响 tauri-driver 的 hyper 服务器
  //    （vitest 环境下 spawn 启动的 tauri-driver 处理 HTTP 请求时会出现 IncompleteMessage）
  //
  //    如果端口 4444 已被外部 tauri-driver 占用（例如通过 start-driver.ps1 预启动），
  //    则跳过 spawn，直接复用外部进程。这样能彻底规避 vitest fork 环境的 hyper 问题。
  const alreadyListening = await isPortListening(DRIVER_PORT);
  if (alreadyListening) {
    const nativeHealthy = await isPortListening(NATIVE_DRIVER_PORT);
    if (nativeHealthy) {
      console.log(
        `[e2e] 检测到外部 tauri-driver 已监听 ${DRIVER_PORT}（msedgedriver ${NATIVE_DRIVER_PORT} 健康），跳过 spawn`
      );
      return async () => {
        // 不杀外部 driver，由外部脚本管理生命周期
      };
    }
    // tauri-driver 在线但 msedgedriver 已死 —— 孤立状态，无法恢复。
    // 杀掉 stale tauri-driver（Job Object 带走 msedgedriver 残骸），落到下方 spawn 新实例。
    console.warn(
      `[e2e] 外部 tauri-driver 监听 ${DRIVER_PORT} 但 msedgedriver 端口 ${NATIVE_DRIVER_PORT} 未监听（已被 cleanup 杀掉），重启 tauri-driver`
    );
    killStaleDriver();
    await new Promise((r) => setTimeout(r, 2000));
  }

  const driverPath = findDriverPath();
  const nativeDriver = findNativeDriverPath();
  const args: string[] = [];
  if (nativeDriver) {
    args.push("--native-driver", nativeDriver);
  }

  driverProcess = spawn(driverPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
    detached: true,
    shell: false
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
        " 并通过 TAURI_DRIVER_PATH 指定路径"
    );
  });

  // 不 unref()，让 tauri-driver 在独立进程组中运行
  // detached: true 已经使其在独立进程组中

  await waitForPort(DRIVER_PORT);
  console.log(`[e2e] tauri-driver 已监听 ${DRIVER_PORT}`);

  return async () => {
    if (driverProcess && !driverProcess.killed) {
      try {
        // detached 进程需要 process.kill 而非 driverProcess.kill
        process.kill(-driverProcess.pid!);
      } catch {
        try { driverProcess.kill(); } catch { /* ignore */ }
      }
      driverProcess = null;
    }
  };
}
