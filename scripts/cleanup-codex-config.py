#!/usr/bin/env python3
"""Install one Grok bridge source and merge Codex direct-only MCP settings.

This script intentionally performs narrow text edits instead of round-tripping the
whole TOML document, so unrelated comments and user configuration stay intact.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

SERVER = "grok_subagent"
MARKETPLACE = "eeaker-grok"
PLUGIN_ID = f"grok-subagent@{MARKETPLACE}"
LEGACY_MARKETPLACE = "walvez-grok"
DIRECT_NAMESPACES = [
    "mcp__grok_subagent",
    "grok_subagent",
    "mcp__eeaker-grok__grok_subagent",
    "mcp__walvez-grok__grok_subagent",
]
TOOLS = {
    "grok_spawn_readonly": ("approve", 700),
    "grok_spawn_worker": ("prompt", 700),
    "grok_wait": ("approve", 1000),
    "grok_artifact_read": ("approve", 1800),
    "grok_artifact_search": ("approve", 1400),
    "grok_send": ("prompt", 700),
    "grok_search": ("approve", 1100),
    "grok_handoff_interactive": ("prompt", 600),
    "grok_cancel": ("approve", 400),
    "grok_close": ("approve", 400),
    "grok_list": ("approve", 1000),
}


def is_table_header(stripped: str) -> bool:
    return bool(re.match(r"^\[\[?.+\]\]?\s*$", stripped))


def drop_named_table_tree(text: str, prefixes: tuple[str, ...]) -> str:
    lines = text.splitlines(keepends=True)
    out: list[str] = []
    skipping = False
    for line in lines:
        stripped = line.strip()
        if is_table_header(stripped):
            normalized = stripped.strip("[]")
            skipping = any(normalized == p or normalized.startswith(p + ".") for p in prefixes)
        if not skipping:
            out.append(line)
    return "".join(out)


def drop_skill_entry(text: str, needle: str) -> str:
    lines = text.splitlines(keepends=True)
    out: list[str] = []
    i = 0
    while i < len(lines):
        if lines[i].strip() == "[[skills.config]]":
            j = i + 1
            block = [lines[i]]
            while j < len(lines) and not is_table_header(lines[j].strip()):
                block.append(lines[j]); j += 1
            if needle.lower() in "".join(block).lower():
                i = j
                continue
        out.append(lines[i]); i += 1
    return "".join(out)


def table_bounds(text: str, header: str) -> tuple[int, int] | None:
    lines = text.splitlines(keepends=True)
    offset = 0
    start = None
    for line in lines:
        stripped = line.strip()
        if stripped == header:
            start = offset + len(line)
        elif start is not None and is_table_header(stripped):
            return start, offset
        offset += len(line)
    return (start, len(text)) if start is not None else None


def merge_direct_namespaces(text: str) -> str:
    """Keep Grok MCP namespaces listed, but do not turn code-mode on.

    A bare `[features.code_mode]` table can enable under-development code-mode on
    some Codex builds, which then hides long-running MCP tools from the model.
    """
    header = "[features.code_mode]"
    bounds = table_bounds(text, header)
    values = ", ".join(json.dumps(v) for v in DIRECT_NAMESPACES)
    if bounds is None:
        suffix = "\n" if text and not text.endswith("\n") else ""
        return text + suffix + f"\n{header}\nenabled = false\ndirect_only_tool_namespaces = [{values}]\n"

    start, end = bounds
    body = text[start:end]
    if re.search(r"(?m)^\s*enabled\s*=", body) is None:
        body = "enabled = false\n" + body
    match = re.search(r"(?ms)^\s*direct_only_tool_namespaces\s*=\s*\[(.*?)\]([^\n]*)$", body)
    if match:
        existing = re.findall(r'"((?:\\.|[^"\\])*)"', match.group(1))
        decoded: list[str] = []
        for raw in existing:
            try:
                decoded.append(json.loads('"' + raw + '"'))
            except json.JSONDecodeError:
                pass
        merged = list(dict.fromkeys(decoded + DIRECT_NAMESPACES))
        suffix = match.group(2) if len(match.groups()) > 1 else ""
        replacement = "direct_only_tool_namespaces = [" + ", ".join(json.dumps(v) for v in merged) + "]" + suffix
        body = body[:match.start()] + replacement + "\n" + body[match.end():]
    else:
        body = body + ("" if body.endswith("\n") else "\n") + f"direct_only_tool_namespaces = [{values}]\n"
    return text[:start] + body + text[end:]


def migrate_plugin_identity(text: str) -> str:
    """Keep Codex plugin/marketplace ids aligned with marketplace.json."""
    text = text.replace(f"[marketplaces.{LEGACY_MARKETPLACE}]", f"[marketplaces.{MARKETPLACE}]")
    text = text.replace(f'[plugins."grok-subagent@{LEGACY_MARKETPLACE}"]', f'[plugins."{PLUGIN_ID}"]')
    text = text.replace(f"[plugins.'grok-subagent@{LEGACY_MARKETPLACE}']", f"[plugins.'{PLUGIN_ID}']")
    if f'[plugins."{PLUGIN_ID}"]' not in text and f"[plugins.'{PLUGIN_ID}']" not in text:
        suffix = "\n" if text and not text.endswith("\n") else ""
        text = text + suffix + f'\n[plugins."{PLUGIN_ID}"]\nenabled = true\n'
    return text


def ensure_project_trust(text: str, project_root: Path) -> str:
    project = str(project_root.resolve())
    quoted = json.dumps(project)
    # Existing project tables can use either quotes style/case; avoid duplicates by path substring.
    if project.lower() in text.lower():
        return text
    suffix = "\n" if text and not text.endswith("\n") else ""
    return text + suffix + f"\n[projects.{quoted}]\ntrust_level = \"trusted\"\n"


def mcp_fallback_block(project_root: Path) -> str:
    server = project_root / "plugins" / "grok-subagent" / "mcp-server" / "server.mjs"
    enabled = ", ".join(json.dumps(name) for name in TOOLS)
    lines = [
        f"[mcp_servers.{SERVER}]",
        'command = "node"',
        f"args = [{json.dumps(str(server.resolve()))}]",
        "startup_timeout_sec = 30",
        "tool_timeout_sec = 1860",
        "enabled = true",
        'default_tools_approval_mode = "approve"',
        f"enabled_tools = [{enabled}]",
        "",
    ]
    for name, (approval, limit) in TOOLS.items():
        lines += [
            f"[mcp_servers.{SERVER}.tools.{name}]",
            f'approval_mode = "{approval}"',
            f"output_token_limit = {limit}",
            "",
        ]
    return "\n".join(lines).rstrip() + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--project-root", required=True)
    parser.add_argument("--desktop", action="store_true")
    args = parser.parse_args()

    path = Path(args.config)
    project_root = Path(args.project_root).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    text = path.read_text(encoding="utf-8") if path.exists() else ""

    # Remove every old fallback server/tool subtree first; Desktop plugin is the single
    # MCP source on Desktop. CLI fallback is re-added below when Desktop is absent.
    text = drop_named_table_tree(text, ("mcp_servers.grok-subagent", "mcp_servers.grok_subagent"))
    if args.desktop:
        text = drop_skill_entry(text, "grok-subagent")
    else:
        suffix = "\n" if text and not text.endswith("\n") else ""
        text = text + suffix + "\n" + mcp_fallback_block(project_root)

    text = migrate_plugin_identity(text)
    text = merge_direct_namespaces(text)
    text = ensure_project_trust(text, project_root)
    path.write_text(text.rstrip() + "\n", encoding="utf-8")
    print(f"updated {path}")


if __name__ == "__main__":
    main()
