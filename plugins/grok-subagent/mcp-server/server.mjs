#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, appendFileSync, chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const VERSION = "0.7.1";
const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_AUTH_BYTES = 64 * 1024;
const TOOL_TIMEOUT_SEC = 1860;
const WAIT_GRACE_SECONDS = 15;
const MAX_PLAN_ITEMS = 20;
const MAX_PLAN_ENTRY_CHARS = 500;
const MAX_TOOL_TITLE_CHARS = 300;
const MAX_STRUCTURED_BYTES = 96 * 1024;
const REDACT_HOLD = 96;
const READ_ONLY_DENY_RULES = ["Edit", "Write", "Bash", "WebSearch", "WebFetch", "MCPTool"];
const SAFE_WORKER_DENY_RULES = ["Bash", "WebSearch", "WebFetch", "MCPTool"];
const FULL_WORKER_DENY_RULES = [
  "Bash(git push *)", "Bash(git commit *)", "Bash(git merge *)", "Bash(git rebase *)",
  "Bash(git cherry-pick *)", "Bash(git tag *)"
];
const WORKER_DENY_RULES = FULL_WORKER_DENY_RULES;
const READ_ONLY_ALLOW_RULES = ["Read", "Grep"];
const SAFE_WORKER_ALLOW_RULES = ["Read", "Grep", "Edit(./**)", "Write(./**)"];
const FULL_WORKER_ALLOW_RULES = ["Read", "Grep", "Edit(./**)", "Bash"];
const SANDBOX_SECRET_DENY = ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/id_rsa", "**/id_ed25519"];
const DEFAULT_RETENTION_DAYS = 7;
const HOST_GROK_HOME = process.env.GROK_HOME || join(homedir(), ".grok");
const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url));
const SEARCH_SNIPPET_CHARS = 400;
const SEARCH_TOTAL_CHARS = 2400;
const SEARCH_STDOUT_MAX = 1_000_000;
const SEARCH_STDERR_MAX = 64_000;
const SEARCH_RUN_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{32}$/;
const MAX_AGENTS = 3;
const MAX_RETAINED_FAILED_AGENTS = 3;
const MAX_TEXT = 120_000;
const MAX_STDERR = 12_000;
const CANCEL_TIMEOUT_MS = 10_000;
const MAX_WAIT_SECONDS = 1800;
const STATUS_PREVIEW_CHARS = 280;
const RESULT_PREVIEW_CHARS = 1200;
const INLINE_RESPONSE_CHARS = 4000;
const PREVIEW_RAM_CHARS = 16_000;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const DEFAULT_MODEL = process.env.GROK_MODEL || "grok-4.6";
const DEFAULT_EFFORT = "medium";
const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const SUPPORTED_MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const CHILD_ENV_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP",
  "USERPROFILE", "USERNAME", "USERDOMAIN", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "SystemRoot", "WINDIR",
  "COMSPEC", "PATHEXT", "PROCESSOR_ARCHITECTURE",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR",
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY",
  "https_proxy", "http_proxy", "all_proxy", "no_proxy",
  "__CF_USER_TEXT_ENCODING", "XAI_API_KEY", "GROK_HOME", "GROK_BIN", "GROK_BINARY"
];
const agents = new Map();

