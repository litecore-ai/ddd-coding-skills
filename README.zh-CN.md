# DDD Coding Skill

[English](README.md) | 中文

面向编码智能体的完整领域驱动设计（DDD）开发工作流。六个可组合的流水线技能（外加一个清理辅助技能 `ddd-auto-cleanup`）覆盖完整生命周期：初始化、规划（含产品意图提炼）、规格生成、实现、审计和自动化批量执行。

> **v2.0：** `ddd-brief` 已合并进 `ddd-roadmap`——路线图的目标对齐步骤会直接写入 `docs/product-brief.md`。需要"产品简报"（或习惯性输入 `/ddd-brief` 类请求）时会路由到 `ddd-roadmap`。

## 工作原理

六个技能构成一条流水线：

```
ddd-init  →  ddd-roadmap   →  ddd-spec  →  ddd-develop  →  ddd-audit
 (初始化)    (简报 + 规划)       (规格)       (实现)           (审计)
                                                 ↑               ↑
                                             ddd-auto ───────────┘
                                            (自动化)
```

**ddd-init** 为新项目初始化 DDD 架构结构，或为现有项目生成重构路线图。创建目录结构、标准化 `docs/` 布局，并将架构约束写入 `CLAUDE.md`。支持内置模板（`/ddd-init --template fastlayer`）或自定义参考架构（`/ddd-init --ref <路径>`）。

**ddd-roadmap** 扫描项目结构，对齐产品目标，将产品意图提炼写入 `docs/product-brief.md`（`ddd-spec`、`ddd-develop`、`ddd-audit` 消费的规范锚点），并生成由垂直切片构成的分阶段路线图。支持 PRD 文件作为主要来源（`/ddd-roadmap docs/my-prd.md`）、范围化规划（`/ddd-roadmap 计费系统`）或全项目规划。路线图审批后，提示为所有功能领域生成规格。

**ddd-spec** 按功能领域生成结构化行为契约，包含编号的验收标准（Given/When/Then）、数据模型、API 契约和边界条件。**需要 `docs/product-brief.md`**（由 `ddd-roadmap` 生成）。通过将 `ddd-develop` 的计划锚定到可测试的验收标准来防止方向漂移。支持单个（`/ddd-spec P0.1`）、范围（`/ddd-spec P0.1 - P0.3`）或阶段级（`/ddd-spec P0`）生成，每个功能领域使用独立子智能体。

**ddd-develop** 自动选取下一个未完成的路线图条目，验证已批准的规格是否存在（规格门禁），生成锚定到规格验收标准的实现计划，通过子智能体以 TDD 方式执行，运行审计，验证规格合规性，最后提交代码。也支持非路线图的即时需求（`/ddd-develop 添加用户认证`）。

**ddd-audit** 基于 DDD 架构标准执行 8 维度审计：设计、架构、质量、安全、测试、集成、性能、可观测性。支持范围化审计（`/ddd-audit src/domain/`）或全项目审计。

**ddd-auto** 按用户指定的路线图范围自动循环执行 `ddd-develop`，完成后对已完成条目运行范围化 `ddd-audit`。若 `docs/product-brief.md` 或已批准的规格缺失则阻断（先运行 `/ddd-roadmap` + `/ddd-spec`，或使用 `--skip-spec` 跳过）。支持范围指定（`/ddd-auto P0.1.1 - P1.3.1`）、单个条目或整个阶段。支持自然语言输入自动生成路线图后执行。通过 Stop hook 实现可靠循环，支持可配置的决策策略。

## 技能一览

