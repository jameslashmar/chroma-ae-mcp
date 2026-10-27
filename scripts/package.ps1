#Requires -Version 7
<#
.SYNOPSIS
    Packages, stamps, signs, and verifies the Chroma AE MCP panel into a distributable .zxp.

.DESCRIPTION
    Builds the production ZXP distribution for Chroma AE MCP following the AFX_Gulp
    and AFX-VoxMark packaging pipeline:
      1. Verifies that required build artifacts (panel/client/mcp-bundle.cjs) and
         host scripts (panel/host/core.jsx) are present.
      2. Stages chroma-ae-mcp/panel into dist/stage/london.chroma.aemcp, strictly excluding
         .debug and test files/directories.
      3. Stamps the product version from VERSION into the staged CSXS/manifest.xml
         ExtensionBundleVersion attribute and every Extension Version attribute.
      4. Signs the staged directory with Adobe ZXPSignCmd using environment variables:
           CHROMA_ZXPSIGNCMD       - Path to ZXPSignCmd.exe
           CHROMA_ZXP_CERT         - Path to .p12 certificate
           CHROMA_ZXP_CERT_PASSWORD- Password injected via op run / op-sa
         Mirrors Gulp's decision to omit a timestamp server for ZXPSignCmd (unless
         CHROMA_ZXP_TSA is explicitly provided).
      5. Verifies the output ZXP with `ZXPSignCmd -verify <zxp> -certInfo`.
      6. Writes dist/chroma-ae-mcp-<version>.zxp and prints its SHA256 hash.

    Gulp decision references:
      - Stage layout & cleanup: AFX_Gulp/scripts/build-dist.ps1 lines 158-161
      - Dev/debug stripping: AFX_Gulp/scripts/build-dist.ps1 line 254; AFX-VoxMark/build/sign.ps1 lines 154-162
      - Manifest version stamping: AFX_Gulp/scripts/stamp-version.js lines 85-89
      - Signer invocation & post-sign checks: AFX_Gulp/scripts/build-dist.ps1 lines 323-329
      - Verification: Obsidian vault "Gulp build & install pipeline.md" line 68
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# ── Paths & Setup ─────────────────────────────────────────────────────────────
# Root resolution mirrors AFX_Gulp/scripts/build-dist.ps1 line 69
$ScriptDir = $PSScriptRoot
$RepoRoot  = Split-Path -Parent $ScriptDir
$PanelDir  = Join-Path $RepoRoot 'panel'
$DistDir   = Join-Path $RepoRoot 'dist'
$DistStage = Join-Path $DistDir 'stage\london.chroma.aemcp'

Write-Host "=== Chroma AE MCP Packaging ===" -ForegroundColor Cyan

# ── 1. Preflight Required Files ───────────────────────────────────────────────
# Critical asset preflight: fails immediately if required build outputs or host scripts are absent.
# Parallels AFX_Gulp/scripts/build-dist.ps1 lines 142-145 and AFX-VoxMark/build/sign.ps1 line 146.
$SourceBundle = Join-Path $PanelDir 'client\mcp-bundle.cjs'
$SourceCore   = Join-Path $PanelDir 'host\core.jsx'

if (-not (Test-Path -LiteralPath $SourceBundle)) {
    throw "Required build artifact missing: '$SourceBundle'. Run 'npm run bundle' in server/ first."
}
if (-not (Test-Path -LiteralPath $SourceCore)) {
    throw "Required host script missing: '$SourceCore'."
}
Write-Host "✓ Verified presence of mcp-bundle.cjs and core.jsx" -ForegroundColor Green

