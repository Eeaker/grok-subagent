# Changelog

## 0.7.2 - 2026-09-04

### Fixed

- Codex could load the Grok **skill** while hiding the MCP tools (`grok_spawn_readonly`, `grok_wait`, …). Two local causes:
  1. marketplace.json was renamed to `eeaker-grok` but `config.toml` still had `grok-subagent@walvez-grok`;
  2. installer wrote a bare `[features.code_mode]` table, which can enable under-development code-mode and defer long MCP tools so the model never sees them.
- Installer now migrates the plugin id to `grok-subagent@eeaker-grok` and sets `features.code_mode.enabled = false` while still recording direct-only namespaces for later.

## 0.7.1 - 2026-09-04

### Fixed

- `grok_wait` no longer defaults to 600s in the schema. If `wait_seconds` is omitted it follows the agent's timeout plus 15s (capped at 1800), so a 900s worker does not wake Codex at 600s.
- Internal wait is event-driven from agent status/revision changes instead of a 200ms poll loop.
- Readonly custom sandbox now extends `strict` (workspace + system paths), not whole-machine `read-only`.
- Spawn/status payloads include a `security` contract that splits filesystem vs child-process network. macOS `restrict_network` is reported as `not_enforced`.
- Plan/tool metadata is bounded server-side. Structured MCP payloads have a 96 KiB budget.
- Secret redaction uses a rolling hold-back buffer and re-scrubs artifact reads. `content` and `structuredContent` both carry a short preview so Codex builds that drop one side still work.

## 0.7.0 - 2026-09-04

- Replaced model-visible polling with one advertised `grok_wait`; legacy status/result names remain unadvertised compatibility aliases.
- Added MCP 2025-11-25 `outputSchema` + `structuredContent` for all 11 advertised tools.
- Replaced public `result_path` with opaque `artifact_id`; unified bounded read/search through `grok_artifact_read` and `grok_artifact_search`.
- Fixed UTF-8 paging semantics: offsets are bytes and calls return `next_offset_bytes`.
- Enforced a strict 8 MiB artifact cap and default 7-day artifact/runtime retention cleanup.
- Added readonly/safe/full policy modes. Readonly and safe-worker are deny-by-default. Native Windows full worker is allowed as `security_level=logical` (no OS sandbox); it is not rejected.
- Linux/macOS managed agents now use explicitly requested custom Grok sandbox profiles so sandbox application failure is fail-closed.
- Removed isolated-auth write-back to host credentials for ACP and search runs; auth snapshots are one-way.
- Added Codex `enabled_tools`, per-tool approval modes, and per-tool `output_token_limit`; long MCP timeout remains 1860s.
- Installer now merges `features.code_mode.direct_only_tool_namespaces` for the Grok namespace to keep long waits out of model-mediated code-mode polling loops.
- Added `npm run doctor`, Linux/macOS `install.sh`, Windows process-tree cleanup for search, and platform-aware search cache paths.
- Added actual Codex token A/B summarizer based on `codex exec --json` `turn.completed.usage`.
- Added Linux/Windows CI coverage and expanded hardening/structured-output tests.
- Documentation now treats only OpenAI Codex, xAI Grok Build, and MCP official upstreams as architecture/security authorities.

All notable changes to this project will be documented here.

## 0.6.5 - 2026-09-03

### Fixed

- Plugin MCP sets `tool_timeout_sec` to 1860 so Codex's client timeout is above the 1800s `grok_result` wait. Official default is 60s.
- Readonly ACP no longer relies on headless-only `--disallowed-tools` with non-existent tool IDs (`write` / `write_file` / `edit_file`). It now uses `--agent-profile`, `--deny Edit/Write/Bash`, and an isolated `GROK_HOME` permission policy. `--always-approve` stays, as xAI documents for agent servers, with deny rules as the hard limit.
- ACP agents get a temporary `GROK_HOME` (auth copy + minimal config), so user plugins/hooks/skills are not inherited. Shell subprocesses use `shell_environment_policy.inherit = "core"` so `XAI_API_KEY` is not forwarded into Grok's shell tool.
- Search finds `grok.exe` on Windows, keeps `SystemRoot`/`COMSPEC`/`PATHEXT`/`TEMP`, sets isolated `USERPROFILE`, and applies the same shell-env policy.
- `npm test` skips the local Grok binary probe when Grok is not installed, so CI does not depend on a Grok CLI.
- MCP server key is `grok_subagent` (underscore). `output_token_limit` is kept; it is still a current Codex field despite one review retracting it.

