#Requires -Version 7.0
<#
.SYNOPSIS
    Creates the self-signed ZXP signing certificate for chroma-ae-mcp and stores it in 1Password.

.DESCRIPTION
    Run once, by Jay, at the desk (1Password approval needed):
        pwsh -NoProfile -File H:/Github_repos/chroma-ae-mcp/scripts/new-cert.ps1

    1. Generates a random passphrase (never printed).
    2. Runs ZXPSignCmd -selfSignedCert to make chroma-ae-mcp-cert.p12, valid 10 years.
    3. Saves the .p12 to the project's Dropbox _work\certs\ folder (shared by both machines),
       the same pattern as VoxMark's certs\voxmark-cert.p12.
    4. Creates the 1Password item "Chroma AE MCP ZXP cert" in the "Release Signing" vault with the
       passphrase and the .p12 attached, so the chroma-release-* service accounts can read it.

    Self-signed ZXP certificates carry no continuity between versions (see AFX-VoxMark/build/sign.ps1),
    so replacing this later is harmless. Users see a one-time warning on install.
#>
[CmdletBinding()]
param(
    [string]$OutDir = 'G:\Dropbox\Projects\ClaudeProjects\AI_genAI_prompting\_work\certs',
    [string]$Vault = 'Release Signing',
    [string]$ItemTitle = 'Chroma AE MCP ZXP cert'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$zxpSignCmd = Join-Path $repoRoot 'build\ZXPSignCmd.exe'
$certPath = Join-Path $OutDir 'chroma-ae-mcp-cert.p12'

if (-not (Test-Path $zxpSignCmd)) { throw "ZXPSignCmd.exe not found at $zxpSignCmd (copy it from AFX-VoxMark\build\)." }
if (Test-Path $certPath) { throw "A certificate already exists at $certPath. Delete it first if you really want a new one." }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# 32 random bytes -> base64url, alphanumerics only so no shell quoting issues.
$bytes = [byte[]]::new(32)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$pass = ([Convert]::ToBase64String($bytes) -replace '[^A-Za-z0-9]', '').Substring(0, 32)

Write-Host 'Creating self-signed certificate...' -ForegroundColor Cyan
$p = Start-Process -FilePath $zxpSignCmd -NoNewWindow -Wait -PassThru -ArgumentList @(
    '-selfSignedCert', 'GB', 'London', 'Chroma Studios Ltd', 'Chroma AE MCP', $pass, $certPath, '-validityDays', '3650'
)
if ($p.ExitCode -ne 0 -or -not (Test-Path $certPath)) { throw "ZXPSignCmd failed (exit $($p.ExitCode))." }
Write-Host "  wrote $certPath" -ForegroundColor Green

Write-Host "Storing passphrase and certificate in 1Password ($Vault / $ItemTitle)..." -ForegroundColor Cyan
& op item create --category password --vault $Vault --title $ItemTitle `
    "password=$pass" "certificate[file]=$certPath" "notes=Self-signed ZXP cert for chroma-ae-mcp, made by scripts/new-cert.ps1 on $(Get-Date -Format yyyy-MM-dd). Copy on disk: $certPath" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "op item create failed. The .p12 is at $certPath; store its passphrase manually." }
Remove-Variable pass

Write-Host ''
Write-Host 'Done. Signing a release:' -ForegroundColor Green
Write-Host '  op-sa op run --env-file H:/Github_repos/chroma-ae-mcp/scripts/release.env -- pwsh -NoProfile -File H:/Github_repos/chroma-ae-mcp/scripts/package.ps1'