# ── 2. Read Product Version ───────────────────────────────────────────────────
# Single source of truth is VERSION file, mirroring AFX_Gulp/scripts/stamp-version.js lines 31-38
$VersionFile = Join-Path $RepoRoot 'VERSION'
if (-not (Test-Path -LiteralPath $VersionFile)) {
    throw "VERSION file missing at '$VersionFile'."
}
$Version = (Get-Content -LiteralPath $VersionFile -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($Version)) {
    throw "VERSION file at '$VersionFile' is empty."
}
# Numeric form (drop -dev / -beta suffix) for CEP manifest specification
# Copied from AFX_Gulp/scripts/stamp-version.js lines 48-50
$NumericVersion = $Version -replace '[-+].*$', ''
Write-Host "✓ Product version: $Version (CEP manifest version: $NumericVersion)" -ForegroundColor Green

# ── 3. Validate Signing Environment Variables ────────────────────────────────
# 1Password & credentials policy:
# Password is read from Windows User environment / op run / op-sa, NEVER queried from 'op' inside the script.
# Referenced from AFX_Gulp/scripts/build-dist.ps1 lines 294-299 and Global Rules.
$ZxpSignCmd   = $env:CHROMA_ZXPSIGNCMD
$ZxpCert      = $env:CHROMA_ZXP_CERT
$CertPassword = $env:CHROMA_ZXP_CERT_PASSWORD

if ([string]::IsNullOrWhiteSpace($ZxpSignCmd)) {
    throw "Environment variable CHROMA_ZXPSIGNCMD is unset. Set it to the full path of ZXPSignCmd.exe."
}
if (-not (Test-Path -LiteralPath $ZxpSignCmd)) {
    throw "ZXPSignCmd executable not found at '$ZxpSignCmd' (from CHROMA_ZXPSIGNCMD)."
}

if ([string]::IsNullOrWhiteSpace($ZxpCert)) {
    throw "Environment variable CHROMA_ZXP_CERT is unset. Set it to the full path of the .p12 certificate."
}
if (-not (Test-Path -LiteralPath $ZxpCert)) {
    throw "Signing certificate not found at '$ZxpCert' (from CHROMA_ZXP_CERT)."
}

if ([string]::IsNullOrWhiteSpace($CertPassword)) {
    throw "Environment variable CHROMA_ZXP_CERT_PASSWORD is unset. Supply it via 'op run' or 'op-sa'."
}
Write-Host "✓ Signing environment variables verified" -ForegroundColor Green

# ── Process Invocation Helper ─────────────────────────────────────────────────
# Enforces that child processes (ZXPSignCmd) run with CreateNoWindow = $true and UseShellExecute = $false
# so no console window flashes or opens unnecessarily, complying with AE/Windows constraints.
function Invoke-ChildTool {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$ArgumentList,
        [switch]$IgnoreExitCode
    )

    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName               = $FilePath
    $psi.CreateNoWindow         = $true
    $psi.UseShellExecute        = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true

    foreach ($arg in $ArgumentList) {
        $psi.ArgumentList.Add($arg)
    }

    $proc = [System.Diagnostics.Process]::Start($psi)
    $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
    $stderrTask = $proc.StandardError.ReadToEndAsync()
    $proc.WaitForExit()

    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()

    if (-not $IgnoreExitCode -and $proc.ExitCode -ne 0) {
        throw "Process '$FilePath' exited with code $($proc.ExitCode).`nSTDOUT: $stdout`nSTDERR: $stderr"
    }

    return [PSCustomObject]@{
        ExitCode = $proc.ExitCode
        StdOut   = $stdout
        StdErr   = $stderr
    }
}

# ── 4. Stage Extension Directory ──────────────────────────────────────────────
# Staging into dist/stage/london.chroma.aemcp:
# Clean stage directory recreation mirrors AFX_Gulp/scripts/build-dist.ps1 lines 158-161.
Write-Host "> Staging panel files into '$DistStage'..." -ForegroundColor Yellow
if (Test-Path -LiteralPath $DistStage) {
    Remove-Item -LiteralPath $DistStage -Recurse -Force
}
New-Item -ItemType Directory -Path $DistStage -Force | Out-Null

