#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: node benchmark/summarize.mjs <codex-exec-jsonl> [more.jsonl ...]");
  process.exit(2);
}

function parse(file) {
  const totals = { turns: 0, input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: null, output_tokens: 0, reasoning_output_tokens: 0, mcp_calls: 0 };
  let sawCacheWrite = false;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "turn.completed" && event.usage) {
      totals.turns += 1;
      for (const key of ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"]) totals[key] += Number(event.usage[key] || 0);
      if (event.usage.cache_write_input_tokens != null || event.usage.cache_write_tokens != null) {
        if (!sawCacheWrite) { totals.cache_write_input_tokens = 0; sawCacheWrite = true; }
        totals.cache_write_input_tokens += Number(event.usage.cache_write_input_tokens ?? event.usage.cache_write_tokens ?? 0);
      }
    }
    if (event.type === "item.started" && event.item?.type === "mcp_tool_call") totals.mcp_calls += 1;
  }
  totals.uncached_input_tokens = totals.input_tokens - totals.cached_input_tokens;
  if (!sawCacheWrite) totals.cache_write_input_tokens = "unknown";
  return totals;
}
const rows = files.map(file => ({ file: basename(file), ...parse(file) }));
const keys = ["turns", "input_tokens", "cached_input_tokens", "uncached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens", "mcp_calls"];
console.log(["file", ...keys].join("\t"));
for (const row of rows) console.log([row.file, ...keys.map(k => row[k])].join("\t"));
if (rows.length === 2) {
  const [a,b] = rows;
  console.log("\nDelta B vs A:");
  for (const key of keys) {
    const delta = b[key] - a[key];
    const pct = a[key] ? (delta / a[key]) * 100 : null;
    console.log(`${key}: ${delta >= 0 ? "+" : ""}${delta}${pct == null ? "" : ` (${pct.toFixed(1)}%)`}`);
  }
}
