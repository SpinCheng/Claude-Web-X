# Phase 0 - 06 Deep link test (KEY: does this 3rd-party client support them at all?)
# NOTE: keep this file ASCII-only. PS 5.1 misparses BOM-less UTF-8 with non-ASCII text.
$ErrorActionPreference = 'Continue'

function Test-Link($name, $url, $expect) {
    Write-Host ''
    Write-Host ("test: " + $name)
    Write-Host ("  URL   : " + $url)
    Write-Host ("  expect: " + $expect)
    try {
        Start-Process $url | Out-Null
    } catch {
        Write-Host ("  [FAIL] cannot launch: " + $_.Exception.Message) -ForegroundColor Red
        return
    }
    $r = Read-Host '  Did it behave as expected? (Y/N/U=opened but behaved differently)'
    Write-Host ("  recorded => " + $r) -ForegroundColor Yellow
}

Test-Link `
    'cowork/new?q creates a Cowork task' `
    ('claude://cowork/new?q=' + [uri]::EscapeDataString('Phase0 deep link test: reply with exactly OK')) `
    'Claude Desktop opens with a NEW Cowork task and the prompt text pre-filled/sent'

Test-Link `
    'code/new?q creates a Claude Code session' `
    ('claude://code/new?q=' + [uri]::EscapeDataString('Phase0 link test: reply with exactly OK')) `
    'a Claude Code session opens (in app or terminal) with the prompt text pre-filled/sent'

Write-Host ''
Write-Host '=== Manual observations (write answers into the report) ==='
Write-Host '1. Open an existing Cowork session in Desktop. Look for a copy-link/share entry,'
Write-Host '   or any place showing claude://claude.ai/chat/<id>. Where does the id come from?'
Write-Host '2. Compare that id with session dir names printed by script 05 - same or different?'
Write-Host '   This decides which parameter phone-side "open a specific session" should use.'
Write-Host '3. Record this Claude Desktop build version (Settings-About, or exe file version).'
