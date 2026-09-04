# Codex token A/B benchmark

Use the same repository commit, task prompt, Codex model, and reasoning effort for both arms.

- **A / Codex-only:** disable the `grok_subagent` MCP server for the run and let Codex do the task itself.
- **B / Bridge:** enable the server and explicitly ask Codex to delegate the large scan/research/implementation workstream to Grok, then verify only targeted evidence.

Run each arm at least five times and compare medians. Keep correctness as a gate; a cheaper wrong run is not a win.

Capture `codex exec --json` output to JSONL, then:

```sh
node benchmark/summarize.mjs codex-only.jsonl bridge.jsonl
```

Primary metric: `uncached_input_tokens = input_tokens - cached_input_tokens`. Also inspect total input, cached input, output/reasoning tokens, number of turns, MCP calls, and wall-clock time.
