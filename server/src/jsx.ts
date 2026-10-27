/**
 * Host functions in panel/host/core.jsx (__chromaAe.<fn>(args)):
 * - status
 * - getProject
 * - getComp
 * - getLayerProps
 * - runUserJsx
 * - setProperty
 * - snapshotFrame
 * - rqAdd
 * - rqStatus
 * - save
 * - snapshotForReceipt
 * - checkGuard
 */

export const HOST_FUNCTIONS = [
  "status",
  "getProject",
  "getComp",
  "getLayerProps",
  "runUserJsx",
  "setProperty",
  "snapshotFrame",
  "rqAdd",
  "rqStatus",
  "save",
  "snapshotForReceipt",
  "checkGuard",
] as const;

export type HostFunctionName = (typeof HOST_FUNCTIONS)[number];

/**
 * Safely encodes an arbitrary JS value into an ASCII-safe JavaScript literal
 * suitable for embedding directly inside an ExtendScript (ES3) call string.
 * Escapes quotes, backslashes, newlines, control chars, U+2028/U+2029, and
 * non-ASCII unicode characters as \uXXXX.
 */
export function encodeJsxArg(value: unknown): string {
  const json = JSON.stringify(value === undefined ? null : value);
  return escapeForExtendScript(json);
}

/**
 * Replaces any character outside printable ASCII (0x20..0x7E) or U+2028/U+2029
 * with \uXXXX (or surrogate pairs for code points > 0xFFFF) so ExtendScript's
 * parser never encounters raw multi-byte sequences or line-separator characters.
 */
export function escapeForExtendScript(jsonLiteral: string): string {
  let out = "";
  for (let i = 0; i < jsonLiteral.length; i++) {
    const code = jsonLiteral.charCodeAt(i);
    if (code >= 0x20 && code <= 0x7e) {
      out += jsonLiteral.charAt(i);
    } else {
      out += "\\u" + code.toString(16).padStart(4, "0");
    }
  }
  return out;
}

/**
 * Builds an ExtendScript call expression `__chromaAe.<fn>(<encodedArgs>)`.
 */
export function buildJsxCall(fn: HostFunctionName, args: unknown = {}): string {
  if (!(HOST_FUNCTIONS as readonly string[]).includes(fn)) {
    throw new Error(`Invalid host function name: ${String(fn)}`);
  }
  return `__chromaAe.${fn}(${encodeJsxArg(args)})`;
}

/**
 * Normalises a project path for target-guard comparison:
 * - Preserves "<unsaved>" literally.
 * - Converts backslashes to forward slashes.
 * - Removes trailing slash (except root "/").
 * - On Windows (or when win32=true), lowercases the path for case-insensitive matching.
 */
export function normalizeGuardPath(
  projectPath: string,
  isWindows: boolean = process.platform === "win32"
): string {
  const trimmed = projectPath.trim();
  if (trimmed === "<unsaved>") {
    return "<unsaved>";
  }
  let normalized = trimmed.replace(/\\/g, "/");
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  if (isWindows) {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

/**
 * Compares an expected project path against the actual project path reported by AE.
 */
export function pathsMatchForGuard(
  expectedPath: string,
  actualPath: string | null | undefined,
  isWindows: boolean = process.platform === "win32"
): boolean {
  const actual = actualPath ? actualPath : "<unsaved>";
  return (
    normalizeGuardPath(expectedPath, isWindows) ===
    normalizeGuardPath(actual, isWindows)
  );
}