const TOOL_DEFINITIONS = [
  {
    name: "grok_spawn_readonly",
    description: "Start a bounded read-only Grok ACP investigator. Returns immediately with agent_id and artifact_id.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string" }, cwd: { type: "string" }, role: { type: "string" }, model: { type: "string" },
        effort: { type: "string", enum: EFFORT_LEVELS }, timeout_seconds: { type: "integer", minimum: 30, maximum: 1800, default: 600 }
      },
      required: ["task", "cwd"], additionalProperties: false
    },
    outputSchema: objectOutputSchema(),
    annotations: { title: "Start read-only Grok", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "grok_spawn_worker",
    description: "Start a Grok writer in a linked Git worktree. Default worker_mode=safe (Edit CWD only, no Bash). full/allow_shell=true allows shell; native Windows has no OS sandbox and reports security_level=logical.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string" }, worktree: { type: "string" }, confirm_write_scope: { type: "boolean" },
        worker_mode: { type: "string", enum: ["safe", "full"], default: "safe" },
        allow_shell: { type: "boolean", description: "Alias of worker_mode=full. Native Windows still has no OS sandbox." },
        allow_network: { type: "boolean", default: false },
        role: { type: "string" }, model: { type: "string" }, effort: { type: "string", enum: EFFORT_LEVELS },
        timeout_seconds: { type: "integer", minimum: 30, maximum: 1800, default: 900 }
      },
      required: ["task", "worktree", "confirm_write_scope"], additionalProperties: false
    },
    outputSchema: objectOutputSchema(),
    annotations: { title: "Start Grok worktree worker", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "grok_wait",
    description: "Wait inside the bridge until the current turn settles. Omit wait_seconds to follow the agent's timeout plus a short grace. Prefer one long wait over polling.",
    inputSchema: { type: "object", properties: { agent_id: { type: "string" }, wait_seconds: { type: "integer", minimum: 0, maximum: 1800, description: "Optional. If omitted, wait until the agent timeout plus 15s, capped at 1800." } }, required: ["agent_id"], additionalProperties: false },
    outputSchema: objectOutputSchema(), annotations: readOnlyAnnotations("Wait for Grok")
  },
  {
    name: "grok_artifact_read",
    description: "Read a bounded UTF-8 slice from an opaque Grok artifact using byte offsets.",
    inputSchema: { type: "object", properties: { artifact_id: { type: "string" }, offset_bytes: { type: "integer", minimum: 0, default: 0 }, max_chars: { type: "integer", minimum: 1, maximum: 4000, default: 1200 } }, required: ["artifact_id"], additionalProperties: false },
    outputSchema: objectOutputSchema(), annotations: readOnlyAnnotations("Read Grok artifact")
  },
  {
    name: "grok_artifact_search",
    description: "Search an opaque Grok artifact with a bounded case-insensitive literal substring.",
    inputSchema: { type: "object", properties: { artifact_id: { type: "string" }, pattern: { type: "string" }, context_lines: { type: "integer", minimum: 0, maximum: 8, default: 2 }, max_matches: { type: "integer", minimum: 1, maximum: 20, default: 8 } }, required: ["artifact_id", "pattern"], additionalProperties: false },
    outputSchema: objectOutputSchema(), annotations: readOnlyAnnotations("Search Grok artifact")
  },
  {
    name: "grok_send",
    description: "Send a follow-up to an existing Grok session instead of spawning a duplicate agent.",
    inputSchema: { type: "object", properties: { agent_id: { type: "string" }, message: { type: "string" }, confirm_write_scope: { type: "boolean" }, timeout_seconds: { type: "integer", minimum: 30, maximum: 1800, default: 600 } }, required: ["agent_id", "message"], additionalProperties: false },
    outputSchema: objectOutputSchema(), annotations: { title: "Send Grok follow-up", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "grok_search",
    description: "Run repository-isolated Grok X/Reddit/web research and return only a preview plus opaque artifact_id.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, platform: { type: "string", enum: ["auto", "x", "reddit", "web"], default: "auto" }, depth: { type: "string", enum: ["quick", "deep"], default: "quick" }, since: { type: "string" }, until: { type: "string" }, keep_run: { type: "boolean" }, timeout_seconds: { type: "integer", minimum: 30, maximum: 1800, default: 600 } }, required: ["query"], additionalProperties: false },
    outputSchema: objectOutputSchema(), annotations: { title: "Research with Grok", readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  {
    name: "grok_handoff_interactive",
    description: "Open a user-supervised Grok TUI window. Codex does not poll the interactive session.",
    inputSchema: {
      type: "object", properties: {
        task: { type: "string" }, cwd: { type: "string" }, access_mode: { type: "string", enum: ["read_only", "isolated_worktree"] },
        confirm_interactive_handoff: { type: "boolean" }, role: { type: "string" }, model: { type: "string" }, effort: { type: "string", enum: EFFORT_LEVELS }
      }, required: ["task", "cwd", "access_mode", "confirm_interactive_handoff"], additionalProperties: false
    },
    outputSchema: objectOutputSchema(), annotations: { title: "Hand off to Grok TUI", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  },
  { name: "grok_cancel", description: "Cancel the current turn without destroying its retained artifact.", inputSchema: objectWithAgentId(), outputSchema: objectOutputSchema(), annotations: { title: "Cancel Grok", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } },
  { name: "grok_close", description: "Close an agent and destroy its isolated runtime. Retained artifact remains available until cleanup.", inputSchema: objectWithAgentId(), outputSchema: objectOutputSchema(), annotations: { title: "Close Grok", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } },
  { name: "grok_list", description: "List live agents and retained search artifacts without exposing physical artifact paths.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, outputSchema: objectOutputSchema(), annotations: readOnlyAnnotations("List Grok state") }
];

function objectWithAgentId() {
  return { type: "object", properties: { agent_id: { type: "string" } }, required: ["agent_id"], additionalProperties: false };
}

function objectOutputSchema() {
  return { type: "object", additionalProperties: true };
}

function readOnlyAnnotations(title) {
  return { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
}

function clamp(value, min, max, fallback) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
}

function resolveEffort(value) {
  if (value == null || String(value).trim() === "") return DEFAULT_EFFORT;
  const effort = String(value).trim().toLowerCase();
  if (!EFFORT_LEVELS.includes(effort)) {
    throw new Error(`effort must be one of: ${EFFORT_LEVELS.join(", ")}. Codex chooses this from task complexity.`);
  }
  return effort;
}

function retentionDays() {
  return clamp(process.env.GROK_SUBAGENT_RETENTION_DAYS, 0, 3650, DEFAULT_RETENTION_DAYS);
}

function resultStoreDir() {
  return process.env.GROK_SUBAGENT_RESULT_DIR || join(homedir(), ".grok", "codex-grok-bridge", "artifacts");
}

function runtimeStoreDir() {
  return join(homedir(), ".grok", "codex-grok-bridge", "runtime");
}

function mkdirPrivate(dir) {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try { chmodSync(dir, DIR_MODE); } catch {}
}

function writePrivate(file, body) {
  writeFileSync(file, body, { encoding: "utf8", mode: FILE_MODE });
  try { chmodSync(file, FILE_MODE); } catch {}
}

function appendPrivate(file, body) {
  appendFileSync(file, body, { encoding: "utf8" });
}

function utf8PrefixBuffer(text, maxBytes) {
  const buf = Buffer.from(String(text), "utf8");
  if (buf.length <= maxBytes) return buf;
  if (maxBytes <= 0) return Buffer.alloc(0);
  let end = maxBytes;
  while (end > 0 && end < buf.length && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end);
}

function appendPrivateCapped(file, body, maxBytes = MAX_RESULT_BYTES) {
  const current = existsSync(file) ? statSync(file).size : 0;
  if (current >= maxBytes) return { written_bytes: 0, truncated: true };
  const payload = Buffer.from(String(body), "utf8");
  const remaining = maxBytes - current;
  if (payload.length <= remaining) {
    appendFileSync(file, payload);
    return { written_bytes: payload.length, truncated: false };
  }
  const marker = Buffer.from("\n\n[truncated: artifact exceeded 8 MiB cap]\n", "utf8");
  let prefixBudget = remaining;
  let addMarker = false;
  if (remaining > marker.length) {
    prefixBudget = remaining - marker.length;
    addMarker = true;
  }
  const prefix = utf8PrefixBuffer(body, prefixBudget);
  if (prefix.length) appendFileSync(file, prefix);
  if (addMarker) appendFileSync(file, marker);
  return { written_bytes: prefix.length + (addMarker ? marker.length : 0), truncated: true };
}

function cleanupExpiredArtifacts(now = Date.now()) {
  const dir = resultStoreDir();
  if (!existsSync(dir)) return [];
  const cutoff = now - retentionDays() * 86400_000;
  const removed = [];
  for (const name of readdirSync(dir)) {
    if (!/^[0-9a-f-]{36}\.md$/i.test(name)) continue;
    const path = join(dir, name);
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.mtimeMs >= cutoff) continue;
      rmSync(path, { force: true });
      removed.push(name);
    } catch {}
  }
  return removed;
}

function cleanupStaleRuntimeDirs(now = Date.now()) {
  const dir = runtimeStoreDir();
  if (!existsSync(dir)) return [];
  const cutoff = now - 24 * 3600_000;
  const removed = [];
  for (const name of readdirSync(dir)) {
    if (!/^[0-9a-f-]{36}$/i.test(name)) continue;
    const path = join(dir, name);
    try {
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink() || info.mtimeMs >= cutoff) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(name);
    } catch {}
  }
  return removed;
}

function resultHeader(agent) {
  return [
    "# Grok subagent result", "", `- agent_id: ${agent.id}`, `- mode: ${agent.mode}`,
    `- worker_mode: ${agent.workerMode || "n/a"}`, `- role: ${agent.role}`, `- model: ${agent.model}`,
    `- effort: ${agent.effort}`, `- cwd: ${agent.cwd}`, `- started_at: ${agent.startedAt}`, "", "## Public answer", "", ""
  ].join("\n");
}

function artifactIdForAgent(agentOrId) {
  const id = typeof agentOrId === "string" ? agentOrId : agentOrId.id;
  return `agent:${id}`;
}

function artifactIdForSearch(runId) {
  return `search:${runId}`;
}

function openAgentResultFile(agent) {
  if (agent.resultPath) return agent.resultPath;
  mkdirPrivate(resultStoreDir());
  cleanupExpiredArtifacts();
  const file = join(resultStoreDir(), `${agent.id}.md`);
  writePrivate(file, resultHeader(agent));
  agent.resultPath = file;
  agent.responseChars = agent.responseChars || 0;
  return file;
}

function writePublicAnswer(agent, text) {
  if (!text || agent.resultTruncated) return;
  if (agent.resultPath) {
    const outcome = appendPrivateCapped(agent.resultPath, text);
    if (outcome.truncated) agent.resultTruncated = true;
  }
  agent.responseChars = (agent.responseChars || 0) + text.length;
  agent.turnChars = (agent.turnChars || 0) + text.length;
  agent.turnText = appendBounded(agent.turnText || "", text, PREVIEW_RAM_CHARS);
  agent.text = appendBounded(agent.text, text, PREVIEW_RAM_CHARS);
}

function appendAgentAnswer(agent, chunk) {
  writePublicAnswer(agent, ingestSecretChunk(agent, chunk));
}

function flushAgentSecrets(agent) {
  writePublicAnswer(agent, flushSecretBuffer(agent));
}

function persistAgentResult(agent) {
  flushAgentSecrets(agent);
  const existed = Boolean(agent.resultPath && existsSync(agent.resultPath));
  openAgentResultFile(agent);
  if (!existed && agent.text) {
    const outcome = appendPrivateCapped(agent.resultPath, agent.text);
    agent.resultTruncated ||= outcome.truncated;
    if (!agent.responseChars) agent.responseChars = agent.text.length;
  }
  return agent.resultPath;
}

function readTextSlice(filePath, offsetBytes = 0, maxChars = RESULT_PREVIEW_CHARS, artifactId = null) {
  if (!filePath || !existsSync(filePath)) throw new Error("artifact was not found.");
  const size = statSync(filePath).size;
  const start = Math.max(0, Number.parseInt(offsetBytes, 10) || 0);
  const limit = clamp(maxChars, 1, INLINE_RESPONSE_CHARS, RESULT_PREVIEW_CHARS);
  if (start >= size) {
    return { artifact_id: artifactId, offset_bytes: start, next_offset_bytes: start, text: "", returned_chars: 0, total_bytes: size, truncated: false };
  }
  const fd = openSync(filePath, "r");
  try {
    const byteLen = Math.min(size - start, limit * 4 + 4);
    const buf = Buffer.alloc(byteLen);
    const n = readSync(fd, buf, 0, byteLen, start);
    const decoded = buf.subarray(0, n).toString("utf8");
    let text = cleanText([...decoded].slice(0, limit).join(""));
    if (remainingSecretShape(text)) text = "[redacted: unsafe output]";
    const returnedBytes = Buffer.byteLength(text, "utf8");
    const next = start + returnedBytes;
    return {
      artifact_id: artifactId, offset_bytes: start, next_offset_bytes: next, text,
      returned_chars: [...text].length, total_bytes: size, truncated: next < size
    };
  } finally { closeSync(fd); }
}

function searchTextFile(filePath, pattern, args = {}, artifactId = null) {
  if (!filePath || !existsSync(filePath)) throw new Error("artifact was not found.");
  if (typeof pattern !== "string" || !pattern.trim()) throw new Error("pattern is required.");
  const needle = pattern.trim().toLowerCase();
  if (needle.length > 200) throw new Error("pattern is too long.");
  const size = statSync(filePath).size;
  const fd = openSync(filePath, "r");
  let raw;
  try {
    const n = Math.min(size, MAX_RESULT_BYTES);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, 0);
    raw = buf.toString("utf8");
  } finally { closeSync(fd); }
  const lines = raw.split(/\n/);
  const context = clamp(args.context_lines, 0, 8, 2);
  const maxMatches = clamp(args.max_matches, 1, 20, 8);
  const matches = [];
  let returnedChars = 0;
  let truncated = false;
  for (let index = 0; index < lines.length && matches.length < maxMatches; index += 1) {
    if (!lines[index].toLowerCase().includes(needle)) continue;
    let snippet = lines.slice(Math.max(0, index - context), Math.min(lines.length, index + context + 1)).join("\n");
    if (snippet.length > SEARCH_SNIPPET_CHARS) snippet = `${snippet.slice(0, SEARCH_SNIPPET_CHARS)}…`;
    if (returnedChars + snippet.length > SEARCH_TOTAL_CHARS) { truncated = true; break; }
    returnedChars += snippet.length;
    matches.push({ line: index + 1, text: remainingSecretShape(snippet) ? "[redacted: unsafe output]" : cleanText(snippet) });
  }
  return { artifact_id: artifactId, pattern: pattern.trim(), matches, match_count: matches.length, matches_truncated: truncated, returned_chars: returnedChars, scanned_lines: lines.length, total_bytes: size, file_truncated: size > MAX_RESULT_BYTES };
}

