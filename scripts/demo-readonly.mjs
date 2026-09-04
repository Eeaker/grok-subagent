#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpTestClient } from "../plugins/grok-subagent/tests/mcp-client.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const server = resolve(root, "plugins/grok-subagent/mcp-server/server.mjs");
const client = new McpTestClient(server, { timeoutMs: 240_000 });
function print(title, value) { console.log(`\n=== ${title} ===\n${JSON.stringify(value, null, 2)}`); }
try {
  await client.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "codex-grok-bridge-demo", version: "0.7.0" } });
  const spawned = await client.call("grok_spawn_readonly", {
    cwd: root, role: "independent investigator", effort: "low",
    task: "只读检查这个仓库。用最多 8 条中文要点说明架构和 Codex/Grok 分工，每条引用具体文件名。不要修改文件。"
  });
  print("spawned", spawned);
  const result = await client.call("grok_wait", { agent_id: spawned.agent_id, wait_seconds: 180 });
  print("wait", result);
  if (result.artifact_id) {
    const slice = await client.call("grok_artifact_read", { artifact_id: result.artifact_id, offset_bytes: 0, max_chars: 1200 });
    print("artifact preview", slice);
  }
  await client.call("grok_close", { agent_id: spawned.agent_id });
} finally { client.close(); }
