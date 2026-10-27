param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("list", "respond")]
    [string]$Mode,

    [int]$AePid = 0,

    [string]$ScreenshotDir = "",

    [long]$Handle = 0,

    [string]$Button = "",

    [string]$Check = ""
)

$ErrorActionPreference = "Stop"

function Write-JsonOut([hashtable]$Obj) {
    $json = $Obj | ConvertTo-Json -Compress -Depth 10
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
                    $fileName = "dialog_${hwndVal}_$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).png"
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

                $dialogs += @{
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
            Write-JsonOut @{ ok = $false; error = "button_not_found" }
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
