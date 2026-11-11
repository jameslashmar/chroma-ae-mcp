#Requires -Version 7.0
<#
.SYNOPSIS
    Installs or uninstalls the Chroma AE MCP extension for Adobe After Effects 2025, 2026 and 2027.

.DESCRIPTION
    Creates a directory junction from %APPDATA%\Adobe\CEP\extensions\london.chroma.aemcp
    to the repo's panel folder, sets HKCU:\Software\Adobe\CSXS.12 and CSXS.13 PlayerDebugMode=1 (string '1'),
    and prints next steps.
    With -Uninstall, removes the directory junction only.

.PARAMETER Uninstall
    Removes the extension junction without modifying registry or repo files.
#>

[CmdletBinding()]
param(
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$extensionId = 'london.chroma.aemcp'
$appDataDir = $env:APPDATA
if (-not $appDataDir) {
    $appDataDir = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
}

$cepExtensionsDir = Join-Path $appDataDir 'Adobe' 'CEP' 'extensions'
$targetJunction = Join-Path $cepExtensionsDir $extensionId
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$panelDir = Join-Path $repoRoot 'panel'

function Test-IsReparsePoint([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        return $false
    }
    $item = Get-Item -LiteralPath $Path -Force
    return [bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
}

if ($Uninstall) {
    Write-Host "Uninstalling Chroma AE MCP extension junction..." -ForegroundColor Cyan
    if (-not (Test-Path -LiteralPath $targetJunction)) {
        Write-Host "No extension found at '$targetJunction'. Nothing to uninstall." -ForegroundColor Yellow
        exit 0
    }

    if (-not (Test-IsReparsePoint $targetJunction)) {
        Write-Error "The path '$targetJunction' exists but is NOT a directory junction or symlink. Refusing to remove a real directory."
        exit 1
    }

    try {
        [System.IO.Directory]::Delete($targetJunction)
        Write-Host "Successfully removed junction: $targetJunction" -ForegroundColor Green
    }
    catch {
        Write-Error "Failed to remove junction '$targetJunction': $_"
        exit 1
    }

    Write-Host "Uninstall complete. Registry settings were retained." -ForegroundColor Green
    exit 0
}

Write-Host "Installing Chroma AE MCP development extension..." -ForegroundColor Cyan

# 1. Verify source panel directory exists
if (-not (Test-Path -LiteralPath $panelDir -PathType Container)) {
    Write-Warning "The panel directory '$panelDir' does not exist yet. The junction will be created pointing here."
}

# 2. Check destination junction path
if (Test-Path -LiteralPath $targetJunction) {
    if (-not (Test-IsReparsePoint $targetJunction)) {
        Write-Error "A non-junction folder already exists at '$targetJunction'. Refusing to overwrite. Please remove or back up the folder manually."
        exit 1
    }

    $existingTarget = (Get-Item -LiteralPath $targetJunction -Force).Target
    if ($existingTarget -and ($existingTarget -eq $panelDir -or $existingTarget.TrimEnd('\') -eq $panelDir.TrimEnd('\'))) {
        Write-Host "Junction already points to '$panelDir'." -ForegroundColor Yellow
    }
    else {
        Write-Host "Updating existing junction at '$targetJunction'..." -ForegroundColor Yellow
        [System.IO.Directory]::Delete($targetJunction)
        New-Item -ItemType Junction -Path $targetJunction -Target $panelDir -Force | Out-Null
        Write-Host "Junction updated successfully." -ForegroundColor Green
    }
}
else {
    if (-not (Test-Path -LiteralPath $cepExtensionsDir)) {
        New-Item -ItemType Directory -Path $cepExtensionsDir -Force | Out-Null
    }
    New-Item -ItemType Junction -Path $targetJunction -Target $panelDir -Force | Out-Null
    Write-Host "Created directory junction:" -ForegroundColor Green
    Write-Host "  Source: $panelDir"
    Write-Host "  Target: $targetJunction"
}

# 3. Set PlayerDebugMode = "1" for CEP 12 (AE 2025/2026) and CEP 13 (in case AE 2027 ships a newer
#    runtime). Each CEP major reads its own CSXS.<n> key; setting an unused key is harmless.
foreach ($registryKey in @('HKCU:\Software\Adobe\CSXS.12', 'HKCU:\Software\Adobe\CSXS.13')) {
    try {
        if (-not (Test-Path -LiteralPath $registryKey)) {
            New-Item -Path $registryKey -Force | Out-Null
        }
        Set-ItemProperty -LiteralPath $registryKey -Name 'PlayerDebugMode' -Value '1' -Type String
        Write-Host "Configured registry: $registryKey\PlayerDebugMode = '1'" -ForegroundColor Green
    }
    catch {
        Write-Error "Failed to set PlayerDebugMode in registry '$registryKey': $_"
        exit 1
    }
}

# 4. Print next steps
Write-Host ""
Write-Host "================ Next Steps ================" -ForegroundColor Cyan
Write-Host "1. Build the server:" -ForegroundColor White
Write-Host "   cd `"$repoRoot\server`"" -ForegroundColor Gray
Write-Host "   npm install" -ForegroundColor Gray
Write-Host "   npm run build" -ForegroundColor Gray
Write-Host ""
Write-Host "2. Restart Adobe After Effects (2025-2027)." -ForegroundColor White
Write-Host "3. In After Effects, open the panel via:" -ForegroundColor White
Write-Host "   Window > Extensions > Chroma AE MCP" -ForegroundColor Yellow
Write-Host "   Verify the panel opens and displays status (listening on 127.0.0.1:7790)." -ForegroundColor Gray
Write-Host ""
Write-Host "4. Register the MCP server in Claude Code / Claude Desktop:" -ForegroundColor White
$serverIndexPath = Join-Path $repoRoot 'server' 'dist' 'index.js'
$serverIndexForward = $serverIndexPath.Replace('\', '/')
Write-Host "   claude mcp add --scope user chroma-ae -- node `"$serverIndexForward`"" -ForegroundColor Yellow
Write-Host "============================================" -ForegroundColor Cyan
