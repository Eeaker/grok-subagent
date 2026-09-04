import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export class McpTestClient {
  constructor(serverPath, options = {}) {
    this.proc = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.nextId = 0;
    this.pending = new Map();
    this.stderr = "";
    this.timeoutMs = options.timeoutMs ?? 45_000;
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", chunk => { this.stderr += chunk; });
    const lines = createInterface({ input: this.proc.stdout });
    lines.on("line", line => {
      const message = JSON.parse(line);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  request(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}\n${this.stderr}`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); }
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async call(name, args = {}) {
    const result = await this.request("tools/call", { name, arguments: args });
    if (result.isError) throw new Error(result.content?.[0]?.text || "MCP tool failed");
    if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
    const text = result.content?.[0]?.text || "{}";
    try { return JSON.parse(text); } catch { return { message: text }; }
  }

  close() {
    this.proc.kill("SIGTERM");
  }
}
