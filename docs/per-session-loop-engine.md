# 设计：把 loop engine 从全局选择改为 per-session

**目标仓库**：dsh-agent-hub（本仓）。本文件记录现状、方案与实施步骤。

## 现状

当前引擎选择是 **per-profile 的全局状态**，不是 per-session：

- 选择存放在 `agent-loop-engine` settings section（`src/settings.ts`）与 profile 的
  `cordis.patch.yml` 托管块（`src/patch-manager.ts`）两处，后者是 boot 时的 ground truth。
- 托管块的作用是把基础 bundle 的 `agent-loop` 行 `disabled: true`，因为
  **harness 只允许一个 AgentFactory 占槽**（`ctx.agents.setFactory`）。非默认引擎靠关掉
  base loop 来夺取槽位；选回 `in-process` 就整体删除该块。
- `src/index.ts` 的 `onChange` 已有运行时 `unmountEngine()/mountEngine()` 换装逻辑，
  外加一段针对 patch 重载竞争的有界重试（`MAX_MOUNT_ATTEMPTS`）。
- 客户端注释直言 "The engine is a deployment-level choice"；切换会中断仍跑在旧引擎上的
  会话，所以 UI 先弹确认框，提交后刷新页面，并需重启 `dsh web`。

### 全局语义带来的实际问题

1. 多会话并行时，切换引擎会让正在运行的旧引擎会话失去其 factory。
2. `resume` 会把历史会话恢复到**当前**引擎，而非它创建时的引擎。各引擎的会话日志
   provenance 不同（如 codex 驱动写入 `provider = 'codex'`、`model = 'codex-native'`），
   跨引擎 resume 会重放该引擎无法理解的历史。
3. 切换成本高（确认 + reload + 重启），与"像切换模型一样"的产品目标不符。

## 两个决定方案的关键事实

### 事实一：`agentPreset` 是官方为此预留的持久字段

`@deepseek-ai/dsh-session` 的 `SessionHeader.agentPreset` 注释：

> Id of the agent preset this session's agent was composed from, **when the deployment
> composes per session**. Durable because the preset decides the session's tools and
> prompt: **a resume that restored a different composition would replay history the
> model can no longer act on**.

这段话逐字描述了 loop engine 的处境。该字段同时存在于：

- `CreateAgentOptions.meta.agentPreset`（创建入口）
- `SessionHeader.agentPreset`（运行时可读）
- `@deepseek-ai/dsh-session-persistence-jsonl` 的 format（持久化）

因此 **per-session 引擎的持久化与 resume 问题不需要自建 sidecar**，且 fork / subagent
路径会随 `meta` 继承自动获得正确的引擎继承语义。

### 事实二：单槽位约束不阻止按会话分发

`AgentFactory` 只有 `createAgent(ownerCtx, options)` 与 `resume(ownerCtx, options)`
两个方法，**都是 per-call 的**。其契约明确要求实现：

> The registry passes a context carrying the `create()` caller's fiber and scope as
> `ownerCtx`. The implementation attaches the unpublished transaction and resulting
> lifecycle to that owner; **it must not infer ownership from the factory object's
> registration context.**

即实现必须把生命周期挂到传入的 `ownerCtx` 上，而非自身注册 context。这正是转发所需的
语义前提：router 原样透传 `ownerCtx` 给子 factory 完全合法，无需任何 hack。

## 方案：Router Factory + `agentPreset` 载体

```
ctx.agents.setFactory(LoopEngineRouter)   ← 唯一占槽者，进程内永不更换
                    │
      ┌─────────────┼──────────────┬──────────────┐
  base loop     ClaudeCodeLoop   CodexLoop      PiLoop
 (in-process)
```

四个引擎全部常驻挂载；router 按会话的 `agentPreset` 转发 `createAgent` / `resume`。

**引擎是会话创建时固化的不可变属性**——这既是正确性要求（见"现状"第 2 条），也让 UI
语义变干净：不需要确认框、不需要 reload、不需要重启。

### Preset 命名空间约定

```
agentPreset: "loop-engine:codex"
```

带前缀以免与未来真实的 agent preset 体系冲突；无前缀或无值一律解析为 `in-process`。

## 实施步骤

### 1. Router 与 `agents` 服务代理

三个 hosted loop 目前都在构造函数里调用
`ctx.effect(() => ctx.agents.setFactory(this))`（如 `src/engine-codex/loop.ts:131`）。