# Copy panel contents excluding .debug and test directories/files
Get-ChildItem -LiteralPath $PanelDir -Force | ForEach-Object {
    $item = $_
    if ($item.Name -eq '.debug') {
        return
    }
    if ($item.PSIsContainer -and ($item.Name -match '^(tests?|__tests__)$')) {
        return
    }
    if (-not $item.PSIsContainer -and ($item.Name -match '\.(test|spec)\.[a-zA-Z0-9]+$')) {
        return
    }

    Copy-Item -LiteralPath $item.FullName -Destination $DistStage -Recurse -Force
}

# Secondary cleanup sweep:
# Explicitly strip any .debug or test artifacts that might have been nested, mirroring
# AFX_Gulp/scripts/build-dist.ps1 line 254 and AFX-VoxMark/build/sign.ps1 lines 154-162.
$StagedDebug = Join-Path $DistStage '.debug'
if (Test-Path -LiteralPath $StagedDebug) {
    Remove-Item -LiteralPath $StagedDebug -Recurse -Force
    Write-Host "  .debug removed from staged package" -ForegroundColor DarkGray
}

Get-ChildItem -LiteralPath $DistStage -Recurse -Force | Where-Object {
    ($_.PSIsContainer -and ($_.Name -match '^(tests?|__tests__)$')) -or
    (-not $_.PSIsContainer -and ($_.Name -match '\.(test|spec)\.[a-zA-Z0-9]+$')) -or
    ($_.Name -eq '.debug')
} | Remove-Item -Recurse -Force

# Assert staged integrity of required files
$StagedBundle = Join-Path $DistStage 'client\mcp-bundle.cjs'
$StagedCore   = Join-Path $DistStage 'host\core.jsx'
if (-not (Test-Path -LiteralPath $StagedBundle) -or -not (Test-Path -LiteralPath $StagedCore)) {
    throw "Staging verification failed: staged copy of mcp-bundle.cjs or core.jsx is missing."
}
Write-Host "✓ Staged extension files (excluded .debug and tests)" -ForegroundColor Green

# ── 5. Stamp Manifest Version ─────────────────────────────────────────────────
# Manifest version stamping:
# Decision copied directly from AFX_Gulp/scripts/stamp-version.js lines 85-89:
# "Touch ONLY ExtensionBundleVersion + the <Extension> element's Version,
#  never the schema/Host/Runtime Version attributes."
$ManifestPath = Join-Path $DistStage 'CSXS\manifest.xml'
if (-not (Test-Path -LiteralPath $ManifestPath)) {
    throw "CSXS manifest missing at '$ManifestPath'."
}

$ManifestContent = Get-Content -LiteralPath $ManifestPath -Raw

if ($ManifestContent -notmatch '\bExtensionBundleVersion="[^"]*"') {
    throw "Failed to locate ExtensionBundleVersion attribute in '$ManifestPath'."
}
if ($ManifestContent -notmatch '<Extension\b[^>]*?\bVersion="[^"]*"') {
    throw "Failed to locate <Extension ... Version=...> elements in '$ManifestPath'."
}

# Replace ExtensionBundleVersion="<old>" with ExtensionBundleVersion="<NumericVersion>"
$UpdatedManifest = [regex]::Replace(
    $ManifestContent,
    '(\bExtensionBundleVersion=")[^"]*(")',
    "`${1}$NumericVersion`${2}"
)

# Replace every Extension Version attribute: <Extension Id="..." Version="<old>">
# Handles both single and multi-extension manifests (Slice 2 service + panel)
$UpdatedManifest = [regex]::Replace(
    $UpdatedManifest,
    '(<Extension\b[^>]*?\bVersion=")[^"]*(")',
    "`${1}$NumericVersion`${2}"
)

[System.IO.File]::WriteAllText($ManifestPath, $UpdatedManifest, [System.Text.UTF8Encoding]::new($false))
Write-Host "✓ Stamped version '$NumericVersion' into $ManifestPath" -ForegroundColor Green

