# DDD Coding Skill

[English](README.md) | 中文

面向编码智能体的完整领域驱动设计（DDD）开发工作流。四个可组合的技能覆盖完整生命周期：规划、实现、审计和自动化批量执行。

## 工作原理

四个技能构成一条流水线：

```
ddd-roadmap  →  ddd-develop  →  ddd-audit
  (规划)          (实现)           (审计)
                      ↑               ↑
                  ddd-auto ───────────┘
                 (自动化)
```

**ddd-roadmap** 分析项目结构，通过对话对齐产品目标，将功能分解为可执行的条目，并按优先级组织为多个阶段（P0-P3）。支持范围化路线图（`/ddd-roadmap 计费系统`）或全项目规划。

**ddd-develop** 自动选取下一个未完成的路线图条目，生成实现计划，通过子智能体以 TDD 方式执行，运行审计并修复所有问题，最后提交代码。也支持非路线图的即时需求（`/ddd-develop 添加用户认证`）。全流程自包含，无外部技能依赖。

**ddd-audit** 基于 DDD 架构标准执行 8 维度审计：设计、架构、质量、安全、测试、集成、性能、可观测性。支持范围化审计（`/ddd-audit src/domain/`）或全项目审计。

**ddd-auto** 按用户指定的路线图范围自动循环执行 `ddd-develop`，完成后运行全项目 `ddd-audit`。支持范围指定（`/ddd-auto P0.1.1 - P1.3.1`）、单个条目或整个阶段。通过 Stop hook 实现可靠循环，支持可配置的决策策略。

## 技能一览

| 技能 | 用途 | 触发词 |
|------|------|--------|
| **ddd-roadmap** | 生成分阶段开发路线图 | `/ddd-roadmap`、`/ddd-roadmap <范围>` |
| **ddd-develop** | 实现路线图条目或即时需求 | `/ddd-develop`、`/ddd-develop <需求>` |
| **ddd-audit** | 8 维度 DDD 架构审计 | `/ddd-audit`、`/ddd-audit <范围>` |
| **ddd-auto** | 自动批量执行路线图 + 审计 | `/ddd-auto`、`/ddd-auto <范围>`、`/cancel-ddd-auto` |

### ddd-roadmap

扫描项目结构，**自动发现产品文档**（PRD、规格说明、需求文档）并提取愿景与约束，对齐产品目标（已有文档时验证提取上下文，无文档时走完整问答），将功能分解为可执行条目，按优先级归入各阶段。

三种输入模式：
- `/ddd-roadmap <范围>` — 针对特定功能领域生成范围化路线图
- `/ddd-roadmap` — 全项目路线图（项目方向明确时）
- `/ddd-roadmap` — 交互模式（范围不明确时主动询问）

**输出**：标准化 checkbox 格式路线图，存放于 `docs/roadmap/`。

### ddd-develop

自包含的端到端开发工作流，包含 6 个阶段：

1. **LOCATE** — 确定开发目标（命令参数 / 路线图 / 询问用户）
2. **PLAN** — 生成细粒度实现计划，包含 TDD 步骤
3. **IMPLEMENT** — 每个任务启动一个子智能体，按 RED-GREEN-REFACTOR 循环执行，配备规格审查员 + 代码质量审查员
4. **AUDIT** — 以增量模式运行 ddd-audit，修复所有发现（所有严重级别）
5. **VERIFY** — 运行 lint、类型检查、完整测试套件，提供实际输出证据
6. **COMPLETE** — 更新路线图（如适用）、提交代码、推送（需用户确认）

三种输入模式：
- `/ddd-develop <需求>` — 开发不在路线图中的即时需求
- `/ddd-develop` — 选取路线图中下一个未完成条目
- `/ddd-develop` — 交互模式（路线图已完成时主动询问）

**内置能力**：TDD（RED-GREEN-REFACTOR）、实现计划生成、子智能体编排（实现者 + 规格审查员 + 质量审查员）、完成前验证。

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

