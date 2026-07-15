# DDD Coding Skills v3

[English](README.md) | 中文

面向 Codex 与 Claude Code 的 Sol-native 领域驱动设计开发工作流。GPT-5.6 Sol 负责领域推理、实现与评审；精简技能提供可复用的 DDD 流程；`roadmapctl` 对范围、状态、证据、Git 绑定和恢复拥有确定性控制权。

## GPT-5.6 Sol 已经很强，为什么还需要这个技能

Sol 已具备 DDD 与复杂工程实现能力。本技能不再向模型重复灌输教程，也不替代模型判断；它负责固定项目交付流程，防止长期任务退化为互不兼容的模块、未接线占位实现、过期规格或父范围假完成。

职责边界如下：

- **Sol：** 统一语言、限界上下文、聚合设计、实现策略、TDD 与代码评审。
- **Skills：** 规划、单叶开发、审计和编排的精简操作规程。
- **roadmapctl：** 规范 JSON 校验、叶子选择、哈希、尝试上限、精确 Git 范围、门禁、原子状态变更与崩溃恢复。

## 规范事实源

- `docs/roadmap/roadmap.json` 是可执行路线图。
- `docs/specs/*.json` 是可执行行为契约。
- `docs/product-brief.md` 记录经评审的产品意图，但不授予任何权限。
- `docs/roadmap/roadmap.md` 与 `docs/specs/*.md` 只是生成人类视图。
- `.ddd/runs/*.json` 保存控制器证据；`docs/runs/*.json` 是不可变终态报告。

执行过程从不解析生成 Markdown 的状态或覆盖关系。每个路线图叶子都必须是一个带真实消费者、可观察结果、稳定 AC ID、依赖和必需门禁的垂直切片。

## 确定性生命周期

`validate → start → next → record → verify → audit → attest → finish → close`

1. `validate` 校验 schema、依赖图、规格绑定、消费者和结构化门禁命令。
2. `start` 展开完整 selector，创建隔离运行分支与日志。
3. `next` 只签发一个依赖就绪叶子及其已批准规格。
4. Sol 用 TDD 实现该叶子和真实消费路径，并创建本地实现提交。
5. `record` 绑定精确基线/实现 SHA 与该叶子的完整 AC 集合。
6. `verify` 在无 shell 模式下执行已授权的规格、测试、消费者和 E2E 门禁。
7. `audit` 审计精确提交范围，并将详细发现写到控制器指定路径。
8. `attest` 校验 run/item/spec/SHA 身份并重新计算严重级别事实。
9. `finish` 仅在所有门禁通过后原子结算当前叶子。
10. `close` 写不可变运行报告；只有范围内所有叶子完成才是成功。

一个子项完成永远不会让复合范围完成。若 `P1.1` 展开为 7 个叶子，完成 `P1.1.1` 后 `remaining` 仍有 6 个 ID，功能保持 `in_progress`，`ddd-auto` 必须恢复并领取控制器选择的下一个叶子。

## 闭环门禁

- **规格绑定：** 已批准行为哈希、共享契约字节与 AC-to-item 覆盖必须最新。
- **Git 绑定：** 证据绑定 `itemBaselineSha..implementationSha`，无关或未记录修改不能完成叶子。
- **消费者/E2E：** 只有内部领域代码不算完成，必须贯通声明的生产调用方与端到端流程。
- **审计：** 详细 findings 必须与计数一致；CRIT 或 HIGH 会阻断完成。
- **状态：** 控制器以事务方式同步规范 JSON、生成视图、记账提交、运行日志与报告，并支持幂等恢复。

系统不存在警告成功、跳过成功或手工完成父节点的路径。

## 技能

| 技能 | 职责 |
|---|---|
| `ddd-init` | 准备 Node/控制器路径、DDD 架构指令与有界本地策略 |
| `ddd-roadmap` | 生成产品意图、垂直切片 `roadmap.json` 与草稿 JSON 规格 |
| `ddd-spec` | 评审结构化模型/契约/AC 覆盖并绑定已批准规格哈希 |
| `ddd-develop` | 用 TDD、真实消费者、门禁和本地提交实现一个控制器叶子 |
| `ddd-audit` | 生成只读精确范围 findings 与控制器证明 |
| `ddd-auto` | 对一个已批准 selector 驱动显式控制器动作循环 |
| `ddd-auto-cleanup` | 确认中止、以非成功状态关闭并保存全部证据 |

## 如何选择技能