function buildAgentResultPayload(agent) {
  persistAgentResult(agent);
  const payload = agent.summary(false);
  delete payload.public_response_preview;
  const preview = String(agent.turnText || agent.text || "").slice(0, RESULT_PREVIEW_CHARS);
  const artifactBytes = agent.resultPath && existsSync(agent.resultPath) ? statSync(agent.resultPath).size : 0;
  payload.artifact_id = artifactIdForAgent(agent);
  payload.preview = preview;
  payload.result_chars = agent.responseChars || 0;
  payload.turn_chars = agent.turnChars || 0;
  payload.result_omitted = (agent.turnChars || preview.length) > RESULT_PREVIEW_CHARS;
  payload.telemetry = { grok_response_chars: agent.responseChars || 0, current_turn_chars: agent.turnChars || 0, artifact_bytes: artifactBytes, preview_chars: preview.length };
  payload.truncated = Boolean(agent.resultTruncated);
  payload.note = "Use grok_artifact_read/search with artifact_id. Reuse this agent_id for retries/follow-ups; do not poll or respawn unnecessarily.";
  return payload;
}

function attachArtifactEnvelope(payload, filePath, artifactId, extra = {}) {
  const envelope = { ...payload, artifact_id: artifactId, preview: "", result_bytes: 0, result_omitted: false, ...extra };
  delete envelope.result;
  delete envelope.result_path;
  delete envelope.run_path;
  if (envelope.manifest && typeof envelope.manifest === "object") {
    envelope.manifest = { ...envelope.manifest };
    delete envelope.manifest.result_path;
    delete envelope.manifest.cwd;
  }
  if (!filePath || !existsSync(filePath)) return envelope;
  const slice = readTextSlice(filePath, 0, RESULT_PREVIEW_CHARS, artifactId);
  envelope.result_bytes = slice.total_bytes;
  envelope.preview = slice.text;
  envelope.result_omitted = slice.truncated;
  envelope.telemetry = { artifact_bytes: slice.total_bytes, preview_chars: [...slice.text].length };
  return envelope;
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[REDACTED]")
    .replace(/(authorization|api[-_ ]?key|client[-_ ]?secret|access[-_ ]?token|refresh[-_ ]?token|password|cookie|token)(\s*["']?\s*[:=]\s*["']?)[^\s,"';}]+/gi, "$1$2[REDACTED]")
    .replace(/\b(?:sk|xai)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED TOKEN]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED GITHUB TOKEN]")
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED AWS ACCESS KEY]");
}

function appendBounded(current, addition, max = MAX_TEXT) {
  const combined = current + cleanText(addition);
  return combined.length <= max ? combined : combined.slice(combined.length - max);
}

function absoluteDirectory(input, label) {
  if (typeof input !== "string" || !input.trim()) throw new Error(`${label} is required.`);
  if (!isAbsolute(input)) throw new Error(`${label} must be an absolute path.`);
  const path = resolve(input);
  accessSync(path, constants.R_OK);
  if (!statSync(path).isDirectory()) throw new Error(`${label} must be a directory.`);
  return realpathSync(path);
}

function assertLinkedWorktree(input) {
  const path = absoluteDirectory(input, "worktree");
  const probe = spawnSync("git", ["-C", path, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 5_000, env: buildChildEnv() });
  if (probe.status !== 0) throw new Error("Writing agents require a valid Git linked worktree.");
  const gitRoot = realpathSync(resolve(probe.stdout.trim()));
  if (gitRoot !== path) throw new Error("worktree must be the root of the linked Git worktree.");
  let marker;
  try { marker = lstatSync(join(path, ".git")); } catch { throw new Error("Writing agents require a linked Git worktree with a .git file."); }
  if (!marker.isFile()) throw new Error("Primary checkouts are rejected. Create a linked Git worktree, whose .git entry is a file.");
  return path;
}

function assertWindowsSafeWorkerProjectPolicy(worktree, platform = process.platform) {
  if (platform !== "win32") return true;
  const configPath = join(worktree, ".grok", "config.toml");
  if (!existsSync(configPath)) return true;
  let text = "";
  try {
    const stat = statSync(configPath);
    if (!stat.isFile() || stat.size > 512 * 1024) {
      throw new Error("Native Windows safe worker refuses an unreadable or oversized project .grok/config.toml.");
    }
    text = readFileSync(configPath, "utf8");
  } catch (error) {
    if (error?.message?.startsWith("Native Windows safe worker")) throw error;
    throw new Error("Native Windows safe worker could not inspect project .grok/config.toml; refusing to run fail-closed.");
  }
  if (/^\s*\[permission(?:\.|\])/mi.test(text) || /^\s*permission\./mi.test(text)) {
    throw new Error("Native Windows safe worker refuses repo-local Grok permission policy because Windows has no OS-level Grok sandbox and project allow rules could widen edit scope. Use WSL2/Linux full worker, remove the repo-local permission section, or use readonly mode and let Codex apply the patch.");
  }
  return true;
}

function assertGitRepositoryRoot(input) {
  const path = absoluteDirectory(input, "cwd");
  const probe = spawnSync("git", ["-C", path, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 5_000, env: buildChildEnv() });
  if (probe.status !== 0) throw new Error("Interactive worktree handoff requires a Git repository root.");
  const gitRoot = realpathSync(resolve(probe.stdout.trim()));
  if (gitRoot !== path) throw new Error("cwd must be the root of the Git repository for interactive worktree handoff.");
  return path;
}

