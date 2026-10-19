#!/usr/bin/env node
/**
 * 发布前门禁（#446）。
 *
 * 做两件事，任一失败就拒绝发布：
 * 1. 校验 tag 与三处版本号一致：package.json / src-tauri/Cargo.toml / src-tauri/tauri.conf.json
 * 2. 校验 tag 提交的 CI 必需检查全部成功（可轮询等待；手动触发可跳过）
 *
 * 用法：
 *   TAG=v0.11.0 node scripts/check-release-ready.mjs
 *   TAG=v0.11.0 REQUIRE_CHECKS=1 node scripts/check-release-ready.mjs
 *
 * 环境变量：
 *   TAG               必填，形如 v1.2.3
 *   REQUIRE_CHECKS    1 = 等待并校验 GitHub check-runs；其它值跳过
 *   GITHUB_TOKEN / GITHUB_REPOSITORY / GITHUB_SHA  校验 check-runs 时必填（CI 自动提供）
 *   MAX_WAIT_SECONDS  等待 check-runs 的上限，默认 2400（40 分钟）
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

/**
 * 发布前必须全绿的 check 名。
 *
 * e2e 自 #444 起在三个平台各切 4 片（见 .github/workflows/test.yml），
 * job 名带形如 `e2e (2/4)` 的分片后缀 —— 改分片数时这里要同步改，
 * 否则发布会被拦在「等一个不存在的 check」。与本文件保持一致的地方还有：
 * 分支保护的 required_status_checks、AGENTS.md 的「过门禁」一节。
 */
const E2E_SHARD_COUNT = 4;
const REQUIRED_CHECKS = [
  "frontend",
  "rust",
  ...Array.from({ length: E2E_SHARD_COUNT }, (_, i) => `e2e (${i + 1}/${E2E_SHARD_COUNT})`),
  ...Array.from({ length: E2E_SHARD_COUNT }, (_, i) => `e2e (linux) (${i + 1}/${E2E_SHARD_COUNT})`),
  ...Array.from({ length: E2E_SHARD_COUNT }, (_, i) => `e2e (macos) (${i + 1}/${E2E_SHARD_COUNT})`),
];

function fail(message) {
  console.error(`✖ ${message}`);
  process.exit(1);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(resolve(ROOT, path), "utf8"));
  } catch (err) {
    fail(`读取 ${path} 失败: ${err.message}`);
  }
}

/** 从 Cargo.toml 的 [package] 段读取 version（避免匹配到依赖的版本号） */
function readCargoVersion() {
  const text = readFileSync(resolve(ROOT, "src-tauri/Cargo.toml"), "utf8");
  const match = text.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m);
  if (!match) fail("src-tauri/Cargo.toml 中找不到 [package] version");
  return match[1];
}

function checkVersions(version) {
  const packageVersion = readJson("package.json").version;
  const cargoVersion = readCargoVersion();
  const tauriVersion = readJson("src-tauri/tauri.conf.json").version;
  const versions = {
    "package.json": packageVersion,
    "Cargo.toml": cargoVersion,
    "tauri.conf.json": tauriVersion,
  };
  const mismatched = Object.entries(versions).filter(([, v]) => v !== version);
  if (mismatched.length > 0) {
    fail(
      `版本号与 tag v${version} 不一致：` +
        mismatched.map(([file, v]) => `${file}=${v}`).join(" / ")
    );
  }
  console.log(`✓ 三处版本号一致：${version}`);
}

async function checkRuns(sha) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo || !sha)
    fail("缺少 GITHUB_TOKEN / GITHUB_REPOSITORY / GITHUB_SHA，无法校验 CI");
  const maxWait = Number(process.env.MAX_WAIT_SECONDS ?? 2400) * 1000;
  const deadline = Date.now() + maxWait;

  while (true) {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/commits/${sha}/check-runs?per_page=100`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );
    if (!response.ok) fail(`查询 check-runs 失败: HTTP ${response.status}`);
    const body = await response.json();
    const byName = new Map((body.check_runs ?? []).map((run) => [run.name, run]));
    const states = REQUIRED_CHECKS.map((name) => {
      const run = byName.get(name);
      return { name, status: run?.status ?? "missing", conclusion: run?.conclusion ?? null };
    });
    const failed = states.filter((s) => s.status === "completed" && s.conclusion !== "success");
    if (failed.length > 0) {
      fail(`CI 检查未通过：${failed.map((s) => `${s.name}=${s.conclusion}`).join(" / ")}`);
    }
    const pending = states.filter((s) => s.status !== "completed");
    if (pending.length === 0) {
      console.log(`✓ ${REQUIRED_CHECKS.length} 项必需检查全部通过`);
      return;
    }
    if (Date.now() >= deadline) {
      fail(
        `等待 CI 超时：${pending.map((s) => `${s.name}=${s.status}`).join(" / ")}。` +
          "请等 Test workflow 跑完后再打 tag。"
      );
    }
    console.log(`… 等待 CI：${pending.map((s) => `${s.name}=${s.status}`).join(" / ")}`);
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

async function main() {
  const tag = process.env.TAG ?? "";
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) fail(`TAG 必须是 vX.Y.Z，收到 "${tag}"`);
  const version = tag.slice(1);
  checkVersions(version);
  if (process.env.REQUIRE_CHECKS === "1") {
    await checkRuns(process.env.GITHUB_SHA);
  } else {
    console.log("… 跳过 CI check-runs 校验（REQUIRE_CHECKS != 1）");
  }
  console.log(`✓ 发布门禁通过：${tag}`);
}

main().catch((err) => fail(err?.message ?? String(err)));