| 技能 | 用途 | 触发词 |
|------|------|--------|
| **ddd-init** | 初始化或重构项目为 DDD 架构 | `/ddd-init`、`/ddd-init --template fastlayer`、`/ddd-init --ref <路径>` |
| **ddd-roadmap** | 产品简报 + 分阶段开发路线图 | `/ddd-roadmap`、`/ddd-roadmap <范围>`、`/ddd-roadmap <prd文件>` |
| **ddd-spec** | 按功能领域生成行为契约 | `/ddd-spec`、`/ddd-spec P0.1`、`/ddd-spec P0` |
| **ddd-develop** | 实现路线图条目或即时需求 | `/ddd-develop`、`/ddd-develop <需求>` |
| **ddd-audit** | 8 维度 DDD 架构审计 | `/ddd-audit`、`/ddd-audit <范围>` |
| **ddd-auto** | 自动批量执行路线图 + 审计 | `/ddd-auto`、`/ddd-auto <范围>`、`/ddd-auto --roadmap <路径>`、`/ddd-auto-cleanup` |

### ddd-init

初始化项目为 DDD 架构或将现有项目重构为 DDD 结构。自动检测项目状态（新项目/现有项目）和技术栈。

两种模式：
- **Scaffold**（新项目）— 创建 DDD 目录结构 + 标准化 `docs/` 布局 + CLAUDE.md 架构约束
- **Refactor**（现有项目）— 创建目标 DDD 结构 + 生成与 `/ddd-auto` 兼容的迁移路线图

选项：
- `--template <名称>` — 内置模板。当前支持：`fastlayer`（TypeScript/Next.js）
- `--ref <路径>` — 使用自定义参考项目的目录结构

输出：
- DDD 分层目录（含 `.gitkeep`）
- 标准化 `docs/` 结构（roadmap、audit、architecture、specs、plans）
- `CLAUDE.md` 架构章节（层级映射、模块模板、依赖规则、编码约定）
- 重构路线图 `docs/roadmap/`（仅 Refactor 模式）

### ddd-roadmap

扫描项目结构，**自动发现产品文档**（PRD、规格说明、需求文档）并提取愿景与约束，对齐产品目标（已有文档时验证提取上下文，无文档时走完整问答），将功能分解为可执行条目，按优先级归入各阶段。

三种输入模式：
- `/ddd-roadmap <范围>` — 针对特定功能领域生成范围化路线图
- `/ddd-roadmap` — 全项目路线图（项目方向明确时）
- `/ddd-roadmap` — 交互模式（范围不明确时主动询问）

**输出**：标准化 checkbox 格式路线图，存放于 `docs/roadmap/`。

### ddd-spec

按功能领域生成结构化行为契约（规格）。每个规格定义验收标准、数据模型、API 契约、边界条件和覆盖映射表，将每个路线图条目关联到具体的 AC 编号。

三种输入模式：
- `/ddd-spec P0.1` — 单个功能领域
- `/ddd-spec P0.1 - P0.3` 或 `/ddd-spec P0` — 范围或整个阶段
- 批量 — 由 ddd-roadmap 在路线图审批后触发

关键特性：
- **product-brief.md 门禁** — 生成前需要 `docs/product-brief.md`；先运行 `/ddd-roadmap`（其目标对齐步骤会写入该文件）
- **子智能体隔离** — 每个功能领域一个独立 Agent，防止注意力衰减
- **AC 编号制** — `AC-1, AC-2...` 采用 Given/When/Then 格式，被 ddd-develop 引用
- **状态门禁** — `draft` → `approved`；ddd-develop 在无已批准规格时阻塞

**输出**：结构化规格文件，存放于 `docs/specs/P{phase}.{area}-{slug}.md`。

### ddd-develop

自包含的端到端开发工作流，包含 6 个阶段（外加 1.5 规格门禁）：

1. **LOCATE** — 确定开发目标（命令参数 / 路线图 / 询问用户）
1.5. **SPEC GATE** — 验证已批准的规格是否存在；缺失则阻塞
2. **PLAN** — 生成锚定到规格验收标准的实现计划
3. **IMPLEMENT** — 每个任务启动一个子智能体，按 RED-GREEN-REFACTOR 循环执行，配备规格审查员
4. **AUDIT** — 以增量模式运行 ddd-audit，修复 CRITICAL/HIGH 发现，MEDIUM/LOW 记入 fix-roadmap 留待批量处理
5. **VERIFY** — 运行 lint、类型检查、完整测试套件、规格合规检查，提供实际输出证据
6. **COMPLETE** — 更新路线图（如适用）、提交代码、推送（需用户确认）