function buildChildEnv(source = process.env) {
  const env = {};
  for (const key of CHILD_ENV_KEYS) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  const extraKeys = String(source.GROK_PASSTHROUGH_ENV || "")
    .split(",")
    .map(key => key.trim())
    .filter(key => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
  for (const key of extraKeys) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  const home = source.HOME || source.USERPROFILE || homedir();
  if (!env.HOME && home) env.HOME = home;
  if (process.platform === "win32") {
    if (!env.USERPROFILE && home) env.USERPROFILE = source.USERPROFILE || home;
    if (!env.HOMEDRIVE && source.HOMEDRIVE) env.HOMEDRIVE = source.HOMEDRIVE;
    if (!env.HOMEPATH && source.HOMEPATH) env.HOMEPATH = source.HOMEPATH;
  }
  return env;
}

function negotiateProtocolVersion(requested) {
  return SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : SUPPORTED_MCP_PROTOCOL_VERSIONS[0];
}

function grokBinaryNames() {
  return process.platform === "win32" ? ["grok.exe", "grok"] : ["grok"];
}

function osSandboxStatus(platform = process.platform) {
  return platform === "win32" ? "unavailable" : "requested-fail-closed-custom-profile";
}

function normalizeWorkerMode(value, { allowShell = false, platform = process.platform } = {}) {
  let mode = String(value || (allowShell ? "full" : "safe")).trim().toLowerCase();
  if (allowShell === true) mode = "full";
  if (!["safe", "full"].includes(mode)) throw new Error("worker_mode must be safe or full.");
  return mode;
}

function securityLevel(mode, workerMode = "safe", platform = process.platform) {
  if (platform !== "win32") return "os-enforced-custom-profile";
  if (mode === "worker" && workerMode === "full") return "logical";
  return "policy-enforced";
}

function securityContract(mode, workerMode = "safe", allowNetwork = false, platform = process.platform) {
  const linux = platform === "linux";
  const win = platform === "win32";
  return {
    platform,
    filesystem_read_scope: win ? "unrestricted-os" : "workspace+system",
    source_workspace_write: mode === "readonly" ? "tool-policy-denied" : (workerMode === "safe" ? "cwd-edit-only" : "workspace-policy"),
    sandbox_enforcement: win ? "none" : "os",
    child_process_network: allowNetwork ? "allowed" : (linux ? "blocked" : "not_enforced"),
    child_process_network_enforcement: allowNetwork ? "n/a" : (linux ? "seccomp" : (win ? "none" : "unsupported_on_platform")),
    agent_http_network: "required",
    web_tools: mode === "readonly" || workerMode !== "full" || !allowNetwork ? "denied-by-policy" : "available"
  };
}

function resolveWaitSeconds(agent, requested) {
  if (Number.isInteger(requested)) return clamp(requested, 0, MAX_WAIT_SECONDS, 0);
  return Math.min((Number(agent?.timeoutSeconds) || 600) + WAIT_GRACE_SECONDS, MAX_WAIT_SECONDS);
}

function remainingSecretShape(text) {
  const value = String(text ?? "");
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)
    || /\b(?:sk|xai)-[A-Za-z0-9_-]{12,}\b/.test(value)
    || /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/.test(value)
    || /\bAKIA[A-Z0-9]{16}\b/.test(value);
}

function ingestSecretChunk(agent, chunk) {
  const raw = `${agent.secretHold || ""}${chunk ?? ""}`;
  const cleaned = cleanText(raw);
  if (cleaned.length <= REDACT_HOLD) {
    agent.secretHold = cleaned;
    return "";
  }
  agent.secretHold = cleaned.slice(-REDACT_HOLD);
  return cleaned.slice(0, cleaned.length - REDACT_HOLD);
}

function flushSecretBuffer(agent) {
  const leftover = agent.secretHold || "";
  agent.secretHold = "";
  return leftover;
}

function denyRulesFor(mode, workerMode = "safe", allowNetwork = false) {
  if (mode === "readonly") return READ_ONLY_DENY_RULES;
  if (workerMode !== "full") return SAFE_WORKER_DENY_RULES;
  return allowNetwork ? FULL_WORKER_DENY_RULES : [...FULL_WORKER_DENY_RULES, "WebSearch", "WebFetch"];
}

function allowRulesFor(mode, workerMode = "safe") {
  if (mode === "readonly") return READ_ONLY_ALLOW_RULES;
  return workerMode === "full" ? FULL_WORKER_ALLOW_RULES : SAFE_WORKER_ALLOW_RULES;
}

function agentProfilePath(mode) {
  return join(PLUGIN_ROOT, "..", "agents", mode === "readonly" ? "readonly.md" : "worker.md");
}

function isolatedConfigToml(mode, workerMode = "safe", allowNetwork = false) {
  const deny = denyRulesFor(mode, workerMode, allowNetwork).map(rule => `  ${JSON.stringify(rule)},`).join("\n");
  const allow = allowRulesFor(mode, workerMode).map(rule => `  ${JSON.stringify(rule)},`).join("\n");
  return `[ui]\npermission_mode = "ask"\n\n[subagents]\nenabled = false\n\n[compat.cursor]\nskills = false\nrules = false\nagents = false\nmcps = false\nhooks = false\nsessions = false\n\n[compat.claude]\nskills = false\nrules = false\nagents = false\nmcps = false\nhooks = false\nsessions = false\n\n[compat.codex]\nsessions = false\n\n[folder_trust]\nenabled = true\n\n[shell_environment_policy]\ninherit = "core"\nignore_default_excludes = false\n\n[permission]\nallow = [\n${allow}\n]\ndeny = [\n${deny}\n]\n`;
}

function sandboxProfileName(mode, workerMode = "safe") {
  if (mode === "readonly") return "bridge-readonly";
  return workerMode === "full" ? "bridge-full-worker" : "bridge-safe-worker";
}

function sandboxToml(mode, workerMode = "safe", allowNetwork = false) {
  const name = sandboxProfileName(mode, workerMode);
  const base = "strict";
  const deny = SANDBOX_SECRET_DENY.map(item => `  ${JSON.stringify(item)},`).join("\n");
  return `[profiles.${name}]\nextends = "${base}"\nrestrict_network = ${allowNetwork ? "false" : "true"}\ndeny = [\n${deny}\n]\n`;
}

function ensurePrivateDir(path) {
  mkdirSync(path, { recursive: true });
  try { chmodSync(path, DIR_MODE); } catch {}
}

function writePrivateFile(path, content, encoding = "utf8") {
  writeFileSync(path, content, { encoding, mode: FILE_MODE });
  try { chmodSync(path, FILE_MODE); } catch {}
}

function copyHostAuth(destination) {
  const source = join(HOST_GROK_HOME, "auth.json");
  if (!existsSync(source)) return false;
  try {
    if (lstatSync(source).isSymbolicLink()) return false;
    const bytes = readFileSync(source);
    if (bytes.length === 0 || bytes.length > MAX_AUTH_BYTES) return false;
    JSON.parse(bytes.toString("utf8"));
    writeFileSync(destination, bytes, { mode: FILE_MODE });
    try { chmodSync(destination, FILE_MODE); } catch {}
    return true;
  } catch { return false; }
}

function createIsolatedRuntime(mode, agentId, workerMode = "safe", allowNetwork = false) {
  cleanupStaleRuntimeDirs();
  const root = join(runtimeStoreDir(), agentId);
  const home = join(root, "home");
  const grokHome = join(home, ".grok");
  const tmp = join(home, "tmp");
  for (const dir of [root, home, grokHome, tmp, join(home, ".config"), join(home, ".cache")]) ensurePrivateDir(dir);
  const isolatedAuth = join(grokHome, "auth.json");
  const authCopied = copyHostAuth(isolatedAuth);
  writePrivateFile(join(grokHome, "config.toml"), isolatedConfigToml(mode, workerMode, allowNetwork));
  if (process.platform !== "win32") writePrivateFile(join(grokHome, "sandbox.toml"), sandboxToml(mode, workerMode, allowNetwork));
  return { root, home, grokHome, tmp, isolatedAuth, authCopied, sandboxProfile: process.platform === "win32" ? null : sandboxProfileName(mode, workerMode) };
}

function removeIsolatedRuntime(runtime) {
  if (runtime?.root) {
    try { rmSync(runtime.root, { recursive: true, force: true }); } catch {}
  }
}

function buildAcpLaunchArgs({ mode, workerMode = "safe", allowNetwork = false, model, effort, profilePath, platform = process.platform }) {
  const args = ["--no-auto-update"];
  if (platform !== "win32") args.push("--sandbox", sandboxProfileName(mode, workerMode));
  args.push("--no-subagents");
  for (const rule of allowRulesFor(mode, workerMode)) args.push("--allow", rule);
  for (const rule of denyRulesFor(mode, workerMode, allowNetwork)) args.push("--deny", rule);
  args.push("agent", "--model", model, "--reasoning-effort", effort);
  if (mode === "worker" && workerMode === "full") args.push("--always-approve");
  args.push("--agent-profile", profilePath, "--no-leader", "stdio");
  return args;
}

function buildAcpChildEnv(runtime, source = process.env) {
  const env = buildChildEnv(source);
  env.HOME = runtime.home;
  env.GROK_HOME = runtime.grokHome;
  env.GROK_SUBAGENTS = "0";
  // Force xAI folder-trust gating on shipped/release Grok builds. This overrides any
  // passthrough environment value so a parent shell cannot silently disable it.
  env.GROK_FOLDER_TRUST = "1";
  env.TMPDIR = runtime.tmp; env.TMP = runtime.tmp; env.TEMP = runtime.tmp;
  env.XDG_CONFIG_HOME = join(runtime.home, ".config"); env.XDG_CACHE_HOME = join(runtime.home, ".cache");
  if (process.platform === "win32") {
    env.USERPROFILE = runtime.home;
    env.APPDATA = join(runtime.home, "AppData", "Roaming");
    env.LOCALAPPDATA = join(runtime.home, "AppData", "Local");
    delete env.HOMEPATH;
  }
  return env;
}

