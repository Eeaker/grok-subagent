# Codex ↔ Grok Bridge 0.7.0

一个面向 Codex 的本地 Grok Build 子代理运行时。目标不是让两个模型“互相聊天”，而是让 **Codex 保留决策和最终审查权，Grok 承担大范围阅读、实现和实时研究，同时尽量不把 Grok 的大输出重新灌回 Codex 上下文**。

本版本的设计依据只使用官方上游：

- OpenAI Codex: https://github.com/openai/codex
- xAI Grok Build: https://github.com/xai-org/grok-build
- Model Context Protocol: https://github.com/modelcontextprotocol/modelcontextprotocol

第三方项目仅在 `THIRD_PARTY_NOTICES.md` 中保留许可证归属，不作为安全或架构正确性的依据。

## 0.7.0 的核心变化

### 1. Token：完整结果永不直接回流

Grok 的完整回答写入 Bridge 自己的 artifact store，Codex 默认只收到短 preview 和 opaque `artifact_id`。需要证据时再用 `grok_artifact_read` / `grok_artifact_search` 局部读取。

MCP 层同时使用 Codex 官方支持的 per-tool `output_token_limit` 作为第二道上限。安装器还把 Grok MCP namespace 写入 Codex `features.code_mode.direct_only_tool_namespaces`，避免长时间 `grok_wait` 被 code mode 拆成 `exec → wait → 再次模型推理` 的轮询链。

`grok_wait` 最长等待 1800 秒；MCP `tool_timeout_sec` 是 1860 秒。不要用 20–60 秒轮询。

### 2. MCP：11 个结构化工具

所有公开工具都定义 `outputSchema` 并返回 MCP `structuredContent`。旧的 `grok_status` / `grok_result` / `grok_result_read` / `grok_result_search` 等名字只保留为不广告的兼容别名。

| 工具 | 用途 |
| --- | --- |
| `grok_spawn_readonly` | 启动只读调查代理 |
| `grok_spawn_worker` | linked worktree 写入；默认 `worker_mode=safe` |
| `grok_wait` | 在 Bridge 内长等待，不让 Codex 轮询 |
| `grok_artifact_read` | 按 UTF-8 字节游标读取小片段 |
| `grok_artifact_search` | 对 artifact 做有界字面搜索 |
| `grok_send` | 复用现有 agent 做追问/返工 |
| `grok_search` | 隔离 X / Reddit / Web 研究 |
| `grok_handoff_interactive` | 用户直接接管一个 Grok TUI |
| `grok_cancel` | 取消当前 turn |
| `grok_close` | 关闭 agent，销毁隔离 runtime |
| `grok_list` | 列出当前 agent 与保留的搜索 artifact |

## 3. 安全模型

### Readonly

- Windows：`ask` baseline + 静态 allow/deny + Bridge 拒绝未预批准 permission request；任何未在静态策略内的 permission request 都由 Bridge 拒绝。
- Linux/macOS：上述策略 + Bridge 生成的 `bridge-readonly` **custom sandbox profile**。自定义 profile 如果无法应用会 fail-closed，而不是默默降级。

### Safe worker（默认）

`grok_spawn_worker` 默认 `worker_mode="safe"`：

- 必须是 linked Git worktree，主 checkout 被拒绝；
- `ask` baseline；
- 只允许 read/grep 和 `Edit(./**)`；
- 不给任意 shell 扩权；
- Git push/commit/merge/rebase/cherry-pick/tag 明确 deny；
- Windows 可用；Linux/macOS 再叠加 custom OS sandbox。

Codex 负责在 worker 完成后运行测试和审查 diff。

### Full worker

`worker_mode="full"`（或 `allow_shell=true`）允许更完整的工具/命令能力。Linux/macOS 叠加 custom OS sandbox。原生 Windows 不会拒绝，但只提供 `security_level=logical`，没有内核沙箱。

需要 Windows 上的 hard full-worker isolation，请把 **Codex / Bridge / Grok 整体运行在 WSL2/Linux**，而不是让 Windows 模式伪装成硬隔离。

`allow_network` 默认 `false`。注意 xAI 当前 macOS sandbox 的 child-process network blocking 不提供与 Linux 等价的强制保证；Bridge 的 doctor 会明确报告平台差异。

## 4. 凭证与运行时隔离

