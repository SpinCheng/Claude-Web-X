# Phase 0 - 01 Environment check
# Checks: claude CLI, 3rd-party API env vars, Node.js, CC/Cowork session dirs
# NOTE: keep this file ASCII-only. PS 5.1 misparses BOM-less UTF-8 with non-ASCII text.
$ErrorActionPreference = 'Stop'
$script:fail = 0
function Pass($m) { Write-Host "[PASS] $m" -ForegroundColor Green }
function Fail($m) { Write-Host "[FAIL] $m" -ForegroundColor Red; $script:fail++ }
function Info($m) { Write-Host "[INFO] $m" -ForegroundColor Gray }

Write-Host '=== 1. claude CLI ==='
$cmd = Get-Command claude -ErrorAction SilentlyContinue
if ($cmd) {
    Pass "claude found at $($cmd.Source)"
    $v = (& claude --version 2>&1 | Out-String).Trim()
    Info "version: $v"
} else {
    Fail 'claude command not found in PATH'
}

Write-Host ''
Write-Host '=== 2. 3rd-party API env vars (values masked) ==='
foreach ($n in @('ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY')) {
    $u = [Environment]::GetEnvironmentVariable($n, 'User')
    $p = [Environment]::GetEnvironmentVariable($n, 'Process')
    $val = if ($p) { $p } else { $u }
    if ($val) {
        if ($n -eq 'ANTHROPIC_BASE_URL') {
            Pass "$n = $val"
        } else {
            $head = $val.Substring(0, [Math]::Min(6, $val.Length))
            $tail = $val.Substring([Math]::Max(0, $val.Length - 4))
            $src = if ($p) { 'process' } else { 'user-level' }
            Pass "$n is set ($head...$tail) source: $src"
        }
    } else {
        Info "$n not set (OK if claude works - maybe injected another way)"
    }
}

Write-Host ''
Write-Host '=== 3. Node.js (bridge dependency, needs >= 20) ==='
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    $nv = (& node --version 2>&1 | Out-String).Trim()
    try {
        $major = [int]($nv.TrimStart('v').Split('.')[0])
        if ($major -ge 20) { Pass "node $nv" } else { Fail "node $nv too old (need >= 20)" }
    } catch { Info "node installed but version parse failed: $nv" }
} else {
    Info 'node not installed (install before Phase 1; does not block this run)'
}

Write-Host ''
Write-Host '=== 4. Claude Code session dir ==='
$ccRoot = Join-Path $env:USERPROFILE '.claude\projects'
if (Test-Path $ccRoot) {
    $dirs = @(Get-ChildItem $ccRoot -Directory -ErrorAction SilentlyContinue)
    $files = @(Get-ChildItem $ccRoot -Recurse -Filter *.jsonl -ErrorAction SilentlyContinue)
    Pass $ccRoot
    Info "project dirs: $($dirs.Count), transcript files: $($files.Count)"
} else {
    Fail "missing: $ccRoot"
}

Write-Host ''
Write-Host '=== 5. Cowork session dirs ==='
$cwFound = $false
foreach ($root in @((Join-Path $env:LOCALAPPDATA 'Claude-3p\local-agent-mode-sessions'), (Join-Path $env:LOCALAPPDATA 'Claude\local-agent-mode-sessions'))) {
    if (Test-Path $root) {
        $s = @(Get-ChildItem $root -Recurse -Filter 'local_*.json' -ErrorAction SilentlyContinue)
        Pass "$root (local_*.json count: $($s.Count))"
        $cwFound = $true
    } else {
        Info "missing: $root"
    }
}
if (-not $cwFound) { Fail 'no Cowork session root found' }

Write-Host ''
if ($script:fail -eq 0) {
    Write-Host 'All environment checks passed.' -ForegroundColor Green
} else {
    Write-Host "$($script:fail) check(s) failed. Fix and rerun." -ForegroundColor Red
}
