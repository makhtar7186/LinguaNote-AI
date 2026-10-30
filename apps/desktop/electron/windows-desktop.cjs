// Windows implementation of the "desktop" used by text-inserter.cjs: which window is in front, and a Ctrl+V into it.
// Done with a short PowerShell script (user32 + SendKeys): no native module to ship. The script never receives the
// transcript: it only pastes what is already on the clipboard, and only if the expected window is still in front.
//
// Limits (docs/security.md): a target running as administrator ignores keys sent by a normal process (Windows UIPI),
// and a paste costs roughly half a second (a PowerShell start-up).
const { execFile } = require("node:child_process");

const TIMEOUT_MS = 8000;

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class LinguaWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
'@
$h = [LinguaWin]::GetForegroundWindow()
$title = New-Object System.Text.StringBuilder 256
[void][LinguaWin]::GetWindowText($h, $title, 256)
$windowPid = [uint32]0
[void][LinguaWin]::GetWindowThreadProcessId($h, [ref]$windowPid)
$id = $h.ToInt64().ToString()
$expected = $env:LINGUANOTE_EXPECTED_WINDOW
$pasted = $false
if ($env:LINGUANOTE_ACTION -eq 'paste' -and $expected -eq $id) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  $pasted = $true
}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
@{ id = $id; title = $title.ToString(); pid = [int]$windowPid; pasted = $pasted } | ConvertTo-Json -Compress
`;

const ENCODED = Buffer.from(SCRIPT, "utf16le").toString("base64");

function runScript(action, expectedId, execFileImpl = execFile) {
  return new Promise((resolve, reject) => {
    execFileImpl(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", ENCODED],
      {
        windowsHide: true,
        timeout: TIMEOUT_MS,
        encoding: "utf8",
        env: { ...process.env, LINGUANOTE_ACTION: action, LINGUANOTE_EXPECTED_WINDOW: expectedId ?? "" },
      },
      (error, stdout) => {
        if (error) return reject(new Error("desktop_script_failed"));
        try {
          resolve(JSON.parse(stdout.trim().split(/\r?\n/).at(-1)));
        } catch {
          reject(new Error("desktop_script_unreadable"));
        }
      },
    );
  });
}

/** `ownPid`: windows of this process (Electron's main process owns every top-level window) are never a target. */
function createWindowsDesktop({ ownPid = process.pid, execFileImpl = execFile } = {}) {
  return {
    async foreground() {
      const info = await runScript("foreground", null, execFileImpl);
      if (!info?.id || info.id === "0") return null;
      return { id: String(info.id), title: String(info.title ?? ""), own: info.pid === ownPid };
    },
    /** Pastes into the window `expectedId` only if it is still in front at that very moment. */
    async paste(expectedId) {
      const info = await runScript("paste", String(expectedId), execFileImpl);
      return { pasted: info?.pasted === true };
    },
  };
}

module.exports = { createWindowsDesktop, SCRIPT };
