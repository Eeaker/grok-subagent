import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GrokAgent, EFFORT_LEVELS, MAX_RESULT_BYTES, MAX_WAIT_SECONDS, TOOL_DEFINITIONS, TOOL_TIMEOUT_SEC,
  READ_ONLY_DENY_RULES, SAFE_WORKER_DENY_RULES, FULL_WORKER_DENY_RULES,
  appendAgentAnswer, appendPrivateCapped, artifactIdForAgent, assertLinkedWorktree, assertWindowsSafeWorkerProjectPolicy, attachArtifactEnvelope,
  buildAcpLaunchArgs, buildAgentResultPayload, buildChildEnv, cleanText, ingestSecretChunk, isolatedConfigToml, normalizeWorkerMode, remainingSecretShape, resolveWaitSeconds, securityContract, securityLevel, sanitizePlan, structuredResult,
  negotiateProtocolVersion, openAgentResultFile, osSandboxStatus, readTextSlice, resolveEffort,
  sandboxToml, searchTextFile, selectPermissionOption
} from "../plugins/grok-subagent/mcp-server/server.mjs";

test("0.7 exposes exactly 11 structured MCP tools", () => {
  assert.equal(TOOL_DEFINITIONS.length, 11);
  const names = TOOL_DEFINITIONS.map(t => t.name);
  assert.deepEqual(names, ["grok_spawn_readonly","grok_spawn_worker","grok_wait","grok_artifact_read","grok_artifact_search","grok_send","grok_search","grok_handoff_interactive","grok_cancel","grok_close","grok_list"]);
  for (const tool of TOOL_DEFINITIONS) assert.equal(tool.outputSchema?.type, "object", tool.name);
});

test("wait budget stays below MCP timeout", () => {
  assert.equal(MAX_WAIT_SECONDS, 1800);
  assert.equal(TOOL_TIMEOUT_SEC, 1860);
  assert.ok(TOOL_TIMEOUT_SEC > MAX_WAIT_SECONDS);
});

test("omitted grok_wait follows the agent timeout plus grace, not a fixed 600s", () => {
  const waitTool = TOOL_DEFINITIONS.find(tool => tool.name === "grok_wait");
  assert.equal(waitTool.inputSchema.properties.wait_seconds.default, undefined);
  assert.equal(resolveWaitSeconds({ timeoutSeconds: 900 }, undefined), 915);
  assert.equal(resolveWaitSeconds({ timeoutSeconds: 600 }, undefined), 615);
  assert.equal(resolveWaitSeconds({ timeoutSeconds: 1800 }, undefined), 1800);
  assert.equal(resolveWaitSeconds({ timeoutSeconds: 900 }, 120), 120);
});

test("readonly custom sandbox is workspace-scoped strict, not whole-machine read-only", () => {
  const toml = sandboxToml("readonly");
  assert.match(toml, /bridge-readonly/);
  assert.match(toml, /extends = "strict"/);
  assert.doesNotMatch(toml, /extends = "read-only"/);
});

test("security contract splits filesystem and child-network enforcement", () => {
  const mac = securityContract("worker", "full", false, "darwin");
  assert.equal(mac.child_process_network, "not_enforced");
  assert.equal(mac.child_process_network_enforcement, "unsupported_on_platform");
  const linux = securityContract("worker", "full", false, "linux");
  assert.equal(linux.child_process_network, "blocked");
  assert.equal(linux.child_process_network_enforcement, "seccomp");
  const win = securityContract("readonly", "safe", false, "win32");
  assert.equal(win.sandbox_enforcement, "none");
  assert.equal(win.filesystem_read_scope, "unrestricted-os");
});

test("streaming redaction holds a tail so split tokens are still caught", () => {
  const agent = { secretHold: "" };
  const first = ingestSecretChunk(agent, "prefix sk-abcdefgh");
  assert(!first.includes("sk-abcdefghijklmnop"));
  const second = ingestSecretChunk(agent, "ijklmnop suffix");
  const combined = first + second + (agent.secretHold || "");
  assert(!combined.includes("sk-abcdefghijklmnop"));
  assert.match(combined, /REDACTED/);
});

test("plan entries are bounded before they enter structured MCP output", () => {
  const plan = sanitizePlan({ entries: [{ content: "x".repeat(4000), status: "pending" }] });
  assert.equal(plan[0].content.length, 500);
});

test("structured MCP envelope carries preview in both content and structuredContent", () => {
  const out = structuredResult({ status: "completed", agent_id: "a", artifact_id: "agent:a", preview: "finding" });
  assert.match(out.content[0].text, /finding/);
  assert.equal(out.structuredContent.preview, "finding");
});

