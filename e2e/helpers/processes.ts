/**
 * 跨平台进程收尾辅助（setup.ts 全局清理与 driver.ts closeSession 共用）。
 *
 * Windows 走 PowerShell（Get-Process / Stop-Process）；POSIX 走 procps 的
 * pgrep / pkill（ubuntu runner 自带）。进程名按精确匹配（-x）；
 * "tauri-driver" 12 字符，不受 comm 名 15 字符截断影响。
 */
import { execSync } from "node:child_process";
import { IS_WINDOWS } from "./platform";

/** 进程是否存活（按进程名精确匹配；单次探测超时 2s） */
export function isProcessAlive(name: string): boolean {
  if (IS_WINDOWS) {
    try {
      // 脚本约定：exit 0 = 不存在，exit 1 = 存在
      execSync(
        `powershell -NoProfile -Command "if (Get-Process -Name ${name} -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"`,
        { timeout: 2000, stdio: "ignore" }
      );
      return false;
    } catch {
      return true;
    }
  }
  try {
    execSync(`pgrep -x ${name}`, { timeout: 2000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** 按进程名强制结束进程（不存在时静默） */
export function killProcessesByName(name: string, timeoutMs = 10000): void {
  try {
    if (IS_WINDOWS) {
      execSync(
        `powershell -NoProfile -Command "Get-Process -Name ${name} -ErrorAction SilentlyContinue | Stop-Process -Force"`,
        { timeout: timeoutMs, stdio: "ignore" }
      );
    } else {
      // pkill 找不到进程时返回 1 —— execSync 会抛错，由外层 try/catch 兜住
      execSync(`pkill -x ${name}`, { timeout: timeoutMs, stdio: "ignore" });
    }
  } catch {
    // 忽略：可能没有残留进程
  }
}