三种输入模式：
- `/ddd-develop <需求>` — 开发不在路线图中的即时需求
- `/ddd-develop` — 选取路线图中下一个未完成条目
- `/ddd-develop` — 交互模式（路线图已完成时主动询问）

**内置能力**：TDD（RED-GREEN-REFACTOR）、实现计划生成、子智能体编排（实现者 + 规格审查员）、规格合规验证、完成前验证。代码质量审查由每个 item 一次的增量审计承担，不再逐 task 审查。

### ddd-audit

8 维度审计矩阵，支持并行子智能体执行。

三种输入模式：
- `/ddd-audit <范围>` — 针对特定模块、分层或文件的范围化审计
- `/ddd-audit` — 全项目审计
- `/ddd-audit` — 交互模式（范围不明确时主动询问）

维度：

| 维度 | 关注点 |
|------|--------|
| D1 设计 | 功能完整性、方案最优性 |
| D2 架构 | DDD 分层合规、依赖方向 |
| D3 质量 | 死代码、重复代码、复杂度 |
| D4 安全 | 漏洞、边界情况、错误处理 |
| D5 测试 | 覆盖率、测试质量、边界测试 |
| D6 集成 | 跨模块契约、数据流 |
| D7 性能 | N+1 查询、缓存、内存泄漏 |
| D8 可观测性 | 日志、指标、链路追踪 |

**严重级别**：

| 级别 | 定义 | 处理 |
|------|------|------|
| CRITICAL | 安全漏洞、数据丢失风险 | 阻断 — 必须在发布前修复 |
| HIGH | Bug、重大设计缺陷 | 警告 — 部署前应修复 |
| MEDIUM | 可维护性问题 | 建议 — 安排上线后处理 |
| LOW | 风格、小优化 | 备注 — 可选 |

**特性**：支持增量（diff）模式、可通过 `.audit-config.yml` 配置、生成带评分的报告和修复路线图。

### ddd-auto

基于 Stop hook 的自动化路线图执行。指定范围后，系统自动通过 `ddd-develop` 逐个实现所有条目，最后对已完成条目运行范围化 `ddd-audit`。

范围语法：
- `/ddd-auto P0.1.1` — 单个条目
- `/ddd-auto P0.1.1 - P1.3.1` — 范围
- `/ddd-auto P0.1.1 - P1.3.1, P2.1.1` — 混合（范围 + 单项）
- `/ddd-auto P0` — 整个阶段
- `/ddd-auto` — 所有未完成的路线图条目
- `/ddd-auto --roadmap path/to/roadmap/` — 自定义路线图目录或文件
- `/ddd-auto <自然语言需求>` — 自动生成路线图后执行

选项：
- `--roadmap <路径>` — 自定义路线图目录或文件（覆盖默认的 `docs/roadmap/`）
- `--skip-spec` — 跳过规格生成门禁。条目将在无行为契约的情况下执行，仅用于快速修复或重构
- `--yes` — 跳过确认直接开始（仍会显示执行计划）
- `--policy <文本|预设>` — 自主决策策略。预设：`pragmatic`（默认，实用优先）、`strict-ddd`（严格 DDD）、`fast`（快速交付）
- `--max-iterations <N>` — 安全上限（默认：50）

按 Escape 中断，然后 `/ddd-auto-cleanup` 清理状态并查看进度摘要。

> **注意：** Escape 只是暂停循环，并不会结束它——在运行 `/ddd-auto-cleanup`（或循环自然完成）之前，Stop hook 会在会话下一次回复结束时恢复循环，即使那次回复与 ddd-auto 无关。