# ── 6. Sign Extension with ZXPSignCmd ─────────────────────────────────────────
$OutZxp = Join-Path $DistDir "chroma-ae-mcp-$Version.zxp"
if (Test-Path -LiteralPath $OutZxp) {
    Remove-Item -LiteralPath $OutZxp -Force
}

# Timestamp server decision:
# AFX_Gulp/scripts/build-dist.ps1 line 324 and AFX_Gulp/scripts/build-dist.sh line 385 invoke:
#   ZXPSignCmd -sign <dir> <output.zxp> <cert.p12> <password>
# Neither passes a timestamp server argument (-tsa) because self-signed CEP certificates
# do not rely on a TSA. We mirror Gulp and omit -tsa by default, but allow CHROMA_ZXP_TSA if set.
$SignArgs = @('-sign', $DistStage, $OutZxp, $ZxpCert, $CertPassword)
if (-not [string]::IsNullOrWhiteSpace($env:CHROMA_ZXP_TSA)) {
    $SignArgs += @('-tsa', $env:CHROMA_ZXP_TSA)
    Write-Host "  Using timestamp server: $($env:CHROMA_ZXP_TSA)" -ForegroundColor DarkGray
}

Write-Host "> Signing .zxp..." -ForegroundColor Yellow
$signResult = Invoke-ChildTool -FilePath $ZxpSignCmd -ArgumentList $SignArgs -IgnoreExitCode

# Error check mirroring AFX_Gulp/scripts/build-dist.ps1 lines 325-329
if ($signResult.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $OutZxp)) {
    $errOut = ($signResult.StdOut + "`n" + $signResult.StdErr).Trim()
    throw ("ZXPSignCmd signing failed (exit $($signResult.ExitCode)):`n$errOut`n" +
           "If it reported 'Failed to parse certificate', check that CHROMA_ZXP_CERT_PASSWORD matches the " +
           "ZXP signing certificate and not an unrelated certificate.")
}
Write-Host "✓ Signed: $OutZxp" -ForegroundColor Green

# ── 7. Verify Signature ───────────────────────────────────────────────────────
# Verification decision from Obsidian vault "Notes/After Effects/Gulp build & install pipeline.md" line 68:
#   Verify: ZXPSignCmd -verify out.zxp -certInfo
Write-Host "> Verifying signature and certificate info..." -ForegroundColor Yellow
$VerifyArgs = @('-verify', $OutZxp, '-certInfo')
$verifyResult = Invoke-ChildTool -FilePath $ZxpSignCmd -ArgumentList $VerifyArgs -IgnoreExitCode

if ($verifyResult.ExitCode -ne 0) {
    $errOut = ($verifyResult.StdOut + "`n" + $verifyResult.StdErr).Trim()
    throw "ZXPSignCmd verification failed (exit $($verifyResult.ExitCode)):`n$errOut"
}

Write-Host $verifyResult.StdOut.Trim() -ForegroundColor Cyan
Write-Host "✓ Signature verification passed" -ForegroundColor Green

# ── 8. Compute and Print SHA256 ───────────────────────────────────────────────
# Mirrors AFX_Gulp/scripts/build-dist.ps1 lines 282-288 and AFX-VoxMark/build/sign.ps1 line 201
$FileHash = (Get-FileHash -LiteralPath $OutZxp -Algorithm SHA256).Hash.ToLowerInvariant()
$SizeMB   = [math]::Round((Get-Item -LiteralPath $OutZxp).Length / 1MB, 2)

Write-Host ""
Write-Host "=================================================" -ForegroundColor Green
Write-Host "Package complete: $OutZxp ($SizeMB MB)" -ForegroundColor Green
Write-Host "SHA256: $FileHash" -ForegroundColor Yellow
Write-Host "=================================================" -ForegroundColor Green
