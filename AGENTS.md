# Repository agent instructions

This repository contains Codex ↔ Grok Bridge `0.7.1`.

When changing it:

- Preserve Codex as orchestrator/final verifier and Grok as bounded execution worker.
- Never expose full Grok transcripts or physical artifact paths in MCP output.
- Keep `grok_wait` runtime-managed and long-running; do not reintroduce model-visible polling.
- Every advertised MCP tool must have `outputSchema`, structured successful output, and a positive Codex `output_token_limit`.
- Native Windows must never claim OS sandbox enforcement. Full worker is allowed only as `security_level=logical`.
- Readonly/safe-worker capability must not be dynamically widened by ACP permission requests.
- Isolated auth is one-way: host → runtime only. Never restore runtime auth to host.
- Do not use xAI hooks as the primary security boundary; documented hook failure behavior is fail-open.
- Keep production MCP on 2025-11-25 until the newer Codex path is no longer feature-gated/experimental for this use case.
- Prefer official OpenAI/xAI/MCP sources for behavioral claims. Third-party repositories are not architecture/security authorities.
- Run `npm test`, `python -m py_compile plugins/grok-subagent/scripts/run_search.py`, and `npm run doctor` after changes. Real Grok E2E is `npm run test:e2e`.
