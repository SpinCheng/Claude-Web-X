# cr.ps1 - PC-side takeover helper for claude-remote (Phase 2).
# Usage:
#   powershell -ExecutionPolicy Bypass -File cli\cr.ps1 list
#   powershell -ExecutionPolicy Bypass -File cli\cr.ps1 attach <number|sessionId>
#   powershell -ExecutionPolicy Bypass -File cli\cr.ps1 release <number|sessionId>
#
# `attach` claims the session (advisory lock via the bridge), injects the
# 3rd-party API env vars from ~/.claude/settings.json (in-memory only), and
# opens an interactive `claude --resume` in this terminal.
# NOTE: keep this file ASCII-only. PS 5.1 misparses BOM-less UTF-8 with non-ASCII.
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$configPath = Join-Path $root 'bridge\data\config.json'
if (-not (Test-Path $configPath)) {
    Write-Host "[FAIL] bridge config not found: $configPath"
    Write-Host "       start the bridge first (npm start)."
    exit 1
}
$cfg = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$base = "http://localhost:$($cfg.port)"
$hdr = @{ Authorization = "Bearer $($cfg.token)" }

function Get-Sessions {
    try {
        $r = Invoke-RestMethod -Uri "$base/api/sessions" -Headers $hdr -TimeoutSec 10
        return @($r.sessions | Where-Object { $_.kind -eq 'cc' })
    } catch {
        Write-Host "[FAIL] cannot reach bridge at $base : $($_.Exception.Message)"
        exit 1
    }
}

function Resolve-Target($sel) {
    $sessions = Get-Sessions
    if ($sel -match '^\d+$') {
        $i = [int]$sel
        if ($i -lt 1 -or $i -gt $sessions.Count) { Write-Host "[FAIL] no session number $i"; exit 1 }
        return $sessions[$i - 1]
    }
    $hit = $sessions | Where-Object { $_.id -eq $sel } | Select-Object -First 1
    if (-not $hit) { Write-Host "[FAIL] no session id matching '$sel'"; exit 1 }
    return $hit
}

function Get-ClaudeExe {
    $cmd = Get-Command claude -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($app in @('Claude-3p', 'Claude')) {
        $ccRoot = Join-Path $env:LOCALAPPDATA "$app\claude-code"
        if (Test-Path $ccRoot) {
            $exe = Get-ChildItem $ccRoot -Recurse -Filter claude.exe -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
            if ($exe) { return $exe.FullName }
        }
    }
    Write-Host '[FAIL] claude CLI not found (PATH or bundled under %LOCALAPPDATA%\<app>\claude-code)'
    exit 1
}

$cmd = if ($args.Count -ge 1) { [string]$args[0] } else { '' }

if ($cmd -eq 'url') {
    # print the current pairing link(s) for every LAN IPv4 address
    $ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '169.254*' -and $_.IPAddress -ne '127.0.0.1' } |
        Select-Object -ExpandProperty IPAddress -Unique)
    if ($ips.Count -eq 0) { Write-Host '[FAIL] no network address found'; exit 1 }
    Write-Host 'phone pairing link(s):'
    foreach ($ip in $ips) {
        Write-Host ("  http://" + $ip + ":" + $cfg.port + "/?token=" + $cfg.token)
    }
    Write-Host 'open on the phone once; it is saved there and never expires while the token is unchanged.'
    exit 0
}

if ($cmd -eq 'list') {
    $sessions = Get-Sessions
    if ($sessions.Count -eq 0) { Write-Host 'no Claude Code sessions yet.'; exit 0 }
    $i = 0
    foreach ($s in $sessions) {
        $i++
        $title = $s.title; if ($title -and $title.Length -gt 42) { $title = $title.Substring(0, 42) + '...' }
        $age = ''
        if ($s.lastActive) {
            $dt = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$s.lastActive).LocalDateTime
            $min = [int]((Get-Date) - $dt).TotalMinutes
            $age = if ($min -lt 1) { 'now' } elseif ($min -lt 60) { "${min}m" } elseif ($min -lt 1440) { [string][int]($min / 60) + 'h' } else { [string][int]($min / 1440) + 'd' }
        }
        $mark = if ($s.status -eq 'active') { '*' } else { ' ' }
        Write-Host ("{0,3} {1} {2,-6} {3,5} lines  {4,5}  {5}" -f $i, $mark, $s.status, $s.lines, $age, $title)
    }
    Write-Host ''
    Write-Host 'attach:  cr attach <number>   (interactive claude --resume)'
    exit 0
}

if ($cmd -eq 'attach') {
    if ($args.Count -lt 2) { Write-Host 'usage: cr attach <number|sessionId>'; exit 1 }
    $s = Resolve-Target ([string]$args[1])
    # advisory claim so the phone UI shows the PC as the current driver
    try {
        $body = @{ action = 'claim-pc' } | ConvertTo-Json
        Invoke-RestMethod -Uri "$base/api/sessions/$($s.id)/driver" -Method Post -Headers $hdr -Body $body -ContentType 'application/json' -TimeoutSec 10 | Out-Null
    } catch { Write-Host "[WARN] could not claim session (bridge off?): $($_.Exception.Message)" }

    $exe = Get-ClaudeExe
    # the bundled CLI does not self-apply settings.json env; inject it here
    $settingsPath = Join-Path $env:USERPROFILE '.claude\settings.json'
    if (Test-Path $settingsPath) {
        try {
            $envBlock = (Get-Content $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json).env
            if ($envBlock) {
                foreach ($p in $envBlock.PSObject.Properties) {
                    Set-Item -Path ("Env:\" + $p.Name) -Value ([string]$p.Value)
                }
            }
        } catch { Write-Host '[WARN] could not read settings.json env block' }
    }
    $workDir = if ($s.cwd) { [string]$s.cwd } else { (Get-Location).Path }
    Write-Host "resuming $($s.id) in $workDir"
    Write-Host "(exit the session with /exit when done; phone shows PC as driver until released)"
    Push-Location $workDir
    try { & $exe --resume $s.id }
    finally {
        Pop-Location
        # auto-drop the advisory claim so the phone is free to drive again
        try {
            $rls = @{ action = 'release' } | ConvertTo-Json
            Invoke-RestMethod -Uri "$base/api/sessions/$($s.id)/driver" -Method Post -Headers $hdr -Body $rls -ContentType 'application/json' -TimeoutSec 5 | Out-Null
            Write-Host ''
            Write-Host 'claim released - phone can drive this session again.'
        } catch { Write-Host '[WARN] auto-release failed (bridge off?): run cr release later' }
    }
    exit 0
}

if ($cmd -eq 'release') {
    if ($args.Count -lt 2) { Write-Host 'usage: cr release <number|sessionId>'; exit 1 }
    $s = Resolve-Target ([string]$args[1])
    $body = @{ action = 'release' } | ConvertTo-Json
    Invoke-RestMethod -Uri "$base/api/sessions/$($s.id)/driver" -Method Post -Headers $hdr -Body $body -ContentType 'application/json' -TimeoutSec 10 | Out-Null
    Write-Host "released $($s.id)"
    exit 0
}

Write-Host 'cr - PC-side takeover helper for claude-remote'
Write-Host 'usage:'
Write-Host '  cr list                  show Claude Code sessions'
Write-Host '  cr attach <n|id>         interactive claude --resume (claims the session)'
Write-Host '  cr release <n|id>        drop the PC claim'
Write-Host '  cr url                   print phone pairing link(s)'
Write-Host '  rotate-token.ps1         rotate the token (scripts dir), then re-pair the phone with cr url'
exit 0
