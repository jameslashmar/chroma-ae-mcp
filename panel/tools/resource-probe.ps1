# panel/tools/resource-probe.ps1
#
# Reads GPU memory counters and the process list, nothing else. It does not
# touch After Effects, writes nothing, needs no elevation and installs nothing.
# Called by server/src/system-resources.ts:
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File resource-probe.ps1 -Pattern "<regex>"
#
# Prints ONE JSON line:
#   { ok, counters, adapters: [{ luid, used_mb }], totals: [{ name, total_mb }],
#     processes: [{ pid, name, gpu_mb }], error? }
#
# - The process list and the memory totals do not depend on the counters, so
#   each is read in its own try: when the counters cannot be read (an older
#   Windows, or counter names in another language) the apps are still listed
#   and `counters` is false.
# - adapters / per-process values: '\GPU Adapter Memory(*)\Dedicated Usage' and
#   '\GPU Process Memory(*)\Dedicated Usage' (Windows 10 1709+, WDDM 2.x). Samples are
#   told apart by their instance names (luid_... and pid_...), not by the
#   counter path, which is localized. The counter PATHS are still the English ones:
#   there is no CIM fallback (it took 7.7 s cold).
# - totals: the display class registry keys' HardwareInformation.qwMemorySize.
#   Win32_VideoController.AdapterRAM is NOT used (it stops at 4 GB).
# - Per-process values can exceed the card (measured), so the server only ranks with them.

param([string]$Pattern = '^$')

$ErrorActionPreference = 'SilentlyContinue'
$result = [ordered]@{ ok = $true; counters = $false; adapters = @(); totals = @(); processes = @() }
$perPid = @{}

# 1. The counters.
try {
  $c = Get-Counter -Counter '\GPU Adapter Memory(*)\Dedicated Usage', '\GPU Process Memory(*)\Dedicated Usage' -ErrorAction Stop
  $adapters = @()
  foreach ($s in $c.CounterSamples) {
    if ($s.InstanceName -match '^luid_') {
      $adapters += [ordered]@{ luid = [string]$s.InstanceName; used_mb = [math]::Round($s.CookedValue / 1MB, 1) }
    }
    elseif ($s.InstanceName -match '^pid_(\d+)_') {
      $procId = [int]$Matches[1]
      $mb = [math]::Round($s.CookedValue / 1MB, 1)
      if (-not $perPid.ContainsKey($procId) -or $perPid[$procId] -lt $mb) { $perPid[$procId] = $mb }
    }
  }
  $result.adapters = @($adapters)
  $result.counters = ($adapters.Count -gt 0)
}
catch {
  $result.error = [string]$_.Exception.Message
}

# 2. The process list (needs no counters).
try {
  $procs = @()
  foreach ($p in (Get-Process | Where-Object { $_.ProcessName -match $Pattern })) {
    $gpu = $null
    if ($perPid.ContainsKey([int]$p.Id)) { $gpu = $perPid[[int]$p.Id] }
    $procs += [ordered]@{ pid = [int]$p.Id; name = [string]$p.ProcessName; gpu_mb = $gpu }
    if ($procs.Count -ge 50) { break }
  }
  $result.processes = @($procs)
}
catch {
  if (-not $result.error) { $result.error = [string]$_.Exception.Message }
}

# 3. The memory totals (registry, needs no counters).
try {
  $totals = @()
  $classKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}'
  foreach ($k in (Get-ChildItem -Path $classKey -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match '^\d{4}$' })) {
    $props = Get-ItemProperty -Path $k.PSPath -ErrorAction SilentlyContinue
    $raw = $props.'HardwareInformation.qwMemorySize'
    if ($null -eq $raw) { continue }
    $bytes = 0
    if ($raw -is [byte[]] -and $raw.Length -ge 8) { $bytes = [BitConverter]::ToUInt64($raw, 0) }
    else { $bytes = [uint64]$raw }
    if ($bytes -gt 0) {
      $totals += [ordered]@{ name = [string]$props.DriverDesc; total_mb = [math]::Round($bytes / 1MB, 0) }
    }
  }
  $result.totals = @($totals)
}
catch {
  if (-not $result.error) { $result.error = [string]$_.Exception.Message }
}

$result | ConvertTo-Json -Compress -Depth 5
