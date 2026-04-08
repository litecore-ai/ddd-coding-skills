# DDD Coding Skill

[English](README.md) | 中文

面向编码智能体的完整领域驱动设计（DDD）开发工作流。三个可组合的技能覆盖完整生命周期：规划、实现、审计。

## 工作原理

三个技能构成一条流水线：

```
ddd-roadmap  →  ddd-develop  →  ddd-audit
  (规划)          (实现)           (审计)
```

**ddd-roadmap** 分析项目结构，通过对话对齐产品目标，将功能分解为可执行的条目，并按优先级组织为多个阶段（P0-P3）。

**ddd-develop** 自动选取下一个未完成的路线图条目，生成实现计划，通过子智能体以 TDD 方式执行，运行审计并修复所有问题，最后提交代码。全流程自包含，无外部技能依赖。

**ddd-audit** 基于 DDD 架构标准执行 8 维度审计：设计、架构、质量、安全、测试、集成、性能、可观测性。

## 技能一览

| 技能 | 用途 | 触发词 |
|------|------|--------|
| **ddd-roadmap** | 生成分阶段开发路线图 | "generate roadmap"、"plan development phases" |
| **ddd-develop** | 实现下一个路线图条目（完整流水线） | "continue development"、"next roadmap item" |
| **ddd-audit** | 8 维度 DDD 架构审计 | "audit this project"、"DDD review" |

### ddd-roadmap

扫描项目结构，通过对话对齐产品目标，将功能分解为可执行条目，按优先级归入各阶段。

**执行流程（7 步）**：
1. **项目扫描** — 检测技术栈、DDD 分层、模块清单、已有文档
2. **目标对齐** — 迭代式收集产品愿景、现状、约束、优先级、架构目标
3. **功能分解** — 拆分为可独立测试的 1-4 小时级条目
4. **阶段排序** — 按关键程度分为 P0（基础/MVP）→ P3（企业级）
5. **生成路线图** — 输出至 `docs/roadmap/`
6. **用户评审** — 根据反馈迭代
7. **提交** — 保存至 Git

**输出**：标准化 checkbox 格式路线图，存放于 `docs/roadmap/`。

### ddd-develop

自包含的端到端开发工作流，包含 6 个阶段：

1. **LOCATE** — 扫描路线图，定位下一个未完成条目
2. **PLAN** — 生成细粒度实现计划，包含 TDD 步骤
3. **IMPLEMENT** — 每个任务启动一个子智能体，按 RED-GREEN-REFACTOR 循环执行，配备规格审查员 + 代码质量审查员
4. **AUDIT** — 以增量模式运行 ddd-audit，修复所有发现（所有严重级别）
5. **VERIFY** — 运行 lint、类型检查、完整测试套件，提供实际输出证据
6. **COMPLETE** — 更新路线图、提交代码、推送（需用户确认）

**内置能力**：TDD（RED-GREEN-REFACTOR）、实现计划生成、子智能体编排（实现者 + 规格审查员 + 质量审查员）、完成前验证。

### ddd-audit

8 维度审计矩阵，支持并行子智能体执行：

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

## 安装

### Claude Code（插件市场）

```bash
/install-plugin litecore-ai/ddd-coding-skills
```

### 手动安装

克隆到 Claude Code 插件目录：

```bash
cd ~/.claude/plugins
git clone https://github.com/litecore-ai/ddd-coding-skills.git
```

或添加为个人技能：

```bash
cd ~/.claude/skills
git clone https://github.com/litecore-ai/ddd-coding-skills.git
```

## 要求

- 支持子智能体的编码智能体（Claude Code、Codex 等）
- 遵循（或正在采用）DDD 架构模式的项目

## 项目结构

```
ddd-coding-skills/
├── .claude-plugin/
│   └── plugin.json          # 插件清单
├── skills/
│   ├── ddd-roadmap/
│   │   └── SKILL.md         # 路线图生成
│   ├── ddd-develop/
│   │   └── SKILL.md         # 开发工作流
│   └── ddd-audit/
│       └── SKILL.md         # 8 维度审计
├── LICENSE                  # MIT
├── package.json
└── README.md
```

## 许可证

MIT — 详见 [LICENSE](LICENSE)。
