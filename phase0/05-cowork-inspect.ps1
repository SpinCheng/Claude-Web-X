# Phase 0 - 05 Inspect Cowork session storage (local-agent-mode-sessions)
# Output: real dir hierarchy, local_*.json location and fields, transcript/audit shapes
# NOTE: keep this file ASCII-only. PS 5.1 misparses BOM-less UTF-8 with non-ASCII text.
$ErrorActionPreference = 'Continue'

function Section($t) { Write-Host ''; Write-Host "== $t ==" }

$roots = @(
    (Join-Path $env:LOCALAPPDATA 'Claude-3p\local-agent-mode-sessions'),
    (Join-Path $env:LOCALAPPDATA 'Claude\local-agent-mode-sessions')
)
$root = $roots | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $root) { Write-Host '[FAIL] no Cowork session root found (neither Claude-3p nor Claude)'; exit 1 }
Write-Host "root: $root"

Section 'L1/L2 hierarchy'
try {
    Get-ChildItem $root -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host ("L1: " + $_.Name)
        Get-ChildItem $_.FullName -Directory -ErrorAction SilentlyContinue | Select-Object -First 5 | ForEach-Object {
            $cnt = @(Get-ChildItem $_.FullName -Directory -ErrorAction SilentlyContinue).Count
            Write-Host ("  L2: " + $_.Name + "  (child dirs: " + $cnt + ")")
        }
    }
} catch { Write-Host ("[WARN] hierarchy walk failed: " + $_.Exception.Message) }

Section 'local_*.json state files'
$stateFiles = @(Get-ChildItem $root -Recurse -Filter 'local_*.json' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending)
if ($stateFiles.Count -eq 0) {
    Write-Host '[FAIL] no local_*.json found anywhere under root'
    Write-Host 'Dumping top-level tree instead:'
    Get-ChildItem $root -Recurse -Depth 3 -ErrorAction SilentlyContinue | Select-Object -First 60 | ForEach-Object {
        Write-Host ("  " + $_.FullName.Substring($root.Length + 1))
    }
    exit 1
}
Write-Host ("total: $($stateFiles.Count), newest 5 (relative paths):")
$stateFiles | Select-Object -First 5 | ForEach-Object {
    Write-Host ("  " + $_.FullName.Substring($root.Length + 1) + "   (" + $_.LastWriteTime.ToString('MM-dd HH:mm') + ")")
}

Section 'Newest state file: top-level fields'
$st = $stateFiles[0]
Write-Host ("file: " + $st.FullName + "  ($([math]::Round($st.Length/1KB)) KB)")
try {
    $j = Get-Content $st.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($p in $j.PSObject.Properties) {
        $v = if ($null -ne $p.Value) { $p.Value.ToString() } else { '(null)' }
        $isInteresting = $p.Name -match 'session|title|status|cwd|path|updated|created|cli|name|state|kind|type'
        if ($v.Length -gt 160) { $v = $v.Substring(0, 160) + '...' }
        if ($isInteresting) {
            Write-Host ("  * " + $p.Name + " = " + $v)
        } else {
            Write-Host ("    " + $p.Name + " = " + $v)
        }
    }
} catch {
    Write-Host "[WARN] JSON parse failed: $($_.Exception.Message)"
    Write-Host 'raw head (400 chars):'
    $raw = Get-Content $st.FullName -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
    if ($raw) { if ($raw.Length -gt 400) { $raw = $raw.Substring(0, 400) + '...' }; Write-Host $raw }
}

Section 'Contents of the newest state file directory'
$dir = $st.Directory.FullName
try {
    Get-ChildItem $dir -Recurse -ErrorAction SilentlyContinue | Select-Object -First 40 | ForEach-Object {
        $rel = $_.FullName.Substring($dir.Length + 1)
        if ($_.PSIsContainer) { Write-Host ("  [dir ] " + $rel) }
        else { Write-Host ("  {0,10:N0} KB  {1}  {2}" -f ($_.Length / 1KB), $_.LastWriteTime.ToString('MM-dd HH:mm'), $rel) }
    }
} catch { Write-Host ("[WARN] dir listing failed: " + $_.Exception.Message) }

Section 'Tail samples of every jsonl under that directory (2 lines, 300 chars each)'
$jsonls = @(Get-ChildItem $dir -Recurse -Filter *.jsonl -ErrorAction SilentlyContinue)
foreach ($f in $jsonls) {
    Write-Host ("--- " + $f.Name + " ---")
    $tail = Get-Content $f.FullName -Tail 2 -Encoding UTF8 -ErrorAction SilentlyContinue
    foreach ($l in $tail) {
        $t = $l
        if ($t -and $t.Length -gt 300) { $t = $t.Substring(0, 300) + '...' }
        Write-Host ("  " + $t)
    }
}
if ($jsonls.Count -eq 0) { Write-Host '  (no jsonl under this dir - record this)' }

Section 'Extra: also dump newest jsonl found anywhere under root (transcript location hunt)'
$anyJsonl = Get-ChildItem $root -Recurse -Filter *.jsonl -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 3
foreach ($f in $anyJsonl) {
    Write-Host ("  " + $f.FullName.Substring($root.Length + 1) + "  ($([math]::Round($f.Length/1KB)) KB)")
}
if (-not $anyJsonl) { Write-Host '  (no jsonl anywhere under root - Cowork transcript may live elsewhere)' }

Section 'Local Claude Desktop dir candidates'
foreach ($d in @('Claude-3p', 'Claude')) {
    $p = Join-Path $env:LOCALAPPDATA $d
    if (Test-Path $p) { Write-Host ("  exists: " + $p) }
}