特性：
- 通过 Stop hook 实现可靠循环（无需手动重复调用）
- 规格覆盖门禁 — 若 `docs/product-brief.md` 或已批准规格缺失则阻断；先运行 `/ddd-roadmap` + `/ddd-spec`，或 `--skip-spec` 跳过
- 会话隔离（仅启动循环的会话受影响）
- Auto-Roadmap — 传入自然语言需求，ddd-auto 先生成路线图再自动执行
- 决策策略（预设或自由文本，用于自主设计决策）
- 进度追踪与完整执行日志
- 每完成一个条目自动同步路线图 checkbox
- 遇到 BLOCKED 自动跳过
- 基于预运行基线的 git diff 范围化审计（减少大型项目的 token 消耗）
- 最终执行报告含审计结果

## 安装

### Claude Code

#### 方式 A：插件市场（推荐）

```bash
claude plugin marketplace add litecore-ai/ddd-coding-skills
claude plugin install ddd-coding-skills@ddd-coding-skills
```

#### 方式 B：`--plugin-dir` 参数

```bash
git clone https://github.com/litecore-ai/ddd-coding-skills.git ~/.local/share/claude/plugins/ddd-coding-skills
claude --plugin-dir ~/.local/share/claude/plugins/ddd-coding-skills
```

#### 方式 C：手动安装技能

```bash
git clone https://github.com/litecore-ai/ddd-coding-skills.git /tmp/ddd-coding-skills

# 安装为个人技能（所有项目可用）
cp -r /tmp/ddd-coding-skills/skills/ddd-init ~/.claude/skills/ddd-init
cp -r /tmp/ddd-coding-skills/skills/ddd-roadmap ~/.claude/skills/ddd-roadmap
cp -r /tmp/ddd-coding-skills/skills/ddd-spec ~/.claude/skills/ddd-spec
cp -r /tmp/ddd-coding-skills/skills/ddd-develop ~/.claude/skills/ddd-develop
cp -r /tmp/ddd-coding-skills/skills/ddd-audit ~/.claude/skills/ddd-audit
cp -r /tmp/ddd-coding-skills/skills/ddd-auto ~/.claude/skills/ddd-auto

# 或安装为项目级技能（随项目版本控制）
cp -r /tmp/ddd-coding-skills/skills/ddd-init .claude/skills/ddd-init
cp -r /tmp/ddd-coding-skills/skills/ddd-roadmap .claude/skills/ddd-roadmap
cp -r /tmp/ddd-coding-skills/skills/ddd-spec .claude/skills/ddd-spec
cp -r /tmp/ddd-coding-skills/skills/ddd-develop .claude/skills/ddd-develop
cp -r /tmp/ddd-coding-skills/skills/ddd-audit .claude/skills/ddd-audit
cp -r /tmp/ddd-coding-skills/skills/ddd-auto .claude/skills/ddd-auto
```

> **注意：** 手动安装不包含 `ddd-auto` 所需的 Stop hook。如需完整的 `ddd-auto` 支持（可靠循环），请使用方式 A 或 B，或参照 `hooks/hooks.json` 的格式将 `hooks/stop-hook.sh` 注册为 `.claude/settings.json` 中的 Stop hook。

> **首次使用：** 在 frontmatter 中声明了 `allowed-tools` 或 `hooks` 的技能（所有 DDD 技能都是）在 Claude Code（≥2.1.19）中首次运行前需要一次性批准。

### Codex CLI

克隆仓库并创建符号链接，通过原生技能发现机制加载：

```bash
git clone https://github.com/litecore-ai/ddd-coding-skills.git ~/.codex/ddd-coding-skills
mkdir -p ~/.agents/skills
ln -s ~/.codex/ddd-coding-skills/skills ~/.agents/skills/ddd-coding-skills
```

在 `~/.codex/config.toml` 中启用多智能体支持（ddd-develop 的子智能体编排需要此功能）：

