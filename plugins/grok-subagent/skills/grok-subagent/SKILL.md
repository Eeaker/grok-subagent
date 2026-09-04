---
name: grok-subagent
description: Delegate bounded coding, investigation, implementation, and current X/Reddit/web research from Codex to the local Grok Build CLI while keeping Codex as orchestrator and verifier.
---

# Grok Subagent 0.7

Codex 做决策、拆任务、选择 effort、审查结果；Grok 承担大范围阅读、实现或实时研究。不要把最终判断外包给 Grok，也不要把 Grok 的完整大输出重新灌回 Codex。

## 什么时候用

- 很短的问题、一行修复：Codex 自己做。
- 大范围仓库阅读、独立审查、跨文件调查：`grok_spawn_readonly`。
- 用户明确授权写入后，在 linked Git worktree 实现：`grok_spawn_worker`。
- X/Reddit/实时公开研究：`grok_search`。
- 用户明确要求自己直接和 Grok 交互：`grok_handoff_interactive`。

## 生命周期

1. 一个 workstream 只 spawn 一次。不要为每个步骤重开 Grok。
2. spawn 时显式选择 `effort`: `low` / `medium` / `high` / `xhigh` / `max` 等；常规默认 `medium`。
3. 同一范围追问、补证据、返工用 `grok_send`。
4. 等结果用**一次长 `grok_wait`**。省略 `wait_seconds` 时会跟随该 agent 的 timeout + 15 秒（上限 1800）。不要用 20–60 秒 status polling。不要在 worker 还在跑时用固定 600 秒 wait。
5. MCP timeout 不等于 Grok 死了。若客户端异常返回，优先复用同一个 `agent_id`，不要立刻 spawn 副本。
6. 完成后 `grok_close`。artifact 与 agent 生命周期分离，关闭后仍可在保留期内按 `artifact_id` 读取。

## Artifact

`grok_wait` / `grok_search` 默认只返回短 preview + opaque `artifact_id`。

- 局部读取：`grok_artifact_read`。
- 关键词定位：`grok_artifact_search`。
- `grok_artifact_read.offset_bytes` 是 UTF-8 byte offset。继续读取时使用返回的 `next_offset_bytes`。
- 不要尝试寻找或直接 `cat` Bridge 的物理 artifact 文件。

## Worker

`grok_spawn_worker` 必须满足：

- 用户已经授权 Grok 写入；`confirm_write_scope=true`。
- `worktree` 是 linked Git worktree 根目录；主 checkout 会被拒绝。
- 默认 `worker_mode="safe"`。safe worker 只获得有界 edit 能力，不获得任意 shell 扩权；Codex 在完成后负责测试和 diff 审查。
- `worker_mode="full"`（或 `allow_shell=true`）允许 shell。Linux/macOS 有 custom OS sandbox；原生 Windows 没有内核沙箱，返回 `security_level=logical`。不要把它说成 hard isolation。
- `allow_network` 仅 full worker 使用，默认 false。

## 安全

- 不要把密钥放进 prompt。
- 不要让 Grok spawn 子代理。
- Native Windows 没有 xAI Grok OS-level sandbox；readonly/safe-worker 是 policy-enforced，不要描述成内核隔离。
- Codex 与 Grok 意见一致不等于验证。最终打开 Grok 给出的证据位置并审查必要 diff/test。
- 跑飞用 `grok_cancel`；不用了用 `grok_close`。

详见 `references/safety.md`。
