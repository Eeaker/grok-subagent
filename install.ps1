#Requires -Version 5.1
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginRoot = Join-Path $Root "plugins\grok-subagent"
$SkillSrc = Join-Path $PluginRoot "skills\grok-subagent"
$CodexHome = Join-Path $env:USERPROFILE ".codex"
$SkillDst = Join-Path $CodexHome "skills\grok-subagent"
$ConfigToml = Join-Path $CodexHome "config.toml"
$DesktopCodex = Join-Path $CodexHome "plugins\.plugin-appserver\codex.exe"
$GrokExe = Join-Path $env:USERPROFILE ".grok\bin\grok.exe"

function Assert-Command($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Name"
  }
}

Write-Host "==> Checking prerequisites"
Assert-Command node
Assert-Command python
if (-not (Test-Path $GrokExe)) {
  $resolved = (Get-Command grok -ErrorAction SilentlyContinue).Source
  if (-not $resolved) { throw "Grok CLI not found. Expected $GrokExe" }
  $GrokExe = $resolved
}
$grokVersion = & $GrokExe version 2>&1 | Select-Object -First 1
Write-Host "    grok: $grokVersion"
Write-Host "    node: $(node -v)"
Write-Host "    python: $(python --version 2>&1)"

$hasDesktop = Test-Path $DesktopCodex

if ($hasDesktop) {
  Write-Host "==> Desktop plugin is the single MCP/skill source; removing duplicate copies"
  if (Test-Path $SkillDst) { Remove-Item $SkillDst -Recurse -Force }
} else {
  Write-Host "==> No Desktop plugin binary; installing CLI skill + MCP fallback"
  New-Item -ItemType Directory -Force -Path (Split-Path $SkillDst) | Out-Null
  if (Test-Path $SkillDst) { Remove-Item $SkillDst -Recurse -Force }
  Copy-Item $SkillSrc $SkillDst -Recurse
}

$cleanup = Join-Path $Root "scripts\cleanup-codex-config.py"
$pyArgs = @($cleanup, "--config", $ConfigToml, "--project-root", $Root)
if ($hasDesktop) { $pyArgs += "--desktop" }
Write-Host "==> Updating Codex config"
& python @pyArgs
if ($LASTEXITCODE -ne 0) { throw "cleanup-codex-config.py failed" }

if ($hasDesktop) {
  Write-Host "==> Reinstalling Codex Desktop plugin grok-subagent@eeaker-grok"
  & $DesktopCodex plugin marketplace remove "walvez-grok" 2>$null
  & $DesktopCodex plugin marketplace add $Root
  if ($LASTEXITCODE -ne 0) { throw "codex plugin marketplace add failed" }
  & $DesktopCodex plugin remove "grok-subagent@walvez-grok" 2>$null
  & $DesktopCodex plugin remove "grok-subagent@eeaker-grok" 2>$null
  & $DesktopCodex plugin add "grok-subagent@eeaker-grok"
  if ($LASTEXITCODE -ne 0) { throw "codex plugin add failed" }
} else {
  Write-Host "==> Codex Desktop plugin binary not found; CLI fallback only"
}

Write-Host ""
Write-Host "==> Running bridge doctor"
Push-Location $Root
try { npm run doctor } finally { Pop-Location }

Write-Host ""
Write-Host "Install finished."
Write-Host "1. Start a NEW Codex task (old threads do not hot-reload plugins/MCP)."
Write-Host "2. Optional live demo: node `"$Root\scripts\demo-readonly.mjs`""
Write-Host "3. In a NEW Codex task: ask Grok to review this repo read-only, then verify the evidence yourself."
