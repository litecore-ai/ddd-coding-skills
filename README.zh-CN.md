# DDD Coding Skills v4

[English](README.md) | 中文

面向 Codex 与 Claude Code、以可用性优先的领域驱动设计工作流。模型负责领域推理、实现和评审；`roadmapctl` 只承担确定性的范围、状态、门禁、Git 绑定与恢复。

## 设计目标

1. 保持系统整体性：每个路线图项都必须通过真实消费者形成垂直切片，而不是孤立分层或桩模块。
2. 循序渐进：按依赖顺序逐个实现、测试、评审和结算叶子。
3. 保持兼容：已批准规格明确领域模型、公共契约、错误、共享哈希和消费者；实现必须沿现有概念与真实调用路径演进。
4. 不压制模型能力：skill 只声明不可妥协的边界与完成条件，不向模型重复讲授 DDD，也不脚本化编码判断。
5. 节省 token：controller 读取默认就是紧凑输出；完整 feature spec 与 evidence 不再复制进编排结果。

## 只保留两个 skill

| Skill | 职责 |
|---|---|
| `ddd-roadmap` | 初始化或演进架构指导、产品意图、垂直切片 `roadmap.json`、feature specs、评审与绑定 |
| `ddd-develop` | 实现一个 ad-hoc 垂直切片，或连续执行/恢复/取消已批准 selector，内含测试、兼容性评审、审计和终态报告 |

初始化、规格、自动循环、审计和清理都是流程阶段，不再作为用户必须选择的独立 skill。

## 连贯使用流程

1. 使用 `ddd-roadmap` 检查现有系统，确定限界上下文和兼容规则，创建产品简报，规划真实垂直切片，评审并绑定规格。
2. 使用 `ddd-develop P1.1` 执行已批准 selector。同一 skill 负责单叶实现、中断恢复、精确差异审计和经确认的取消。
3. 使用 `ddd-develop <有界需求>` 执行轻量 ad-hoc DDD 切片，不修改 roadmap 状态。

规范事实源是 `docs/roadmap/roadmap.json` 与 `docs/specs/*.json`；生成 Markdown 只用于展示。只有行为贯通真实消费者并通过相关测试与兼容检查，叶子才算完成。

## Controller 生命周期

`validate → start → next → record → verify → audit → attest → finish → close`

生命周期由工具执行，不由模型复述。`next` 只返回当前叶子的 AC、消费者、公共签名、模型名称、共享哈希和证据绑定；`resume` 只返回可操作状态。只有需要字段级细节时才局部读取 canonical spec。

评审证据由 `ddd-develop` 生成，schema 为 `ddd-review/v1`；评审是开发阶段，不是第三个 skill。

只有终态 `successful` 是成功。`blocked`、`failed`、`cancelled`、`capped` 必须如实保留。禁止警告成功、跳过成功、隐藏重试、手工完成父节点或削弱门禁。

## 安全与权限

门禁使用结构化 executable/argv/cwd/timeout 且不经过 shell。显式 selector 授权经检查的仓库内 build/test/lint 门禁。网络、凭据、安装、删除、push/deploy、破坏性 Git 和仓库外写入仍需显式批准。

## 环境与安装

- Node.js 20 或更新版本
- Git
- Codex 或 Claude Code

Codex 参见 [.codex/INSTALL.md](.codex/INSTALL.md)。Claude Code 可将本仓库安装为插件。两者使用同一个 controller 和两个 skill 目录。

## 验证

```bash
npm run check
```

许可证：MIT