function selectPermissionOption(mode, message, workerMode = "safe") {
  const options = message?.params?.options || [];
  const reject = options.find(option => ["reject", "reject_once", "denied"].includes(option.kind));
  const allowed = options.find(option => ["allow_once", "allow", "allow_always", "approved"].includes(option.kind));
  if (mode === "readonly" || (mode === "worker" && workerMode === "safe")) return reject || null;
  return allowed || reject || null;
}

function findGrok() {
  const home = homedir();
  const names = grokBinaryNames();
  const candidates = [
    process.env.GROK_BIN,
    process.env.GROK_BINARY,
    ...names.map(name => join(home, ".grok", "bin", name)),
    ...names
  ].filter(Boolean);
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (isAbsolute(candidate) && !existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      env: buildChildEnv(),
      windowsHide: true
    });
    if (probe.status === 0) return candidate;
  }
  throw new Error("Grok CLI was not found. Install Grok Build and authenticate with `grok login`. On Windows the expected path is %USERPROFILE%\\.grok\\bin\\grok.exe.");
}

function findPython() {
  const candidates = [process.env.PYTHON, process.platform === "win32" ? "python" : "python3", "python3", "python"].filter(Boolean);
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const probe = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      env: buildChildEnv(),
      windowsHide: true
    });
    if (probe.status === 0) return candidate;
  }
  return process.platform === "win32" ? "python" : "python3";
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function appleScriptString(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function powershellSingleQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function interactiveWorktreeName() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `grok-handoff-${stamp}-${randomUUID().slice(0, 6)}`;
}

function buildInteractiveCommand({ binary, cwd, promptFile, promptDir, accessMode, model, effort, worktreeName }) {
  const args = [shellQuote(binary), "--no-subagents"];
  if (effort) args.push("--reasoning-effort", shellQuote(effort));
  if (model) args.push("--model", shellQuote(model));
  if (accessMode === "read_only") {
    args.push("--sandbox", "read-only", "--permission-mode", "default");
    for (const rule of READ_ONLY_DENY_RULES) args.push("--deny", shellQuote(rule));
  } else {
    args.push(`--worktree=${shellQuote(worktreeName)}`, "--sandbox", "workspace", "--permission-mode", "acceptEdits");
    for (const rule of WORKER_DENY_RULES) args.push("--deny", shellQuote(rule));
  }
  args.push('--', '"$grok_handoff_prompt"');
  return [
    `cd ${shellQuote(cwd)}`,
    `grok_handoff_prompt="$(cat -- ${shellQuote(promptFile)})"`,
    `{ rm -f -- ${shellQuote(promptFile)}; rmdir -- ${shellQuote(promptDir)} 2>/dev/null || true; exec ${args.join(" ")}; }`
  ].join(" && ");
}

function buildWindowsInteractiveCommand({ binary, cwd, promptFile, promptDir, accessMode, model, effort, worktreeName }) {
  const grokArgs = ["--no-subagents"];
  if (effort) grokArgs.push("--reasoning-effort", effort);
  if (model) grokArgs.push("--model", model);
  if (accessMode === "read_only") {
    grokArgs.push("--sandbox", "read-only", "--permission-mode", "default");
    for (const rule of READ_ONLY_DENY_RULES) grokArgs.push("--deny", rule);
  } else {
    grokArgs.push(`--worktree=${worktreeName}`, "--sandbox", "workspace", "--permission-mode", "acceptEdits");
    for (const rule of WORKER_DENY_RULES) grokArgs.push("--deny", rule);
  }
  return [
    `Set-Location -LiteralPath ${powershellSingleQuote(cwd)}`,
    `$grok_handoff_prompt = Get-Content -LiteralPath ${powershellSingleQuote(promptFile)} -Raw -Encoding utf8`,
    `Remove-Item -LiteralPath ${powershellSingleQuote(promptFile)} -Force`,
    `Remove-Item -LiteralPath ${powershellSingleQuote(promptDir)} -Force -ErrorAction SilentlyContinue`,
    `& ${powershellSingleQuote(binary)} ${grokArgs.map(powershellSingleQuote).join(" ")} -- $grok_handoff_prompt`
  ].join("; ");
}

function launchWindowsInteractiveHandoff({ binary, cwd, promptFile, promptDir, accessMode, model, effort, worktreeName }) {
  const command = buildWindowsInteractiveCommand({ binary, cwd, promptFile, promptDir, accessMode, model, effort, worktreeName });
  const wt = spawnSync("wt.exe", ["-w", "0", "nt", "-d", cwd, "powershell.exe", "-NoExit", "-NoProfile", "-Command", command], {
    encoding: "utf8",
    timeout: 10_000,
    env: buildChildEnv(),
    windowsHide: true
  });
  if (wt.status === 0) return;
  const started = spawnSync("cmd.exe", ["/c", "start", "Grok Handoff", "powershell.exe", "-NoExit", "-NoProfile", "-Command", command], {
    encoding: "utf8",
    timeout: 10_000,
    env: buildChildEnv(),
    windowsHide: true
  });
  if (started.status !== 0) {
    throw new Error(`Could not open the interactive Grok window: ${cleanText(wt.stderr || started.stderr || started.stdout || "unknown error")}`);
  }
}

function launchInteractiveHandoff(args) {
  if (!["darwin", "win32"].includes(process.platform)) {
    throw new Error("Interactive Terminal handoff is currently supported on Windows and macOS.");
  }
  if (args.confirm_interactive_handoff !== true) {
    throw new Error("confirm_interactive_handoff must be true after the user explicitly requests a separate interactive Grok window.");
  }
  if (typeof args.task !== "string" || !args.task.trim()) throw new Error("task is required.");
  if (args.task.length > MAX_TEXT) throw new Error(`task must be at most ${MAX_TEXT} characters.`);
  if (!["read_only", "isolated_worktree"].includes(args.access_mode)) throw new Error("access_mode must be read_only or isolated_worktree.");
  const cwd = args.access_mode === "isolated_worktree" ? assertGitRepositoryRoot(args.cwd) : absoluteDirectory(args.cwd, "cwd");
  const binary = findGrok();
  const effort = resolveEffort(args.effort);
  const worktreeName = args.access_mode === "isolated_worktree" ? interactiveWorktreeName() : null;
  const rules = [
    `Codex has handed this task to you as an interactive ${cleanText(args.role || "Grok Build specialist")}.`,
    "Work directly with the user in this Terminal window. Ask the user when a material decision or additional authority is required.",
    "Do not spawn subagents.",
    args.access_mode === "read_only"
      ? "This is a read-only session. Do not modify project files."
      : "Work only in the isolated worktree created for this session. Do not commit, push, merge, publish, or alter other worktrees unless the user explicitly authorizes that action in this window.",
    "When finished, summarize the changes, tests, remaining risks, and the worktree path so the user can return to Codex for independent verification.",
    "",
    "Task from Codex:",
    cleanText(args.task)
  ].join("\n");
  const promptDir = mkdtempSync(join(tmpdir(), "grok-handoff-"));
  const promptFile = join(promptDir, "prompt.txt");
  writeFileSync(promptFile, rules, { encoding: "utf8", mode: 0o600 });
  try {
    if (process.platform === "win32") {
      launchWindowsInteractiveHandoff({ binary, cwd, promptFile, promptDir, accessMode: args.access_mode, model: args.model, effort, worktreeName });
    } else {
      const command = buildInteractiveCommand({ binary, cwd, promptFile, promptDir, accessMode: args.access_mode, model: args.model, effort, worktreeName });
      const script = `tell application "Terminal"\nactivate\ndo script "${appleScriptString(command)}"\nend tell`;
      const launched = spawnSync("osascript", ["-e", script], { encoding: "utf8", timeout: 10_000, env: buildChildEnv() });
      if (launched.status !== 0) {
        throw new Error(`Could not open the interactive Grok Terminal window: ${cleanText(launched.stderr || launched.stdout || "unknown error")}`);
      }
    }
  } catch (error) {
    rmSync(promptDir, { recursive: true, force: true });
    throw error;
  }
  const cleanupTimer = setTimeout(() => rmSync(promptDir, { recursive: true, force: true }), 60_000);
  cleanupTimer.unref();
  return {
    launched: true,
    supervision: "user",
    access_mode: args.access_mode,
    cwd,
    worktree_name: worktreeName,
    effort,
    note: "This Terminal session is independent. Return to Codex when you want its result or diff verified."
  };
}

