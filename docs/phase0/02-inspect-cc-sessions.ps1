# Phase 0 - 02 Inspect Claude Code session storage (~/.claude/projects)
# Output: dir layout, line-type distribution and samples of the newest session
# NOTE: keep this file ASCII-only. PS 5.1 misparses BOM-less UTF-8 with non-ASCII text.
$ErrorActionPreference = 'Stop'

$projRoot = Join-Path $env:USERPROFILE '.claude\projects'
if (-not (Test-Path $projRoot)) { Write-Host "[FAIL] missing: $projRoot"; exit 1 }

Write-Host '== Project dirs (by last write, top 10) =='
$dirs = Get-ChildItem $projRoot -Directory -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 10
foreach ($d in $dirs) {
    $files = @(Get-ChildItem $d.FullName -Filter *.jsonl -ErrorAction SilentlyContinue)
    $latest = $files | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    $latestStr = if ($latest) { $latest.LastWriteTime.ToString('yyyy-MM-dd HH:mm') } else { '-' }
    Write-Host ("{0}  sessions:{1}  latest:{2}" -f $d.Name, $files.Count, $latestStr)
}

Write-Host ''
Write-Host '== Newest session anatomy =='
$newest = Get-ChildItem $projRoot -Recurse -Filter *.jsonl -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $newest) { Write-Host '[FAIL] no jsonl session file found'; exit 1 }

Write-Host ("file      : " + $newest.FullName)
Write-Host ("sessionId : " + $newest.BaseName)
Write-Host ("size/time : {0:N0} KB / {1}" -f ($newest.Length / 1KB), $newest.LastWriteTime)

$types = @{}
$samples = @{}
$lineCount = 0
foreach ($line in [System.IO.File]::ReadLines($newest.FullName)) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $lineCount++
    try { $o = $line | ConvertFrom-Json } catch { continue }
    $t = if ($o.type) { [string]$o.type } else { '(no-type)' }
    if ($types.ContainsKey($t)) { $types[$t]++ } else { $types[$t] = 1; $samples[$t] = $line }
}

Write-Host ("total lines: " + $lineCount)
Write-Host ''
Write-Host 'line type distribution:'
$types.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object {
    Write-Host ("  {0} x {1}" -f $_.Key, $_.Value)
}

Write-Host ''
Write-Host 'First sample per type (truncated to 500 chars):'
foreach ($k in @($samples.Keys)) {
    $s = $samples[$k]
    if ($s.Length -gt 500) { $s = $s.Substring(0, 500) + '...' }
    Write-Host "--- [$k] ---"
    Write-Host $s
    Write-Host ''
}

$toolLine = $null
foreach ($line in [System.IO.File]::ReadLines($newest.FullName)) {
    if ($line -match '"type":"tool_use"' -and $line -match '"assistant"') { $toolLine = $line; break }
}
if ($toolLine) {
    if ($toolLine.Length -gt 500) { $toolLine = $toolLine.Substring(0, 500) + '...' }
    Write-Host '--- [assistant line containing tool_use] ---'
    Write-Host $toolLine
} else {
    Write-Host '[INFO] no tool_use line in this session (rerun after using tools for a sample)'
}
