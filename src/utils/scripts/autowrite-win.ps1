param(
    [string]$TextFile,
    [int]$DelayMs = 80,
    [int]$JitterMs = 20,
    [int]$StartDelayMs = 500,
    [string]$Mode = "type",
    [int]$ParentPid = 0
)

# Wait initial delay before typing to allow user to focus target window/editor
if ($StartDelayMs -gt 0) {
    Start-Sleep -Milliseconds $StartDelayMs
}

if (-not $TextFile -or -not (Test-Path $TextFile)) {
    Write-Error "Text file not found: $TextFile"
    exit 1
}

$text = ""
if ($TextFile -and (Test-Path $TextFile)) {
    $text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
}

if ([string]::IsNullOrEmpty($text)) {
    Write-Output "PROGRESS:100"
    Write-Output "DONE"
    exit 0
}

# Win32 SendInput implementation with 64-bit (40 bytes) & 32-bit (28 bytes) struct layout
$csharpSource = @"
using System;
using System.Runtime.InteropServices;

public class WinInputHelper {
    [StructLayout(LayoutKind.Explicit, Size = 40)]
    public struct INPUT64 {
        [FieldOffset(0)] public uint type;
        [FieldOffset(8)] public ushort wVk;
        [FieldOffset(10)] public ushort wScan;
        [FieldOffset(12)] public uint dwFlags;
        [FieldOffset(16)] public uint time;
        [FieldOffset(24)] public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit, Size = 28)]
    public struct INPUT32 {
        [FieldOffset(0)] public uint type;
        [FieldOffset(4)] public ushort wVk;
        [FieldOffset(6)] public ushort wScan;
        [FieldOffset(8)] public uint dwFlags;
        [FieldOffset(12)] public uint time;
        [FieldOffset(16)] public IntPtr dwExtraInfo;
    }

    const uint INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;
    const ushort VK_RETURN = 0x0D;
    const ushort VK_CONTROL = 0x11;
    const ushort VK_V = 0x56;

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, [MarshalAs(UnmanagedType.LPArray)] INPUT64[] pInputs, int cbSize);

    [DllImport("user32.dll", SetLastError = true, EntryPoint = "SendInput")]
    static extern uint SendInput32(uint nInputs, [MarshalAs(UnmanagedType.LPArray)] INPUT32[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);

    [DllImport("kernel32.dll")]
    public static extern IntPtr OpenProcess(uint processAccess, bool bInheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr hObject);

    public static bool IsProcessAlive(int pid) {
        if (pid <= 0) return true;
        IntPtr h = OpenProcess(0x0400 /* PROCESS_QUERY_INFORMATION */, false, pid);
        if (h == IntPtr.Zero) return false;
        uint exitCode;
        bool ok = GetExitCodeProcess(h, out exitCode);
        CloseHandle(h);
        return ok && (exitCode == 259 /* STILL_ACTIVE */);
    }

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    public static uint GetForegroundProcessId() {
        IntPtr hWnd = GetForegroundWindow();
        if (hWnd == IntPtr.Zero) return 0;
        uint pid;
        GetWindowThreadProcessId(hWnd, out pid);
        return pid;
    }

    const int VK_ESCAPE = 0x1B;
    const int VK_MENU = 0x12;
    const int VK_D = 0x44;

    public static bool IsCancelPressed() {
        bool esc = (GetAsyncKeyState(VK_ESCAPE) & 0x8000) != 0;
        bool altD = ((GetAsyncKeyState(VK_MENU) & 0x8000) != 0) && ((GetAsyncKeyState(VK_D) & 0x8000) != 0);
        return esc || altD;
    }

    public static bool IsEscapePressed() {
        return IsCancelPressed();
    }

    public static bool Is64Bit = (IntPtr.Size == 8);

    public static bool SendUnicodeChar(char c) {
        if (Is64Bit) {
            INPUT64[] inputs = new INPUT64[2];
            inputs[0].type = INPUT_KEYBOARD;
            inputs[1].type = INPUT_KEYBOARD;

            if (c == '\n') {
                inputs[0].wVk = VK_RETURN;
                inputs[0].dwFlags = 0;
                inputs[1].wVk = VK_RETURN;
                inputs[1].dwFlags = KEYEVENTF_KEYUP;
            } else {
                inputs[0].wScan = (ushort)c;
                inputs[0].dwFlags = KEYEVENTF_UNICODE;
                inputs[1].wScan = (ushort)c;
                inputs[1].dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            }

            uint sent = SendInput(2, inputs, 40);
            return sent == 2;
        } else {
            INPUT32[] inputs = new INPUT32[2];
            inputs[0].type = INPUT_KEYBOARD;
            inputs[1].type = INPUT_KEYBOARD;

            if (c == '\n') {
                inputs[0].wVk = VK_RETURN;
                inputs[0].dwFlags = 0;
                inputs[1].wVk = VK_RETURN;
                inputs[1].dwFlags = KEYEVENTF_KEYUP;
            } else {
                inputs[0].wScan = (ushort)c;
                inputs[0].dwFlags = KEYEVENTF_UNICODE;
                inputs[1].wScan = (ushort)c;
                inputs[1].dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            }

            uint sent = SendInput32(2, inputs, 28);
            return sent == 2;
        }
    }

    public static bool SendVkKey(ushort vk) {
        if (IntPtr.Size == 8) {
            INPUT64[] inputs = new INPUT64[2];
            inputs[0].type = INPUT_KEYBOARD;
            inputs[0].wVk = vk;
            inputs[0].dwFlags = 0;
            inputs[1].type = INPUT_KEYBOARD;
            inputs[1].wVk = vk;
            inputs[1].dwFlags = KEYEVENTF_KEYUP;
            uint sent = SendInput(2, inputs, 40);
            return sent == 2;
        } else {
            INPUT32[] inputs = new INPUT32[2];
            inputs[0].type = INPUT_KEYBOARD;
            inputs[0].wVk = vk;
            inputs[0].dwFlags = 0;
            inputs[1].type = INPUT_KEYBOARD;
            inputs[1].wVk = vk;
            inputs[1].dwFlags = KEYEVENTF_KEYUP;
            uint sent = SendInput32(2, inputs, 28);
            return sent == 2;
        }
    }
}
"@

