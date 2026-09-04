# Architecture

This document describes the **0.7.1 implementation model**. Release history belongs in [CHANGELOG.md](./CHANGELOG.md); this file focuses on components and invariants that the code is expected to preserve.

## Goals

The Bridge exists to make Grok a bounded execution and context-offload runtime underneath Codex:

1. **Codex stays the top-level orchestrator and final verifier.**
2. **Large Grok output stays outside the Codex context by default.**
3. **Writing happens only in an explicitly authorized linked Git worktree.**
4. **Waiting happens inside the runtime, not through model-visible polling loops.**
5. **Security claims come from API preconditions, static permission policy, sandbox enforcement, and explicit platform reporting—not from prompt wording.**

It is not intended to be a second top-level multi-agent orchestrator, a cross-platform-identical kernel sandbox, or a complete secret/DLP system.

## Component model

```text
Codex
  |  decision / orchestration / verification
  |
  |  MCP tools
  v
Grok Bridge
  |-- tool schema + bounded structured output
  |-- ACP session manager
  |-- permission policy
  |-- platform sandbox selection
  |-- isolated HOME / GROK_HOME
  |-- artifact store
  |-- repository-free search bridge
  |-- bounded telemetry / previews
  |
  |  ACP stdio
  v
Grok Build
  |-- readonly investigator
  |-- safe worker
  |-- full worker
  `-- research runtime
