#!/usr/bin/env node
/**
 * E2E 环境预检（跨平台，替代 check-env.ps1）：
 * 1. tauri-driver：TAURI_DRIVER_PATH → ~/.cargo/bin → PATH（macOS 免检，见下）
 * 2. 原生 driver：Windows = msedgedriver（同上查找顺序）；
 *    Linux = WebKitWebDriver（webkit2gtk-driver 包，需在 PATH）
 * 3. 被测应用二进制：MURASAKI_BINARY → Windows/Linux = target/release/murasaki[.exe]，
 *    macOS = target/debug/murasaki（内嵌 WebDriver 服务端仅 debug 构建注册）
 *
 * macOS 例外：tauri-driver 不支持 WKWebView，走应用内嵌 WebDriver 服务端
 * （tauri-plugin-wdio-webdriver，仅 debug 构建），应用进程由 driver.ts spawn，
 * 无需 tauri-driver 与原生 driver。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const isWindows = process.platform === "win32";
const isMacOS = process.platform === "darwin";
const exeSuffix = isWindows ? ".exe" : "";
const homeDir = isWindows ? process.env.USERPROFILE : process.env.HOME;

/** 探测命令是否在 PATH 中 */
function inPath(name) {
  try {
    execFileSync(isWindows ? "where" : "which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const problems = [];

// 1+2. 外部 driver 栈（macOS 免检：内嵌服务端随应用 spawn，无外部 driver）
if (isMacOS) {
  console.log("[ok] macOS: 应用内嵌 WebDriver 服务端，无需 tauri-driver / 原生 driver");
} else {
  // 1. tauri-driver
  const tauriDriver =
    process.env.TAURI_DRIVER_PATH ??
    (homeDir ? join(homeDir, ".cargo", "bin", `tauri-driver${exeSuffix}`) : null);
  if (tauriDriver && existsSync(tauriDriver)) {
    console.log(`[ok] tauri-driver: ${tauriDriver}`);
  } else if (inPath(`tauri-driver${exeSuffix}`)) {
    console.log("[ok] tauri-driver: PATH");
  } else {
    problems.push(
      "未找到 tauri-driver。安装：cargo install tauri-driver\n" +
        "      或通过 TAURI_DRIVER_PATH 指定路径"
    );
  }

  // 2. 原生 driver
  if (isWindows) {
    const msedgedriver =
      process.env.MSEDGEDRIVER_PATH ??
      (homeDir ? join(homeDir, ".cargo", "bin", "msedgedriver.exe") : null);
    if (msedgedriver && existsSync(msedgedriver)) {
      console.log(`[ok] msedgedriver: ${msedgedriver}`);
    } else if (inPath("msedgedriver.exe")) {
      console.log("[ok] msedgedriver: PATH");
    } else {
      problems.push(
        "未找到 msedgedriver。运行 e2e/scripts/install-msedgedriver.ps1 安装"
      );
    }
  } else if (inPath("WebKitWebDriver")) {
    console.log("[ok] WebKitWebDriver: PATH");
  } else {
    problems.push("未找到 WebKitWebDriver。安装：sudo apt install webkit2gtk-driver");
  }
}

// 3. 应用二进制（macOS 必须 debug 构建：内嵌 WebDriver 服务端仅 debug 注册，
//    release 二进制没有 /status，waitForEmbeddedServer 必超时）
const binary =
  process.env.MURASAKI_BINARY ??
  (isMacOS
    ? "src-tauri/target/debug/murasaki"
    : `src-tauri/target/release/murasaki${exeSuffix}`);
if (existsSync(binary)) {
  console.log(`[ok] 应用二进制: ${binary}`);
} else {
  problems.push(
    `未找到应用二进制 ${binary}。构建：npx tauri build --no-bundle${isMacOS ? " --debug" : ""}`
  );
}

if (problems.length > 0) {
  console.error("\n[e2e 预检失败]");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("\n[e2e 预检通过]");
