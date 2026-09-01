# dsh-agent-hub

[![npm version](https://img.shields.io/npm/v/@vidge/dsh-agent-hub?color=cb3837)](https://www.npmjs.com/package/@vidge/dsh-agent-hub)

在 **dsh** 上运行任意 agent loop 引擎——内置的 in-process loop、Claude Code、
Codex、Pi——**按会话选择**，并且全部共用 dsh 自己的会话存储、消息格式、模型调度
与链路追踪。

像选模型一样选引擎：在 composer 里选，开一个新会话。当前会话仍跑在它创建时的引擎
上。不用重启，不是全局切换，不会打断正在进行的工作。

## 为什么是 hub

dsh 整个进程只允许一个 `AgentFactory`。正是这个唯一槽位，使得以往所有做法都只能是
**全局**选择：要跑 Claude Code 就得禁掉 base loop，profile 里的每个会话都被一起
带走。

本插件占住那个槽位，并把它变成一个路由器。它为每个引擎持有一个 factory——**包括
dsh 自己的 in-process loop，它是被托管为一等引擎，而不是被替换**——并把每次
`createAgent` / `resume` 调用分发给该会话所属的引擎。

```
dsh harness  (会话 · llm · 追踪 · 模型调度)
      │
      │  唯一的 AgentFactory 槽位
      ▼
 LoopEngineRouter
      ├── in-process   → @deepseek-ai/dsh-agent-loop  (托管，非替换)
      ├── claude-code  → Claude Agent SDK
      ├── codex        → codex app-server
      └── pi           → pi --mode rpc
```

路由器之上的一切仍然是 dsh 的。各引擎的原生输出会被翻译成 dsh 的 `Message` /
`ContentBlock` / `StreamChunk` 类型，因此不同引擎产生的会话在存储、流式推送、恢复
和追踪上表现完全一致。

### 引擎归属是持久的

会话的引擎在创建时被记录，并随会话一起流转。恢复会话时会回到产生这段历史的引擎，
而不是当前选中的引擎。这一点很重要：各引擎的会话日志 provenance 不同（Codex 驱动
的会话记录 `provider = 'codex'`），跨引擎重放会把一段模型无法据以行动的历史交给它。

fork 出的会话与 subagent 会继承父会话的引擎。

## 安装

```sh
dsh plugin --profile web add @vidge/dsh-agent-hub
```

安装后重启一次 `dsh web`。此后引擎选择即为运行时状态——再也不需要因切换而重启。

> 安装会在 profile 的 `cordis.patch.yml` 中写入一小段托管块，禁用 bundle 自带的
> `agent-loop` 行，以便路由器接管 factory 槽位并由它自己重新挂载该 loop。文件中
> 其余内容逐字节保留。

### 依赖要求

仅针对你实际使用的引擎：

- **Claude Code** —— 宿主机安装 Claude Code CLI。凭证由 dsh 自身的 LLM provider
  配置派生（见下文）；CLI 登录只是兜底，不是必需。
- **Codex** —— 通过 `codex login` 认证，或提供 `CODEX_API_KEY`。
- **Pi** —— 按 pi 自己的方式认证：`~/.pi/agent/auth.json`，或对应 provider 的
  API-key 环境变量。

in-process 引擎除 dsh 本身外无任何额外要求。

## 使用

在 composer 中开始会话时选择引擎。要换引擎，开一个新会话——当前会话保持它的引擎，
仍在其上运行的任务不受影响。

**设置 → Loop engine** 用于设定新会话的默认引擎，以及控制是否显示 composer 选择器。

卸载插件：

```sh
dsh plugin --profile web remove @vidge/dsh-agent-hub
```

然后重启 `dsh web`。

## 模型与凭证路由

对 Claude Code 引擎，子进程的 provider 环境变量由 **dsh 自身的 LLM 配置派生**，
而不是从启动宿主的 shell 继承。选中的模型指明一条 provider 路由，插件从
`llm-pi-ai` 设置中读取该路由的 endpoint，通过 dsh 的 `credentials` 服务解析其密钥，
再把结果表述为 Agent SDK 能理解的环境变量——支持 Bedrock（含企业网关场景）与原生
Anthropic endpoint。

这正是从桌面启动器启动的 dsh 也能工作的原因：它没有继承任何 provider 变量，但它
不需要。dsh 自己就知道答案。

当路由无法派生时——例如没有 Claude Code 对应实现的 OpenAI 协议 provider、或凭证
未配置——插件会回退到继承环境，并报告子进程实际被指向了哪里。

## 各引擎说明

- **Claude Code** 每个 dsh step 运行一次 SDK query。其斜杠命令被桥接进 web 菜单
  （内置命令加上用户级 `~/.claude/commands/`）并转发给引擎原生展开。项目级
  `.claude/commands/` 文件保留在引擎侧，直接输入即可使用。
- **Codex** 运行 `codex app-server`，没有交互式工具审批——权限来自会话的
  `sandboxMode` + `approvalPolicy`。其 `AGENTS.md` 指令文件通过 dsh 的
  skill-injection 接缝暴露，覆盖从会话 cwd 到 git 根目录的每一层，外加
  `~/.codex/AGENTS.md`。
- **Pi** 运行 `pi --mode rpc`。Pi 没有权限系统，因此整个子进程通过 dsh subprocess
  服务沙箱化（默认 `read-only`）。其上下文文件（`AGENTS.md` / `CLAUDE.md`，
  优先 `AGENTS.override.md`，加上 pi 配置目录下的用户级文件）与 `skills/` 目录
  通过同一接缝暴露。

## 许可

MIT