### Changed

- Spawn/status payloads include `os_sandbox`: `unavailable` on Windows, `requested` on Linux/macOS. Native Windows is not advertised as kernel-enforced readonly.

## 0.6.4 - 2026-09-03

### Changed

- Isolated search defaults to `grok-4.6` (`GROK_SEARCH_MODEL` / `GROK_MODEL` override). Search `--max-turns` default is 12.
- Read-only ACP agents also pass `--disallowed-tools write,write_file,edit_file,search_replace` because Grok's OS sandbox may not enforce on Windows.
- Result reads no longer load the whole file into RAM; artifact size is capped at 8 MiB.
- `include_full` was removed. Installer no longer writes a global `model_auto_compact_token_limit`.
- Search auth write-back only happens when the isolated `auth.json` actually changed, is valid JSON, and is under 64 KiB.
- MCP tool descriptions were shortened to cut schema tax without collapsing 14 tools into one.

## 0.6.3 - 2026-09-03

### Fixed

- `grok_result.preview` is the **current turn**, not the first 1200 characters of the session artifact. Follow-ups no longer show a stale first answer.
- Windows interactive handoff now forwards `effort` into `--reasoning-effort`.
- `grok_result_search` uses literal substring matching and caps each snippet / total returned chars so a 50k line cannot blow the payload.
- Search `run_id` is validated against the same `YYYYMMDDThhmmssZ-<32 hex>` shape as the Python bridge, blocking path traversal.
- Async search stdout/stderr are bounded (1MB / 64KB). Python `show` no longer dumps the full result over stdout.
- Telemetry splits `grok_response_chars`, `current_turn_chars`, `artifact_chars`, and `preview_chars`.

## 0.6.2 - 2026-09-03

### Changed

