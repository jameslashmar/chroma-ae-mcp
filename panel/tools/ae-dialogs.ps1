param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("list", "respond", "screenshot-main")]
    [string]$Mode,

    [int]$AePid = 0,

    [string]$ScreenshotDir = "",

    [string]$OutDir = "",

    [long]$Handle = 0,

    [string]$Button = "",

    [string]$Check = "",

    # respond: the key to post to an AE-painted dialog (enter or escape). TypeScript decides it from the
    # button row and the default button; without -Key the old OCR-label decision is used.
    [string]$Key = "",

    # respond with -Key: refuse (dialog_changed) when the dialog's title is no longer this one.
    [string]$ExpectTitle = "",
    [switch]$ExpectEmptyTitle,

    # respond with -Key: refuse (dialog_changed) when the window rect is no longer "left,top,right,bottom".
    [string]$ExpectRect = ""
)

$ErrorActionPreference = "Stop"

function Write-JsonOut([hashtable]$Obj) {
    $json = $Obj | ConvertTo-Json -Compress -Depth 10
    # Escape everything outside ASCII: stdout may be a legacy code page (ibm850), which would corrupt it.
    $json = [regex]::Replace($json, '[^\x00-\x7F]', [System.Text.RegularExpressions.MatchEvaluator]{ param($m) '\u{0:x4}' -f [int][char]$m.Value })
    [Console]::Out.WriteLine($json)
}

