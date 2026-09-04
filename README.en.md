# Codex ↔ Grok Bridge 0.7.0

A local Grok Build agent runtime for Codex. Codex remains the orchestrator and final verifier; Grok handles wide repository reading, implementation, and live research without feeding large Grok outputs back into the Codex context by default.

Architecture and security decisions are grounded only in official upstreams:

- OpenAI Codex: https://github.com/openai/codex
- xAI Grok Build: https://github.com/xai-org/grok-build
- Model Context Protocol: https://github.com/modelcontextprotocol/modelcontextprotocol

Third-party code attribution remains in `THIRD_PARTY_NOTICES.md`, but third-party repositories are not treated as security/architecture authorities.

## What 0.7.0 changes

- **Opaque artifacts:** full Grok output stays in a Bridge-owned artifact store. MCP returns a bounded preview plus `artifact_id`, never a local `result_path`.
- **Structured MCP:** 11 advertised tools use `outputSchema` + `structuredContent`. Old result/status/read/search names remain callable only as compatibility aliases.
- **Runtime-managed waiting:** one `grok_wait` can block up to 1800s; MCP timeout is 1860s. The installer puts the Grok namespace in Codex `code_mode.direct_only_tool_namespaces` so long waits stay direct rather than being split into model-mediated exec/wait loops.
- **Double output bound:** Bridge previews/artifact reads are bounded and Codex per-tool `output_token_limit` is configured for every advertised tool.
- **Layered isolation:** readonly and safe-worker are deny-by-default. Linux/macOS additionally use Bridge-generated custom Grok sandbox profiles; custom-profile failure is fail-closed. Native Windows never claims an OS sandbox.
- **Safe worker by default:** linked worktree only, read/grep + `Edit(./**)`, no arbitrary shell widening. Full worker on native Windows is explicit logical isolation (`security_level=logical`), not a kernel sandbox.
- **One-way auth snapshot:** isolated Grok auth is copied in but never written back to the host credential file.
- **UTF-8-correct artifact paging:** offsets are bytes; callers continue with `next_offset_bytes`.
- **Hard artifact cap + retention:** 8 MiB strict cap; default 7-day cleanup.
- **Token A/B harness:** parses official `codex exec --json` `turn.completed.usage` fields.
- **Doctor:** reports platform sandbox capability, direct-only config, output limits, auth state, Grok/Codex discovery, and Linux bubblewrap prerequisites.

## Public MCP tools

`grok_spawn_readonly`, `grok_spawn_worker`, `grok_wait`, `grok_artifact_read`, `grok_artifact_search`, `grok_send`, `grok_search`, `grok_handoff_interactive`, `grok_cancel`, `grok_close`, `grok_list`.

## Worker modes

`grok_spawn_worker` requires an explicit write-scope confirmation and a linked Git worktree.

- `worker_mode="safe"` (default): path-scoped edits with deny-by-default policy. Supported on Windows, Linux, and macOS. Codex should run tests and review the diff afterward.
- `worker_mode="full"`: fuller command/tool access inside a custom OS sandbox. Supported only on Linux/macOS. Native Windows rejects this mode; run the whole Codex/Bridge/Grok stack inside WSL2/Linux for hard full-worker isolation.

Network access for full worker is off by default. xAI's macOS sandbox does not provide Linux-equivalent child-process network blocking, and doctor reports that distinction.

## Install

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Linux/macOS CLI fallback:

```sh
./install.sh
```

Then start a new Codex thread.

## Validate

```sh
npm test
npm run doctor
npm run test:e2e   # requires official Grok Build + authentication
```

## Measure actual Codex token use

Generate JSONL for the same task under Codex-only and Bridge conditions using `codex exec --json`, then:

```sh
node benchmark/summarize.mjs codex-only.jsonl bridge.jsonl
```

Run at least five repeats per condition and compare medians. Keep commit, prompt, Codex model, and reasoning settings fixed. The primary diagnostic is uncached input (`input_tokens - cached_input_tokens`), but correctness and wall time matter too. Raw token counters are not a promise about product billing.

## Protocol stance

Production uses stable MCP 2025-11-25 structured tool output. Codex currently feature-gates MCP 2026-07-28; this Bridge deliberately does not make experimental Tasks/Resources a production dependency yet.

> Windows security note: native Windows `safe` worker fails closed when a worktree carries repo-local `.grok/config.toml` permission rules. Use WSL2/Linux full worker for such repositories, or keep Grok readonly and let Codex apply the patch.