class GrokAgent {
  constructor({ cwd, mode, workerMode = "safe", allowNetwork = false, role, model, effort, timeoutSeconds }) {
    this.id = randomUUID();
    this.cwd = cwd;
    this.mode = mode;
    this.workerMode = mode === "worker" ? workerMode : null;
    this.allowNetwork = Boolean(allowNetwork);
    this.role = cleanText(role || (mode === "readonly" ? "independent investigator" : "isolated implementation worker"));
    this.model = model || DEFAULT_MODEL;
    this.effort = resolveEffort(effort);
    this.timeoutSeconds = timeoutSeconds;
    this.status = "starting";
    this.sessionId = null;
    this.text = "";
    this.stderr = "";
    this.plan = null;
    this.toolEvents = [];
    this.error = null;
    this.resultPath = null;
    this.responseChars = 0;
    this.turnText = "";
    this.turnChars = 0;
    this.resultTruncated = false;
    this.startedAt = new Date().toISOString();
    this.updatedAt = this.startedAt;
    this.revision = 0;
    this.requestId = 0;
    this.pending = new Map();
    this.turnPromise = null;
    this.cancelTimer = null;
    this.closed = false;
    this.runtime = null;
    this.waiters = new Set();
    this.secretHold = "";
  }

  async start() {
    const binary = findGrok();
    this.runtime = createIsolatedRuntime(this.mode, this.id, this.workerMode || "safe", this.allowNetwork);
    const args = buildAcpLaunchArgs({
      mode: this.mode,
      workerMode: this.workerMode || "safe",
      allowNetwork: this.allowNetwork,
      model: this.model,
      effort: this.effort,
      profilePath: agentProfilePath(this.mode)
    });
    this.proc = spawn(binary, args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], env: buildAcpChildEnv(this.runtime), windowsHide: true });
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", chunk => { this.stderr = appendBounded(this.stderr, chunk, MAX_STDERR); });
    this.proc.on("exit", (code, signal) => this.onExit(code, signal));
    this.proc.on("error", error => this.fail(error));
    const lines = createInterface({ input: this.proc.stdout });
    lines.on("line", line => this.onLine(line));

    const initialized = await this.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, 30_000);
    const methods = initialized?.authMethods || [];
    if (methods.some(method => method.id === "cached_token")) {
      await this.request("authenticate", { methodId: "cached_token" }, 30_000);
    }
    const rules = [
      `You are acting as a ${this.role} under Codex orchestration.`,
      "Do not spawn or delegate to other agents.",
      "Do not expose private chain-of-thought; provide concise conclusions and verifiable evidence.",
      this.mode === "readonly"
        ? "This session is read-only. Do not attempt to modify project files."
        : "Modify only the requested files inside this isolated linked worktree. Do not commit, push, merge, or alter other worktrees."
    ].join("\n");
    const session = await this.request("session/new", { cwd: this.cwd, mcpServers: [], _meta: { rules } }, 30_000);
    if (!session?.sessionId) throw new Error("Grok ACP did not return a sessionId.");
    this.sessionId = session.sessionId;
    this.status = "idle";
    openAgentResultFile(this);
    this.touch();
  }

  request(method, params, timeoutMs = 60_000) {
    if (this.closed || !this.proc?.stdin?.writable) return Promise.reject(new Error("Grok process is not available."));
    const id = ++this.requestId;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer, method });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  write(message) {
    this.proc.stdin.write(JSON.stringify(message) + "\n");
  }

  onLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(cleanText(message.error.message || JSON.stringify(message.error))));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (message.method === "session/update" || message.method === "x.ai/session/update") {
      this.consumeUpdate(message.params?.update || message.params);
      return;
    }
    if (Object.hasOwn(message, "id") && message.method) this.handleAgentRequest(message);
  }

  handleAgentRequest(message) {
    if (!message.method.includes("permission")) {
      this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unsupported client method" } });
      return;
    }
    const selected = selectPermissionOption(this.mode, message, this.workerMode || "safe");
    if (selected) {
      this.write({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "selected", optionId: selected.optionId } } });
    } else {
      this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unsupported client method" } });
    }
  }

  consumeUpdate(update) {
    if (!update || typeof update !== "object") return;
    if (update.sessionUpdate === "agent_message_chunk") {
      this.touch();
      appendAgentAnswer(this, update.content?.text || "");
    } else if (update.sessionUpdate === "plan") {
      this.touch();
      this.plan = sanitizePlan(update);
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      this.touch();
      this.toolEvents.push({
        type: update.sessionUpdate,
        title: cleanText(update.title || update.kind || "tool").slice(0, MAX_TOOL_TITLE_CHARS),
        status: cleanText(update.status || "unknown"),
        at: this.updatedAt,
        revision: this.revision
      });
      this.toolEvents = this.toolEvents.slice(-20);
    }
  }

  runTurn(prompt, timeoutSeconds = this.timeoutSeconds) {
    if (this.status !== "idle" && this.status !== "completed") throw new Error(`Agent is ${this.status}; wait for the current turn to settle or close it before sending another prompt.`);
    this.status = "running";
    this.error = null;
    this.turnText = "";
    this.turnChars = 0;
    if (this.responseChars > 0 && this.resultPath) appendPrivateCapped(this.resultPath, "\n\n## Follow-up\n\n");
    this.touch();
    const boundedTimeout = clamp(timeoutSeconds, 30, 1800, this.timeoutSeconds) * 1000;
    const turn = this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text: cleanText(prompt) }]
    }, boundedTimeout).then(result => {
      this.clearCancelTimer();
      this.status = this.status === "cancelling" ? "idle" : "completed";
      this.touch();
      try { persistAgentResult(this); } catch { /* disk is best-effort */ }
      return result;
    }).catch(error => {
      this.clearCancelTimer();
      if (this.status === "cancelling") {
        this.status = "idle";
        this.touch();
        return { stopReason: "cancelled" };
      }
      if (this.closed) return { stopReason: "closed" };
      this.fail(error);
      throw error;
    }).finally(() => {
      if (this.turnPromise === turn) this.turnPromise = null;
    });
    this.turnPromise = turn;
    this.turnPromise.catch(() => {});
    return turn;
  }

  cancel() {
    if (!this.sessionId || this.closed || this.status !== "running") return false;
    this.write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sessionId } });
    this.status = "cancelling";
    this.touch();
    this.clearCancelTimer();
    this.cancelTimer = setTimeout(() => {
      if (this.status === "cancelling") this.fail(new Error("Grok cancellation timed out."));
    }, CANCEL_TIMEOUT_MS);
    this.cancelTimer.unref();
    return true;
  }

  clearCancelTimer() {
    if (this.cancelTimer) clearTimeout(this.cancelTimer);
    this.cancelTimer = null;
  }

  terminateProcess() {
    if (!this.proc || this.proc.killed || this.proc.exitCode !== null || this.proc.signalCode !== null) return;
    if (process.platform === "win32") {
      const pid = this.proc.pid;
      if (Number.isInteger(pid) && pid > 0) {
        spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      }
      try { this.proc.kill("SIGTERM"); } catch {}
      return;
    }
    this.proc.kill("SIGTERM");
    setTimeout(() => {
      if (this.proc?.exitCode === null && this.proc?.signalCode === null) this.proc.kill("SIGKILL");
    }, 1500).unref();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.status = "closed";
    this.touch();
    this.clearCancelTimer();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Grok agent closed."));
    }
    this.pending.clear();
    this.terminateProcess();
    removeIsolatedRuntime(this.runtime);
    this.runtime = null;
  }

  onExit(code, signal) {
    if (this.closed || this.status === "failed") return;
    const reason = `Grok process exited (${signal || code}).`;
    this.fail(new Error(reason));
  }

  fail(error) {
    if (this.closed || this.status === "failed") return;
    this.error = cleanText(error?.message || error);
    if (this.stderr.trim()) this.error += `\n${cleanText(this.stderr.trim()).slice(-2000)}`;
    this.status = "failed";
    this.touch();
    this.clearCancelTimer();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(this.error));
    }
    this.pending.clear();
    this.terminateProcess();
    removeIsolatedRuntime(this.runtime);
    this.runtime = null;
  }

  notifyWaiters() {
    for (const fn of [...this.waiters]) {
      try { fn(); } catch { /* waiter errors are ignored */ }
    }
  }

  touch() {
    this.updatedAt = new Date().toISOString();
    this.revision += 1;
    this.notifyWaiters();
  }

  summary(includeText = false) {
    const result = {
      agent_id: this.id,
      status: this.status,
      mode: this.mode,
      role: this.role,
      model: this.model,
      effort: this.effort,
      cwd: this.cwd,
      worker_mode: this.workerMode,
      sandbox_profile: this.runtime?.sandboxProfile || null,
      os_sandbox: osSandboxStatus(),
      security_level: securityLevel(this.mode, this.workerMode),
      security: securityContract(this.mode, this.workerMode, this.allowNetwork),
      artifact_id: artifactIdForAgent(this),
      started_at: this.startedAt,
      updated_at: this.updatedAt,
      elapsed_seconds: Math.max(0, Math.trunc((Date.now() - Date.parse(this.startedAt)) / 1000)),
      revision: this.revision,
      plan: this.plan,
      recent_tools: this.toolEvents.slice(-8),
      error: this.error
    };
    result.response_chars = this.responseChars || this.text.length;
    result.telemetry = {
      grok_response_chars: result.response_chars,
      preview_chars: Math.min(STATUS_PREVIEW_CHARS, this.text.length)
    };
    if (includeText) result.response = this.text;
    else result.public_response_preview = this.text.slice(-STATUS_PREVIEW_CHARS);
    return result;
  }
}

