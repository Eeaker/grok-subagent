# Codex ↔ Grok Bridge

[简体中文](./README.zh-CN.md) · [English](./README.en.md)

一个把 **Grok Build** 放在 **Codex** 下方运行的本地 ACP 子代理桥接器：Codex 负责拆解任务、做决策和最终验证，Grok 负责大范围阅读、实现和实时研究。Bridge 的重点不是让两个模型互相聊天，而是把 Grok 的大输出留在本地 artifact store，只把短 preview 和不透明的 `artifact_id` 送回 Codex。

当前实现版本为 **0.7.1**。版本变化请看 [CHANGELOG.md](./CHANGELOG.md)，这里尽量只保留长期有效的使用说明。

## 它解决什么问题

- **大上下文下沉**：让 Grok 消化仓库、日志或研究材料，避免把完整长回答重新塞进 Codex 上下文。
- **有边界的写入**：写代理只能在 linked Git worktree 中启动；默认 `safe` 模式没有任意 shell 权限。
- **一次长等待**：`grok_wait` 在 Bridge 内等待 agent 状态变化，不需要 Codex 反复短轮询。
- **隔离运行时**：managed agent 使用临时 `HOME` / `GROK_HOME`，不继承用户 plugins、hooks、skills 或兼容层配置。
- **独立实时研究**：`grok_search` 在仓库之外运行 X / Reddit / Web 研究，并同样只返回 preview + artifact。

```text
Codex
  ├─ 任务拆解 / 决策 / 最终验证
  │
  └─ MCP
      ↓
Grok Bridge
  ├─ ACP session lifecycle
  ├─ permission / sandbox policy
  ├─ artifact store
  ├─ isolated search
  └─ bounded output / telemetry
      ↓
Grok Build
  ├─ readonly investigator
  ├─ safe worker
  ├─ full worker
  └─ research
```

## 快速安装

### 前置要求

- Node.js **22+**
- Python 3
- 已安装并登录官方 Grok Build CLI
- Codex Desktop 或 Codex CLI

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

安装器会优先使用 Codex Desktop plugin；找不到 Desktop plugin binary 时会安装 CLI fallback skill + MCP 配置。安装完成后请新开一个 Codex task/thread，让 plugin、skill 和 MCP 配置重新加载。

### Linux / macOS

```sh
./install.sh
```

Linux 上如果 `doctor` 提示缺少 `bubblewrap`，先安装它再使用需要 custom sandbox 的 managed agent。

安装后建议先运行：

```sh
npm run doctor
```

## 推荐工作流

### 只读调查

让 Codex 用 `grok_spawn_readonly` 启动一个调查 agent，然后用一次 `grok_wait` 等待完成。Codex 只读取 preview；需要证据时再对返回的 `artifact_id` 调用 `grok_artifact_search` 或 `grok_artifact_read`。

### 实现任务

写代理必须运行在 linked Git worktree 中，主 checkout 会被拒绝。默认使用 `worker_mode="safe"`：允许 Read/Grep，以及 worktree 内受路径限制的 Edit/Write；不允许 Bash，也不能通过 permission request 动态扩大权限。

Grok 完成后，仍由 Codex 检查 diff、运行测试并决定是否采用修改。

### 实时研究

`grok_search` 使用独立缓存和独立运行时，不把当前仓库作为 cwd。适合需要 X、Reddit 或公开 Web 的最新信息，但检索到的网页内容仍应视为不可信输入。

## 公开 MCP 工具

| 工具 | 用途 |
| --- | --- |
| `grok_spawn_readonly` | 启动只读调查 agent |
| `grok_spawn_worker` | 在 linked worktree 中启动写 agent；默认 `safe` |
| `grok_wait` | 在 Bridge 内等待当前 turn 完成 |
| `grok_artifact_read` | 按 UTF-8 字节偏移读取 artifact 小片段 |
| `grok_artifact_search` | 对 artifact 做有界、大小写不敏感的字面搜索 |
| `grok_send` | 复用已有 session 做追问或返工 |
| `grok_search` | 隔离的 X / Reddit / Web 研究 |
| `grok_handoff_interactive` | 打开用户监督的 Grok TUI；当前支持 Windows/macOS |
| `grok_cancel` | 取消当前 turn，保留已写入的 artifact |
| `grok_close` | 关闭 agent 并销毁隔离 runtime |
| `grok_list` | 列出 live agents 和保留的 search artifacts |

