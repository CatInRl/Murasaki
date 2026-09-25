# ADR 0019: 主干开发 + 短分支 PR 工作流

## 状态

已接受

## 背景

Murasaki 至今是单人或小规模维护（作者 + AI Agent）：所有改动直接提交 `main`——历史里已有 22 个 merge commit（一次 UI 改造留下 25 个 `feat/tXX-*` 分支，直接 merge 而未走 PR）。CI 只有打 tag 触发的 [release.yml](../../.github/workflows/release.yml)，没有任何测试门禁；main 分支保护未开启；根目录长期堆着 `*.log`、一次性 `harness-*.html` 与截图等调试产物。

「直推 main」带来三个具体问题：

1. **没有验证门禁**：改动是否让 `npm test`（1028 用例）/ `cargo test`（90 用例）/ `vue-tsc` 挂掉，只有本地跑过才知道；推上 main 即成既成事实。
2. **没有审查痕迹**：改动为什么这么做、边界在哪，只能靠 commit message 与 ADR 反推；PR 这种「讨论 + 自查结论」的载体完全缺失。
3. **没有回滚单位**：一个功能拆成多个直接提交落在 main，出问题只能逐个 revert。

同时项目已有成熟的 issue 规范（spec issue + 子 issue + `Part of #N`），但 issue 与代码之间缺一段：任务怎么变成分支、怎么进入 main，没有约定。

## 决策

**主干开发（trunk-based）+ 短生命周期分支 + PR 合入**。

1. **`main` 恒为可发布状态**，不引入 `develop` 与 `release/x.y` 分支；版本准备单独走一个 `chore(release)` PR。
2. **分支命名 `<type>/<issue>-<slug>`**，`<type>` 取 Conventional Commits 类型；分支从最新 main 切出，生命周期以「一个 issue 的活干完」为界。
3. **PR 是进入 main 的唯一通道**：标题 `<type>(<scope>): <描述> (#<issue>)`；描述按 `.github/pull_request_template.md`（变更摘要 / 关联 issue / 验证方式 / 风险与回滚）。
4. **门禁自动化**：新增 `.github/workflows/test.yml`，PR 与 push main 触发；`frontend`（ubuntu：`npm test` + `npm run build`）与 `rust`（windows：`npm run build` + `npm run test:rust`）两个 job；e2e 依赖 tauri-driver，保持本地跑。
5. **main 分支保护**：required status checks = 上述两个 job、Require branches to be up to date before merging、`enforce_admins=false`（管理员豁免仅用于紧急修复）、不设 required approving review。
6. **合入方式为 squash**：一个 PR 压成一个 conventional commit，PR 标题即提交信息。
7. **审查由 Agent 自查承担**：合入前跑 `/code-review` skill，把结论贴在 PR 里，替代人工 approving review。
8. **Agent 的自主边界**：可自主切分支 / 提交 / 推送 / 开 PR；**squash 合入 main 前必须得到用户确认**。

## 理由

1. **单人 + AI 协作下，主干开发是唯一不亏的选择** —— 分支的价值是「隔离未完成的工作」与「承载审查」，不是隔离并行团队。短分支两点都拿到了，又不引入长期分叉的合并成本。
2. **门禁必须自动，否则等于没有** —— 这个项目没有第二双人手；靠「记得本地跑测试」的历史已经证明会漏（0.9.0 端到端自测一次性揪出 4 个 P0）。CI 是把「自觉」换成「机器拒绝」的唯一手段。
3. **squash 让 CHANGELOG 与回滚都变简单** —— `release.yml` 从 `CHANGELOG.md` 提取段落，而 CHANGELOG 条目本就按 issue / 功能组织；一个 PR 一个提交正好一一对应，回滚粒度也是「一个功能」。
4. **不设 required approving review 是单人仓库的必然** —— GitHub 不允许作者批准自己的 PR，设了这条等于把门禁焊死；把审查责任交给可复现的 code-review skill 输出，比一条永远填不上的审批要求更有价值。
5. **保留管理员豁免** —— 门禁的意义是「防止疏忽」，不是「阻止作者修线上」；紧急修复仍应能绕过，但必须自知这是例外。

## 备选方案

**Git Flow（develop + release/\* + hotfix/\*）** —— 被否决：这套模型解决的是「多版本并行维护 + 长冻结期」，而 Murasaki 是单版本连续滚动、按版本直接发布的桌面应用；引入 develop 只会让「main 上跑的是什么」变成需要解释的问题。

**维持直推 main** —— 被否决：见背景的三个问题；项目已有成熟 issue 规范，缺的正是 issue → 代码这一段。

**merge commit（`--no-ff`）合入** —— 被否决：保留分支内每个提交会让 main 历史继续膨胀（现状已有 22 个 merge commit），且「回滚一个功能」要 revert 一个 merge，比 revert 一个 squash 提交麻烦。

**rebase 合入** —— 被否决：线性历史好看，但重写哈希会断掉「PR ↔ 提交」的对应，多提交 PR 的回溯成本明显上升。

**把 e2e 纳入 CI** —— 被否决：e2e 依赖 tauri-driver + msedgedriver 且是 Windows 专属（见 [e2e/scripts/check-env.ps1](../../e2e/scripts/check-env.ps1)），塞进 ubuntu runner 需要另一套驱动方案，收益不抵维护成本。

**引入 release/x.y 分支做版本冻结** —— 被否决：没有并行开发下一版本的需求，也没有等待冻结期的下游；版本准备用一个 `chore(release)` PR 就够。

## 后果

**正面**

- 任何进入 main 的改动都过了单测 + 类型检查 + Rust 测试，回归在 PR 阶段暴露。
- 每个功能有 PR 作为「为什么这么做」的载体，与 issue 双向关联（`Closes #N` / `Part of #N`）。
- 回滚单位清晰：`git revert <squash commit>` 对应一个功能。
- 分支名带 issue 号后，`git branch` / `gh pr list` 能直接看出每个分支在做什么。

**负面**

- 文档类改动（如本 ADR）也要走 PR，比直接提交慢一步——这是刻意代价，换取 main 历史可读。
- CI 两个 job 每个 PR 都要跑一遍前端构建与 Rust 编译，Rust job 尤其慢。若日后成为瓶颈，可改为 rust job 仅在 `src-tauri/**` 变更时触发。
- 保护规则开启后 Agent 的自主边界停在「开 PR」，合入前需要用户介入一次——这是有意的检查点。

## 实施边界

### 文件改动

- `AGENTS.md`：新增「开发流程」章节；改写「Issue 跟踪约定」（`T{簇号}.{序号}` 降级为 spec 内的顺序标签）。
- 新增 `.github/pull_request_template.md`、`.github/workflows/test.yml`、本 ADR。
- `.gitignore`：补 `/harness-*.html`、`/*.png`（根目录一次性调试产物）。
- GitHub 侧（非文件）：main 分支保护、仓库「Automatically delete head branches」。

### 范围外

- 把 e2e 纳入 CI。
- release/x.y 分支与版本冻结流程。
- 引入第二个人工评审者 / 强制 approving review。
- 对 `feat/tXX-*` 等历史分支的追溯性改写。
