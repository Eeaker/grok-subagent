# Architecture — 0.7.0

## Goal

Use Grok as a bounded context-offload runtime underneath Codex, not as a second top-level orchestrator.

```text
Codex (decision + verification)
        |
        | MCP 2025-11-25, structured output
        v
Grok Bridge
  |-- Session manager (ACP)
  |-- Permission + sandbox policy
  |-- Opaque artifact store
  |-- Search isolation
  |-- Token/latency telemetry hooks
        |
        v
Grok Build (readonly / safe-worker / full-worker / research)
```

## Managed agent lifecycle

1. Codex spawns one bounded agent and chooses reasoning effort.
2. Bridge creates an isolated HOME/GROK_HOME and copies host auth one-way.
3. Bridge writes a minimal config with compatibility loading disabled and shell secret filtering enabled.
4. On Linux/macOS, Bridge writes and explicitly selects a custom sandbox profile. Explicit custom-profile failure is fail-closed in xAI Grok Build.
5. Bridge starts `grok agent ... stdio` and creates one ACP session.
6. Grok streams public message chunks and structured tool status. Private thought chunks are never persisted or forwarded.
7. Full public answer streams directly to an 8 MiB-capped artifact; RAM holds only bounded previews.
8. Codex waits through one direct `grok_wait`; internal 200ms state checks do not invoke the Codex model.
9. Codex receives structured metadata + preview + opaque artifact ID, then reads/searches only relevant slices.
10. Follow-ups reuse the same session. Close destroys the isolated runtime; artifact retention is independent.

## Why direct-only in Codex code mode

OpenAI Codex exposes `code_mode.direct_only_tool_namespaces` specifically for namespaces that must remain top-level direct tools. Long-running MCP calls can otherwise be nested in code-mode execution and yield back to the model. Installer configures both `mcp__grok_subagent` and `grok_subagent` to cover prefixed and non-prefixed MCP naming modes.

## Why custom Grok sandbox profiles

xAI distinguishes built-in sandbox profiles from explicitly requested custom profiles. Built-in sandbox application can warn and continue in some failure cases. An explicit custom profile is fail-closed on supported platforms. Bridge therefore generates `bridge-readonly`, `bridge-safe-worker`, and `bridge-full-worker` profiles instead of treating the built-in profile name as a hard security promise.

The profiles also deny common secret-file patterns. On Linux, read-deny requires bubblewrap; if it is absent, startup fails rather than silently removing the deny layer.

## Windows model

xAI currently documents OS-level Grok sandbox primitives for Linux (Landlock/bubblewrap) and macOS (Seatbelt), not Windows. Therefore:

- readonly and safe-worker are `policy-enforced` on native Windows;
- full-worker on native Windows is `security_level=logical` (no OS sandbox);
- hard full-worker isolation requires running the stack inside WSL2/Linux.

## Artifact API

Physical result paths are implementation details and never enter MCP results. Artifact IDs are capability-like handles:

- `agent:<uuid>`
- `search:<run-id>`

`grok_artifact_read` uses byte offsets and returns `next_offset_bytes`; `grok_artifact_search` uses bounded literal substring matches. This makes “do not cat the whole result” an API invariant instead of a prompt convention.

## MCP protocol choice

0.7.0 uses MCP 2025-11-25 `outputSchema` + `structuredContent`, which both the official MCP spec and current Codex implementation support. Codex has a feature-gated MCP 2026-07-28 mode, but the Bridge does not yet require Tasks/Resources because that path is still evolving.

## Upstream authority

- OpenAI Codex: https://github.com/openai/codex
- xAI Grok Build: https://github.com/xai-org/grok-build
- MCP: https://github.com/modelcontextprotocol/modelcontextprotocol
