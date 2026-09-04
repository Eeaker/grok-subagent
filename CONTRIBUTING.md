# Contributing

Contributions are welcome, especially around ACP compatibility, safer isolation, cross-platform behavior, tests, and documentation that matches the implementation.

## Development setup

1. Install Node.js 22 or newer and Python 3.
2. Clone the repository.
3. Run `npm test`.
4. For local Codex plugin testing, add the repository as a marketplace and install `grok-subagent@eeaker-grok`.
5. Start a new Codex task/thread after plugin or MCP changes; existing threads do not hot-reload them.

No npm dependency installation is required for the current repository layout.

For a normal development check:

```sh
npm test
npm run doctor
```

Run the real ACP E2E only when the official Grok CLI is installed and authenticated:

```sh
npm run test:e2e
```

The E2E consumes Grok usage. Use a disposable/non-sensitive directory or set `GROK_E2E_CWD` explicitly.

## Documentation vs runtime-sensitive files

Not every Markdown file in this repository is merely explanatory documentation.

**User-facing documentation** includes files such as:

- `README.md`
- `README.zh-CN.md`
- `README.en.md`
- `ARCHITECTURE.md`
- `SECURITY.md`
- `LOCALIZATION.md`
- `CONTRIBUTING.md`

These can be cleaned up or reorganized without changing runtime behavior, as long as the claims remain consistent with code and tests.

By contrast, files under areas such as `AGENTS.md`, `.agents/`, `plugins/grok-subagent/agents/`, and `plugins/grok-subagent/skills/` participate in agent/plugin behavior or handoff. **Do not edit those as part of a docs-only cleanup.** Change them only when the runtime behavior intentionally changes and the corresponding tests/review cover that change.

The same caution applies to plugin manifests, MCP configuration, installers, and generated policy/configuration code: they are implementation, not prose-only documentation.

## Pull-request expectations

- Keep changes focused and explain the user-visible behavior or trust-boundary impact.
- Add or update tests when protocol, lifecycle, permissions, sandboxing, artifact handling, or installer behavior changes.
- Keep the Chinese and English READMEs aligned on behavior. `README.md` and `README.zh-CN.md` are both Simplified Chinese entry points.
- Update `ARCHITECTURE.md` when an implementation invariant changes.
- Update `SECURITY.md` when a security guarantee, limitation, or platform capability changes.
- Put release-specific history in `CHANGELOG.md` instead of turning the README into a running release note.
- Preserve repository-free isolation for search-mode changes and keep required third-party attribution intact.
- Do not weaken the linked-worktree requirement without a documented replacement that provides at least equivalent protection.
- Run `npm test` before opening a pull request whenever the change can affect executable behavior.

## Sensitive data

Never commit authentication files, captured tokens, private prompts, or test repositories containing real secrets. Sanitized reproductions should remove both credentials and private repository content.

By contributing, you agree that your contribution is licensed under the MIT License.
