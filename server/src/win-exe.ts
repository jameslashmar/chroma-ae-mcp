/**
 * Windows PowerShell by absolute path. A bare "powershell.exe" is looked up in the working folder first, so a file
 * planted there would run; the system copy is under %SystemRoot%\System32. If that copy is not there (an unusual
 * install, a test box), the bare name is the fallback, as before.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export function powershellExe(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): string {
  const root = env.SystemRoot || env.windir || "C:\\Windows";
  const full = path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    if (exists(full)) return full;
  } catch {
    // fall through
  }
  return "powershell.exe";
}
