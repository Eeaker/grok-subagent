#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rows = [];
let packageFailure = false;
function add(id, status, detail) { rows.push({ id, status, detail }); if (status === "FAIL") packageFailure = true; }
function commandVersion(names, args = ["--version"]) {
  for (const name of names) {
    const r = spawnSync(name, args, { encoding: "utf8", timeout: 5000, windowsHide: true });
    if (!r.error && r.status === 0) return { name, text: String(r.stdout || r.stderr).trim().split(/\r?\n/)[0] };
  }
  return null;
}

const major = Number(process.versions.node.split(".")[0]);
add("node", major >= 22 ? "OK" : "FAIL", process.version);
const py = commandVersion(process.platform === "win32" ? ["python", "py"] : ["python3", "python"], ["--version"]);
add("python", py ? "OK" : "WARN", py?.text || "not found");
const grok = commandVersion(process.platform === "win32" ? [join(homedir(), ".grok", "bin", "grok.exe"), "grok.exe", "grok"] : [join(homedir(), ".grok", "bin", "grok"), "grok"], ["version"]);
add("grok", grok ? "OK" : "WARN", grok?.text || "not found; real ACP E2E unavailable");
const codex = commandVersion(["codex"], ["--version"]);
add("codex", codex ? "OK" : "WARN", codex?.text || "not found on PATH");

try {
  const cfg = JSON.parse(readFileSync(join(root, "plugins", "grok-subagent", ".mcp.json"), "utf8"));
  const server = cfg.mcpServers?.grok_subagent;
  add("mcp.timeout", server?.tool_timeout_sec === 1860 ? "OK" : "FAIL", `tool_timeout_sec=${server?.tool_timeout_sec}`);
  const enabled = server?.enabled_tools || [];
  add("mcp.tools", enabled.length === 11 ? "OK" : "FAIL", `${enabled.length} enabled tools`);
  const missingLimits = enabled.filter(name => !(server.tools?.[name]?.output_token_limit > 0));
  add("mcp.output_limits", missingLimits.length ? "FAIL" : "OK", missingLimits.length ? `missing: ${missingLimits.join(", ")}` : "all enabled tools have positive output_token_limit");
} catch (error) { add("mcp.config", "FAIL", error.message); }

const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
const configPath = join(codexHome, "config.toml");
if (existsSync(configPath)) {
  const text = readFileSync(configPath, "utf8");
  const pluginOk = text.includes('grok-subagent@eeaker-grok');
  const stalePlugin = text.includes('grok-subagent@walvez-grok');
  add("codex.plugin_id", pluginOk && !stalePlugin ? "OK" : "WARN", pluginOk && !stalePlugin ? "plugin id is grok-subagent@eeaker-grok" : "run install.ps1: Codex still has grok-subagent@walvez-grok or missing eeaker-grok; Skill can load while MCP tools stay hidden");
  const codeModeOn = /\[features\.code_mode\][\s\S]*?enabled\s*=\s*true/.test(text);
  const codeModeBare = text.includes("[features.code_mode]") && !/\[features\.code_mode\][\s\S]*?enabled\s*=/.test(text);
  add("codex.code_mode", !codeModeOn && !codeModeBare ? "OK" : "WARN", codeModeOn || codeModeBare ? "features.code_mode may hide long MCP tools from the model; install.ps1 sets enabled=false" : "code-mode not enabled");
  const direct = text.includes("mcp__grok_subagent") && text.includes("grok_subagent");
  add("codex.direct_only", direct ? "OK" : "WARN", direct ? "Grok namespace is listed for direct-only if code-mode is later enabled" : "run install script to merge direct_only_tool_namespaces");
} else add("codex.config", "WARN", `${configPath} not found`);

const authPath = join(process.env.GROK_HOME || join(homedir(), ".grok"), "auth.json");
add("grok.auth", existsSync(authPath) ? "OK" : "WARN", existsSync(authPath) ? authPath : "auth.json not found; run grok login");

if (process.platform === "win32") {
  add("sandbox", "WARN", "native Windows: filesystem sandbox none; child-process network not_enforced; full worker is logical only");
} else if (process.platform === "linux") {
  const bwrap = commandVersion(["bwrap"], ["--version"]);
  add("sandbox.linux", bwrap ? "OK" : "WARN", bwrap?.text || "bubblewrap not found; custom profiles with deny paths will fail closed");
} else if (process.platform === "darwin") {
  add("sandbox.macos", "OK", "Seatbelt custom sandbox supported; child-process network restriction is not equivalent to Linux seccomp");
} else add("sandbox", "WARN", `unsupported platform: ${process.platform}`);

for (const row of rows) console.log(`${row.status.padEnd(4)}  ${row.id.padEnd(20)} ${row.detail}`);
process.exitCode = packageFailure ? 1 : 0;