基于 Stop hook 的自动化路线图执行。指定范围后，系统自动通过 `ddd-develop` 逐个实现所有条目，最后运行全项目 `ddd-audit`。

范围语法：
- `/ddd-auto P0.1.1` — 单个条目
- `/ddd-auto P0.1.1 - P1.3.1` — 范围
- `/ddd-auto P0.1.1 - P1.3.1, P2.1.1` — 混合（范围 + 单项）
- `/ddd-auto P0` — 整个阶段
- `/ddd-auto` — 所有未完成的路线图条目

选项：
- `--policy <文本|预设>` — 自主决策策略。预设：`pragmatic`（默认，实用优先）、`strict-ddd`（严格 DDD）、`fast`（快速交付）
- `--max-iterations <N>` — 安全上限（默认：50）

随时可用 `/cancel-ddd-auto` 取消。

特性：
- 通过 Stop hook 实现可靠循环（无需手动重复调用）
- 会话隔离（仅启动循环的会话受影响）
- 决策策略（预设或自由文本，用于自主设计决策）
- 进度追踪与完整执行日志
- 遇到 BLOCKED 自动跳过
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
cp -r /tmp/ddd-coding-skills/skills/ddd-roadmap ~/.claude/skills/ddd-roadmap
cp -r /tmp/ddd-coding-skills/skills/ddd-develop ~/.claude/skills/ddd-develop
cp -r /tmp/ddd-coding-skills/skills/ddd-audit ~/.claude/skills/ddd-audit

# 或安装为项目级技能（随项目版本控制）
cp -r /tmp/ddd-coding-skills/skills/ddd-roadmap .claude/skills/ddd-roadmap
cp -r /tmp/ddd-coding-skills/skills/ddd-develop .claude/skills/ddd-develop
cp -r /tmp/ddd-coding-skills/skills/ddd-audit .claude/skills/ddd-audit
```

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
cp -r skills/ddd-roadmap ~/.claude/skills/ddd-roadmap
cp -r skills/ddd-develop ~/.claude/skills/ddd-develop
cp -r skills/ddd-audit ~/.claude/skills/ddd-audit
```

### Codex CLI

```bash
cd ~/.codex/ddd-coding-skills && git pull
```

技能通过符号链接即时更新。

## 使用示例

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
# 第一步：规划项目
You: /ddd-roadmap

# 第二步：逐个实现功能
You: /ddd-develop
You: /ddd-develop
You: /ddd-develop

# 第三步：发布前做最终审计
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
# 4. 全部完成后运行全项目 /ddd-audit
# 5. 生成最终执行报告
```

带决策策略：

```
You: /ddd-auto P0 --policy "偏向简单实现，复用已有库"
```

随时取消：

```
You: /cancel-ddd-auto
```

## 要求

- 支持子智能体的编码智能体 — [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 或 [Codex CLI](https://github.com/openai/codex)
- 遵循（或正在采用）DDD 架构模式的项目

## 项目结构

```
ddd-coding-skills/
├── .claude-plugin/
│   └── plugin.json          # Claude Code 插件清单
├── .codex/
│   └── INSTALL.md           # Codex CLI 安装指南
├── commands/
│   ├── ddd-auto.md          # /ddd-auto 命令
│   └── cancel-ddd-auto.md   # /cancel-ddd-auto 命令
├── hooks/
│   ├── hooks.json           # Stop hook 注册
│   └── stop-hook.sh         # ddd-auto 循环引擎
├── skills/
│   ├── ddd-roadmap/
│   │   └── SKILL.md         # 路线图生成
│   ├── ddd-develop/
│   │   └── SKILL.md         # 开发工作流
│   ├── ddd-auto/
│   │   └── SKILL.md         # 自动化路线图执行
│   └── ddd-audit/
│       └── SKILL.md         # 8 维度审计
├── LICENSE                  # MIT
├── package.json
└── README.md
```

## 许可证

MIT — 详见 [LICENSE](LICENSE)。
