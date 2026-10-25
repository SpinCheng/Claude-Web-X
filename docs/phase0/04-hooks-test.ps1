# Phase 0 - 04 CC hooks -> bridge push pipeline test
# Uses a TEMPORARY --settings file (your ~/.claude/settings.json is NOT modified),
# starts a local HTTP listener and checks whether the Stop hook calls back.
# NOTE: keep this file ASCII-only. PS 5.1 misparses BOM-less UTF-8 with non-ASCII text.
$ErrorActionPreference = 'Continue'
$port = 8791

$cc = Get-Command claude -ErrorAction SilentlyContinue
if (-not $cc) { Write-Host '[FAIL] claude CLI not found in PATH'; exit 1 }

$listener = $null
try {
    $listener = New-Object System.Net.HttpListener
    $listener.Prefixes.Add("http://localhost:$port/")
    $listener.Start()
} catch {
    Write-Host "[FAIL] cannot start local listener on port $port : $($_.Exception.Message)"
    Write-Host '       try running this script from an elevated (admin) terminal.'
    exit 1
}

$hookCmd = "powershell -NoProfile -Command ""try{Invoke-RestMethod -Uri 'http://localhost:$port/stop' -Method Post -Body 'phase0-stop-hook'|Out-Null}catch{}"""
$settingsObj = @{
    hooks = @{
        Stop = @(
            @{ hooks = @( @{ type = 'command'; command = $hookCmd } ) }
        )
    }
}
$tmp = Join-Path $env:TEMP ("phase0-hooks-" + [guid]::NewGuid().ToString('N') + ".json")
$settingsObj | ConvertTo-Json -Depth 10 | Set-Content -Path $tmp -Encoding ASCII
Write-Host "temp settings file: $tmp (your ~/.claude/settings.json is untouched)"
Write-Host 'running one headless session with the Stop hook attached...'

try {
    $ctxTask = $listener.GetContextAsync()
    $out = (& claude -p 'Reply with exactly two characters: OK' --settings $tmp 2>&1 | Out-String).Trim()
    Write-Host "claude output: $out"
    Write-Host ''

    if ($out -match 'unknown option|unrecognized|--settings') {
        Write-Host '[FAIL] this claude version may not support --settings. Manual fallback:' -ForegroundColor Red
        Write-Host '  1) backup ~/.claude/settings.json'
        Write-Host "  2) add this command under hooks.Stop: $hookCmd"
        Write-Host '  3) run claude -p "hi" and watch for the callback, then restore settings.json'
        exit 1
    }

    $got = $ctxTask.Wait(30000)
    if ($got -and $ctxTask.Status -eq 'RanToCompletion') {
        $ctx = $ctxTask.Result
        $body = (New-Object System.IO.StreamReader($ctx.Request.InputStream, [System.Text.Encoding]::UTF8)).ReadToEnd()
        Write-Host "[PASS] Stop hook callback received, body: $body" -ForegroundColor Green
    } else {
        Write-Host '[FAIL] no hook callback within 30s (check claude output above for hook errors)' -ForegroundColor Red
    }
} finally {
    if ($listener) { try { $listener.Stop(); $listener.Close() } catch {} }
    Remove-Item $tmp -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host 'Note: this covers the Stop hook only. The Notification hook (fires on permission'
Write-Host 'prompts) needs an interactive permission event - deferred to bridge integration.'