```

The plugin advertises 11 MCP tools: spawn readonly/worker, wait, artifact read/search, send, search, interactive handoff, cancel, close, and list. Older status/result/read/search names remain callable as compatibility aliases but are intentionally not advertised.

## Managed agent lifecycle

1. **Validate scope.** A readonly agent requires an absolute readable directory. A worker requires explicit write-scope confirmation and the root of a linked Git worktree; a primary checkout is rejected.
2. **Create an isolated runtime.** The Bridge creates a private temporary home, copies a bounded regular `auth.json` one-way when available, writes a minimal Grok config, disables subagents and compatibility-loaded plugins/hooks/skills, and configures shell secret excludes.
3. **Select policy and sandbox.** The Bridge passes explicit allow/deny rules to Grok. On Linux/macOS it also writes and explicitly selects a Bridge-owned custom sandbox profile extending `strict`. Native Windows does not claim an OS sandbox.
4. **Start ACP.** The Bridge launches `grok agent ... stdio`, initializes ACP, authenticates with the cached token when available, and creates one session.
5. **Run a turn.** Public agent-message chunks are streamed into the artifact path. Plan/tool metadata is retained only in bounded form. Private reasoning is not persisted or returned by the Bridge.
6. **Scrub and cap output.** Public text passes through rolling secret-pattern redaction before persistence. The artifact is capped at 8 MiB; in-memory previews remain bounded.
7. **Wait by state change.** `grok_wait` subscribes to agent revision/status changes. It does not run a fixed 200 ms polling loop. If `wait_seconds` is omitted, the wait follows the turn timeout plus 15 seconds, capped at 1800 seconds.
8. **Return an envelope.** Codex receives status metadata, a short preview, telemetry, the security contract, and an opaque `artifact_id`. Structured payloads are capped by a 96 KiB server budget.
9. **Read evidence selectively.** Codex can search or page the artifact with bounded tools. Artifact reads are scrubbed again before returning text.
10. **Reuse or close.** `grok_send` reuses the existing ACP session. `grok_close` destroys the isolated runtime; retained artifacts expire independently according to retention policy.

## Why `grok_wait` stays direct

Long-running waits should not become `exec → wait → model turn → wait again` loops. The installer merges the Grok MCP namespace into Codex `features.code_mode.direct_only_tool_namespaces`, preserving existing entries, so the long MCP wait remains a direct tool call.

The Bridge MCP timeout is 1860 seconds, above the maximum 1800-second agent wait. Callers should normally use one long `grok_wait`, not short heartbeat polling.

## Artifact model

Physical result paths are implementation details and are removed from public MCP envelopes. The public handle format is:

- `agent:<uuid>`
- `search:<run-id>`

Agent artifacts are capped at 8 MiB and retained for seven days by default. `GROK_SUBAGENT_RETENTION_DAYS` can change retention.

`grok_artifact_read` uses UTF-8 **byte offsets** and returns `next_offset_bytes`. Callers should continue from that returned cursor rather than deriving offsets from character counts. `grok_artifact_search` performs bounded case-insensitive literal substring search.

This makes selective evidence retrieval an API property rather than a prompt convention.

## Permission and worker modes

### Readonly

Static allow rules: Read, Grep.

Static deny rules include Edit, Write, Bash, WebSearch, WebFetch, and MCPTool. Permission requests are rejected rather than used to widen the policy.

### Safe worker

Safe is the default worker mode. It requires a linked worktree and allows Read/Grep plus path-scoped `Edit(./**)` and `Write(./**)`. Bash, WebSearch, WebFetch, and MCPTool are denied, and permission requests cannot dynamically widen that boundary.

On native Windows, safe worker additionally rejects a repo-local `.grok/config.toml` permission section because there is no OS sandbox to contain a project rule that could widen the effective scope.

### Full worker

Full worker allows Read/Grep, path-scoped Edit, and Bash. Git push/commit/merge/rebase/cherry-pick/tag are explicitly denied. WebSearch/WebFetch are denied unless `allow_network=true`.

On Linux/macOS the Bridge also selects a custom `strict` sandbox. On native Windows full worker is allowed but is reported as `security_level=logical`: worktree + policy only, with no kernel sandbox.

## Platform security contract

The Bridge returns a machine-readable security contract instead of pretending that every platform enforces the same boundary.

| Property | Native Windows | Linux | macOS |
| --- | --- | --- | --- |
| managed OS sandbox | none | custom `strict` profile | custom `strict` profile |
| readonly filesystem scope | policy only; OS read scope is not contained | workspace + system via sandbox | workspace + system via sandbox |
| safe-worker write boundary | worktree + static tool/path policy | policy + sandbox | policy + sandbox |
| full-worker level | `logical` | OS-enforced custom profile | OS-enforced custom profile |
| child-process network when disabled | not enforced | blocked / reported enforced | not enforced |

`agent_http_network` remains required for Grok itself. `allow_network=false` controls WebSearch/WebFetch by policy, while child-process network enforcement is a separate platform capability. Those dimensions should not be conflated.

For hard full-worker isolation on a Windows host, run Codex, Bridge, and Grok inside WSL2/Linux.

## Runtime and credential isolation

Each managed agent gets its own private home and Grok home. The generated config:

- disables Grok subagents;
- disables Cursor/Claude compatibility skills, rules, agents, MCPs, hooks, and sessions;
- uses `shell_environment_policy.inherit = "core"` with default secret excludes;
- forces folder-trust gating on managed sessions;
- installs only the Bridge permission policy.

Host `auth.json` is accepted only as a bounded regular JSON file and is copied into the isolated runtime. Changes inside that runtime are discarded; credentials are never copied back to the host.

## Search isolation

`grok_search` does not run in the current repository. It uses a platform-specific private cache and a separate isolated HOME/GROK_HOME, exposes only the intended research surface, and returns its output through the same artifact envelope.

Search artifacts use validated run IDs, and physical cache/result paths are stripped from MCP results.

## MCP protocol and output compatibility

The server prefers MCP `2025-11-25` and can negotiate several earlier supported protocol versions. Advertised tools define `outputSchema` and return `structuredContent`; a compact text summary is also returned for clients/builds that rely on the text side of the MCP result.

The Bridge intentionally bounds both sides:

- preview and artifact reads are small;
- plan/tool metadata is capped;
- structured output has a 96 KiB server budget;
- the plugin config applies per-tool `output_token_limit` as an additional client-side bound.

## Invariants worth testing

A behavior change should preserve or deliberately revise these invariants:

- worker writes require explicit authorization and a linked worktree;
- primary checkouts are rejected for managed workers;
- readonly/safe permission requests cannot widen static policy;
- non-Windows managed agents explicitly select Bridge custom sandbox profiles;
- Windows security reporting never claims an OS sandbox;
- full output is represented by opaque artifact IDs, not public local paths;
- artifacts and structured output remain bounded;
- wait is event-driven and supports one long call;
- isolated auth is never persisted back to the host;
- user plugins/hooks/skills are not inherited by managed agents.

See [SECURITY.md](./SECURITY.md) for the threat model and platform-specific caveats.
