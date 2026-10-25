# Phase 0 - 03 Bidirectional handoff test
# Verifies: session started in a terminal -> resumed headless via claude --resume -p
#           -> same transcript file gets appended (core of the handoff model)
# NOTE: keep this file ASCII-only. PS 5.1 misparses BOM-less UTF-8 with non-ASCII text.
$ErrorActionPreference = 'Stop'

$cc = Get-Command claude -ErrorAction SilentlyContinue
if (-not $cc) {
    Write-Host '[FAIL] claude CLI not found in PATH. Install it first (needed for bridge too).'
    exit 1
}

Write-Host '=== Bidirectional handoff test ==='
Write-Host 'Step 1/3: open a NEW terminal window and run: claude'
Write-Host '          tell it a passphrase, e.g. type: my secret passphrase is banana-7'
Write-Host '          after it replies, type /exit to leave the session.'
Read-Host 'Done? Press Enter here to continue' | Out-Null

$projRoot = Join-Path $env:USERPROFILE '.claude\projects'
$newest = Get-ChildItem $projRoot -Recurse -Filter *.jsonl -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $newest) { Write-Host '[FAIL] no session file found'; exit 1 }

$sid = $newest.BaseName
$firstUser = $null
foreach ($line in [System.IO.File]::ReadLines($newest.FullName)) {
    if ($line -match '"type"\s*:\s*"user"') { $firstUser = $line; break }
}
if ($firstUser) {
    if ($firstUser.Length -gt 300) { $firstUser = $firstUser.Substring(0, 300) + '...' }
    Write-Host "selected session: $sid"
    Write-Host 'first user line in it (truncated):'
    Write-Host "  $firstUser"
    $ok = Read-Host 'Is this the session you just created? (Y/N)'
    if ($ok -notmatch '^[Yy]') {
        Write-Host '[INFO] picked a wrong (newer) file. Rerun this script and press Enter right after exiting the terminal session.'
        exit 1
    }
}

$before = 0
foreach ($line in [System.IO.File]::ReadLines($newest.FullName)) { if ($line.Trim()) { $before++ } }

Write-Host ''
Write-Host 'Step 2/3: resuming the SAME session headless (simulates phone-side message)...'
$answer = (& claude --resume $sid -p 'What was the secret passphrase I told you? Reply with the passphrase only, nothing else.' 2>&1 | Out-String).Trim()
Write-Host "model reply: $answer"

$after = 0
$newest.Refresh()
foreach ($line in [System.IO.File]::ReadLines($newest.FullName)) { if ($line.Trim()) { $after++ } }
Write-Host ''
Write-Host ("transcript lines: $before -> $after (same file appended?)")
if ($after -gt $before) {
    Write-Host '[PASS] headless resume appended to the ORIGINAL session file (phone-side takeover path works)' -ForegroundColor Green
} else {
    $newest2 = Get-ChildItem $projRoot -Recurse -Filter *.jsonl -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($newest2.FullName -ne $newest.FullName) {
        Write-Host "[WARN] resume wrote to a NEW file ($($newest2.Name)) instead of the original - record this behavior!" -ForegroundColor Yellow
    } else {
        Write-Host '[FAIL] line count did not increase' -ForegroundColor Red
    }
}

$ok2 = Read-Host 'Did the model say the passphrase correctly? (Y/N)'
Write-Host ''
Write-Host "Step 3/3 (manual, optional): open another terminal and run: claude --resume $sid"
Write-Host '          confirm interactive mode sees the headless exchange and can continue (PC-side takeover).'
Write-Host "passphrase correct: $ok2"