```toml
[features]
multi_agent = true
```

重启 Codex 以发现技能。

> **Windows 用户：** 使用 junction 替代符号链接 — 详见 [.codex/INSTALL.md](.codex/INSTALL.md)。

## 更新

### Claude Code — 插件市场

```bash
claude plugin marketplace update ddd-coding-skills
claude plugin update ddd-coding-skills@ddd-coding-skills
```

更新后需要重启 Claude Code 才会生效。

### Claude Code — 手动安装

```bash
cd /tmp/ddd-coding-skills && git pull
cp -r skills/ddd-init ~/.claude/skills/ddd-init
cp -r skills/ddd-roadmap ~/.claude/skills/ddd-roadmap
cp -r skills/ddd-spec ~/.claude/skills/ddd-spec
cp -r skills/ddd-develop ~/.claude/skills/ddd-develop
cp -r skills/ddd-audit ~/.claude/skills/ddd-audit
cp -r skills/ddd-auto ~/.claude/skills/ddd-auto
```

### Codex CLI

```bash
cd ~/.codex/ddd-coding-skills && git pull
```

技能通过符号链接即时更新。

## 使用示例

### 初始化 DDD 架构

新项目使用内置模板：

```
You: /ddd-init --template fastlayer

# 技能将会：
# 1. 创建 DDD 目录结构（server/handler、server/infras、server/modules）
# 2. 创建标准化 docs/ 布局
# 3. 将架构约束写入 CLAUDE.md
```

现有项目重构：

```
You: /ddd-init

# 技能将会：
# 1. 检测现有代码和技术栈
# 2. 将文件分类到 DDD 各层
# 3. 创建目标 DDD 目录
# 4. 在 docs/roadmap/ 生成重构路线图
# 5. 建议执行：/ddd-auto --roadmap docs/roadmap/ P0
```

使用自定义参考架构：

```
You: /ddd-init --ref ~/my-other-ddd-project
```

### 生成开发路线图

```
You: /ddd-roadmap

# 技能将会：
# 1. 扫描项目结构和技术栈
# 2. 通过对话了解你的产品目标和优先级
# 3. 将功能分解为可执行的条目
# 4. 生成分阶段路线图（P0-P3）到 docs/roadmap/
```

也可以直接描述需求：

```
You: /ddd-roadmap 我要构建一个多租户 SaaS 平台，包含用户管理、计费和数据分析功能
```

### 实现功能

从路线图中自动选取下一个未完成条目：

```
You: /ddd-develop
You: /ddd-develop   # 下一个条目
You: /ddd-develop   # 下一个条目
```

或开发不在路线图中的即时需求：

```
You: /ddd-develop 添加基于 JWT 的用户认证，支持 refresh token 轮换
```

### 审计项目

全项目审计：

```
You: /ddd-audit
```

范围化审计（指定模块或分层）：

```
You: /ddd-audit src/domain/billing
You: /ddd-audit 对认证模块做安全审查
```

增量模式（仅审计最近变更）：

```
You: /ddd-audit --diff HEAD~3
```

### 完整工作流示例

典型的端到端工作流：

```
# 第一步：规划项目（以 PRD 为主要来源；目标对齐时自动写入 docs/product-brief.md）
You: /ddd-roadmap docs/my-prd.md

# 第二步：为所有功能领域生成行为契约（规格）
You: /ddd-spec P0

# 第三步：逐个实现功能（锚定到规格）
You: /ddd-develop
You: /ddd-develop
You: /ddd-develop

# 第四步：发布前做最终审计
You: /ddd-audit
```

### 自动批量执行

自动执行一个范围内的路线图条目：

```
You: /ddd-auto P0.1.1 - P1.3.1

# 技能将会：
# 1. 展开范围为 P0.1.1 到 P1.3.1 之间所有子功能
# 2. 显示执行计划并请求确认
# 3. 逐个通过 /ddd-develop 实现（TDD、审计、提交）
# 4. 对已完成条目运行范围化 /ddd-audit
# 5. 生成最终执行报告
```

