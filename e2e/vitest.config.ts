import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readdirSync } from "node:fs";

const e2eRoot = dirname(fileURLToPath(import.meta.url));

/**
 * 已知 flake 的隔离清单（#444）。
 *
 * 用法：`E2E_QUARANTINE=wysiwyg-full,scroll-sync`（spec 文件名，可省略 `.spec.ts`）。
 * 默认空 —— 不隔离任何用例；隔离后该文件不参与本次运行，但仍在仓库里等待修复。
 */
const quarantined = (process.env.E2E_QUARANTINE ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean)
  .map((name) => `specs/${name.endsWith(".ts") ? name : `${name}.spec.ts`}`);

/**
 * CI 分片（#444）：`E2E_SHARD=2/4` 表示共 4 片、跑第 2 片。
 *
 * **不用 Vitest 内置的 `--shard`**：它按 spec 路径 sha1 排序后**按文件数均分**，
 * 不看每个文件有多少用例。实测 41 个文件切 4 片得到 66 / 81 / 54 / **164** 条 ——
 * `wysiwyg-full.spec.ts` 一个文件就 79 条、约 170 秒，全落进第 4 片，
 * 于是整体耗时仍由那一片决定，等于白分。
 *
 * 因此这里改用**显式分组**：按用例数把文件摊到各片，权重高的（wysiwyg-full）
 * 单独占一片起头。分组变了只要改下表；片数变了要同步改 CI 的 matrix
 * 与分支保护的 required checks（job 名是 `e2e (2/4)` 这种格式）。
 */
/**
 * 分片原则：**按「每片会启动几次应用」均衡，而不是按用例数**。
 *
 * 瓶颈是 session 启动（Linux 上每个 spec ≈30s），所以先保证各片文件数接近
 * （≈10 个/片），再让 `wysiwyg-full` 这种 79 条的重头单独占一片 —— 它的耗时
 * 主要也在用例上，不与其它文件争。
 *
 * 当前估算（Linux）：第 1 片 wysiwyg-full ≈ 170s + 启动；其余三片各 ≈10 个文件
 * + 80 条用例。实测值请以 CI 为准，调整时只改下表。
 */
const SHARD_GROUPS: string[][] = [
  [
    "wysiwyg-full",
    "file-tree-keyboard",
    "editor-toolbar",
    "smoke",
    "search-navigation",
    "external-modifications",
    "context-menu-keyboard",
  ],
  [
    "detailed",
    "drag-drop",
    "toast",
    "wysiwyg-mode",
    "workspace",
    "context-menu",
    "file-tree-search",
    "menu-events",
    "inspect",
    "image-drop",
    "settings-runtime",
  ],
  [
    "misc-visual",
    "shortcuts",
    "presentation-mode",
    "state-display",
    "tab-overflow",
    "tabs",
    "verify-wysiwyg-manual",
    "status-bar",
    "persistence-recovery",
    "scroll-sync",
    "multi-window",
  ],
  [
    "file-operations",
    "wysiwyg-widgets",
    "design-system",
    "html-export",
    "dialog",
    "context-menu-business",
    "editor-preview",
    "settings-explicit-save",
    "outline-navigation",
    "global-search",
    "driver-reuse",
    "settings-window",
  ],
];

function resolveShardInclude(): string[] | null {
  const raw = process.env.E2E_SHARD?.trim();
  if (!raw) return null;
  const match = /^(\d+)\/(\d+)$/.exec(raw);
  if (!match) {
    throw new Error(`E2E_SHARD 格式应为 "序号/总数"（如 2/4），收到: ${raw}`);
  }
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (index < 1 || index > count) {
    throw new Error(`E2E_SHARD 序号越界: ${raw}`);
  }
  if (count !== SHARD_GROUPS.length) {
    // 直接报错而不是静默跑全集：片数与分组表不一致会让某些文件永远没人跑
    throw new Error(
      `E2E_SHARD 总数 ${count} 与分组表长度 ${SHARD_GROUPS.length} 不一致；` +
        `请同步更新 e2e/vitest.config.ts 的 SHARD_GROUPS 与 CI matrix`
    );
  }
  const group = SHARD_GROUPS[index - 1];
  if (!group || group.length === 0) {
    throw new Error(`E2E_SHARD ${raw} 对应的分组是空的`);
  }
  return group.map((name) => `specs/${name}.spec.ts`);
}

/**
 * 分组表的一致性自检：漏列一个 spec 会让它在 CI 上**永远不跑**，且没有任何报错，
 * 所以宁可在这里直接抛错。新增 spec 文件时必须同时加进某个分组。
 */
function assertShardGroupsComplete(): void {
  const listed = new Set(SHARD_GROUPS.flat());
  const duplicates = SHARD_GROUPS.flat().filter((name, i, all) => all.indexOf(name) !== i);
  if (duplicates.length > 0) {
    throw new Error(`E2E 分片分组表里有重复项: ${[...new Set(duplicates)].join(", ")}`);
  }
  const onDisk = readdirSync(join(e2eRoot, "specs"))
    .filter((file) => file.endsWith(".spec.ts"))
    .map((file) => file.replace(/\.spec\.ts$/, ""));
  const missing = onDisk.filter((name) => !listed.has(name));
  if (missing.length > 0) {
    throw new Error(
      `以下 e2e spec 未加入 SHARD_GROUPS，CI 分片下不会被任何一片跑到: ${missing.join(", ")}`
    );
  }
}

assertShardGroupsComplete();

const shardInclude = resolveShardInclude();

/**
 * E2E 测试配置
 * - 串行执行（避免多个 Tauri 实例同时启动）：`fileParallelism: false` +
 *   `isolate: false` 让所有 spec 在同一个 fork 里依次跑
 * - 超时放宽到 60s（应用冷启动慢）
 * - 通过 globalSetup 启动 tauri-driver，由各测试文件自行创建 session
 * - root 指向 e2e/ 目录，使 include/specs 相对解析
 *
 * 注意：原写法 `poolOptions.forks.singleFork` 在 Vitest 4 已被移除（旧写法只会打印
 * 弃用警告并被忽略，串行保障会静默失效），等价顶层选项是 `fileParallelism: false`。
 */
export default defineConfig({
  test: {
    root: e2eRoot,
    // 分片时只跑本片列出的文件；未设置 E2E_SHARD 时跑全集（本地默认行为不变）
    include: shardInclude ?? ["specs/**/*.spec.ts"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 60000,
    // 已知 flake 重试一次（#444）：真实 WebView 的启动/渲染抖动不应让门禁变红
    retry: 1,
    exclude: ["**/node_modules/**", ...quarantined],
    globalSetup: resolve(e2eRoot, "setup.ts"),
    globals: true,
    isolate: false,
  },
});
