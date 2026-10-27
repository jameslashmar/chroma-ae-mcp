// qa/client.js — HTTP client for the Chroma AE MCP CEP service (port 7790).
// Plain Node 20 ESM, zero external dependencies.

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 7790;
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Resolves the token file path (%LOCALAPPDATA%/chroma-ae-mcp/token on Windows).
 */
export function resolveTokenPath(customTokenPath) {
  if (customTokenPath) {
    return path.resolve(customTokenPath);
  }
  if (process.env.CHROMA_AE_MCP_TOKEN_PATH) {
    return path.resolve(process.env.CHROMA_AE_MCP_TOKEN_PATH);
  }
  if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "chroma-ae-mcp", "token");
  }
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "chroma-ae-mcp",
      "token"
    );
  }
  return path.join(os.homedir(), ".chroma-ae-mcp", "token");
}

/**
 * Reads the Bearer token from disk.
 */
export function readToken(customTokenPath) {
  const tokenPath = resolveTokenPath(customTokenPath);
  if (!fs.existsSync(tokenPath)) {
    throw new Error(`Chroma AE token file not found at ${tokenPath}`);
  }
  const token = fs.readFileSync(tokenPath, "utf8").trim();
  if (!token) {
    throw new Error(`Chroma AE token file is empty at ${tokenPath}`);
  }
  return token;
}

/**
 * Normalises a filesystem path to forward slashes for ExtendScript.
 */
export function toExtendScriptPath(filePath) {
  return path.resolve(filePath).replace(/\\/g, "/");
}

/**
 * Creates a client for talking to http://127.0.0.1:7790 (/health, /eval, raw /eval).
 */
export function createClient(options = {}) {
  const host = options.host || DEFAULT_HOST;
  const port =
    Number(options.port || process.env.CHROMA_AE_MCP_PORT) || DEFAULT_PORT;
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const tokenPath = options.tokenPath;
  let cachedToken = options.token || null;
  let reqSeq = 0;

  function getToken() {
    if (!cachedToken) {
      cachedToken = readToken(tokenPath);
    }
    return cachedToken;
  }

  function requestJson(method, urlPath, bodyObj, reqTimeoutMs = timeoutMs) {
    const token = getToken();
    const bodyStr = bodyObj !== undefined ? JSON.stringify(bodyObj) : "";
    const headers = {
      Host: `${host}:${port}`,
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    if (bodyObj !== undefined) {
      headers["Content-Type"] = "application/json; charset=utf-8";
      headers["Content-Length"] = Buffer.byteLength(bodyStr, "utf8");
    }

    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: host,
          port,
          path: urlPath,
          method,
          headers,
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("error", (err) => reject(err));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed;
            try {
              parsed = JSON.parse(raw);
            } catch (err) {
              reject(
                new Error(
                  `Invalid JSON from ${method} ${urlPath} (HTTP ${res.statusCode}): ${raw.slice(0, 200)}`
                )
              );
              return;
            }
            if (res.statusCode < 200 || res.statusCode >= 300) {
              const msg =
                parsed?.error?.message ||
                `HTTP ${res.statusCode} from ${method} ${urlPath}`;
              const e = new Error(msg);
              e.statusCode = res.statusCode;
              e.payload = parsed;
              reject(e);
              return;
            }
            resolve(parsed);
          });
        }
      );

      req.setTimeout(reqTimeoutMs, () => {
        const err = new Error(
          `Request to ${method} http://${host}:${port}${urlPath} timed out after ${reqTimeoutMs}ms`
        );
        err.kind = "timeout";
        req.destroy(err);
      });

      req.on("error", (err) => reject(err));

      if (bodyObj !== undefined) {
        req.write(bodyStr);
      }
      req.end();
    });
  }

  async function health() {
    return requestJson("GET", "/health");
  }

  async function evalEnvelope(script, opts = {}) {
    reqSeq += 1;
    const id = opts.id || `qa_${reqSeq}`;
    const label = opts.label || "qa_eval";
    const raw = opts.raw === true;
    return requestJson(
      "POST",
      "/eval",
      {
        id,
        script: String(script),
        label,
        ...(raw ? { raw: true } : {}),
      },
      opts.timeoutMs || timeoutMs
    );
  }

  async function evalScript(script, opts = {}) {
    const payload = await evalEnvelope(script, { ...opts, raw: false });
    if (!payload || payload.ok !== true) {
      const errInfo = payload?.error || {};
      const err = new Error(
        errInfo.message || "ExtendScript evaluation failed"
      );
      err.kind = errInfo.kind || "evalscript_error";
      if (errInfo.line !== undefined) err.line = errInfo.line;
      if (errInfo.sourceText !== undefined) err.sourceText = errInfo.sourceText;
      throw err;
    }
    return payload.result;
  }

  async function evalRaw(script, opts = {}) {
    const payload = await evalEnvelope(script, { ...opts, raw: true });
    if (!payload || payload.ok !== true) {
      const errInfo = payload?.error || {};
      const err = new Error(
        errInfo.message || "Raw ExtendScript evaluation failed"
      );
      err.kind = errInfo.kind || "evalscript_error";
      throw err;
    }
    return payload.result;
  }

  /**
   * Loads a .jsx file into ExtendScript's global scope via raw $.evalFile(<absPath>).
   */
  async function evalFile(filePath, opts = {}) {
    const absPath = toExtendScriptPath(filePath);
    if (!opts.skipExistsCheck && !fs.existsSync(absPath)) {
      throw new Error(`JSX file not found: ${absPath}`);
    }
    // Send the file's source through a raw evalScript, as VoxMark's own loader
    // (host-adapter.js) does: $.evalFile can trap declarations in the calling
    // scope, while raw source sent to evalScript runs at global scope.
    // The trailing comment names the file for logs and tests without shifting
    // the line numbers AE reports for errors in it.
    const script = opts.viaEvalFile
      ? `$.evalFile(${JSON.stringify(absPath)});`
      : `${fs.existsSync(absPath) ? fs.readFileSync(absPath, "utf8") : ""}
// qa-load: ${absPath}
`;
    return evalRaw(script, {
      label: opts.label || `evalFile:${path.basename(absPath)}`,
      timeoutMs: opts.timeoutMs,
    });
  }

  /**
   * Calls a global ExtendScript function fnName(...args).
   * If the function returns a JSON string (as VoxMark's hostscript-aeft.jsx does),
   * parses it and throws on `{ error }`.
   */
  async function call(fnName, args = [], opts = {}) {
    if (typeof fnName !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(fnName)) {
      throw new Error(`Invalid ExtendScript function name: ${String(fnName)}`);
    }
    const encodedArgs = (args || []).map((a) => JSON.stringify(a)).join(", ");
    const script = `${fnName}(${encodedArgs})`;
    const rawResult = await evalScript(script, {
      label: opts.label || `call:${fnName}`,
      timeoutMs: opts.timeoutMs,
    });

    let parsed = rawResult;
    if (typeof rawResult === "string") {
      const trimmed = rawResult.trim();
      if (
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))
      ) {
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          parsed = rawResult;
        }
      }
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      !opts.allowError &&
      typeof parsed.error === "string" &&
      parsed.error.length > 0
    ) {
      const err = new Error(parsed.error);
      err.hostResponse = parsed;
      throw err;
    }

    return parsed;
  }

  return {
    host,
    port,
    health,
    evalEnvelope,
    eval: evalScript,
    evalRaw,
    evalFile,
    call,
  };
}