带决策策略：

```
You: /ddd-auto P0 --policy "偏向简单实现，复用已有库"
```

随时按 Escape 中断循环，然后清理状态：

```
You: [按 Escape 停止循环]
You: /ddd-auto-cleanup
```

## 常见问题

### ddd-auto 被权限确认弹窗阻塞（Claude Code）

**症状：** `ddd-auto` 或 `ddd-develop` 执行中弹出 "This command requires approval"，阻塞在 `grep`、`find`、`python` 等基础命令上。

**原因：** 旧版 Claude Code 中，子智能体（Agent 工具）不能可靠继承项目权限设置，技能 frontmatter 中的 `PermissionRequest` 钩子也可能对子智能体请求不触发。`ddd-auto` 通过子智能体运行每个 `ddd-develop` 周期，这些子智能体可能以空白权限启动。较新版本（v2.1.186+）会把子智能体的权限确认弹到主会话中——问题变得可见，但仍可能中断无人值守的循环。

**解决方法 — 使用限定范围的本机权限配置。** 运行 `/ddd-init`（或参考其 Permissions Template）在项目中生成 `.claude/settings.local.json`，其中包含：

- 针对你技术栈的常用构建/测试/git 命令前缀白名单；
- 一个**条件化**的 `PermissionRequest` 钩子：仅当 ddd-auto 循环运行中（`.ddd-auto.local.md` 存在）才自动批准权限请求。循环之外，正常的权限确认流程照常生效。

`settings.local.json` 是本机文件且默认被 gitignore，宽松权限不会影响协作者。

如果循环中仍有个别命令触发弹窗，在 `.claude/settings.local.json` 中为其添加窄范围规则（如 `Bash(npm run test:*)`）后重启会话。

> **警告：** 不要在全局 `~/.claude/settings.json` 中添加 `Bash(*)`——那会永久关闭本机**所有**项目的命令审批，远超 ddd-auto 所需。

## 要求

- 支持子智能体的编码智能体 — [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 或 [Codex CLI](https://github.com/openai/codex)
- 遵循（或正在采用）DDD 架构模式的项目
- 系统已安装 `jq`（ddd-auto 的 Stop hook 需要用于 JSON 处理）

## 项目结构

```
ddd-coding-skills/
├── .claude-plugin/
│   ├── marketplace.json     # Claude Code 插件市场条目
│   └── plugin.json          # Claude Code 插件清单
├── .codex/
│   └── INSTALL.md           # Codex CLI 安装指南
├── hooks/
│   ├── hooks.json           # Stop hook 注册
│   └── stop-hook.sh         # ddd-auto 循环引擎
├── skills/
│   ├── ddd-auto-cleanup/
│   │   └── SKILL.md         # 中断 ddd-auto 后清理状态
│   ├── ddd-init/
│   │   ├── SKILL.md         # DDD 项目初始化
│   │   └── references/      # fastlayer 模板 + 权限模板（按需加载）
│   ├── ddd-roadmap/
│   │   ├── SKILL.md         # 产品简报 + 路线图生成
│   │   └── references/      # product-brief 格式（按需加载）
│   ├── ddd-spec/
│   │   └── SKILL.md         # 行为契约生成
│   ├── ddd-develop/
│   │   ├── SKILL.md         # 开发工作流
│   │   └── references/      # 子代理 prompt 模板（按需加载）
│   ├── ddd-auto/
│   │   └── SKILL.md         # 自动化路线图执行
│   └── ddd-audit/
│       ├── SKILL.md         # 8 维度审计
│       └── references/      # 审计配置 schema、CI/CD 集成（按需加载）
├── LICENSE                  # MIT
├── package.json
└── README.md
```

## 许可证

MIT — 详见 [LICENSE](LICENSE)。