function sanitizePlan(update) {
  const entries = update.entries || update.plan || [];
  if (!Array.isArray(entries)) return cleanText(JSON.stringify(entries)).slice(0, 6000);
  return entries.slice(0, MAX_PLAN_ITEMS).map(entry => ({
    content: cleanText(entry.content || entry.text || entry.title || "").slice(0, MAX_PLAN_ENTRY_CHARS),
    status: cleanText(entry.status || "pending").slice(0, 40)
  }));
}

function getAgent(id) {
  const agent = agents.get(id);
  if (!agent) throw new Error(`Unknown Grok agent: ${id}`);
  return agent;
}

async function spawnAgent(args, mode) {
  pruneFailedAgents();
  const activeAgents = [...agents.values()].filter(agent => !["failed", "closed"].includes(agent.status));
  if (activeAgents.length >= MAX_AGENTS) throw new Error(`At most ${MAX_AGENTS} Grok agents may be open. Close one first.`);
  if (typeof args.task !== "string" || !args.task.trim()) throw new Error("task is required.");
  if (mode === "worker" && args.confirm_write_scope !== true) throw new Error("confirm_write_scope must be true after explicit user authorization.");
  const workerMode = mode === "worker" ? normalizeWorkerMode(args.worker_mode, { allowShell: args.allow_shell === true }) : "safe";
  const allowNetwork = mode === "worker" && workerMode === "full" ? args.allow_network === true : false;
  const cwd = mode === "readonly" ? absoluteDirectory(args.cwd, "cwd") : assertLinkedWorktree(args.worktree);
  if (mode === "worker" && workerMode === "safe") assertWindowsSafeWorkerProjectPolicy(cwd);
  const agent = new GrokAgent({
    cwd,
    mode,
    workerMode,
    allowNetwork,
    role: args.role,
    model: args.model,
    effort: args.effort,
    timeoutSeconds: clamp(args.timeout_seconds, 30, 1800, mode === "readonly" ? 600 : 900)
  });
  agents.set(agent.id, agent);
  try {
    await agent.start();
    agent.runTurn(args.task);
  } catch (error) {
    agent.close();
    agents.delete(agent.id);
    throw error;
  }
  return agent.summary(false);
}

function pruneFailedAgents() {
  const failed = [...agents.values()]
    .filter(agent => agent.status === "failed")
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  while (failed.length > MAX_RETAINED_FAILED_AGENTS) {
    const agent = failed.shift();
    agent.close();
    agents.delete(agent.id);
  }
}

function waitUntil(agent, predicate, timeoutMs) {
  if (predicate() || timeoutMs <= 0) return Promise.resolve();
  return new Promise(resolvePromise => {
    let settled = false;
    const timer = setTimeout(done, timeoutMs);
    function done() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      agent.waiters.delete(onWake);
      resolvePromise();
    }
    function onWake() {
      if (predicate()) done();
    }
    agent.waiters.add(onWake);
    if (predicate()) done();
  });
}

async function waitForAgent(agent, seconds) {
  const waitSeconds = resolveWaitSeconds(agent, seconds);
  await waitUntil(agent, () => !["running", "cancelling"].includes(agent.status), waitSeconds * 1000);
  flushAgentSecrets(agent);
}

async function waitForRevision(agent, afterRevision, seconds) {
  if (!Number.isInteger(afterRevision) || afterRevision < 0) return;
  const waitSeconds = resolveWaitSeconds(agent, seconds);
  await waitUntil(
    agent,
    () => agent.revision > afterRevision || !["running", "cancelling"].includes(agent.status),
    waitSeconds * 1000
  );
}


function searchScriptPath() {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "run_search.py");
}

function parseSearchStdout(stdout, stderr, status) {
  const text = String(stdout || "").trim();
  const err = String(stderr || "").trim();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); }
    catch {
      const match = text.match(/\{[\s\S]*\}\s*$/) || text.match(/\[[\s\S]*\]\s*$/);
      if (match) {
        try { payload = JSON.parse(match[0]); } catch {}
      }
    }
  }
  if (payload && typeof payload === "object") {
    if (err) payload.bridge_stderr = cleanText(err).slice(-2000);
    return payload;
  }
  throw new Error(cleanText(err || text || `Search bridge exited with code ${status}`));
}

function runSearchBridge(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(findPython(), [searchScriptPath(), ...args], {
      env: buildChildEnv(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout = appendBounded(stdout, chunk, SEARCH_STDOUT_MAX); });
    child.stderr.on("data", chunk => { stderr = appendBounded(stderr, chunk, SEARCH_STDERR_MAX); });
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error("Search bridge timed out."));
    }, 1_860_000);
    child.on("error", error => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      try { resolvePromise(parseSearchStdout(stdout, stderr, code)); }
      catch (error) { rejectPromise(error); }
    });
  });
}

async function callSearch(args = {}) {
  if (typeof args.query !== "string" || !args.query.trim()) throw new Error("query is required.");
  if (args.query.length > MAX_TEXT) throw new Error(`query must be at most ${MAX_TEXT} characters.`);
  const platform = args.platform || "auto";
  if (!["auto", "x", "reddit", "web"].includes(platform)) throw new Error("platform must be auto, x, reddit, or web.");
  const depth = args.depth || "quick";
  if (!["quick", "deep"].includes(depth)) throw new Error("depth must be quick or deep.");
  const command = [
    "run",
    "--platform", platform,
    "--depth", depth,
    "--timeout", String(clamp(args.timeout_seconds, 30, 1800, 600)),
    "--retention-days", "7"
  ];
  if (typeof args.since === "string" && args.since.trim()) command.push("--since", args.since.trim());
  if (typeof args.until === "string" && args.until.trim()) command.push("--until", args.until.trim());
  if (args.keep_run === true) command.push("--keep-run");
  command.push("--model", process.env.GROK_SEARCH_MODEL || process.env.GROK_MODEL || DEFAULT_MODEL);
  command.push("--max-turns", "12");
  command.push(args.query);
  const payload = await runSearchBridge(command);
  const filePath = payload.result_path;
  return attachArtifactEnvelope(payload, filePath, artifactIdForSearch(payload.run_id));
}

function searchCacheRoot() {
  if (process.platform === "win32" && process.env.LOCALAPPDATA) return resolve(process.env.LOCALAPPDATA, "grok-subagent", "search-runs");
  return resolve(homedir(), ".cache", "grok-subagent", "search-runs");
}

function listSearchRuns() { return runSearchBridge(["list"]); }

function searchRunResultPath(runId) {
  const id = String(runId || "").trim();
  if (!SEARCH_RUN_ID_RE.test(id)) throw new Error("run_id is malformed.");
  const root = searchCacheRoot();
  const candidate = resolve(root, id, "result.md");
  const rootReal = existsSync(root) ? realpathSync(root) : root;
  const candidateReal = existsSync(candidate) ? realpathSync(candidate) : candidate;
  const prefix = (rootReal.endsWith(sep) ? rootReal : rootReal + sep).toLowerCase();
  if (!candidateReal.toLowerCase().startsWith(prefix)) throw new Error("run_id is outside the search cache.");
  return candidateReal;
}