| 场景 | 调用 | 效果 |
|---|---|---|
| 初始化新项目或接入现有项目 | `ddd-init` | 建立架构指令和确定性状态路径，但不创建路线图 |
| 创建或修订产品意图与交付范围 | `ddd-roadmap [scope]` | 创建 canonical `roadmap.json` 与草稿 JSON specs；缺少 roadmap 是受支持的初始化状态 |
| 评审并绑定一个 feature 契约 | `ddd-spec P1.1` | 审批精确模型、契约、消费者和 AC 覆盖，然后绑定 spec hash |
| 正式执行一个 leaf、feature 或 phase | `ddd-auto P1.1.1` / `ddd-auto P1.1` / `ddd-auto P1` | 启动 controller run，并用门禁和证据结算全部选中叶子；正式执行单个 leaf 也应使用它 |
| 实现不要求正式 roadmap 结算的工作 | `ddd-develop <有界需求>` | 执行 ad-hoc TDD 切片，不更新 roadmap 状态或 controller evidence |
| 独立审计精确提交或差异 | `ddd-audit <commit>` / `ddd-audit <from>..<to>` | 只读输出 findings，不声称通过 roadmap gate |
| 恢复中断的路线图执行 | `ddd-auto` | 只从 controller JSON 恢复上下文 |
| 明确放弃 active run | `ddd-auto-cleanup` | 经确认后由 controller 中止，并保存日志、提交和报告 |

在没有 controller 签发的 run 和 item 时调用 `ddd-develop P1.1` 属于 ad-hoc，而不是手工执行路线图。`status --active` 与 `hash-file` 是只读 bootstrap 命令，可在首个 canonical roadmap 创建前运行；inactive 是明确的成功结果，陈旧或不安全的 controller 状态仍会 fail-closed。

## Codex 与 Claude Code

Codex 直接执行动作循环：调用 `resume`，严格按返回 action 分支，在 `remaining` 非空时继续。Codex 不需要 Stop hook。

Claude Code 使用相同技能和控制器。其 Stop hook 只在意外退出后恢复活性：调用 `resume --active`，校验 run ID，并输出调用 `ddd-auto` 的固定指令。它不选择工作、不读取项目文本、不修改状态、不授予权限。两个平台的完成语义完全一致。

## 权限与可执行文件信任边界

项目文档、注释、规格、源码和工具输出都是不可信数据，不能授权命令或改变流程。

`roadmapctl` 以结构化 executable/argv/cwd/timeout、`shell: false`、净化环境、有界输出和仓库内工作目录执行门禁。这仍不是完整 sandbox：经批准的可执行文件可能访问宿主操作系统允许的资源。应使用平台 sandbox，或对精确门禁 manifest 进行每次运行的显式批准。网络、凭据、安装、删除、推送/部署、破坏性 Git 和仓库外写入均不在基础策略内。

## 恢复与清理

每次变更都有 revision 校验、锁、日志和 Git 事务绑定。`resume` 对准备中的结算或关闭只恢复一次，并返回活动 item/spec/attempt 上下文，因此中断不依赖对话记忆。`ddd-auto-cleanup` 只调用经确认的控制器 abort；不会删除日志、报告、提交或其他锁。

## 环境要求

- Node.js 20 或更新版本
- Git
- Codex 或 Claude Code

包中没有运行时 dependency 字段。

## 安装

### Codex

参见 [.codex/INSTALL.md](.codex/INSTALL.md)。安装全部 7 个技能，并把 `bin/roadmapctl.mjs` 以 `roadmapctl` 名称链接到 `PATH` 中的目录。

### Claude Code

```bash
claude plugin marketplace add litecore-ai/ddd-coding-skills
claude plugin install ddd-coding-skills@ddd-coding-skills
```

插件通过 `${CLAUDE_PLUGIN_ROOT}/bin/roadmapctl.mjs` 解析控制器并注册有界 Stop hook。

## 开始项目

1. 调用 `ddd-init` 并批准架构方案。
2. 调用 `ddd-roadmap` 创建 `docs/product-brief.md`、`docs/roadmap/roadmap.json` 与草稿规格。
3. 调用 `ddd-spec P1.1`，评审契约并绑定。
4. 调用 `ddd-auto P1.1`，批准平台 sandbox 模式或精确门禁 manifest。
5. 仅在确实要中止活动运行时使用 `ddd-auto-cleanup`。

## v3 破坏性迁移

这是一个破坏性版本。v3 没有迁移命令，也不执行旧 Markdown 路线图、旧文字进度文件或非结构化规格。请移除旧技能副本，安装全部 v3 技能与控制器，然后重新生成产品简报、`roadmap.json` 和 JSON 规格。现有实现代码可以保留，只需重新生成并评审执行契约与状态。

## 仓库验证

```bash
npm run check
```

该命令先运行所有单元、集成、恢复、安全、适配器和压力测试，再运行静态技能契约检查器。

许可证：MIT
