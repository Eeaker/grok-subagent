# Platform notes

The implementation is Windows-first, but the managed ACP runtime supports Windows, Linux, and macOS with **different security guarantees**. This file keeps the platform-specific operational notes in one place; detailed trust boundaries live in [SECURITY.md](./SECURITY.md).

## Platform summary

| | Native Windows | Linux | macOS |
| --- | --- | --- | --- |
| installer | `install.ps1` | `install.sh` | `install.sh` |
| managed custom OS sandbox | no | yes | yes |
| full worker | allowed, `logical` only | OS-sandboxed | OS-sandboxed |
| child-process network block when disabled | not enforced | enforced/reported blocked | not enforced |
| interactive handoff | yes | no | yes |

## Windows

`install.ps1` checks Node, Python, and Grok, detects the Codex Desktop plugin binary when available, and otherwise falls back to the CLI skill + MCP configuration path.

The runtime includes Windows-specific handling for:

- `grok.exe` discovery under `%USERPROFILE%\.grok\bin` as well as `PATH`;
- required Windows child-process environment variables;
- process-tree termination with `taskkill` where needed;
- `%LOCALAPPDATA%\grok-subagent\search-runs` search cache;
- Windows Terminal / PowerShell interactive handoff;
- explicit reporting that xAI Grok provides no native-Windows OS sandbox in this setup.

Native-Windows readonly and safe worker are policy-enforced. Full worker is allowed but only as logical isolation. For hard full-worker containment, run the Codex / Bridge / Grok stack inside WSL2/Linux.

## Linux

`install.sh` installs the CLI fallback skill + MCP configuration. Managed agents explicitly select Bridge-generated custom sandbox profiles.

Run `npm run doctor` after installation. If it reports a missing `bubblewrap` prerequisite, install it before relying on the custom sandbox path.

Linux is the platform where the Bridge reports child-process network blocking as enforced when network is disabled.

## macOS

`install.sh` is also the supported setup path. Managed agents use custom OS sandbox profiles, and interactive handoff can open a user-supervised Terminal session.

Filesystem sandboxing and child-process network isolation are separate capabilities: the Bridge does not report hard child-process network blocking as enforced on macOS.

## Search cache locations

- Windows: `%LOCALAPPDATA%\grok-subagent\search-runs`
- Linux/macOS: `~/.cache/grok-subagent/search-runs`

Search runs remain separate from the current repository on every platform.