test("child environment excludes unrelated secrets", () => {
  const env = buildChildEnv({ PATH: "/bin", HOME: "/tmp/h", XAI_API_KEY: "xai-test", AWS_SECRET_ACCESS_KEY: "no", GROK_PASSTHROUGH_ENV: "SAFE_FLAG", SAFE_FLAG: "yes" });
  assert.equal(env.XAI_API_KEY, "xai-test");
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.SAFE_FLAG, "yes");
});

test("credential-shaped output is redacted", () => {
  const cleaned = cleanText("token=secret Authorization: Bearer abc.def xai-abcdefghijklmnop ghp_abcdefghijklmnopqrstuvwxyz123456");
  assert(!cleaned.includes("token=secret"));
  assert(!cleaned.includes("abc.def"));
  assert(!cleaned.includes("abcdefghijklmnop"));
});

test("protocol negotiation defaults to MCP 2025-11-25", () => {
  assert.equal(negotiateProtocolVersion("unsupported"), "2025-11-25");
  assert.equal(negotiateProtocolVersion("2024-11-05"), "2024-11-05");
});

test("effort validation defaults to medium", () => {
  assert.equal(resolveEffort(undefined), "medium");
  assert.equal(resolveEffort("HIGH"), "high");
  assert.deepEqual(EFFORT_LEVELS, ["none","minimal","low","medium","high","xhigh","max"]);
  assert.throws(() => resolveEffort("ultra"));
});

test("readonly policy denies edit shell and network", () => {
  const cfg = isolatedConfigToml("readonly");
  for (const rule of READ_ONLY_DENY_RULES) assert(cfg.includes(JSON.stringify(rule)));
  assert.match(cfg, /permission_mode = "ask"/);
  assert.match(cfg, /inherit = "core"/);
  assert.match(cfg, /\[folder_trust\]\nenabled = true/);
});

test("safe worker is path-limited and denies arbitrary shell", () => {
  const cfg = isolatedConfigToml("worker", "safe");
  assert.match(cfg, /Edit\(\.\/\*\*\)/);
  for (const rule of SAFE_WORKER_DENY_RULES) assert(cfg.includes(JSON.stringify(rule)));
});

test("full worker keeps git-state denies and uses always-approve only with OS sandbox", () => {
  const args = buildAcpLaunchArgs({ mode: "worker", workerMode: "full", model: "grok-4.6", effort: "high", profilePath: "/tmp/worker.md", platform: "linux" });
  assert(args.includes("--always-approve"));
  assert(args.includes("bridge-full-worker"));
  for (const rule of FULL_WORKER_DENY_RULES) assert(args.includes(rule));
  assert(args.includes("WebSearch"));
  assert(args.includes("WebFetch"));
});

test("native Windows launch does not claim Grok OS sandbox", () => {
  const args = buildAcpLaunchArgs({ mode: "worker", workerMode: "safe", model: "grok-4.6", effort: "medium", profilePath: "C:\\worker.md", platform: "win32" });
  assert(!args.includes("--sandbox"));
  assert.equal(osSandboxStatus("win32"), "unavailable");
});

test("native Windows full worker is explicit logical isolation, not a hard reject", () => {
  assert.equal(normalizeWorkerMode("full", { platform: "win32" }), "full");
  assert.equal(normalizeWorkerMode("safe", { allowShell: true, platform: "win32" }), "full");
  assert.equal(securityLevel("worker", "full", "win32"), "logical");
  assert.equal(securityLevel("worker", "safe", "win32"), "policy-enforced");
  const args = buildAcpLaunchArgs({ mode: "worker", workerMode: "full", model: "grok-4.6", effort: "high", profilePath: "C:\\worker.md", platform: "win32" });
  assert(!args.includes("--sandbox"));
  assert(args.includes("--always-approve"));
});


