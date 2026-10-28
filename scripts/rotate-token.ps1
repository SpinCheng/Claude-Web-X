# rotate-token.ps1 - one-shot token rotation for claude-remote (Plan section 8).
# Does, in order:
#   1. generate a fresh 24-byte hex token
#   2. write it into bridge/data/config.json
#   3. rewrite the Stop/Notification hook commands in ~/.claude/settings.json
#      (they embed the token; a backup settings.json.bak-rotate-<ts> is kept)
#   4. restart the bridge (kills the port listener, relaunches via start-bridge.vbs)
#   5. verify with the new token and print fresh pairing links
# NOTE: keep this file ASCII-only. PS 5.1 misparses BOM-less UTF-8 with non-ASCII.
# JSON edits are done by node (PS 5.1 ConvertTo-Json mangles nested objects).
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$cfgPath = Join-Path $root 'bridge\data\config.json'
$settingsPath = Join-Path $env:USERPROFILE '.claude\settings.json'
$vbs = Join-Path $root 'scripts\start-bridge.vbs'
foreach ($p in @($cfgPath, $settingsPath, $vbs)) {
    if (-not (Test-Path $p)) { Write-Host "[FAIL] missing: $p"; exit 1 }
}

# 1. new token
$newTok = & node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
if (-not $newTok -or $newTok.Length -ne 48) { Write-Host '[FAIL] token generation failed'; exit 1 }

# 2+3. JSON edits in node (paths + token passed via env; forward slashes only)
$env:CR_CFG = $cfgPath -replace '\\', '/'
$env:CR_SETTINGS = $settingsPath -replace '\\', '/'
$env:CR_HOOK_CMD = ((Join-Path $root 'bridge\hook-post.cmd') -replace '\\', '/')
$env:CR_NEW_TOKEN = $newTok
$backup = $settingsPath + '.bak-rotate-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
Copy-Item $settingsPath $backup -Force
& node -e "
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync(process.env.CR_CFG, 'utf8'));
cfg.token = process.env.CR_NEW_TOKEN;
fs.writeFileSync(process.env.CR_CFG, JSON.stringify(cfg, null, 2));
const s = JSON.parse(fs.readFileSync(process.env.CR_SETTINGS, 'utf8'));
const hook = (ev) => [{ hooks: [{ type: 'command', command: process.env.CR_HOOK_CMD + ' ' + ev + ' ' + process.env.CR_NEW_TOKEN }] }];
s.hooks = s.hooks || {};
s.hooks.Stop = hook('stop');
s.hooks.Notification = hook('notification');
fs.writeFileSync(process.env.CR_SETTINGS, JSON.stringify(s, null, 2));
console.log('config.json + settings.json hooks updated');
"
if ($LASTEXITCODE -ne 0) {
    Write-Host '[FAIL] JSON edit failed - restoring settings backup'
    Copy-Item $backup $settingsPath -Force
    exit 1
}

# 4. restart the bridge
$port = (& node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.CR_CFG,'utf8')).port)")
$c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($c) { Stop-Process -Id $c.OwningProcess -Force; Start-Sleep -Milliseconds 800 }
wscript.exe $vbs
Start-Sleep -Seconds 3

# 5. verify + print links
$ok = & node -e "
fetch('http://localhost:' + $port + '/api/ping', { headers: { Authorization: 'Bearer ' + process.env.CR_NEW_TOKEN } })
  .then(r => console.log(r.ok ? 'ok' : 'http ' + r.status)).catch(e => console.log('fail: ' + e.message));
"
if ($ok -ne 'ok') { Write-Host "[FAIL] bridge did not come back with the new token ($ok)"; exit 1 }

Write-Host ''
Write-Host "token rotated. settings backup: $backup"
Write-Host 'old pairing links are dead; give the phone the new one:'
$ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '169.254*' -and $_.IPAddress -ne '127.0.0.1' } |
    Select-Object -ExpandProperty IPAddress -Unique)
foreach ($ip in $ips) { Write-Host ("  http://" + $ip + ":" + $port + "/?token=" + $newTok) }
Write-Host '(or run: cr url anytime to re-print them)'