- Plugin `.mcp.json` sets per-tool `output_token_limit` for Codex Desktop ≥ 0.152 (this machine is 0.153.0-alpha.5). Official capability: [openai/codex#41421](https://github.com/openai/codex/pull/41421). Limits sit above the bridge envelope so previews still fit, and clip a runaway tool payload before it enters the model history.

## 0.6.1 - 2026-09-03

### Changed

- `grok_search` / `grok_search_show` no longer inline the full Grok answer; they return `result_path` + a short preview.
- Added `grok_result_read` and `grok_result_search` so Codex can pull slices instead of shelling `cat`/`sed`.
- ACP public text is appended to the result file as chunks arrive. RAM keeps only a 16KB tail, so answers over 120K no longer lose their beginning.
- Search uses async `spawn` so a long search does not block other MCP calls on the same Node process.
- MCP tool payloads are compact JSON (no pretty-print). `grok_result` no longer repeats preview/full text in three fields.
- Result directories/files request mode `0700`/`0600` (best-effort on Windows).

## 0.6.0 - 2026-09-03

### Changed

- Codex chooses Grok `--reasoning-effort` on spawn (`none`…`max`, default `medium`). Follow-ups reuse the session; effort is locked until close.
- Skill forbids spawning a new Grok for every orchestration step. One workstream = one agent; `grok_send` for follow-ups.
- `grok_status` / `grok_result` `wait_seconds` max is 1800. Skill uses one long `grok_result` wait instead of 20–30s heartbeats ([openai/codex#37299](https://github.com/openai/codex/issues/37299), [#41875](https://github.com/openai/codex/issues/41875)).
- `grok_result` writes `~/.grok/codex-grok-bridge/results/<id>.md` and returns `result_path` plus a short preview. Full inline text only when short or `include_full=true`.
- Status payloads keep a 280-character preview and at most 8 recent tools.

## 0.5.0 - 2026-09-02

### Changed (local Windows fork)

- Default model is `grok-4.6` (override with `GROK_MODEL`).
- Locate `grok.exe` at `%USERPROFILE%\\.grok\\bin\\grok.exe` as well as `PATH`.
- Pass Windows env (`USERPROFILE`, `APPDATA`, `SystemRoot`, proxies) into Grok/Python child processes and synthesize `HOME` when missing.
- Prefer `python` on Windows for the isolated search bridge.
- Interactive handoff opens Windows Terminal / PowerShell on Windows; macOS Terminal path is unchanged.
- Kill ACP child process trees with `taskkill /T` on Windows.
- Hide spawned Grok consoles (`windowsHide`) and add `--no-subagents` to ACP workers.
- Skill now states the intended split: Codex orchestrates / designs / reviews; Grok executes.

## 0.4.0 - 2026-08-03

### Added

- Added isolated `grok_search`, `grok_search_list`, and `grok_search_show` tools for Grok-native X, Reddit, and public-web research outside the current repository.
- Bundled a repository-free Grok search bridge adapted from the MIT-licensed `sudoHG/codex-grok-search` project.
- Extended the orchestration skill so current X/Twitter and Reddit research prefers `grok_search` before ordinary web search or project-scoped Grok agents.

### Security

- Search runs use a private cache under `~/.cache/grok-subagent/search-runs`, temporary HOME/GROK_HOME isolation, and only `x_search`, `web_search`, and `web_fetch`.
- Search mode still sends queries and retrieved public content to xAI; it reduces local repository exposure rather than claiming zero upload.

## 0.3.0 - 2026-07-18

### Added

- Added a macOS-only `grok_handoff_interactive` tool that opens the official Grok TUI in a new Terminal window with a Codex-authored task prompt.
- Added read-only and isolated-worktree access modes for user-supervised interactive handoffs.

### Security

- Interactive implementation handoffs cannot write directly to the primary checkout and do not authorize commits, pushes, publication, or changes outside the Grok-created worktree.
- Initial handoff prompts use mode-0600 temporary files and are removed by the launched Terminal command before Grok starts.

## 0.2.0 - 2026-07-18

### Added

- Added monotonic progress revisions, elapsed time, timestamped tool events, and a bounded public-response preview to Grok agent status.
- Added optional long-polling to `grok_status` through `after_revision` and `wait_seconds`.
- Made the orchestration skill relay material Grok progress and provide a user-visible heartbeat at least once per minute.

### Security

- Kept visible progress limited to public answer chunks, plan entries, tool metadata, and lifecycle state; private chain-of-thought remains discarded.

## 0.1.1 - 2026-07-17

### Fixed

- Canonicalized project and worktree paths so symlinked roots, including macOS `/tmp`, are handled correctly.
- Made cancellation settle back to an idle session and terminated failed or timed-out Grok processes.
- Corrected MCP tool annotations and protocol-version negotiation.
- Required explicit write-scope confirmation for writing-agent follow-ups.
- Limited Grok child processes to a documented environment-variable allowlist.
- Added deterministic tests for worktree guards, lifecycle behavior, environment filtering, redaction, and protocol metadata.

### Changed

- Raised the minimum supported Node.js version to 22 and added Node.js 22/24 CI coverage.

## 0.1.0 - 2026-07-17

### Added

- Codex plugin and `$grok-subagent` orchestration skill.
- Dependency-free MCP-to-ACP bridge for the official Grok Build CLI.
- Read-only investigation mode.
- Linked-Git-worktree writing mode with explicit authorization guard.
- Agent status, result, follow-up, cancellation, close, and list tools.
- Bounded event retention and credential-shaped text sanitization.
- MCP smoke tests, authenticated end-to-end test, repository validation, and CI.

### Final hardening
- Force Grok folder-trust gating for managed ACP sessions.
- Native Windows safe-worker now fails closed on repo-local `.grok/config.toml` permission policy, preventing project allow rules from widening the edit scope where no OS-level Grok sandbox exists.
