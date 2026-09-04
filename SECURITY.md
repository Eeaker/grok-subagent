# Security model

Grok is treated as an **untrusted external coding agent**. Repository content, web pages, tool output, and model-generated text can all contain adversarial instructions. Codex remains responsible for final verification, and the Bridge must not turn a model request into broader authority than the caller explicitly granted.

This document describes the implemented trust boundaries. It deliberately distinguishes policy enforcement from OS-level containment.

## Threat model

The Bridge is primarily designed to reduce these risks:

- a delegated agent writes to the user's primary checkout or unrelated files;
- a permission request silently widens a readonly/safe session;
- user Grok plugins/hooks/skills change the behavior of a managed agent;
- long Grok output floods the Codex context;
- isolated authentication state is written back to host credentials;
- secrets in public agent output are unnecessarily forwarded to Codex;
- repository content causes live web/tool use outside the intended mode;
- platform limitations are presented as stronger isolation than they really provide.

The Bridge does **not** protect against a compromised host OS or administrator, does not encrypt local artifacts, and does not provide identical filesystem/network isolation on Windows, Linux, and macOS.

## Security invariants

1. **Explicit write scope:** managed writers require `confirm_write_scope=true` after user authorization.
2. **Linked worktree only:** writing agents require the root of a linked Git worktree; a primary checkout is rejected.
3. **Static policy for readonly/safe:** permission requests cannot dynamically widen the allow/deny policy.
4. **Custom sandbox on Linux/macOS:** managed agents explicitly select a Bridge-generated profile extending Grok `strict`; explicit profile failure is intended to fail closed.
5. **No Windows sandbox claim:** native Windows reports no OS sandbox. Full worker is `logical`, not kernel-contained.
6. **Isolated runtime:** managed agents use private temporary HOME/GROK_HOME state and do not inherit user plugins/hooks/skills or compatibility agents.
7. **One-way credentials:** host auth may be copied into the runtime but is never copied back.
8. **Bounded public output:** artifacts, previews, metadata, and structured MCP payloads have explicit limits.
9. **Independent verification:** successful Grok completion does not make its output or diff trusted.

## Platform matrix

| Property | Native Windows | Linux | macOS |
| --- | --- | --- | --- |
| Bridge-managed OS sandbox | none | custom `strict` profile | custom `strict` profile |
| readonly write prevention | static tool policy | policy + OS sandbox | policy + OS sandbox |
| readonly read containment | **not OS-contained** | workspace + system scope | workspace + system scope |
| safe-worker write boundary | path-scoped Edit/Write policy in linked worktree | policy + OS sandbox | policy + OS sandbox |
| full-worker filesystem containment | **none; logical only** | custom sandbox | custom sandbox |
| child-process network with `allow_network=false` | **not enforced** | reported blocked/enforced | **not enforced** |

The machine-readable `security` contract returned by the Bridge separates filesystem, web-tool, and child-process-network properties so callers do not have to infer guarantees from a single label.

## Readonly mode

Readonly statically allows Read and Grep and denies Edit, Write, Bash, WebSearch, WebFetch, and MCPTool. Permission requests are rejected rather than used as an escalation path.

On Linux/macOS, the Bridge also selects `bridge-readonly`, a custom sandbox profile extending `strict` with additional sensitive-path denies.

On native Windows, readonly is **policy-enforced only**. It prevents writes through the advertised Grok tool policy, but it is not a filesystem privacy sandbox: OS-level read scope is not contained by the Bridge. Do not use native-Windows readonly as a way to expose a repository while hiding every other file readable by the same user account.

## Safe worker

Safe worker is the default writing mode. It requires a linked worktree and statically allows:

- Read
- Grep
- `Edit(./**)`
- `Write(./**)`

It denies Bash, WebSearch, WebFetch, and MCPTool. Permission requests cannot dynamically widen this policy.

This makes safe worker the preferred native-Windows write mode because arbitrary shell access is absent and write tools remain path-scoped. Native Windows still has no OS read sandbox, so safe worker should not be treated as a confidentiality boundary for unrelated readable files.

### Native Windows project-policy guard

If a linked worktree contains a repo-local `.grok/config.toml` permission section, native-Windows safe worker fails closed. Without an OS sandbox, a project-level Grok allow rule could otherwise widen the effective tool policy.