try {
    Add-Type -TypeDefinition $csharpSource
} catch {}

$wshell = $null
try {
    $wshell = New-Object -ComObject WScript.Shell
} catch {}

function Escape-SendKeysChar([char]$c) {
    switch ($c) {
        '+' { return "{+}" }
        '^' { return "{^}" }
        '%' { return "{%}" }
        '~' { return "{~}" }
        '(' { return "{(}" }
        ')' { return "{)}" }
        '{' { return "{{}" }
        '}' { return "{}}" }
        '[' { return "{[}" }
        ']' { return "{]}" }
        "`n" { return "{ENTER}" }
        default { return [string]$c }
    }
}


# Type mode: Character by character with delay, jitter and automatic WScript fallback
$totalLength = $text.Length
$random = New-Object System.Random
$lastProgress = 0
$useWShellFallback = $false

# If foreground window is still Cheating Daddy overlay/app, give user up to 2.5s to switch to target editor
if ($ParentPid -gt 0) {
    $waited = 0
    while ($waited -lt 2500 -and [WinInputHelper]::GetForegroundProcessId() -eq $ParentPid) {
        if ([WinInputHelper]::IsCancelPressed() -or (-not [WinInputHelper]::IsProcessAlive($ParentPid))) {
            Write-Output "CANCELLED"
            exit 0
        }
        Start-Sleep -Milliseconds 100
        $waited += 100
    }
}

for ($i = 0; $i -lt $totalLength; $i++) {
    try {
        if ([WinInputHelper]::IsCancelPressed()) {
            Write-Output "CANCELLED"
            exit 0
        }
        if ($ParentPid -gt 0 -and (-not [WinInputHelper]::IsProcessAlive($ParentPid))) {
            exit 0
        }
    } catch {}

    # Check for pause signal
    if ($TextFile) {
        $pauseFile = "$TextFile.pause"
        if (Test-Path $pauseFile) {
            Write-Output "PAUSED"
            while (Test-Path $pauseFile) {
                if ([WinInputHelper]::IsCancelPressed() -or ($ParentPid -gt 0 -and (-not [WinInputHelper]::IsProcessAlive($ParentPid)))) {
                    Write-Output "CANCELLED"
                    exit 0
                }
                Start-Sleep -Milliseconds 80
            }
            Write-Output "RESUMED"
        }
    }

    $c = $text[$i]
    if ($c -eq "`r") {
        continue
    }

    $isBlockOpen = $false
    if ($c -eq '{' -or $c -eq '(' -or $c -eq '[') {
        for ($k = $i + 1; $k -lt $totalLength; $k++) {
            $nc = $text[$k]
            if ($nc -eq ' ' -or $nc -eq "`t") { continue }
            if ($nc -eq "`n" -or $nc -eq "`r") { $isBlockOpen = $true }
            break
        }
    }

    $typed = $false
    if (-not $useWShellFallback) {
        try {
            $typed = [WinInputHelper]::SendUnicodeChar($c)
        } catch {
            $typed = $false
        }
        if (-not $typed) {
            # SendInput failed (Access denied / UIPI / parameter), switch to WScript.Shell fallback
            $useWShellFallback = $true
        }
    }

    if ($useWShellFallback -and $wshell) {
        try {
            $escaped = Escape-SendKeysChar $c
            $wshell.SendKeys($escaped)
            $typed = $true
        } catch {
            $typed = $false
        }
    }

    if ($isBlockOpen) {
        Start-Sleep -Milliseconds 15
        if (-not $useWShellFallback) {
            [WinInputHelper]::SendVkKey(0x2E) # VK_DELETE removes editor-inserted ghost bracket
        } elseif ($wshell) {
            $wshell.SendKeys("{DEL}")
        }
    }

    # Periodic progress output (every ~5% or on final char)
    $percent = [Math]::Floor((($i + 1) / $totalLength) * 100)
    if ($percent -ge ($lastProgress + 5) -or ($i -eq $totalLength - 1)) {
        $lastProgress = $percent
        Write-Output "PROGRESS:$percent"
    }

    if ($DelayMs -gt 0) {
        $wait = $DelayMs
        if ($JitterMs -gt 0) {
            $wait += $random.Next(0, $JitterMs + 1)
        }
        if ($c -eq "`n") {
            # Line break pause: allows editor indentation to settle and mimics human cadence
            $wait += $random.Next(250, 500)
        } elseif ($c -eq ';' -or $c -eq '{' -or $c -eq '}') {
            # Statement completion pause
            $wait += $random.Next(60, 150)
        } elseif ($c -eq ' ' -and $DelayMs -ge 30) {
            # Subtle word transition pause
            $wait += $random.Next(20, 50)
        }
        [System.Threading.Thread]::Sleep($wait)
    }
}

Write-Output "DONE"
exit 0