改为在 router 提供的**子 context** 上挂载它们，该 context 的 `agents` 服务被代理，
`setFactory` 重定向为"向 router 登记为候选引擎"。三个 loop 类的源码**无需改动**——
它们的 `setFactory` 调用被透明接管。

风险集中于此步的 cordis 服务代理写法。注：本仓已在 `src/driver-core/ownership.ts` 中
直接内联 cordis 的 fiber state 数字常量（4.0.1 不导出 `FiberState`），对 cordis 内部
细节的依赖是既有且可接受的工程风格。

### 2. 托管 base in-process loop

- `cordis.patch.yml` 的托管块从"随选择改写"退化为**常驻**的
  `- id: agent-loop / disabled: true`；`src/patch-manager.ts` 中
  `renderManagedBlock` / `currentEngineOf` 等随选择变化的逻辑大部分可删。
- 把 `@deepseek-ai/dsh-agent-loop` 加入 `peerDependencies`（版本对齐现有 dsh peer 的
  `0.1.1-rc.2`），用同一个代理 context 挂载。

这是本方案唯一的真实成本：插件从"完全不碰主仓库"变为"与主仓 loop 版本对齐"。鉴于
已有十个 dsh peer 依赖，边际耦合很小。

### 3. `agentPreset` 路由与 resume

- `createAgent`：读 `options.meta.agentPreset` → 解析引擎 → 转发。
- `resume`：先经 `sessionPersistence` 取得 header，读 `agentPreset` → 转发。
- 未知或缺失前缀 → `in-process`；已登记但未挂载成功的引擎 → 明确失败，不静默回退。

### 4. skill / command provider 按引擎过滤

当前 `src/index.ts` 的 `skillDisposer` 是单变量、互斥注册（`mountClaude` /
`mountCodex` / `mountPi` 各注册一套）。四引擎并存后需改为四套 provider 同时在线，
各自按调用会话的引擎过滤，否则 codex 会话会看到 `~/.claude/commands/`。

可用接入点：

- `SkillsService.get()` 已接受 `{ cwd, signal, scope }`，`scope` 是天然的会话辨识入口。
- `ClaudeCodeSkillProvider` / `CodexSkillProvider` / `PiSkillProvider` 均为构造注入
  `control`，加一个 engine 判定谓词即可。
- Claude 的 slash commands 保留注册，handler 对非 Claude 会话返回"该命令在当前引擎
  不可用"，而非静默转发。

这是剩余工作量最大的一块。

### 5. UI 语义简化（代码净减少）

- `src/client/LoopEngineComposerSelect.tsx`：去掉确认 Modal 与 `location.reload()`，
  语义改为"下一个新会话使用哪个引擎"。
- `src/client/LoopEngineBadge.tsx`：从"全局状态"改为"当前会话的引擎"，从 session
  header 读取，**只读不可改**。
- `src/client/LoopEngineSection.tsx`：保留，语义变为"新会话的默认引擎"。

## 工作量估计

| 部分 | 估计 |
| --- | --- |
| Router + `agents` 服务代理 | 1.5 天 |
| 托管 base loop + patch 块简化 | 1 天 |
| `agentPreset` 路由与 resume | 0.5 天 |
| skill / command 按引擎过滤 | 1.5 天 |
| UI 简化 + 测试补齐 | 1.5 天 |
| **合计** | **约 6 天** |

## 已否决的备选方案

**A. 运行时热切换，但仍保持全局单引擎。**
把切换从"改文件 + 重启"降级为"运行时换装 + 只影响新会话"，复用 `src/index.ts:404`
`onChange` 中已有的 unmount/mount 与槽位重试逻辑，约 1–2 天。

否决原因：多会话并行时依然是错的——切换会让正在跑的旧引擎会话失去 factory，且
resume 会恢复到错误的引擎。它只是"看起来像" per-session。

**B. 自建 sidecar 文件持久化会话→引擎映射。**
否决原因：`agentPreset` 使这块工作完全消失，且 sidecar 无法自动获得 fork / subagent
的引擎继承语义。

## 建议的起步动作

先做第 1 步的 router 骨架 + 一个可运行的双引擎路由测试，把最大的技术风险（cordis
`agents` 服务代理）先行证伪，再推进其余步骤。