旧的 status/result/read/search 工具名只作为未广告的兼容别名保留，新集成不要依赖它们。

## Artifact 与等待语义

Grok 的完整公共回答写入 Bridge 自己的 artifact store。MCP 结果不暴露物理 `result_path`，而是返回类似下面的句柄：

```text
agent:550e8400-e29b-41d4-a716-446655440000
search:20260903T120000Z-0123456789abcdef0123456789abcdef
```

- 单个 agent artifact 最大 **8 MiB**，超过后严格截断。
- 默认保留 **7 天**，可用 `GROK_SUBAGENT_RETENTION_DAYS` 调整。
- `grok_artifact_read` 的 offset 是 **byte offset**；继续分页时应使用返回的 `next_offset_bytes`。
- 结构化 MCP payload 有服务端 **96 KiB** 预算；plugin 还为公开工具配置 per-tool `output_token_limit`。
- `grok_wait` 未显式提供 `wait_seconds` 时，会跟随 agent timeout + 15 秒，最多 1800 秒；等待是事件驱动的，不是固定间隔轮询。
- MCP `tool_timeout_sec` 为 1860 秒，正常使用不应自行做 20–60 秒 heartbeat polling。

## 安全边界

Bridge 会主动收紧权限，但它不是跨平台完全等价的沙箱产品。详细威胁模型见 [SECURITY.md](./SECURITY.md)。

| 模式 | 原生 Windows | Linux / macOS |
| --- | --- | --- |
| readonly | 静态 tool policy；**没有 OS sandbox** | 静态 policy + Bridge 生成的 custom `strict` sandbox |
| safe worker | linked worktree + 静态 path/tool policy；**没有 OS sandbox** | linked worktree + 静态 policy + custom `strict` sandbox |
| full worker | 允许，但仅 `security_level=logical` | custom `strict` sandbox + policy |

几个容易误解的点：

- 原生 Windows 不提供 xAI Grok 的内核级 sandbox。需要 hard isolation 时，把 Codex / Bridge / Grok 整体放进 WSL2/Linux。
- `allow_network=false` 会通过 policy 禁用 WebSearch/WebFetch；**child-process 网络的强制阻断只在 Linux 报告为 enforced**。macOS 和 Windows 不应被当作 hard network isolation。
- 原生 Windows 的 `safe` worker 遇到 worktree 内带 permission section 的 `.grok/config.toml` 会 fail closed，避免项目级 allow 规则扩大写权限。
- managed agent 的 host `auth.json` 只做单向快照，不会从隔离 runtime 写回宿主凭证。
- 公共输出会做 secret pattern 清理，并在 artifact 读取时再次检查；这是防御层，不应当被当作完整 DLP 保证。

## 验证与开发

```sh
npm test
npm run doctor
npm run test:e2e   # 需要真实 Grok CLI + 登录
```

普通测试不要求本机已经安装 Grok；真实 ACP E2E 会消耗 Grok 使用量。

如果要比较 Codex-only 与 Bridge 的 token 使用，可以对同一任务采集 `codex exec --json` 输出，再运行：

```sh
node benchmark/summarize.mjs codex-only.jsonl bridge.jsonl
```

把 benchmark 当作诊断工具，不要把字符数或缓存 token 直接解释成产品计费结论。

## 进一步阅读

- [ARCHITECTURE.md](./ARCHITECTURE.md) — 生命周期、组件和关键 invariant
- [SECURITY.md](./SECURITY.md) — 威胁模型、平台差异和安全边界
- [CHANGELOG.md](./CHANGELOG.md) — 版本变化
- [CONTRIBUTING.md](./CONTRIBUTING.md) — 开发与贡献约定
- [LOCALIZATION.md](./LOCALIZATION.md) — 平台相关说明
- [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) — 第三方许可证归属

## 上游与许可证

架构和兼容性主要对照以下官方上游：

- [OpenAI Codex](https://github.com/openai/codex)
- [xAI Grok Build](https://github.com/xai-org/grok-build)
- [Model Context Protocol](https://github.com/modelcontextprotocol/modelcontextprotocol)

本仓库由 Eeaker 维护，源自 [Walvez/grok-subagent](https://github.com/Walvez/grok-subagent) 的 MIT 代码并做了 Windows 本地化、token offload 与安全边界改造。许可证与第三方归属见 [LICENSE](./LICENSE) 和 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