try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type -AssemblyName System.Drawing

    $win32Source = @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class ChromaWin32 {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindowEnabled(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);

    public const uint GW_OWNER = 4;
    public const uint PW_RENDERFULLCONTENT = 2;

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    public static List<IntPtr> GetProcessTopWindows(int targetPid) {
        List<IntPtr> result = new List<IntPtr>();
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            uint pid = 0;
            GetWindowThreadProcessId(hWnd, out pid);
            if ((int)pid == targetPid) {
                result.Add(hWnd);
                return true;
            }
            IntPtr owner = GetWindow(hWnd, GW_OWNER);
            if (owner != IntPtr.Zero) {
                uint ownerPid = 0;
                GetWindowThreadProcessId(owner, out ownerPid);
                if ((int)ownerPid == targetPid) {
                    result.Add(hWnd);
                }
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    public static bool CaptureWindowPng(IntPtr hWnd, int x, int y, int width, int height, string filePath) {
        if (width <= 0 || height <= 0) {
            RECT r;
            if (GetWindowRect(hWnd, out r)) {
                x = r.Left;
                y = r.Top;
                width = r.Right - r.Left;
                height = r.Bottom - r.Top;
            }
        }
        if (width <= 0 || height <= 0) return false;

        using (Bitmap bmp = new Bitmap(width, height, PixelFormat.Format32bppArgb)) {
            bool printed = false;
            using (Graphics g = Graphics.FromImage(bmp)) {
                IntPtr hdc = g.GetHdc();
                try {
                    printed = PrintWindow(hWnd, hdc, PW_RENDERFULLCONTENT);
                    if (!printed) {
                        printed = PrintWindow(hWnd, hdc, 0);
                    }
                } finally {
                    g.ReleaseHdc(hdc);
                }

                if (!printed) {
                    try {
                        g.CopyFromScreen(x, y, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
                        printed = true;
                    } catch {
                        printed = false;
                    }
                }
            }
            if (!printed) return false;
            bmp.Save(filePath, ImageFormat.Png);
            return true;
        }
    }
}
"@

    if (-not ("ChromaWin32" -as [type])) {
        Add-Type -TypeDefinition $win32Source -ReferencedAssemblies "System.Drawing"
    }


# ---------- OCR fallback ----------
# AE paints many dialogs itself, so UIA and Win32 see no text and no buttons in them. Measured
# 2026-10-27 on AE 26.0: a "Script Alert" (#32770) and an AE colour-profile warning both exposed no
# child controls. Windows.Media.Ocr (Windows PowerShell 5.1) reads a 3x-upscaled screenshot instead.
$script:OcrReady = $false
function Initialize-Ocr {
    if ($script:OcrReady) { return $true }
    try {
        Add-Type -AssemblyName System.Runtime.WindowsRuntime
        $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
        $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
        $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
        $script:AsTaskOp = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
            $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        })[0]
        $script:OcrReady = $true
    } catch { $script:OcrReady = $false }
    return $script:OcrReady
}
function Wait-WinRt($op, [Type]$t) {
    $task = $script:AsTaskOp.MakeGenericMethod($t).Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    return $task.Result
}
# Returns @{ lines = @(@{ text; words = @(@{ text; x; y; w; h }) }) } in the ORIGINAL image's pixels.
function Invoke-DialogOcr([string]$PngPath, [int]$Scale = 3) {
    if (-not (Initialize-Ocr)) { return $null }
    $tmp = [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName($PngPath), "_ocr_" + [Guid]::NewGuid().ToString("N") + ".png")
    try {
        $src = [System.Drawing.Image]::FromFile($PngPath)
        try {
            $big = New-Object System.Drawing.Bitmap ($src.Width * $Scale), ($src.Height * $Scale)
            $g = [System.Drawing.Graphics]::FromImage($big)
            $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $g.DrawImage($src, 0, 0, $big.Width, $big.Height)
            $g.Dispose()
            $big.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
            $big.Dispose()
        } finally { $src.Dispose() }
        $file = Wait-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tmp)) ([Windows.Storage.StorageFile])
        $stream = Wait-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
        $dec = Wait-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bmp = Wait-WinRt ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
        $res = Wait-WinRt ($eng.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
        $stream.Dispose()
        $lines = @()
        foreach ($ln in $res.Lines) {
            $words = @()
            foreach ($w in $ln.Words) {
                $words += @{ text = [string]$w.Text; x = [int]($w.BoundingRect.X / $Scale); y = [int]($w.BoundingRect.Y / $Scale); w = [int]($w.BoundingRect.Width / $Scale); h = [int]($w.BoundingRect.Height / $Scale) }
            }
            $lines += @{ text = [string]$ln.Text; words = $words }
        }
        return @{ lines = $lines }
    } catch {
        return $null
    } finally {
        Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue
    }
}
    if ($Mode -eq "list") {
        $targetPids = @()
        if ($AePid -gt 0) {
            $targetPids = @($AePid)
        } else {
            $procs = @(Get-Process -Name "AfterFX" -ErrorAction SilentlyContinue)
            foreach ($p in $procs) {
                $targetPids += [int]$p.Id
            }
        }

        if ($targetPids.Count -eq 0) {
            Write-JsonOut @{
                ok      = $true
                ae_pid  = $null
                dialogs = @()
            }
            exit 0
        }

        $seenHandles = New-Object 'System.Collections.Generic.HashSet[long]'
        $candidateElements = New-Object 'System.Collections.Generic.List[System.Windows.Automation.AutomationElement]'

        foreach ($tPid in $targetPids) {
            $hwnds = [ChromaWin32]::GetProcessTopWindows($tPid)
            foreach ($h in $hwnds) {
                $hLong = $h.ToInt64()
                if ($hLong -ne 0 -and $seenHandles.Add($hLong)) {
                    try {
                        $el = [System.Windows.Automation.AutomationElement]::FromHandle($h)
                        if ($null -ne $el) {
                            $candidateElements.Add($el)
                        }
                    } catch {
                        # Ignore windows that vanished mid-enumeration
                    }
                }
            }

            try {
                $pidCond = New-Object System.Windows.Automation.PropertyCondition(
                    [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
                    [int]$tPid
                )
                $rootChildren = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
                    [System.Windows.Automation.TreeScope]::Children,
                    $pidCond
                )
                if ($null -ne $rootChildren) {
                    for ($i = 0; $i -lt $rootChildren.Count; $i++) {
                        $rc = $rootChildren[$i]
                        try {
                            $rcHandle = [long]$rc.Current.NativeWindowHandle
                            if ($rcHandle -ne 0 -and $seenHandles.Add($rcHandle)) {
                                $candidateElements.Add($rc)
                            }
                        } catch {}
                    }
                }
            } catch {}
        }

        $allWindows = New-Object 'System.Collections.Generic.List[System.Windows.Automation.AutomationElement]'
        $winCond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Window
        )

        foreach ($topEl in $candidateElements) {
            $allWindows.Add($topEl)
            try {
                $descWindows = $topEl.FindAll([System.Windows.Automation.TreeScope]::Descendants, $winCond)
                if ($null -ne $descWindows) {
                    for ($i = 0; $i -lt $descWindows.Count; $i++) {
                        $dw = $descWindows[$i]
                        try {
                            $dwHandle = [long]$dw.Current.NativeWindowHandle
                            if ($dwHandle -ne 0 -and $seenHandles.Add($dwHandle)) {
                                $allWindows.Add($dw)
                            }
                        } catch {}
                    }
                }
            } catch {}
        }

        if ($ScreenshotDir -ne "") {
            if (-not (Test-Path -LiteralPath $ScreenshotDir)) {
                New-Item -ItemType Directory -Path $ScreenshotDir -Force | Out-Null
            }
            # Our own dialog screenshots older than 7 days (the old per-call names included).
            try {
                $cutoff = (Get-Date).AddDays(-7)
                Get-ChildItem -LiteralPath $ScreenshotDir -Filter "dialog_*.png" -File -ErrorAction SilentlyContinue |
                    Where-Object { $_.LastWriteTime -lt $cutoff } |
                    Remove-Item -Force -ErrorAction SilentlyContinue
            } catch {}
        }

        $dialogs = @()
        foreach ($win in $allWindows) {
            try {
                $curr = $win.Current
                $hwndVal = [long]$curr.NativeWindowHandle
                if ($hwndVal -eq 0) { continue }
                if (-not [ChromaWin32]::IsWindowVisible([IntPtr]$hwndVal)) { continue }

                $cls = [string]$curr.ClassName
                $title = [string]$curr.Name
                $isMain = $cls -like "AE_CApplication_*"

                $isModal = $false
                $wpObj = $null
                if ($win.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$wpObj)) {
                    try {
                        $isModal = [bool]$wpObj.Current.IsModal
                    } catch {
                        $isModal = $false
                    }
                }

                # A popup is a modal window or a standard Windows dialog (#32770).
                # Any other window of AE counts only if it has a title and at least
                # one button: AE's floating panel frames ("DroverLord - Window Class")
                # are visible, untitled, button-less windows and are never popups.
                # AE's panel frames report IsModal while a popup is up; they are never popups.
                if ($cls -like "DroverLord*") { continue }
                $isDialog = $isModal -or ($cls -eq "#32770")
                if ($isMain -and (-not $isModal)) {
                    $isDialog = $false
                }
                if ((-not $isDialog) -and (-not $isMain) -and ($cls -notlike "DroverLord*") -and (-not [string]::IsNullOrWhiteSpace($title))) {
                    $btnCond = New-Object System.Windows.Automation.PropertyCondition(
                        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                        [System.Windows.Automation.ControlType]::Button
                    )
                    if ($null -ne $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $btnCond)) {
                        $isDialog = $true
                    }
                }
                if (-not $isDialog) { continue }

                $rect = $curr.BoundingRectangle
                $bx = 0; $by = 0; $bw = 0; $bh = 0
                if (-not [double]::IsInfinity($rect.Width) -and -not [double]::IsNaN($rect.Width)) {
                    $bx = [int][Math]::Round($rect.Left)
                    $by = [int][Math]::Round($rect.Top)
                    $bw = [int][Math]::Round($rect.Width)
                    $bh = [int][Math]::Round($rect.Height)
                }
                if ($bw -le 0 -or $bh -le 0) { continue }

                # Collect text content from Text and Edit controls
                $textCond = New-Object System.Windows.Automation.OrCondition(
                    (New-Object System.Windows.Automation.PropertyCondition(
                        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                        [System.Windows.Automation.ControlType]::Text
                    )),
                    (New-Object System.Windows.Automation.PropertyCondition(
                        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                        [System.Windows.Automation.ControlType]::Edit
                    )),
                    (New-Object System.Windows.Automation.PropertyCondition(
                        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                        [System.Windows.Automation.ControlType]::Document
                    ))
                )
                $textLines = New-Object 'System.Collections.Generic.List[string]'
                $textEls = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $textCond)
                if ($null -ne $textEls) {
                    for ($i = 0; $i -lt $textEls.Count; $i++) {
                        $te = $textEls[$i]
                        try {
                            $tName = [string]$te.Current.Name
                            if (-not [string]::IsNullOrWhiteSpace($tName)) {
                                if ($textLines.Count -eq 0 -or $textLines[$textLines.Count - 1] -ne $tName) {
                                    $textLines.Add($tName)
                                }
                            }
                            $vpObj = $null
                            if ($te.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vpObj)) {
                                $tVal = [string]$vpObj.Current.Value
                                if (-not [string]::IsNullOrWhiteSpace($tVal) -and $tVal -ne $tName) {
                                    if ($textLines.Count -eq 0 -or $textLines[$textLines.Count - 1] -ne $tVal) {
                                        $textLines.Add($tVal)
                                    }
                                }
                            }
                        } catch {}
                    }
                }
                $joinedText = ($textLines -join "`n")
                if ($joinedText.Length -gt 4000) {
                    $joinedText = $joinedText.Substring(0, 4000)
                }

                # Collect buttons
                $btnCond = New-Object System.Windows.Automation.PropertyCondition(
                    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                    [System.Windows.Automation.ControlType]::Button
                )
                $buttons = @()
                $btnEls = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
                if ($null -ne $btnEls) {
                    for ($i = 0; $i -lt $btnEls.Count; $i++) {
                        $be = $btnEls[$i]
                        try {
                            $buttons += @{
                                name         = [string]$be.Current.Name
                                automationId = [string]$be.Current.AutomationId
                                enabled      = [bool]$be.Current.IsEnabled
                            }
                        } catch {}
                    }
                }

                # Collect checkboxes
                $chkCond = New-Object System.Windows.Automation.PropertyCondition(
                    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                    [System.Windows.Automation.ControlType]::CheckBox
                )
                $checkboxes = @()
                $chkEls = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $chkCond)
                if ($null -ne $chkEls) {
                    for ($i = 0; $i -lt $chkEls.Count; $i++) {
                        $ce = $chkEls[$i]
                        try {
                            $isChecked = $false
                            $tpObj = $null
                            if ($ce.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$tpObj)) {
                                $isChecked = ($tpObj.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On)
                            }
                            $checkboxes += @{
                                name    = [string]$ce.Current.Name
                                checked = [bool]$isChecked
                            }
                        } catch {}
                    }
                }

                $screenshotPath = $null
                if ($ScreenshotDir -ne "") {
                    # One file per dialog handle, overwritten on every list (it used to be one file per call).
                    $fileName = "dialog_${hwndVal}.png"
                    $candPath = Join-Path $ScreenshotDir $fileName
                    try {
                        $saved = [ChromaWin32]::CaptureWindowPng([IntPtr]$hwndVal, $bx, $by, $bw, $bh, $candPath)
                        if ($saved -and (Test-Path -LiteralPath $candPath)) {
                            $screenshotPath = $candPath
                        }
                    } catch {
                        $screenshotPath = $null
                    }
                }

                # UIA saw nothing (AE painted the dialog itself): fall back to OCR of a screenshot.
                # The words and their boxes go to TypeScript (dialog-geometry.ts), which finds the button row
                # and the default button; the screenshot stays available for that (screenshot, or analysis_png
                # when no screenshot directory was given: TypeScript deletes that one after reading it).
                $textSource = "uia"
                $ocrLines = $null
                $analysisPng = $null
                if ([string]::IsNullOrWhiteSpace($joinedText) -or $buttons.Count -eq 0) {
                    $ocrPng = $screenshotPath
                    $ocrTemp = $false
                    if (-not $ocrPng) {
                        $ocrPng = Join-Path ([System.IO.Path]::GetTempPath()) ("chroma_dlg_" + [Guid]::NewGuid().ToString("N") + ".png")
                        $ocrTemp = [ChromaWin32]::CaptureWindowPng([IntPtr]$hwndVal, $bx, $by, $bw, $bh, $ocrPng)
                    }
                    if ($ocrPng -and (Test-Path -LiteralPath $ocrPng)) {
                        $ocr = Invoke-DialogOcr $ocrPng
                        if ($null -ne $ocr) {
                            if ([string]::IsNullOrWhiteSpace($joinedText)) {
                                $joinedText = (($ocr.lines | ForEach-Object { $_.text }) -join "`n")
                                if ($joinedText.Length -gt 4000) { $joinedText = $joinedText.Substring(0, 4000) }
                                $textSource = "ocr"
                            }
                            if ($buttons.Count -eq 0) {
                                # Keep the LAST 60 lines: the button row is at the bottom.
                                $ocrLines = @($ocr.lines | Select-Object -Last 60)
                                if ($ocrTemp) { $analysisPng = $ocrPng; $ocrTemp = $false }
                            }
                        }
                    }
                    if ($ocrTemp) { Remove-Item -LiteralPath $ocrPng -ErrorAction SilentlyContinue }
                }

                $winRect = ""
                try {
                    $wr = New-Object ChromaWin32+RECT
                    if ([ChromaWin32]::GetWindowRect([IntPtr]$hwndVal, [ref]$wr)) { $winRect = "$($wr.Left),$($wr.Top),$($wr.Right),$($wr.Bottom)" }
                } catch {}
                $dialogs += @{
                    win_rect     = $winRect
                    text_source  = $textSource
                    handle       = $hwndVal
                    title        = $title
                    class        = $cls
                    isModal      = $isModal
                    text         = $joinedText
                    buttons      = $buttons
                    checkboxes   = $checkboxes
                    boundingRect = @{
                        x      = $bx
                        y      = $by
                        width  = $bw
                        height = $bh
                    }
                    screenshot   = $screenshotPath
                    ocr_lines    = $ocrLines
                    analysis_png = $analysisPng
                }
            } catch {
                # Skip dialog if it disappeared while reading properties
            }
        }

        Write-JsonOut @{
            ok      = $true
            ae_pid  = $targetPids[0]
            dialogs = $dialogs
        }
        exit 0
    }

    if ($Mode -eq "respond") {
    Add-Type @"
using System; using System.Runtime.InteropServices;
public class ChromaPost {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref POINT p);
  public static bool Key(IntPtr h, int vk) {
    PostMessage(h, 0x0100, (IntPtr)vk, (IntPtr)0x00000001);
    return PostMessage(h, 0x0101, (IntPtr)vk, unchecked((IntPtr)0xC0000001));
  }
}
"@

        if ($Handle -le 0) {
            Write-JsonOut @{ ok = $false; error = "dialog_gone" }
            exit 0
        }
        if ([string]::IsNullOrWhiteSpace($Button)) {
            Write-JsonOut @{ ok = $false; error = "missing_button_name" }
            exit 0
        }

        $hwndPtr = [IntPtr]$Handle
        if ((-not [ChromaWin32]::IsWindow($hwndPtr)) -or (-not [ChromaWin32]::IsWindowVisible($hwndPtr))) {
            Write-JsonOut @{ ok = $false; error = "dialog_gone" }
            exit 0
        }

        if (-not [string]::IsNullOrWhiteSpace($Key)) {
            # -Key: TypeScript has read the dialog (screenshot, OCR, button row, default button) moments ago
            # and decided which key answers it: Enter presses the default button, Escape answers Cancel/No.
            # Posted to the dialog's own window, so AE is not brought to the front and no focus changes.
            # This is the ONLY place a key is posted. Every guard runs before it and none touches the UI
            # Automation tree of the window.
            #
            # NOT BUILT, on purpose: a focus-taking fallback (AppActivate + SendKeys Enter). Posted Enter was
            # measured on AE 26.0 (2026-10-27) on the one-OK font dialog and on the Save dialog; whether it
            # also closes the tall "is missing N frames" warning is not yet measured live. Build the fallback
            # only if that live test shows posted Enter fails, and then guard it: dialog valid and AfterFX's,
            # title unchanged, target is the default button, no user input for 1.5 s (GetLastInputInfo),
            # foreground re-checked right before the key, one Enter and no other key, previous foreground
            # window restored. Until then a dialog that does not close is reported closed:false.
            $keyName = $Key.Trim().ToLowerInvariant()
            if ($keyName -ne "enter" -and $keyName -ne "escape") {
                Write-JsonOut @{ ok = $false; error = "bad_key" }
                exit 0
            }
            if (-not [string]::IsNullOrWhiteSpace($Check)) {
                Write-JsonOut @{ ok = $false; error = "checkbox_not_found"; detail = "a painted dialog has no checkbox that can be toggled" }
                exit 0
            }
            # The window must still be an enabled AE window, with the rect and title TypeScript saw.
            [uint32]$ownerPid = 0
            $null = [ChromaWin32]::GetWindowThreadProcessId($hwndPtr, [ref]$ownerPid)
            $ownerProc = Get-Process -Id ([int]$ownerPid) -ErrorAction SilentlyContinue
            if ($null -eq $ownerProc -or $ownerProc.ProcessName -ne "AfterFX") {
                Write-JsonOut @{ ok = $false; error = "dialog_changed"; detail = "the window is not an After Effects window" }
                exit 0
            }
            if (-not [ChromaWin32]::IsWindowEnabled($hwndPtr)) {
                Write-JsonOut @{ ok = $false; error = "dialog_not_enabled"; detail = "another window is modal above this one" }
                exit 0
            }
            if ($ExpectRect -ne "") {
                $nr = New-Object ChromaWin32+RECT
                $nowRect = ""
                if ([ChromaWin32]::GetWindowRect($hwndPtr, [ref]$nr)) { $nowRect = "$($nr.Left),$($nr.Top),$($nr.Right),$($nr.Bottom)" }
                if ($nowRect -ne $ExpectRect) {
                    Write-JsonOut @{ ok = $false; error = "dialog_changed"; detail = "the window moved or was resized" }
                    exit 0
                }
            }
            $nowTitle = ""
            try { $nowTitle = [string][System.Windows.Automation.AutomationElement]::FromHandle($hwndPtr).Current.Name } catch { $nowTitle = "" }
            if ($ExpectEmptyTitle) {
                if ($nowTitle -ne "") {
                    Write-JsonOut @{ ok = $false; error = "dialog_changed"; detail = "the window has a title now" }
                    exit 0
                }
            } elseif ($ExpectTitle -ne "") {
                if ($nowTitle -ne $ExpectTitle) {
                    Write-JsonOut @{ ok = $false; error = "dialog_changed"; detail = "the window title is different now" }
                    exit 0
                }
            } else {
                Write-JsonOut @{ ok = $false; error = "dialog_changed"; detail = "no expected title was given" }
                exit 0
            }
            if ($keyName -eq "enter") {
                $null = [ChromaPost]::Key($hwndPtr, 0x0D)
                $method = "post_enter"
            } else {
                $null = [ChromaPost]::Key($hwndPtr, 0x1B)
                $method = "post_escape"
            }
            $closed = $false
            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            while ($sw.ElapsedMilliseconds -lt 3000) {
                if ((-not [ChromaWin32]::IsWindow($hwndPtr)) -or (-not [ChromaWin32]::IsWindowVisible($hwndPtr))) { $closed = $true; break }
                Start-Sleep -Milliseconds 100
            }
            Write-JsonOut @{ ok = $true; handle = $Handle; pressed = $Button; method = $method; closed = $closed }
            exit 0
        }

        $dlgEl = $null
        try {
            $dlgEl = [System.Windows.Automation.AutomationElement]::FromHandle($hwndPtr)
        } catch {
            $dlgEl = $null
        }
        if ($null -eq $dlgEl) {
            Write-JsonOut @{ ok = $false; error = "dialog_gone" }
            exit 0
        }
        # Same guard as the -Key path: a window that another modal window sits above cannot take a click.
        if (-not [ChromaWin32]::IsWindowEnabled($hwndPtr)) {
            Write-JsonOut @{ ok = $false; error = "dialog_not_enabled"; detail = "another window is modal above this one" }
            exit 0
        }

        $checkedName = $null
        if (-not [string]::IsNullOrWhiteSpace($Check)) {
            $chkCond = New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                [System.Windows.Automation.ControlType]::CheckBox
            )
            $chkEls = $dlgEl.FindAll([System.Windows.Automation.TreeScope]::Descendants, $chkCond)
            $targetChk = $null
            if ($null -ne $chkEls) {
                for ($i = 0; $i -lt $chkEls.Count; $i++) {
                    $ce = $chkEls[$i]
                    try {
                        $cName = [string]$ce.Current.Name
                        if ($cName -ieq $Check -or $cName.Trim() -ieq $Check.Trim()) {
                            $targetChk = $ce
                            $checkedName = $cName
                            break
                        }
                    } catch {}
                }
            }
            if ($null -eq $targetChk) {
                Write-JsonOut @{ ok = $false; error = "checkbox_not_found" }
                exit 0
            }
            $tpObj = $null
            if ($targetChk.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$tpObj)) {
                if ($tpObj.Current.ToggleState -ne [System.Windows.Automation.ToggleState]::On) {
                    $tpObj.Toggle()
                }
            } else {
                Write-JsonOut @{ ok = $false; error = "checkbox_toggle_unsupported" }
                exit 0
            }
        }

        $btnCond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Button
        )
        $btnEls = $dlgEl.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
        $targetBtn = $null
        $matchedBtnName = $null
        if ($null -ne $btnEls) {
            for ($i = 0; $i -lt $btnEls.Count; $i++) {
                $be = $btnEls[$i]
                try {
                    $bName = [string]$be.Current.Name
                    if ($bName -ieq $Button) {
                        $targetBtn = $be
                        $matchedBtnName = $bName
                        break
                    }
                } catch {}
            }
        }

        if ($null -eq $targetBtn) {
            # No UIA button: AE painted this dialog itself. Only a -Key call (every guard checked above) may post
            # a key to it; without -Key nothing is sent. (The old OCR decision lived here and is gone.)
            Write-JsonOut @{ ok = $false; error = "button_not_answerable"; hint = "No UI Automation button with that name. An AE-painted dialog is answered through ae_dialogs and ae_dialog_respond, which read it first and post Enter or Escape." }
            exit 0
        }

        if (-not [bool]$targetBtn.Current.IsEnabled) {
            Write-JsonOut @{ ok = $false; error = "button_disabled" }
            exit 0
        }

        $invObj = $null
        if (-not $targetBtn.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invObj)) {
            Write-JsonOut @{ ok = $false; error = "button_invoke_unsupported" }
            exit 0
        }

        $invObj.Invoke()

        $closed = $false
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        while ($sw.ElapsedMilliseconds -lt 3000) {
            if ((-not [ChromaWin32]::IsWindow($hwndPtr)) -or (-not [ChromaWin32]::IsWindowVisible($hwndPtr))) {
                $closed = $true
                break
            }
            Start-Sleep -Milliseconds 100
        }
        if (-not $closed) {
            if ((-not [ChromaWin32]::IsWindow($hwndPtr)) -or (-not [ChromaWin32]::IsWindowVisible($hwndPtr))) {
                $closed = $true
            }
        }

        Write-JsonOut @{
            ok      = $true
            handle  = $Handle
            pressed = $matchedBtnName
            checked = $checkedName
            closed  = $closed
        }
        exit 0
    }

    if ($Mode -eq "screenshot-main") {
        $targetPids = @()
        if ($AePid -gt 0) {
            $targetPids = @($AePid)
        } else {
            $procs = @(Get-Process -Name "AfterFX" -ErrorAction SilentlyContinue)
            foreach ($p in $procs) {
                $targetPids += [int]$p.Id
            }
        }

        if ($targetPids.Count -eq 0) {
            Write-JsonOut @{
                ok    = $false
                error = "ae_not_running"
            }
            exit 0
        }

        $targetDir = $OutDir
        if ([string]::IsNullOrWhiteSpace($targetDir)) {
            $targetDir = $ScreenshotDir
        }
        if ([string]::IsNullOrWhiteSpace($targetDir)) {
            $localApp = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
            $targetDir = Join-Path $localApp "chroma-ae-mcp\ui"
        }

        if (-not (Test-Path -LiteralPath $targetDir)) {
            New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
        }

        $mainHwnd = [IntPtr]::Zero
        $mainRect = $null

        foreach ($tPid in $targetPids) {
            $hwnds = [ChromaWin32]::GetProcessTopWindows($tPid)
            foreach ($h in $hwnds) {
                if ($h -eq [IntPtr]::Zero) { continue }
                if (-not [ChromaWin32]::IsWindowVisible($h)) { continue }
                try {
                    $el = [System.Windows.Automation.AutomationElement]::FromHandle($h)
                    if ($null -ne $el) {
                        $cls = [string]$el.Current.ClassName
                        if ($cls -like "AE_CApplication_*") {
                            $mainHwnd = $h
                            $mainRect = $el.Current.BoundingRectangle
                            break
                        }
                    }
                } catch {}
            }
            if ($mainHwnd -ne [IntPtr]::Zero) { break }

            try {
                $pidCond = New-Object System.Windows.Automation.PropertyCondition(
                    [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
                    [int]$tPid
                )
                $rootChildren = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
                    [System.Windows.Automation.TreeScope]::Children,
                    $pidCond
                )
                if ($null -ne $rootChildren) {
                    for ($i = 0; $i -lt $rootChildren.Count; $i++) {
                        $rc = $rootChildren[$i]
                        try {
                            $cls = [string]$rc.Current.ClassName
                            if ($cls -like "AE_CApplication_*") {
                                $rcHandle = [long]$rc.Current.NativeWindowHandle
                                $hPtr = [IntPtr]$rcHandle
                                if ($hPtr -ne [IntPtr]::Zero -and [ChromaWin32]::IsWindowVisible($hPtr)) {
                                    $mainHwnd = $hPtr
                                    $mainRect = $rc.Current.BoundingRectangle
                                    break
                                }
                            }
                        } catch {}
                    }
                }
            } catch {}
            if ($mainHwnd -ne [IntPtr]::Zero) { break }
        }

        if ($mainHwnd -eq [IntPtr]::Zero) {
            Write-JsonOut @{
                ok    = $false
                error = "ae_main_window_not_found"
            }
            exit 0
        }

        # A minimized window only paints a title-bar stub (measured: 199x34 on AE 26.2.1).
        if ([ChromaWin32]::IsIconic($mainHwnd)) {
            Write-JsonOut @{
                ok    = $false
                error = "ae_minimized"
            }
            exit 0
        }

        $bx = 0; $by = 0; $bw = 0; $bh = 0
        if ($null -ne $mainRect -and (-not [double]::IsInfinity($mainRect.Width)) -and (-not [double]::IsNaN($mainRect.Width))) {
            $bx = [int][Math]::Round($mainRect.Left)
            $by = [int][Math]::Round($mainRect.Top)
            $bw = [int][Math]::Round($mainRect.Width)
            $bh = [int][Math]::Round($mainRect.Height)
        }
        if ($bw -le 0 -or $bh -le 0) {
            $r = New-Object ChromaWin32+RECT
            if ([ChromaWin32]::GetWindowRect($mainHwnd, [ref]$r)) {
                $bx = $r.Left
                $by = $r.Top
                $bw = $r.Right - $r.Left
                $bh = $r.Bottom - $r.Top
            }
        }

        if ($bw -le 0 -or $bh -le 0) {
            Write-JsonOut @{
                ok    = $false
                error = "invalid_window_dimensions"
            }
            exit 0
        }

        $fileName = "ae_main_$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).png"
        $filePath = Join-Path $targetDir $fileName

        $saved = [ChromaWin32]::CaptureWindowPng($mainHwnd, $bx, $by, $bw, $bh, $filePath)
        if ($saved -and (Test-Path -LiteralPath $filePath)) {
            Write-JsonOut @{
                ok     = $true
                path   = $filePath
                width  = $bw
                height = $bh
                handle = $mainHwnd.ToInt64()
            }
            exit 0
        } else {
            Write-JsonOut @{
                ok    = $false
                error = "screenshot_capture_failed"
            }
            exit 0
        }
    }
} catch {
    $errMsg = $_.Exception.Message
    if ([string]::IsNullOrWhiteSpace($errMsg)) {
        $errMsg = "unknown_powershell_error"
    }
    Write-JsonOut @{
        ok    = $false
        error = $errMsg
    }
    exit 0
}