function artifactPath(artifactId) {
  const id = String(artifactId || "").trim();
  if (id.startsWith("agent:")) {
    const agentId = id.slice(6);
    if (!/^[0-9a-f-]{36}$/i.test(agentId)) throw new Error("artifact_id is malformed.");
    const live = agents.get(agentId);
    if (live) { persistAgentResult(live); return live.resultPath; }
    const candidate = join(resultStoreDir(), `${agentId}.md`);
    if (!existsSync(candidate)) throw new Error("artifact was not found or expired.");
    return candidate;
  }
  if (id.startsWith("search:")) return searchRunResultPath(id.slice(7));
  throw new Error("artifact_id must begin with agent: or search:.");
}

async function showSearchRun(args = {}) {
  if (typeof args.run_id !== "string" || !args.run_id.trim()) throw new Error("run_id is required.");
  const runId = args.run_id.trim();
  const payload = await runSearchBridge(["show", runId]);
  const filePath = payload.manifest?.result_path || payload.result_path || searchRunResultPath(runId);
  return attachArtifactEnvelope(payload, filePath, artifactIdForSearch(runId));
}

async function callTool(name, args = {}) {
  switch (name) {
    case "grok_spawn_readonly": return spawnAgent(args, "readonly");
    case "grok_spawn_worker": return spawnAgent(args, "worker");
    case "grok_handoff_interactive": return launchInteractiveHandoff(args);
    case "grok_search": return callSearch(args);
    case "grok_wait":
    case "grok_result": {
      const agent = getAgent(args.agent_id);
      await waitForAgent(agent, args.wait_seconds);
      return buildAgentResultPayload(agent);
    }
    case "grok_artifact_read": {
      const id = String(args.artifact_id || "");
      return readTextSlice(artifactPath(id), args.offset_bytes, args.max_chars, id);
    }
    case "grok_artifact_search": {
      const id = String(args.artifact_id || "");
      return searchTextFile(artifactPath(id), args.pattern, args, id);
    }
    case "grok_result_read": {
      const agent = getAgent(args.agent_id);
      const id = artifactIdForAgent(agent);
      persistAgentResult(agent);
      return readTextSlice(agent.resultPath, args.offset ?? args.offset_bytes, args.max_chars, id);
    }
    case "grok_result_search": {
      if (args.agent_id) {
        const agent = getAgent(args.agent_id); persistAgentResult(agent);
        return searchTextFile(agent.resultPath, args.pattern, args, artifactIdForAgent(agent));
      }
      if (args.run_id) return searchTextFile(searchRunResultPath(String(args.run_id).trim()), args.pattern, args, artifactIdForSearch(String(args.run_id).trim()));
      throw new Error("agent_id or run_id is required.");
    }
    case "grok_search_show": return showSearchRun(args);
    case "grok_search_list": return { search_runs: await listSearchRuns() };
    case "grok_status": {
      const agent = getAgent(args.agent_id);
      await waitForRevision(agent, args.after_revision, args.wait_seconds);
      return { ...agent.summary(false), changed: !Number.isInteger(args.after_revision) || agent.revision > args.after_revision };
    }
    case "grok_send": {
      const agent = getAgent(args.agent_id);
      if (agent.mode === "worker" && args.confirm_write_scope !== true) throw new Error("confirm_write_scope must be true for writing-agent follow-ups after explicit user authorization.");
      agent.runTurn(args.message, clamp(args.timeout_seconds, 30, 1800, 600));
      return agent.summary(false);
    }
    case "grok_cancel": { const agent = getAgent(args.agent_id); return { agent_id: agent.id, artifact_id: artifactIdForAgent(agent), cancelled: agent.cancel(), status: agent.status }; }
    case "grok_close": { const agent = getAgent(args.agent_id); const artifactId = artifactIdForAgent(agent); agent.close(); agents.delete(agent.id); return { agent_id: agent.id, artifact_id: artifactId, closed: true }; }
    case "grok_list": {
      let searchRuns = [];
      try { searchRuns = await listSearchRuns(); } catch {}
      return { agents: [...agents.values()].map(agent => agent.summary(false)), search_artifacts: Array.isArray(searchRuns) ? searchRuns.map(run => ({ ...run, artifact_id: artifactIdForSearch(run.run_id) })) : [] };
    }
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

function resultSummary(value) {
  if (!value || typeof value !== "object") return "Grok bridge completed.";
  const bits = [];
  if (value.status) bits.push(String(value.status));
  if (value.agent_id) bits.push(`agent_id=${value.agent_id}`);
  if (value.artifact_id) bits.push(`artifact_id=${value.artifact_id}`);
  if (value.preview) bits.push(`preview=${JSON.stringify(String(value.preview).slice(0, 240))}`);
  return bits.length ? `Grok bridge: ${bits.join(" ")}` : "Grok bridge completed.";
}

function boundStructured(value) {
  if (!value || typeof value !== "object") return value;
  try {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_STRUCTURED_BYTES) return value;
  } catch { /* fall through */ }
  return {
    status: value.status,
    agent_id: value.agent_id,
    artifact_id: value.artifact_id,
    preview: String(value.preview || "").slice(0, 800),
    truncated: true,
    note: "structured payload exceeded server budget"
  };
}

function structuredResult(value, isError = false) {
  if (isError) return { content: [{ type: "text", text: cleanText(value?.error || value) }], isError: true };
  const projected = boundStructured(value);
  return { content: [{ type: "text", text: resultSummary(projected) }], structuredContent: projected, isError: false };
}

function sendMcp(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function startMcpServer() {
  cleanupExpiredArtifacts();
  cleanupStaleRuntimeDirs();
  const input = createInterface({ input: process.stdin });
  input.on("line", async line => {
    let request;
    try { request = JSON.parse(line); }
    catch {
      sendMcp({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    if (!Object.hasOwn(request, "id")) return;
    try {
      let result;
      if (request.method === "initialize") {
        result = {
          protocolVersion: negotiateProtocolVersion(request.params?.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "grok-subagent", version: VERSION }
        };
      } else if (request.method === "ping") {
        result = {};
      } else if (request.method === "tools/list") {
        result = { tools: TOOL_DEFINITIONS };
      } else if (request.method === "tools/call") {
        try { result = structuredResult(await callTool(request.params?.name, request.params?.arguments || {})); }
        catch (error) { result = structuredResult({ error: cleanText(error?.message || error) }, true); }
      } else {
        sendMcp({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
        return;
      }
      sendMcp({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      sendMcp({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: cleanText(error?.message || error) } });
    }
  });
  input.on("close", shutdown);
  return input;
}

function shutdown() {
  for (const agent of agents.values()) agent.close();
  agents.clear();
}

export {
  GrokAgent, EFFORT_LEVELS, MAX_RESULT_BYTES, MAX_WAIT_SECONDS, TOOL_DEFINITIONS, TOOL_TIMEOUT_SEC, VERSION,
  READ_ONLY_DENY_RULES, SAFE_WORKER_DENY_RULES, FULL_WORKER_DENY_RULES, WORKER_DENY_RULES,
  absoluteDirectory, agentProfilePath, appleScriptString, artifactIdForAgent, artifactIdForSearch, artifactPath,
  assertLinkedWorktree, assertGitRepositoryRoot, assertWindowsSafeWorkerProjectPolicy, attachArtifactEnvelope, appendAgentAnswer, appendPrivateCapped,
  buildAcpLaunchArgs, buildInteractiveCommand, buildWindowsInteractiveCommand, buildChildEnv, buildAgentResultPayload,
  callSearch, cleanText, cleanupExpiredArtifacts, cleanupStaleRuntimeDirs, createIsolatedRuntime, findGrok, findPython,
  grokBinaryNames, ingestSecretChunk, isolatedConfigToml, listSearchRuns, negotiateProtocolVersion, normalizeWorkerMode, objectOutputSchema, remainingSecretShape, resolveWaitSeconds, securityContract, securityLevel, sanitizePlan,
  openAgentResultFile, osSandboxStatus, powershellSingleQuote, readTextSlice, removeIsolatedRuntime, resolveEffort,
  resultStoreDir, sandboxProfileName, sandboxToml, searchCacheRoot, searchRunResultPath, searchTextFile, searchScriptPath,
  selectPermissionOption, showSearchRun, shutdown, startMcpServer, structuredResult, waitForRevision
};

let isMainModule = false;
try {
  isMainModule = Boolean(process.argv[1])
    && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {}

if (isMainModule) {
  startMcpServer();
  process.on("SIGINT", () => { shutdown(); process.exit(0); });
  process.on("SIGTERM", () => { shutdown(); process.exit(0); });
  process.on("exit", shutdown);
}
