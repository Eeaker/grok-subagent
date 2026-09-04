# Codex ↔ Grok Bridge

[简体中文](./README.zh-CN.md) · [English](./README.en.md)

A local ACP subagent bridge that runs **Grok Build** underneath **Codex**. Codex keeps task decomposition, decisions, and final verification; Grok handles wide repository reading, implementation, and live research. The Bridge is designed to keep large Grok outputs in a local artifact store and return only a short preview plus an opaque `artifact_id` to Codex.

The current implementation version is **0.7.1**. See [CHANGELOG.md](./CHANGELOG.md) for release-specific changes; this README focuses on the stable usage model.

## What it is for

- **Context offload:** let Grok digest repositories, logs, or research without feeding the full response back into Codex.
- **Bounded writes:** writing agents may only start in a linked Git worktree; the default `safe` worker has no arbitrary shell access.
- **One long wait:** `grok_wait` waits inside the Bridge for agent state changes instead of making Codex run short polling loops.
- **Isolated managed runtime:** each managed agent gets a temporary `HOME` / `GROK_HOME` and does not inherit user plugins, hooks, skills, or compatibility rules.
- **Repository-free live research:** `grok_search` runs X / Reddit / Web research outside the current repository and also returns preview + artifact only.

```text
Codex
  ├─ task decomposition / decisions / final verification
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

## Quick install

### Requirements

- Node.js **22+**
- Python 3
- Official Grok Build CLI installed and authenticated
- Codex Desktop or Codex CLI

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The installer prefers the Codex Desktop plugin path. If the Desktop plugin binary is not available, it installs the CLI fallback skill + MCP configuration. Start a new Codex task/thread after installation so plugin, skill, and MCP configuration are reloaded.

### Linux / macOS

```sh
./install.sh
```

On Linux, install `bubblewrap` if `doctor` reports it missing before using managed agents that require the custom sandbox profile.

Then run:

```sh
npm run doctor
```

## Recommended workflow

### Read-only investigation

Have Codex start `grok_spawn_readonly`, then use one `grok_wait`. Codex should rely on the preview first and use `grok_artifact_search` or `grok_artifact_read` only when it needs supporting evidence from the returned `artifact_id`.

### Implementation work

Writing agents require a linked Git worktree; the primary checkout is rejected. The default `worker_mode="safe"` allows Read/Grep plus path-scoped Edit/Write inside the worktree. It does not allow Bash, and permission requests cannot dynamically widen the policy.

After Grok finishes, Codex should still inspect the diff, run tests, and decide whether to keep the changes.

### Live research

`grok_search` uses a separate cache and runtime and does not use the repository as its cwd. It is intended for current X, Reddit, or public-Web research. Retrieved web content remains untrusted input.

## Advertised MCP tools

| Tool | Purpose |
| --- | --- |
| `grok_spawn_readonly` | Start a read-only investigation agent |
| `grok_spawn_worker` | Start a writer in a linked worktree; defaults to `safe` |
| `grok_wait` | Wait inside the Bridge for the current turn to settle |
| `grok_artifact_read` | Read a bounded artifact slice using UTF-8 byte offsets |
| `grok_artifact_search` | Run bounded case-insensitive literal search over an artifact |
| `grok_send` | Reuse an existing session for follow-up or rework |
| `grok_search` | Isolated X / Reddit / Web research |
| `grok_handoff_interactive` | Open a user-supervised Grok TUI; currently Windows/macOS |
| `grok_cancel` | Cancel the current turn while retaining the artifact |
| `grok_close` | Close the agent and destroy its isolated runtime |
| `grok_list` | List live agents and retained search artifacts |

Legacy status/result/read/search names remain only as unadvertised compatibility aliases. New integrations should not depend on them.

## Artifact and wait semantics

Full public Grok output is written to the Bridge-owned artifact store. MCP results do not expose a physical `result_path`; they return handles such as:

```text
agent:550e8400-e29b-41d4-a716-446655440000
search:20260903T120000Z-0123456789abcdef0123456789abcdef
```

- An agent artifact is capped at **8 MiB** and is truncated strictly at the cap.
- Artifacts are retained for **7 days** by default; `GROK_SUBAGENT_RETENTION_DAYS` overrides retention.
- `grok_artifact_read` uses **byte offsets**. Continue paging with the returned `next_offset_bytes`.
- Structured MCP payloads have a server-side **96 KiB** budget; the plugin also configures per-tool `output_token_limit` for advertised tools.
- If `wait_seconds` is omitted, `grok_wait` follows the agent timeout plus 15 seconds, capped at 1800 seconds. Waiting is event-driven rather than interval polling.
- MCP `tool_timeout_sec` is 1860 seconds. Normal use should not add 20–60 second heartbeat polling.

## Security boundaries

The Bridge deliberately narrows authority, but it is not an identical sandbox across operating systems. See [SECURITY.md](./SECURITY.md) for the full threat model.

| Mode | Native Windows | Linux / macOS |
| --- | --- | --- |
| readonly | static tool policy; **no OS sandbox** | static policy + Bridge-generated custom `strict` sandbox |
| safe worker | linked worktree + static path/tool policy; **no OS sandbox** | linked worktree + static policy + custom `strict` sandbox |
| full worker | allowed, but only `security_level=logical` | custom `strict` sandbox + policy |

Important caveats:

- Native Windows has no xAI Grok kernel-level sandbox. For hard isolation, run the Codex / Bridge / Grok stack inside WSL2/Linux.
- `allow_network=false` disables WebSearch/WebFetch by policy. **Hard child-process network blocking is reported as enforced only on Linux**; macOS and Windows must not be treated as hard network isolation.
- Native Windows `safe` worker fails closed if the worktree contains a `.grok/config.toml` permission section, preventing repo-local allow rules from widening the write scope.
- Host `auth.json` is copied one-way into managed runtimes and is never written back from the isolated runtime.
- Public output is scrubbed for common secret patterns and artifact reads are checked again. This is defense in depth, not a complete DLP guarantee.

## Validate and develop

```sh
npm test
npm run doctor
npm run test:e2e   # requires a real Grok CLI + authentication
```

The normal test suite does not require Grok to be installed locally; the real ACP E2E does consume Grok usage.

For a Codex-only vs Bridge token comparison, capture `codex exec --json` for the same task and run:

```sh
node benchmark/summarize.mjs codex-only.jsonl bridge.jsonl
```

Treat the benchmark as a diagnostic tool. Character counts and cached-token counters are not direct product-billing claims.

## Further reading

- [ARCHITECTURE.md](./ARCHITECTURE.md) — lifecycle, components, and invariants
- [SECURITY.md](./SECURITY.md) — threat model, platform differences, and trust boundaries
- [CHANGELOG.md](./CHANGELOG.md) — release history
- [CONTRIBUTING.md](./CONTRIBUTING.md) — development and contribution rules
- [LOCALIZATION.md](./LOCALIZATION.md) — platform notes
- [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) — third-party attribution

## Upstreams and license

Architecture and compatibility are primarily checked against these official upstreams:

- [OpenAI Codex](https://github.com/openai/codex)
- [xAI Grok Build](https://github.com/xai-org/grok-build)
- [Model Context Protocol](https://github.com/modelcontextprotocol/modelcontextprotocol)

This repository is maintained by Eeaker and started from MIT-licensed [Walvez/grok-subagent](https://github.com/Walvez/grok-subagent), with substantial Windows localization, token-offload, and security-boundary changes. See [LICENSE](./LICENSE) and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