每个 managed Grok agent 都使用独立的临时 `HOME` / `GROK_HOME`：

- 不加载用户 plugins / hooks / skills / Claude/Cursor compatibility；
- 宿主 `auth.json` 只做**单向快照**；隔离运行时绝不写回真实 auth；
- `shell_environment_policy.inherit = "core"` 且启用默认 secret excludes；
- Grok 主进程可以拿到认证信息，但 shell 子进程默认看不到 `*KEY*` / `*SECRET*` / `*TOKEN*` 类环境变量；
- 运行结束销毁隔离 runtime。

## 5. Artifact

MCP 输出不再暴露 `result_path`。ID 示例：

```text
agent:550e8400-e29b-41d4-a716-446655440000
search:20260903T120000Z-0123456789abcdef0123456789abcdef
```

artifact 最大 8 MiB，写入时严格截断，不会因为单个大 chunk 越过上限。默认保留 7 天，可用 `GROK_SUBAGENT_RETENTION_DAYS` 修改。

`grok_artifact_read` 的 offset 是 **byte offset**。始终使用返回的 `next_offset_bytes` 继续读，中文/emoji 不会因为把字符偏移误当字节偏移而错位。

## 6. 搜索隔离

`grok_search` 在独立缓存目录中运行，不把当前仓库作为 cwd，只开放 Grok 的 X/web 搜索能力。Windows 默认缓存到 `%LOCALAPPDATA%\grok-subagent\search-runs`，Linux/macOS 默认 `~/.cache/grok-subagent/search-runs`。

搜索同样只把 preview + `artifact_id` 给 Codex。搜索隔离 auth 也不再回写宿主。

## 7. 安装

### Windows / Codex Desktop

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

安装脚本会：

- 清理重复的旧 MCP/skill 配置；
- 安装/重装 Desktop plugin 或 CLI fallback skill；
- 合并 Codex `features.code_mode.direct_only_tool_namespaces`，保留已有 namespace；
- 把项目设为 trusted；
- 运行 `npm run doctor`。

安装后必须新开 Codex thread。

### Linux/macOS CLI fallback

```sh
./install.sh
```

若 Linux doctor 提示缺少 `bubblewrap`，请先安装它。Bridge 的 custom sandbox 使用敏感路径 deny 时会 fail-closed；不会为了“能跑”而静默撤掉保护。

## 8. Doctor

```sh
npm run doctor
```

检查 Node/Python/Grok/Codex、MCP timeout/output limits、Codex direct-only namespace、auth 文件、平台 sandbox 能力以及 Linux bubblewrap。

## 9. 真实 Token A/B 测量

不要用“少了多少字符”冒充“省了多少 Codex token”。Codex 官方 `codex exec --json` 的 `turn.completed.usage` 已提供 input/cached/cache-write/output/reasoning token。

```sh
node benchmark/summarize.mjs codex-only.jsonl bridge.jsonl
```

至少每组跑 5 次，固定 commit、任务、Codex 模型和 reasoning effort，比较中位数。重点看：

```text
uncached_input_tokens = input_tokens - cached_input_tokens
```

同时比较 correctness、turn 数、MCP calls 和 wall time。缓存 token 与套餐/计费的换算不能由本项目擅自推断。

## 10. 测试

```sh
npm test
npm run doctor
npm run test:e2e   # 需要真实 Grok CLI + 登录
```

静态/单元测试不要求本机安装 Grok。真实 ACP E2E 单独运行。

## 设计原则

1. Codex 是 orchestrator 和最终 verifier。
2. 大上下文交给 Grok 消化，大结果留在 artifact store。
3. 等待发生在 runtime，不发生在模型轮询层。
4. 安全保证必须来自 permission / sandbox / API invariant，而不是“请不要这样做”的 prompt。
5. Windows 不虚构 OS sandbox。
6. 不抢跑不稳定协议：生产 MCP 保持 2025-11-25；等 Codex 对 2026-07-28 Tasks/Resources 路径成熟后再迁移。

> Windows 安全说明：原生 Windows 的 `safe` worker 会拒绝带项目级 `.grok/config.toml` 权限规则的 worktree，避免项目 allow 规则在缺少 OS sandbox 时扩大写入范围。此类项目建议在 WSL2/Linux 中使用 full worker，或让 Grok 只读分析、由 Codex 应用修改。