For repositories that intentionally carry Grok permission policy, use WSL2/Linux for stronger containment, remove the conflicting project permission section, or keep Grok readonly and let Codex apply the patch.

## Full worker

Full worker allows a broader execution surface, including Bash. Git push/commit/merge/rebase/cherry-pick/tag remain explicitly denied, and WebSearch/WebFetch are denied unless `allow_network=true`.

On Linux/macOS, a custom `strict` sandbox is also selected.

On native Windows, full worker is allowed but reports `security_level=logical`. This is an important limitation: **the linked worktree is the working directory and Git-isolation boundary, not a filesystem sandbox for Bash**. A shell command runs with the permissions of the host user and can potentially access or modify paths outside the worktree unless the operating environment provides separate containment.

If hard full-worker isolation is required on a Windows machine, run the entire Codex / Bridge / Grok stack inside WSL2/Linux or another independently sandboxed environment.

## Network model

Network has three separate dimensions:

1. **Grok agent HTTP network:** required for the Grok service itself.
2. **WebSearch/WebFetch tools:** controlled by Bridge policy. In full worker they are available only when `allow_network=true`; readonly/safe deny them.
3. **Child-process network:** relevant when Bash can run commands. With `allow_network=false`, the Bridge reports hard child-process network blocking only on Linux. macOS and native Windows report it as not enforced.

Therefore `allow_network=false` must not be read as "all process networking is impossible" on macOS or Windows full worker. It reliably removes the Grok web tools from policy, but host-level child-process network containment is platform-dependent.

## Runtime and plugin isolation

Each managed ACP agent gets a private temporary HOME/GROK_HOME. The generated Grok configuration disables:

- subagents;
- Cursor compatibility skills/rules/agents/MCPs/hooks/sessions;
- Claude compatibility skills/rules/agents/MCPs/hooks/sessions;
- Codex compatibility sessions.

The shell environment policy uses `inherit="core"` and keeps the default secret excludes. Managed sessions also force Grok folder-trust gating.

These controls are why user-level Grok customization should not silently become part of a managed Bridge session.

## Authentication

A host `auth.json` snapshot is accepted only when it is a regular, bounded, valid JSON file. Symlinks, malformed files, empty files, and oversized files are ignored.

The snapshot is copied into the isolated runtime for Grok authentication. Any refresh or mutation inside that runtime is discarded on close; the Bridge does not persist isolated auth back to the host. Refresh host credentials separately with the official Grok login flow.

## Secret handling and output bounds

Public Grok output is passed through common secret-pattern redaction before being persisted. The streaming path keeps a rolling hold-back buffer so a recognizable token split across chunks can still be scrubbed. Artifact reads and search snippets are checked again before being returned.

The Bridge also limits exposure by size:

- agent artifact: 8 MiB maximum;
- in-memory previews: bounded;
- search snippets/results: bounded;
- plan/tool metadata: bounded;
- structured MCP payload: 96 KiB maximum.

Secret redaction is **defense in depth, not a complete DLP system**. Unknown token formats, encoded data, arbitrary private text, or secrets transformed beyond the implemented patterns may not be detected. Do not intentionally place sensitive data in delegated prompts or repositories merely because redaction exists.

Artifacts are local files protected with private-file permissions on a best-effort basis. Opaque `artifact_id` values prevent physical paths from entering the MCP/model result; they do not encrypt the underlying files from the local user or administrator.

## Search isolation

`grok_search` runs outside the current repository in a private cache and isolated HOME/GROK_HOME. Its research surface is intentionally separated from the repository-scoped managed agent flow, and result paths are converted to opaque artifact IDs before reaching Codex.

Retrieved web/X/Reddit content remains untrusted and can contain prompt injection. Search output should be treated as evidence to verify, not instructions to obey.

## Interactive handoff

`grok_handoff_interactive` is user-supervised and outside the managed ACP lifecycle. The Bridge opens a separate Grok terminal/TUI session only after explicit confirmation.

Once the user takes over that terminal, Codex cannot attest to later approvals or actions. Treat interactive handoff as a deliberate transfer of control and inspect any resulting diff independently afterward.

Current interactive handoff support is Windows and macOS.

## Security reporting

When reporting a security issue, include:

- Bridge version;
- operating system;
- Grok Build version;
- Codex version;
- relevant `npm run doctor` output;
- a minimal sanitized reproduction.

Never attach host auth files, API keys, raw private prompts, or repositories containing real secrets to a public issue.
