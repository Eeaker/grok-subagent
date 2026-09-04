# Localization / platform notes

Current version: `0.7.1`.

The implementation is Windows-first. Native Windows has no xAI OS sandbox: readonly/safe-worker are policy-enforced; full worker (`allow_shell` / `worker_mode=full`) is allowed as **logical** isolation and is never advertised as kernel containment. WSL2/Linux remains the hard-isolation path.

Windows-specific work in 0.7.0 includes `grok.exe` discovery, required system environment variables, process-tree termination through `taskkill`, `%LOCALAPPDATA%` search cache, PowerShell interactive handoff quoting, and explicit doctor reporting.

Architecture/security authority is limited to OpenAI Codex, xAI Grok Build, and MCP official repositories/specifications. Third-party source attribution is legal provenance only.
