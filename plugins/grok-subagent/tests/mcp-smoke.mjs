import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpTestClient } from "./mcp-client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const client = new McpTestClient(resolve(here, "../mcp-server/server.mjs"));
try {
  const initialized = await client.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  assert.equal(initialized.serverInfo.name, "grok-subagent");
  assert.equal(initialized.serverInfo.version, "0.7.1");
  const listed = await client.request("tools/list");
  const names = listed.tools.map(t => t.name);
  assert.equal(names.length, 11);
  for (const name of ["grok_spawn_readonly","grok_spawn_worker","grok_wait","grok_artifact_read","grok_artifact_search","grok_send","grok_search","grok_handoff_interactive","grok_cancel","grok_close","grok_list"]) assert(names.includes(name));
  for (const tool of listed.tools) assert.equal(tool.outputSchema?.type, "object");
  assert(!names.includes("grok_result"));
  assert(!names.includes("grok_status"));
  console.log(`MCP smoke passed (${names.length} structured tools).`);
} finally { client.close(); }
