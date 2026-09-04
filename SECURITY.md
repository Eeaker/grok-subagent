# Security model — 0.7.0

Grok is an untrusted external coding agent. Repository text, web pages, and tool output can contain adversarial instructions. Codex remains the final verifier.

## Security layers

1. **Scope preconditions:** write agents require an explicit user-authorized flag and a linked Git worktree; primary checkout is rejected.
2. **Static tool policy:** readonly and safe-worker use an explicit Ask baseline, static allow/deny rules, and Bridge-side rejection of all non-pre-approved permission requests. Permission requests cannot dynamically widen them.
3. **OS sandbox:** Linux/macOS managed agents explicitly request Bridge-generated custom profiles. Custom-profile application failure is fail-closed.
4. **Isolated Grok home:** no user plugins/hooks/skills/compat rules are inherited.
5. **Secret environment filtering:** Grok shell subprocesses use xAI `shell_environment_policy.inherit="core"` with default secret excludes.
6. **One-way credentials:** host auth may be copied into an isolated runtime; isolated auth is never copied back.
7. **Bounded outputs:** public answers are capped and exposed only through opaque artifacts.
8. **Codex verification:** worker output/diff is not trusted merely because the agent completed successfully.

## Readonly

Readonly denies Edit, Write, and Bash. On Linux/macOS it additionally selects `bridge-readonly`, a custom profile extending Grok read-only sandbox with sensitive path denies. On Windows no OS sandbox is claimed; the security level is explicitly reported as `policy-enforced`.

## Safe worker

Safe worker is the default writing mode. It requires a linked worktree and statically allows Read/Grep plus `Edit(./**)`. Arbitrary shell permission cannot be granted dynamically. Git publication/history-changing operations are denied. Linux/macOS additionally use a custom strict filesystem sandbox.

## Full worker

Full worker on native Windows is allowed as logical isolation only (`security_level=logical`): policy + worktree, no kernel sandbox. On Linux/macOS it uses a custom strict sandbox and explicit denies for push/commit/merge/rebase/cherry-pick/tag. Network is disabled by default unless the caller opts in.

Filesystem and network guarantees are not identical across platforms. In particular, xAI documents Linux child-process network controls but macOS network blocking is not equivalent. Doctor reports this honestly.

## Hooks

xAI PreToolUse hooks are useful for audit and defense-in-depth, but xAI documents hook timeout/crash/malformed-output behavior as fail-open. For that reason this Bridge does **not** use hooks as its primary write boundary. Static permission rules and OS sandboxing are authoritative.

## Authentication

`auth.json` must be a regular bounded JSON file to be snapshotted. Symlinks, malformed files, and oversized files are ignored. A refreshed/modified credential inside an isolated runtime is discarded on close. Run the official `grok login` separately to refresh host credentials.

## Interactive handoff

Interactive handoff is user-supervised and outside the managed ACP lifecycle. Codex cannot attest to later terminal approvals/actions. Treat it as a conscious transfer of control and independently verify resulting diffs afterward.

## Search

Search runs outside the repository in a private cache, expose only X/web tools, use an isolated HOME/GROK_HOME, and never write isolated auth back to the host. Retrieved web content remains untrusted.

## Reporting

Please include Bridge version, OS, Grok Build version, Codex version, doctor output, and a minimal sanitized reproduction. Never attach auth files, API keys, or raw private prompts to public issues.

### Native Windows safe-worker project policy guard

On native Windows, `grok_spawn_worker` in `safe` mode fails closed when the linked worktree contains a repo-local `.grok/config.toml` permission section. Grok Build does not provide an OS-level Windows sandbox, and a repo-local allow rule could otherwise widen the path scope beyond the Bridge's `Edit(./**)` policy. The Bridge also forces `GROK_FOLDER_TRUST=1` and `[folder_trust] enabled = true` for managed sessions so shipped Grok builds gate trust-sensitive repo configuration. For repositories that intentionally carry Grok permission policy, use WSL2/Linux for the full worker or keep Grok readonly and let Codex apply the patch.