test("native Windows safe worker fails closed on repo-local Grok permission policy", () => {
  const dir = mkdtempSync(join(tmpdir(), "cgb-win-policy-"));
  try {
    mkdirSync(join(dir, ".grok"), { recursive: true });
    writeFileSync(join(dir, ".grok", "config.toml"), '[permission]\nallow = ["Edit(C:/outside/**)"]\n');
    assert.throws(() => assertWindowsSafeWorkerProjectPolicy(dir, "win32"), /refuses repo-local Grok permission policy/);
    assert.equal(assertWindowsSafeWorkerProjectPolicy(dir, "linux"), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("custom sandbox profiles restrict network and deny secret files", () => {
  const toml = sandboxToml("worker", "safe", false);
  assert.match(toml, /bridge-safe-worker/);
  assert.match(toml, /extends = "strict"/);
  assert.match(toml, /restrict_network = true/);
  assert.match(toml, /\*\*\/\.env/);
});

test("readonly and safe-worker permission requests cannot widen capability", () => {
  const message = { params: { options: [{ optionId: "yes", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }] } };
  assert.equal(selectPermissionOption("readonly", message, "safe").optionId, "no");
  assert.equal(selectPermissionOption("worker", message, "safe").optionId, "no");
  assert.equal(selectPermissionOption("worker", message, "full").optionId, "yes");
});

test("artifact write cap is strict", () => {
  const dir = mkdtempSync(join(tmpdir(), "cgb-cap-"));
  const file = join(dir, "a.md");
  writeFileSync(file, "head");
  try {
    const out = appendPrivateCapped(file, "🙂".repeat(MAX_RESULT_BYTES), MAX_RESULT_BYTES);
    assert.equal(out.truncated, true);
    assert.ok(statSync(file).size <= MAX_RESULT_BYTES);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("UTF-8 artifact reader uses byte cursor without splitting Chinese or emoji", () => {
  const dir = mkdtempSync(join(tmpdir(), "cgb-utf8-"));
  const file = join(dir, "a.md");
  writeFileSync(file, "甲乙🙂丙丁", "utf8");
  try {
    const first = readTextSlice(file, 0, 3, "agent:test");
    assert.equal(first.text, "甲乙🙂");
    assert.equal(first.next_offset_bytes, Buffer.byteLength("甲乙🙂"));
    const second = readTextSlice(file, first.next_offset_bytes, 2, "agent:test");
    assert.equal(second.text, "丙丁");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("artifact search returns bounded snippets without physical path", () => {
  const dir = mkdtempSync(join(tmpdir(), "cgb-search-"));
  const file = join(dir, "a.md"); writeFileSync(file, `alpha\n${"x".repeat(1000)} NEEDLE\nomega\n`);
  try {
    const out = searchTextFile(file, "needle", {}, "agent:test");
    assert.equal(out.artifact_id, "agent:test");
    assert.equal(out.match_count, 1);
    assert.ok(out.matches[0].text.length <= 401);
    assert.equal("result_path" in out, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("agent result envelope exposes opaque artifact id but not result path", () => {
  const dir = mkdtempSync(join(tmpdir(), "cgb-agent-")); const prev = process.env.GROK_SUBAGENT_RESULT_DIR; process.env.GROK_SUBAGENT_RESULT_DIR = dir;
  try {
    const agent = new GrokAgent({ cwd: tmpdir(), mode: "readonly", role: "test", model: "grok-4.6", effort: "medium", timeoutSeconds: 60 });
    openAgentResultFile(agent); appendAgentAnswer(agent, "finding"); agent.status = "completed";
    const out = buildAgentResultPayload(agent);
    assert.equal(out.artifact_id, artifactIdForAgent(agent));
    assert.equal("result_path" in out, false);
    assert.equal(out.preview, "finding");
  } finally { if (prev === undefined) delete process.env.GROK_SUBAGENT_RESULT_DIR; else process.env.GROK_SUBAGENT_RESULT_DIR = prev; rmSync(dir,{recursive:true,force:true}); }
});

test("search envelopes scrub physical paths and structured MCP result is non-duplicative", () => {
  const dir = mkdtempSync(join(tmpdir(), "cgb-env-")); const file = join(dir, "result.md"); writeFileSync(file, "hello world");
  try {
    const env = attachArtifactEnvelope({ result_path: file, run_path: dir, manifest: { result_path: file, cwd: dir } }, file, "search:abc");
    assert.equal("result_path" in env, false); assert.equal("run_path" in env, false); assert.equal("result_path" in env.manifest, false); assert.equal("cwd" in env.manifest, false);
    const mcp = structuredResult(env);
    assert.deepEqual(mcp.structuredContent, env);
    assert(!mcp.content[0].text.includes(file));
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test("linked worktree guard rejects primary checkout and accepts linked worktree", () => {
  const dir = mkdtempSync(join(tmpdir(), "cgb-git-")); const repo = join(dir,"repo"); const wt = join(dir,"wt");
  try {
    execFileSync("git", ["init", repo]); execFileSync("git", ["-C",repo,"config","user.email","test@example.com"]); execFileSync("git", ["-C",repo,"config","user.name","Test"]);
    writeFileSync(join(repo,"a.txt"),"a"); execFileSync("git",["-C",repo,"add","a.txt"]); execFileSync("git",["-C",repo,"commit","-m","init"]);
    assert.throws(() => assertLinkedWorktree(repo), /Primary checkouts/);
    execFileSync("git",["-C",repo,"worktree","add",wt,"-b","bridge-test"]);
    assert.equal(assertLinkedWorktree(wt), wt);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
