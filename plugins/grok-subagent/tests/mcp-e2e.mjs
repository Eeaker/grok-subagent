import assert from "node:assert/strict";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpTestClient } from "./mcp-client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const client = new McpTestClient(resolve(here, "../mcp-server/server.mjs"), { timeoutMs: 300_000 });
const target = resolve(process.env.GROK_E2E_CWD || process.cwd());
const expectedCwd = basename(target);
let agentId;
try {
  await client.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "e2e", version: "0.7.0" } });
  let guardWorked = false;
  try { await client.call("grok_spawn_worker", { task: "Do nothing.", worktree: target, confirm_write_scope: true }); }
  catch (error) { guardWorked = /worktree|Git|checkout/i.test(error.message); }
  assert(guardWorked, "writing guard did not reject a non-linked-worktree target");

  const started = await client.call("grok_spawn_readonly", {
    cwd: target, role: "installation test reviewer", model: "grok-4.6", effort: "low", timeout_seconds: 240,
    task: `Read-only integration test. Inspect only the current directory. Reply with exactly two lines: GROK_SUBAGENT_OK and cwd=${expectedCwd}. Do not modify files or use subagents.`
  });
  agentId = started.agent_id;
  assert.match(started.artifact_id, /^agent:/);
  const result = await client.call("grok_wait", { agent_id: agentId, wait_seconds: 240 });
  assert.equal(result.status, "completed", result.error || `unexpected status: ${result.status}`);
  const slice = await client.call("grok_artifact_read", { artifact_id: result.artifact_id, offset_bytes: 0, max_chars: 4000 });
  assert.match(slice.text, /GROK_SUBAGENT_OK/);
  assert(slice.text.includes(`cwd=${expectedCwd}`));
  await client.call("grok_close", { agent_id: agentId }); agentId = null;
  console.log("Grok ACP end-to-end test passed.");
} finally {
  if (agentId) { try { await client.call("grok_close", { agent_id: agentId }); } catch {} }
  client.close();
}
