# Phase 0 - 00 Run all checks and build the report
# Usage: powershell -ExecutionPolicy Bypass -File phase0\00-run-all.ps1
# NOTE: keep this file ASCII-only. PS 5.1 misparses BOM-less UTF-8 with non-ASCII text.
$ErrorActionPreference = 'Continue'

$report = Join-Path $PSScriptRoot 'PHASE0-REPORT.md'
"# Claude Remote - Phase 0 field report" | Set-Content -Path $report -Encoding UTF8
Add-Content -Path $report -Value ("generated: " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + "  host: " + $env:COMPUTERNAME) -Encoding UTF8
Add-Content -Path $report -Value ("PowerShell: " + $PSVersionTable.PSVersion + "  OS: " + [System.Environment]::OSVersion.VersionString) -Encoding UTF8

$scripts = @(
    '01-verify-env.ps1',
    '02-inspect-cc-sessions.ps1',
    '03-handoff-test.ps1',
    '04-hooks-test.ps1',
    '05-cowork-inspect.ps1',
    '06-deeplink-test.ps1'
)

foreach ($s in $scripts) {
    $p = Join-Path $PSScriptRoot $s
    if (-not (Test-Path $p)) { continue }
    Write-Host ""
    Write-Host ("========== $s ==========") -ForegroundColor Yellow
    Add-Content -Path $report -Value ("`n## " + $s) -Encoding UTF8
    Add-Content -Path $report -Value '```' -Encoding UTF8
    $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $p 2>&1
    foreach ($l in $out) {
        $t = $l.ToString()
        Write-Host $t
        Add-Content -Path $report -Value $t -Encoding UTF8
    }
    Add-Content -Path $report -Value '```' -Encoding UTF8
}

Add-Content -Path $report -Value "`n## 07 UIA inspection (manual)" -Encoding UTF8
Add-Content -Path $report -Value "Follow phase0/07-uia-inspect.md, fill results into uia-selectors.json (not in this report)." -Encoding UTF8

Write-Host ""
Write-Host ("report written: " + $report) -ForegroundColor Green
Write-Host "Next: give the report to Claude (or just ask Claude to read this folder) to freeze adapter interfaces."
